"""Online speech synthesis. No voice models, audio files, chat runs or notifications."""
import asyncio
import base64
import json
from typing import Literal
from urllib.parse import urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel, Field, field_validator, model_validator

from . import config, db as store

router = APIRouter()
Provider = Literal["bailian", "siliconflow", "minimax", "custom"]
LIMIT = 16 * 1024 * 1024
ALI_PATH = "/api/v1/services/aigc/multimodal-generation/generation"


class TTSVoice(BaseModel):
    value: str
    label: str


class TTSPreset(BaseModel):
    provider: Provider
    label: str
    url: str
    model: str
    voice: str
    models: list[str]
    voices: list[TTSVoice]
    description: str
    docs_url: str


PRESETS = [
    TTSPreset(provider="bailian", label="阿里云百炼", url="https://dashscope.aliyuncs.com" + ALI_PATH,
        model="qwen3-tts-flash", voice="Cherry", models=["qwen3-tts-flash"],
        # System voices supported by qwen3-tts-flash; names from the official voice list.
        voices=[TTSVoice(value=key, label=label) for key, label in (
            ("Cherry", "芊悦 · 自然女声（默认）"), ("Serena", "苏瑶 · 温柔女声"),
            ("Ethan", "晨煦 · 阳光男声"), ("Chelsie", "千雪 · 二次元女声"),
            ("Momo", "茉兔 · 活泼女声"), ("Maia", "四月 · 知性女声"),
            ("Moon", "月白 · 率性男声"), ("Kai", "凯 · 男声"),
            ("Jennifer", "詹妮弗 · 美语女声"), ("Ryan", "甜茶 · 表现力男声"),
            ("Neil", "阿闻 · 新闻播报男声"), ("Seren", "小婉 · 舒缓女声"),
            ("Dylan", "晓东 · 北京话男声"), ("Sunny", "晴儿 · 四川话女声"),
            ("Rocky", "阿强 · 粤语男声"), ("Kiki", "阿清 · 粤语女声"))],
        description="通义千问语音合成；默认使用北京地域，可修改地址匹配自己的地域与密钥。",
        docs_url="https://help.aliyun.com/zh/model-studio/qwen-tts-voice-list"),
    TTSPreset(provider="siliconflow", label="硅基流动", url="https://api.siliconflow.cn/v1/audio/speech",
        model="FunAudioLLM/CosyVoice2-0.5B", voice="FunAudioLLM/CosyVoice2-0.5B:alex",
        models=["FunAudioLLM/CosyVoice2-0.5B"],
        voices=[TTSVoice(value="FunAudioLLM/CosyVoice2-0.5B:" + key, label=label) for key, label in (
            ("alex", "Alex · 沉稳男声"), ("benjamin", "Benjamin · 低沉男声"),
            ("charles", "Charles · 磁性男声"), ("david", "David · 欢快男声"),
            ("anna", "Anna · 沉稳女声"), ("bella", "Bella · 热情女声"),
            ("claire", "Claire · 温柔女声"), ("diana", "Diana · 欢快女声"))],
        description="提供 CosyVoice2 等 TTS 模型；预置音色 ID 包含模型名前缀。",
        docs_url="https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech"),
    TTSPreset(provider="minimax", label="MiniMax", url="https://api.minimax.cn/v1/t2a_v2",
        model="speech-2.8-turbo", voice="male-qn-qingse", models=["speech-2.8-turbo", "speech-2.8-hd"],
        voices=[TTSVoice(value="male-qn-qingse", label="male-qn-qingse（示例音色）")],
        description="独立语音合成服务，可填写系统音色或账户内已有音色 ID。",
        docs_url="https://platform.minimax.cn/docs/api-reference/speech-t2a-http"),
    TTSPreset(provider="custom", label="自定义兼容接口", url="", model="", voice="", models=[], voices=[],
        description="兼容 /audio/speech，返回 MP3 或 WAV；按接口提供的模型名和音色 ID 配置。", docs_url=""),
]


