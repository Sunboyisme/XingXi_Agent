"""Text-to-image via Images-compatible and native DashScope Qwen providers."""

import asyncio
import base64
import hashlib
import json
import re
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import httpx
from langchain_core.tools import tool
from sqlalchemy import select

from . import artifacts, config, schemas
from .db import Artifact, RunEvent, Session, Settings
from .runs import emit


def settings():
    with Session() as db:
        row = db.get(Settings, config.PROFILE_ID)
        saved = row.image_generation_config if row else {}
    return schemas.ImageGenerationRead(
        **(saved or {}), key_configured=bool(config.secret_get("image_generation"))
    ).model_dump()


def ready(value=None):
    value = value or settings()
    return bool(value["enabled"] and value["model"] and value["key_configured"])


_DASHSCOPE_PATH = "/api/v1/services/aigc/multimodal-generation/generation"
IMAGE_REQUEST_TIMEOUT_SECONDS = 240


def request_spec(value, prompt):
    """Choose a protocol before submitting, without retrying paid generation."""
    url = value["url"].rstrip("/")
    parsed = urlsplit(url)
    host = (parsed.hostname or "").lower()
    ali_host = host in {
        "dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"
    } or host.endswith(".maas.aliyuncs.com")
    native = parsed.path.endswith(_DASHSCOPE_PATH) or (
        ali_host and value["model"].lower().startswith("qwen-image")
        # An explicitly entered full Images endpoint takes precedence.
        and not parsed.path.endswith("/images/generations")
    )
    if native:
        if not parsed.path.endswith(_DASHSCOPE_PATH):
            prefix = parsed.path.rstrip("/")
            for suffix in ("/compatible-mode/v1", "/api/v1", "/v1"):
                if prefix.endswith(suffix):
                    prefix = prefix[:-len(suffix)]
                    break
            url = urlunsplit((parsed.scheme, parsed.netloc, prefix + _DASHSCOPE_PATH, "", ""))
        body = {
            "model": value["model"],
            "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
        }
        if value["size"] and value["size"] != "auto":
            body["parameters"] = {"size": value["size"].replace("x", "*")}
        return "dashscope", url, body
    if not parsed.path.endswith("/images/generations"):
        url += "/images/generations"
    body = {"model": value["model"], "prompt": prompt, "n": 1}
    if value["size"]:
        body["size"] = value["size"]
    if value["response_format"] != "auto":
        body["response_format"] = value["response_format"]
    return "openai_images", url, body


def response_image(payload):
    if not isinstance(payload, dict):
        return None
    data = payload.get("data")
    if isinstance(data, list) and data and isinstance(data[0], dict):
        return data[0]
    output = payload.get("output")
    choices = output.get("choices", []) if isinstance(output, dict) else []
    if not isinstance(choices, list):
        return None
    for choice in choices:
        message = choice.get("message", {}) if isinstance(choice, dict) else {}
        content = message.get("content", []) if isinstance(message, dict) else []
        if not isinstance(content, list):
            continue
        for item in content:
            if isinstance(item, dict) and isinstance(item.get("image"), str) and item["image"]:
                return {"url": item["image"]}
    return None


