"""Durable tool outputs; only public, bounded, decoded images are fetched."""

import asyncio
import base64
import io
import ipaddress
import json
import mimetypes
import re
import socket
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import httpx
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import select

from . import config
from .db import Artifact, RunEvent, Session, uid

LIMIT = 10 * 1024 * 1024
IMAGE_SUFFIXES = (
    ".avif",
    ".bmp",
    ".gif",
    ".jpeg",
    ".jpg",
    ".png",
    ".tif",
    ".tiff",
    ".webp",
)


def looks_like_image_url(value):
    if value.startswith("data:image/"):
        return True
    return (
        value.startswith(("http://", "https://"))
        and urlsplit(value).path.lower().endswith(IMAGE_SUFFIXES)
    )


def root():
    value = config.ATTACHMENTS_DIR / "artifacts"
    value.mkdir(exist_ok=True)
    return value


def describe(row):
    return {
        "id": row.id,
        "name": row.name,
        "media_type": row.media_type,
        "source_url": "" if row.source_url.startswith("xiaoxi-office:") else row.source_url,
        "image": row.media_type.startswith("image/"),
    }


def image_info(data):
    if len(data) > LIMIT:
        raise ValueError("图片超过 10 MB")
    with Image.open(io.BytesIO(data)) as picture:
        if picture.width * picture.height > 40_000_000 or picture.format not in {
            "JPEG", "PNG", "WEBP", "GIF",
        }:
            raise ValueError("图片格式或尺寸不支持")
        value = {"media_type": Image.MIME[picture.format], "width": picture.width, "height": picture.height}
        picture.verify()
    return value


def save_file(run_id, name, data, source_url="", image=False):
    media = mimetypes.guess_type(name)[0] or "application/octet-stream"
    if image or media.startswith("image/"):
        media = image_info(data)["media_type"]
        if Path(name).suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp", ".gif"}:
            name += {
                "image/jpeg": ".jpg",
                "image/png": ".png",
                "image/webp": ".webp",
                "image/gif": ".gif",
            }[media]
    key = uid()
    with Session() as db:
        record = Artifact(
            id=key,
            run_id=run_id,
            name=Path(name).name[:300] or "工具产物",
            media_type=media,
            storage_name=key + ".bin",
            source_url=source_url,
        )
        file = root() / record.storage_name
        file.write_bytes(data)
        try:
            db.add(record)
            db.commit()
        except Exception:
            file.unlink(missing_ok=True)
            raise
        return describe(record)


async def fetch_image(url):
    """Pin each redirect to a validated public IP, preserving TLS SNI and Host."""
    async with httpx.AsyncClient(timeout=15, trust_env=False) as client:
        for _ in range(5):
            parsed = urlsplit(url)
            if (
                parsed.scheme not in {"http", "https"}
                or not parsed.hostname
                or parsed.username
                or parsed.password
            ):
                raise ValueError("图片地址必须为公开 HTTP/HTTPS 地址")
            addresses = await asyncio.to_thread(
                socket.getaddrinfo,
                parsed.hostname,
                parsed.port or (443 if parsed.scheme == "https" else 80),
                type=socket.SOCK_STREAM,
            )
            if not addresses or any(
                not ipaddress.ip_address(entry[4][0]).is_global for entry in addresses
            ):
                raise ValueError("不加载本机或内网图片地址")
            pinned = httpx.URL(url).copy_with(host=addresses[0][4][0])
            request = client.build_request(
                "GET",
                pinned,
                headers={"Host": parsed.netloc},
                extensions={"sni_hostname": parsed.hostname},
            )
            response = await client.send(request, stream=True)
            try:
                if response.status_code in {301, 302, 303, 307, 308}:
                    url = urljoin(url, response.headers["location"])
                    continue
                response.raise_for_status()
                data = bytearray()
                async for chunk in response.aiter_bytes():
                    data.extend(chunk)
                    if len(data) > LIMIT:
                        raise ValueError("图片超过 10 MB")
                return bytes(data)
            finally:
                await response.aclose()
    raise ValueError("图片重定向次数过多")


async def image_from_url(run_id, url):
    if len(url) > 16000:
        raise ValueError("图片地址过长")
    with Session() as db:
        previous = db.scalar(
            select(Artifact).where(
                Artifact.run_id == run_id, Artifact.source_url == url
            )
        )
        if previous:
            return describe(previous)
    if url.startswith("data:image/"):
        if len(url) > LIMIT * 1.4:
            raise ValueError("图片超过 10 MB")
        data = base64.b64decode(url.split(",", 1)[1], validate=True)
        source = ""
    else:
        data, source = await fetch_image(url), url
    return save_file(run_id, "图片", data, source_url=source, image=True)