class TTSProfileWrite(BaseModel):
    provider: Provider
    url: str = Field(max_length=2048)
    model: str = Field(max_length=200)
    voice: str = Field(max_length=300)
    api_key: str | None = Field(default=None, max_length=4096)

    @field_validator("url")
    @classmethod
    def valid_url(cls, value):
        value = value.strip().rstrip("/")
        parsed = urlsplit(value)
        if value and (parsed.scheme not in {"https", "http"} or not parsed.hostname
                      or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise ValueError("请输入不含密钥和查询参数的 HTTP(S) 接口地址")
        return value

    @field_validator("model", "voice")
    @classmethod
    def strip_text(cls, value):
        return value.strip()


class TTSProfileRead(BaseModel):
    provider: Provider
    url: str
    model: str
    voice: str
    key_configured: bool


class TTSSettingsRead(BaseModel):
    selected: Provider
    profiles: list[TTSProfileRead]
    presets: list[TTSPreset]


class TTSSettingsWrite(BaseModel):
    selected: Provider
    profiles: list[TTSProfileWrite] = Field(min_length=1, max_length=4)

    @model_validator(mode="after")
    def unique_providers(self):
        if len({profile.provider for profile in self.profiles}) != len(self.profiles):
            raise ValueError("朗读服务不能重复")
        return self


@router.get("/settings/tts", response_model=TTSSettingsRead)
def settings():
    with store.Session() as db:
        saved = db.get(store.Settings, config.PROFILE_ID).tts_config or {}
    profiles = []
    for preset in PRESETS:
        profile = {key: getattr(preset, key) for key in ("provider", "url", "model", "voice")}
        profile.update((saved.get("profiles") or {}).get(preset.provider, {}))
        profiles.append(TTSProfileRead(**profile, key_configured=bool(config.secret_get("tts:" + preset.provider))))
    return TTSSettingsRead(selected=saved.get("selected", "bailian"), profiles=profiles, presets=PRESETS)


@router.put("/settings/tts", response_model=TTSSettingsRead)
def save_settings(value: TTSSettingsWrite):
    with store.Session() as db:
        row = db.get(store.Settings, config.PROFILE_ID)
        profiles = dict((row.tts_config or {}).get("profiles", {}))
        for profile in value.profiles:
            profiles[profile.provider] = profile.model_dump(exclude={"provider", "api_key"})
            config.secret_set("tts:" + profile.provider, profile.api_key)
        row.tts_config = {"selected": value.selected, "profiles": profiles}
        db.commit()
    return settings()


class TTSSynthesisWrite(BaseModel):
    text: str = Field(min_length=1, max_length=600)
    profile: TTSProfileWrite | None = None

    @field_validator("text")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("请输入需要朗读的文字")
        return value


def request_spec(profile, text):
    url = profile.url
    parsed = urlsplit(url)
    if profile.provider == "bailian":
        if not parsed.path.endswith(ALI_PATH):
            prefix = parsed.path.rstrip("/")
            for suffix in ("/compatible-mode/v1", "/api/v1", "/v1"):
                if prefix.endswith(suffix):
                    prefix = prefix[:-len(suffix)]
                    break
            url = urlunsplit((parsed.scheme, parsed.netloc, prefix + ALI_PATH, "", ""))
        return url, {"model": profile.model, "input": {"text": text, "voice": profile.voice, "language_type": "Auto"}}
    if profile.provider == "minimax":
        if not parsed.path.endswith("/t2a_v2"):
            url += "/t2a_v2" if parsed.path.endswith("/v1") else "/v1/t2a_v2"
        return url, {"model": profile.model, "text": text, "stream": False, "output_format": "hex",
                     "voice_setting": {"voice_id": profile.voice, "speed": 1, "vol": 1, "pitch": 0},
                     "audio_setting": {"format": "mp3", "sample_rate": 32000, "bitrate": 128000, "channel": 1}}
    if not parsed.path.endswith("/audio/speech"):
        url += ("/v1" if not parsed.path else "") + "/audio/speech"
    return url, {"model": profile.model, "input": text, "voice": profile.voice, "response_format": "mp3"}


async def read_response(client, method, url, *, limit=LIMIT * 2, **kwargs):
    async with client.stream(method, url, **kwargs) as response:
        if not response.is_success:
            raise HTTPException(400, f"朗读服务请求失败（HTTP {response.status_code}），请检查接口、密钥、模型、音色和额度")
        content = bytearray()
        async for chunk in response.aiter_bytes():
            content.extend(chunk)
            if len(content) > limit:
                raise HTTPException(400, "朗读服务返回的音频过大，请缩短文字后重试")
        return bytes(content)


def media_type(audio):
    if len(audio) > LIMIT or len(audio) < 12:
        raise HTTPException(400, "朗读服务没有返回有效音频")
    if audio[:4] == b"RIFF" and audio[8:12] == b"WAVE":
        return "audio/wav"
    if audio[:3] == b"ID3" or (audio[0] == 255 and audio[1] & 224 == 224):
        return "audio/mpeg"
    raise HTTPException(400, "朗读服务未返回支持的 MP3 或 WAV 音频，请检查接口配置")


async def synthesize(value):
    profile = value.profile
    if profile is None:
        saved = settings()
        profile = TTSProfileWrite(**next(p.model_dump() for p in saved.profiles if p.provider == saved.selected))
    key = config.secret_get("tts:" + profile.provider) if profile.api_key is None else profile.api_key.strip()
    if not profile.url or not profile.model or not profile.voice or (profile.provider != "custom" and not key):
        raise HTTPException(400, "请在「连接与设置 → 能力连接 → 语音朗读」配置接口、模型、音色和密钥")
    url, body = request_spec(profile, value.text)
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(75, connect=15), follow_redirects=False, trust_env=False) as client:
            content = await read_response(client, "POST", url, json=body,
                headers={"Authorization": "Bearer " + key} if key else {})
            if profile.provider == "bailian":
                payload = json.loads(content)
                item = payload.get("output", {}).get("audio", {})
                if item.get("data"):
                    content = base64.b64decode(item["data"], validate=True)
                else:
                    address = urlsplit(item.get("url") or "")
                    host = (address.hostname or "").lower()
                    configured_host = (urlsplit(profile.url).hostname or "").lower()
                    if (address.scheme not in {"http", "https"} or not host or address.username or address.password
                            or not (host.endswith(".aliyuncs.com") or host == configured_host)):
                        raise HTTPException(400, "百炼没有返回可用的音频，请检查模型和音色配置")
                    if host.endswith(".aliyuncs.com"):
                        address = address._replace(scheme="https")
                    # Signed audio downloads never receive the provider API key.
                    content = await read_response(client, "GET", address.geturl(), limit=LIMIT)
            elif profile.provider == "minimax":
                payload = json.loads(content)
                code = payload.get("base_resp", {}).get("status_code", -1)
                if not isinstance(code, int):
                    raise HTTPException(400, "MiniMax 朗读服务返回格式异常，请检查接口配置")
                if code != 0:
                    raise HTTPException(400, f"MiniMax 朗读失败（错误码 {code}），请检查模型、音色、密钥和额度")
                content = bytes.fromhex((payload.get("data") or {}).get("audio") or "")
        return content, media_type(content)
    except httpx.TimeoutException:
        raise HTTPException(408, "语音合成超时，请稍后重试") from None
    except httpx.HTTPError:
        raise HTTPException(400, "无法连接朗读服务，请检查接口地址和网络") from None
    except (ValueError, TypeError, KeyError, AttributeError):
        raise HTTPException(400, "朗读服务返回格式异常，请检查所选服务、模型和音色") from None


@router.post("/speech/synthesis", response_class=Response,
    responses={200: {"content": {"audio/mpeg": {}, "audio/wav": {}}}})
async def speech(value: TTSSynthesisWrite, request: Request):
    async def disconnected():
        while True:
            message = await request.receive()
            if message["type"] == "http.disconnect":
                return
    operation = asyncio.create_task(synthesize(value))
    watcher = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait({operation, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if watcher in done:
            raise HTTPException(499, "已停止朗读")
        audio, mime = await operation
        return Response(audio, media_type=mime, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})
    finally:
        for task in (operation, watcher):
            if not task.done():
                task.cancel()
        await asyncio.gather(operation, watcher, return_exceptions=True)