async def request_image(value, api_key, prompt, progress=None):
    """Shared request path for Agent generation and user-initiated connection checks."""
    protocol, url, body = request_spec(value, prompt)
    stage = "generate"
    image = None
    payload = None

    async def advance(next_stage):
        if progress:
            await progress(next_stage)

    await advance("submit")
    try:
        from .usage_cost import MeteredAsyncClient, metadata
        async with MeteredAsyncClient(
            usage_metadata=metadata(value, kind="images", purpose="image_generation" if progress else "connection_test"),
            timeout=httpx.Timeout(IMAGE_REQUEST_TIMEOUT_SECONDS, connect=15),
            trust_env=False,
        ) as client:
            # The provider renders while this request is open: that is the generating stage.
            await advance("generate")
            async with client.stream("POST", url, json=body, headers={
                "Authorization": f"Bearer {api_key}"
            }) as response:
                encoded = bytearray()
                async for chunk in response.aiter_bytes():
                    encoded.extend(chunk)
                    if len(encoded) > 16 * 1024 * 1024:
                        raise ValueError("图片服务响应超过大小限制")
                if not response.is_success:
                    try:
                        payload = json.loads(encoded)
                    except ValueError:
                        pass
                response.raise_for_status()
        payload = json.loads(encoded)
        item = response_image(payload)
        if not item:
            raise ValueError("图片服务没有返回可保存的图片")
        if isinstance(item.get("b64_json"), str) and item["b64_json"]:
            if len(item["b64_json"]) > artifacts.LIMIT * 1.4:
                raise ValueError("图片超过 10 MB")
            image = base64.b64decode(item["b64_json"], validate=True)
        elif isinstance(item.get("url"), str) and item["url"]:
            stage = "download"
            await advance("download")
            image = await artifacts.fetch_image(item["url"])
        else:
            raise ValueError("图片服务没有返回图片内容或地址")
        stage = "validate"
        await advance("validate")
        info = await asyncio.to_thread(artifacts.image_info, image)
        result = {"width": info["width"], "height": info["height"]}
    except asyncio.CancelledError:
        raise
    except httpx.HTTPStatusError as error:
        status = error.response.status_code
        message = {
            400: "图片服务不接受当前模型或参数，请检查模型、尺寸与返回格式。",
            401: "图片生成接口认证失败，请检查密钥。",
            403: "图片生成接口无访问权限，请检查模型授权。",
            404: "图片服务返回 HTTP 404，当前地址没有对应的生图接口，请核对接口地址与协议。",
            429: "图片生成额度不足或请求过于频繁，请稍后再试。",
        }.get(status, "图片服务请求失败，未自动重试。")
        if stage == "download":
            message = f"图片服务已返回结果，但下载图片失败（HTTP {status}）；未重新生成。"
        result = {"error": message, "http_status": status,
                  "not_executed": stage == "generate" and status in {400, 401, 403, 404, 422, 429}}
        if stage == "generate" and isinstance(payload, dict):
            remote = payload.get("error")
            code = remote.get("code") if isinstance(remote, dict) else payload.get("code")
            # Codes are useful diagnostics; provider messages may echo credentials.
            if isinstance(code, str) and 0 < len(code) <= 80 and api_key not in code and all(c.isascii() and (c.isalnum() or c in "_.-") for c in code):
                result["error"] += f"（{code}）"
    except httpx.TimeoutException:
        result = {
            "error": (
                f"图片服务在 {IMAGE_REQUEST_TIMEOUT_SECONDS} 秒内没有返回结果。"
                "服务商可能仍在生成；为避免重复计费，未自动重试。"
            )
        }
    except httpx.HTTPError:
        result = {"error": "图片生成请求未完成，服务商可能已接收；未自动重试，请稍后核对。"}
    except (ValueError, OSError, KeyError):
        result = {"error": "图片服务返回的内容不可用，请检查图片格式、大小与返回格式；未自动重试。"}
    if result.get("error"):
        image = None
    result.update(protocol=protocol, endpoint=url, model=value["model"], stage=stage)
    return image, result


async def probe(value, api_key):
    """Generate and decode one sample without saving settings, files or chat records."""
    image, result = await request_image(
        value, api_key, "A single blue circle on a plain white background. No text."
    )
    return {
        "ok": image is not None and not result.get("error"),
        "message": result.get("error") or "连接成功，测试图片已生成并读取。",
        "protocol": result["protocol"], "endpoint": result["endpoint"], "model": result["model"],
        "width": result.get("width"), "height": result.get("height"),
        "http_status": result.get("http_status"),
    }