def extract_sources(value, read=False):
    if isinstance(value, dict) and value.get("error"):
        return []
    found = []

    def walk(item, depth=0):
        if depth > 8 or len(found) >= 30:
            return
        if isinstance(item, dict):
            url = item.get("url") or item.get("link")
            title = item.get("title") or item.get("name")
            text = (
                item.get("summary")
                or item.get("snippet")
                or item.get("content")
                or item.get("raw_content")
            )
            if (
                isinstance(url, str)
                and urlsplit(url).scheme in {"http", "https"}
                and (title or isinstance(text, str))
            ):
                found.append(
                    {
                        "url": url,
                        "title": str(title or urlsplit(url).hostname)[:300],
                        "summary": text[:600] if isinstance(text, str) else "",
                        "kind": "read" if read or item.get("raw_content") else "search",
                    }
                )
            for child in item.values():
                walk(child, depth + 1)
        elif isinstance(item, list):
            for child in item[:100]:
                walk(child, depth + 1)
        elif isinstance(item, str):
            if item.lstrip().startswith(("{", "[")):
                try:
                    walk(json.loads(item), depth + 1)
                except (ValueError, RecursionError):
                    pass
            for title, url in re.findall(
                r"(?<!!)\[([^\]]{1,300})\]\((https?://[^\s)]+)\)", item
            )[:30]:
                found.append(
                    {
                        "url": url,
                        "title": title,
                        "summary": "",
                        "kind": "read" if read else "search",
                    }
                )

    walk(value)
    return list({x["url"]: x for x in found}.values())[:30]


async def normalize(run_id, value, read=False):
    if not isinstance(value, dict):
        return value
    value = dict(value)
    media, errors = list(value.get("artifacts", [])), []
    blocks = value.pop("media_blocks", [])
    urls = []
    for block in blocks:
        if block.get("type") in {"image", "image_url"}:
            url = block.get("url") or (block.get("image_url") or {}).get("url")
            if block.get("base64"):
                url = (
                    "data:"
                    + block.get("mime_type", "image/png")
                    + ";base64,"
                    + block["base64"]
                )
            if url:
                urls.append(url)
        elif block.get("type") == "file":
            if block.get("base64") and len(block["base64"]) <= LIMIT * 1.4:
                try:
                    media.append(
                        save_file(
                            run_id,
                            block.get("name", "工具文件"),
                            base64.b64decode(block["base64"], validate=True),
                        )
                    )
                except (ValueError, OSError):
                    errors.append("工具文件无法保存")
            else:
                errors.append("工具返回的文件地址暂不支持下载")
    text = value.get("text", "")
    if isinstance(text, str):
        urls.extend(re.findall(r"!\[[^\]]*\]\((https?://[^\s)]+)\)", text))

    def image_links(item, depth=0, image_context=False):
        if depth > 6:
            return
        if isinstance(item, dict):
            for key, child in item.items():
                if (
                    (
                        key in {"image_url", "imageUrl", "image"}
                        or (image_context and key in {"url", "uri"})
                    )
                    and isinstance(child, str)
                    and child.startswith(("http://", "https://", "data:image/"))
                ):
                    urls.append(child)
                else:
                    image_links(
                        child,
                        depth + 1,
                        image_context
                        or key in {"image_url", "imageUrl", "image", "images"},
                    )
        elif isinstance(item, list):
            for child in item[:30]:
                image_links(child, depth + 1, image_context)
        elif isinstance(item, str):
            stripped = item.lstrip()
            if stripped.startswith(("{", "[")):
                try:
                    image_links(json.loads(stripped), depth + 1)
                except (ValueError, RecursionError):
                    pass
            elif image_context or looks_like_image_url(item):
                urls.append(item)

    image_links(value)
    value["image_urls"] = list(
        dict.fromkeys(url for url in urls if url.startswith(("http://", "https://")))
    )[:10]
    for url in dict.fromkeys(urls):
        if len(media) >= 10:
            break
        try:
            media.append(await image_from_url(run_id, url))
        except (ValueError, OSError, httpx.HTTPError, KeyError):
            errors.append("图片加载失败，可在回答中重试；未重新调用生成工具")
    value["artifacts"] = media
    sources = extract_sources(value, read)
    if sources:
        value["sources"] = sources
    if errors:
        value["media_errors"] = errors
    return value


def presentation(run_id):
    with Session() as db:
        media = [
            describe(row)
            for row in db.scalars(select(Artifact).where(Artifact.run_id == run_id))
        ]
        sources, errors, image_urls = {}, [], []
        knowledge_sources = {}
        for event in db.scalars(select(RunEvent).where(RunEvent.run_id == run_id, RunEvent.kind == "knowledge_retrieval")):
            for source in event.data.get("sources", []):
                knowledge_sources[source["chunk_id"]] = source
        for event in db.scalars(
            select(RunEvent).where(RunEvent.run_id == run_id, RunEvent.kind == "tool")
        ):
            result = event.data.get("result", {})
            if isinstance(result, dict):
                for source in result.get("sources", extract_sources(result)):
                    sources[source["url"]] = source
                errors.extend(result.get("media_errors", []))
                image_urls.extend(result.get("image_urls", []))
    return {
        "artifacts": media,
        "sources": list(sources.values()),
        "knowledge_sources": list(knowledge_sources.values()),
        "errors": list(dict.fromkeys(errors)),
        "image_urls": [
            url
            for url in dict.fromkeys(image_urls)
            if not any(a["source_url"] == url for a in media)
        ],
    }


def file_record(key):
    with Session() as db:
        row = db.get(Artifact, key)
        if row is None or row.profile_id != config.PROFILE_ID:
            raise HTTPException(404, "文件不存在")
        path = root() / row.storage_name
        if not path.resolve().is_relative_to(root().resolve()) or not path.is_file():
            raise HTTPException(404, "文件缺失")
        return path, row