async def generate(run_id, prompt, name):
    value = settings()
    if not ready(value):
        return {"error": "请先在「连接与设置 → 图片生成」配置并启用图片模型。", "not_executed": True}
    prompt = prompt.strip()
    if not prompt or len(prompt) > 16000:
        return {"error": "图片描述需要 1–16000 个字符。", "not_executed": True}
    protocol, url, _ = request_spec(value, prompt)
    fingerprint = hashlib.sha256(json.dumps({
        "prompt": prompt, "model": value["model"], "url": value["url"],
        "size": value["size"], "response_format": value["response_format"],
        "protocol": protocol, "endpoint": url,
    }, ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    from .task_context import current
    execution = current.get()
    if execution and execution.operation_id:
        fingerprint = hashlib.sha256((execution.operation_id + fingerprint).encode()).hexdigest()
    with Session() as db:
        previous = list(db.scalars(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.kind == "image_generation"
        ).order_by(RunEvent.id)))
    matching = [event.data for event in previous if event.data.get("fingerprint") == fingerprint]
    if matching:
        completed = next((event for event in reversed(matching) if event.get("result")), None)
        return completed["result"] if completed else {
            "error": "本轮已提交相同的图片生成请求，结果尚未确认；为避免重复生成，未再次提交。"
        }
    started_at = time.time()
    emit(run_id, "image_generation", {
        "fingerprint": fingerprint, "status": "started",
        "protocol": protocol, "endpoint": url, "model": value["model"],
        "stage": "submit", "started_at": started_at,
    })

    async def progress(stage):
        emit(run_id, "image_generation", {
            "fingerprint": fingerprint, "status": "progress", "stage": stage,
            "started_at": started_at,
        })

    image, result = await request_image(
        value, config.secret_get("image_generation"), prompt, progress
    )
    if image is not None:
        await progress("save")
        try:
            artifact = await asyncio.to_thread(
                artifacts.save_file, run_id, Path(name).stem[:120] or "生成图片", image, image=True
            )
            result.update(artifacts=[artifact], summary="图片已生成并保存在本机，可在回答下方放大查看或下载。")
        except (ValueError, OSError):
            result.update(error="图片已返回，但保存到本机失败；未重新生成。", stage="save")
    emit(run_id, "image_generation", {
        "fingerprint": fingerprint, "status": "finished", "result": result,
        "started_at": started_at,
        "elapsed_ms": round((time.time() - started_at) * 1000),
    })
    return result


def is_generation_tool(tool_id, name="", description=""):
    """Recognize the built-in and common MCP image-generation tool names."""
    return bool(re.search(
        r"generate[_ -]?(?:an?[_ -]?)?image|image[_ -]?gen(?:eration)?"
        r"|text[_ -]?to[_ -]?image|text2image|txt2img"
        r"|生图|文生图|图片生成|图像生成|生成图片|生成图像|绘制图片",
        " ".join(str(value or "") for value in (tool_id, name, description)), re.IGNORECASE,
    ))


def is_image_request(text):
    """Hold image-related narration until the execution result is verified."""
    return bool(re.search(
        r"图片|图像|壁纸|海报|插画|生图|画一|画个|绘制"
        r"|\b(?:image|wallpaper|poster|illustration|draw)\b",
        text, re.IGNORECASE,
    ))


def _execution(run_id):
    with Session() as db:
        events = list(db.scalars(select(RunEvent).where(
            RunEvent.run_id == run_id,
            RunEvent.kind.in_(["tool", "image_generation"]),
        ).order_by(RunEvent.id)))
        attempts = [event.data for event in events if event.kind == "tool" and (
            event.data.get("image_generation")
            or is_generation_tool(event.data.get("tool_id", ""), event.data.get("name", ""))
        )]
        # If the connection broke before the guarded tool returned, recover the
        # last durable state of each built-in request without counting it twice.
        if not any(item.get("tool_id") == "generate_image" for item in attempts):
            requests = {}
            for event in events:
                if event.kind == "image_generation":
                    requests[event.data.get("fingerprint", "builtin")] = event.data
            attempts.extend(requests.values())
        artifact_ids = {
            item["id"]
            for attempt in attempts
            for result in [attempt.get("result")]
            if isinstance(result, dict)
            for item in result.get("artifacts", [])
            if isinstance(item, dict) and isinstance(item.get("id"), str)
        }
        images = [artifacts.describe(row) for row in db.scalars(select(Artifact).where(
            Artifact.run_id == run_id,
            Artifact.profile_id == config.PROFILE_ID,
            Artifact.id.in_(artifact_ids),
            Artifact.media_type.startswith("image/"),
        ).order_by(Artifact.created_at, Artifact.id)) if (
            (artifacts.root() / row.storage_name).is_file()
        )] if artifact_ids else []
    return attempts, images


def result_receipt(run_id):
    """Report only tool-backed images that exist in this run's local storage."""
    attempts, images = _execution(run_id)
    if not attempts:
        return ""
    errors = []
    missing_result = False
    saved_ids = {image["id"] for image in images}
    for attempt in attempts:
        result = attempt.get("result")
        if not isinstance(result, dict):
            missing_result = True
            continue
        if result.get("error"):
            errors.append(str(result["error"])[:700])
        media_errors = result.get("media_errors") or []
        if isinstance(media_errors, str):
            media_errors = [media_errors]
        errors.extend(str(error)[:700] for error in media_errors)
        if not any(isinstance(item, dict) and item.get("id") in saved_ids
                   for item in result.get("artifacts", [])) and not (result.get("error") or media_errors):
            missing_result = True
    lines = []
    if images:
        names = "、".join(image["name"].replace("\n", " ") for image in images)
        lines.extend([f"图片已生成并保存在本机：{names}", "", "可在本轮回答下方查看、放大或下载。"])
        if errors or missing_result:
            lines.extend(["", "另有图片请求未取得可展示的结果。"])
    else:
        lines.append("本轮已调用图片生成工具，但尚未取得可展示的图片产物。")
    if errors:
        lines.extend(["", *dict.fromkeys(errors)])
    if missing_result:
        lines.extend(["", "没有真实图片的请求不能确认为生成成功；服务端结果尚未确认，未自动重新提交。"])
    return "\n".join(lines)


def verify_reply(run_id, text, request=""):
    """Replace invented completion claims even when no image tool was called."""
    receipt = result_receipt(run_id)
    if receipt:
        return receipt
    # Explanations, quoted examples and code are not the assistant's own claim.
    prose = re.sub(r"```[\s\S]*?```|`[^`]*`|“[^”]*”|‘[^’]*’|「[^」]*」|^>.*$", "", text, flags=re.MULTILINE)
    subject = r"(?:图片|图像|壁纸|海报|插画)"
    requested = bool(re.search(
        rf"(?:生成|绘制|画|制作|做|设计|给我|来一张).{{0,30}}{subject}"
        rf"|{subject}.{{0,12}}(?:生成|绘制|画出来|做出来)", request,
    )) and not re.search(r"怎么|如何|为什么|教程|提示词|文案", request)
    claim = re.compile(
        rf"(?:已(?:经)?(?:为你|帮你)?(?:成功)?(?:生成|画好|绘制|做好|完成|保存)).{{0,30}}{subject}"
        rf"|{subject}.{{0,24}}(?:已(?:经)?(?:生成|画好|绘制|做好|完成|保存)|生成(?:成功|完成)|来[啦咯了]|出炉|搞定)"
        rf"|(?:已生成|生成成功|做好了|画好了).{{0,12}}[：:].{{0,30}}{subject}",
    )
    delivery_claim = re.compile(
        rf"{subject}.{{0,18}}(?:就?在下(?:方|面)|如下|可以直接(?:查看|下载))"
        r"|已(?:经)?(?:成功)?生成|搞定|来[啦咯]|出炉|做好[了啦]|画好[了啦]"
    )
    for sentence in re.split(r"[。！？\n]", prose):
        matches = list(claim.finditer(sentence))
        if requested:
            matches.extend(delivery_claim.finditer(sentence))
        for match in matches:
            prefix = re.split(r"[，,；;]", sentence[:match.start()])[-1][-12:]
            if re.search(r"(?:不能|不可|不要|不得|无法|并未|没有|尚未|还没|未能)(?:说|声称|确认|表示|保证)?$", prefix):
                continue
            if re.search(r"(?:没有|尚未|还没|未能|无法|不能|并未).{0,6}(?:生成|完成|保存|做好|绘制)", match.group()):
                continue
            if re.match(r"后|时|的话", sentence[match.end():]):
                continue
            return (
                "本轮没有调用图片生成工具，也没有保存可展示的生成图片，不能确认为生成成功。"
                "你可以重新发送生成请求；本轮未自动提交或重试。"
            )
    return text


def build(run_id):
    @tool
    async def generate_image(prompt: str, name: str = "生成图片") -> str:
        """用户要求生成图片、海报、插画时，调用独立配置的图片模型。prompt 写清画面、风格、构图和需要出现的文字，保留用户明确要求，不虚构联系电话或地址；name 是图片名称。每次生成一张，尺寸使用图片连接中保存的设置。仅支持文字生图，不支持把附件作为参考图编辑；如用户要求修改已有图片或保留参考图身份，应明确说明限制，不可声称已编辑。成功后界面自动展示真实图片，不编造链接，也不把生成PDF当成已生图。失败或结果未知时不自行重复提交，说明实际情况。"""
        return json.dumps(await generate(run_id, prompt, name), ensure_ascii=False)

    return [generate_image]


INFO = {"generate_image": ("生成图片", "调用独立图片模型生成海报、插画等图片", False)}
