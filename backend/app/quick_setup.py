"""Conservative one-key setup: add a connection and fill only empty capabilities."""

import asyncio
from copy import deepcopy
from uuid import uuid4

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal

from . import config, model_profiles, provider, schemas, service_credentials
from .db import Session, Settings

router = APIRouter()
lock = asyncio.Lock()

# Curated capabilities, intersected with the account's catalog at setup time.
# Conservative context budgets avoid treating a model name as a capacity guarantee.
PRESETS = {
    "siliconflow": {
        "label": "硅基流动", "url": "https://api.siliconflow.cn/v1",
        "key_url": "https://cloud.siliconflow.cn/account/ak",
        "description": "适合首次配置，多家模型共用一个密钥。",
        "chat": [("Qwen/Qwen3.8-27B", True), ("Qwen/Qwen3-VL-32B-Instruct", True),
                 ("deepseek-ai/DeepSeek-V4.1-Flash", True), ("deepseek-ai/DeepSeek-V4-Flash", False),
                 ("Qwen/Qwen3-8B", False)],
        "embedding": ["Qwen/Qwen3-Embedding-0.6B", "Qwen/Qwen3-Embedding-4B", "BAAI/bge-m3"],
        "image": ["Qwen/Qwen-Image", "Tongyi-MAI/Z-Image-Turbo", "Kwai-Kolors/Kolors"],
        "speech": "FunAudioLLM/SenseVoiceSmall",
        "tts": "FunAudioLLM/CosyVoice2-0.5B",
        "voice": "FunAudioLLM/CosyVoice2-0.5B:claire",
    },
    "bailian": {
        "label": "阿里云百炼", "url": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "key_url": "https://bailian.console.aliyun.com/?tab=model#/api-key",
        "description": "适合已有阿里云账号，使用北京地域的百炼密钥。",
        "chat": [("qwen3.7-flash", True), ("qwen3.8-flash", True), ("qwen3.6-flash", True),
                 ("qwen3.5-flash", True), ("qwen-plus", False), ("qwen-vl-plus", True)],
        "embedding": ["qwen3.7-text-embedding-flash", "text-embedding-v4", "text-embedding-v3"],
        "image": ["qwen-image-plus", "qwen-image-max", "qwen-image"],
        "speech": "qwen3-asr-flash", "tts": "qwen3-tts-flash", "voice": "Cherry",
    },
}


class QuickSetupWrite(BaseModel):
    provider: Literal["siliconflow", "bailian"]
    api_key: str = Field(min_length=1, max_length=4096)


class QuickPresetRead(BaseModel):
    provider: Literal["siliconflow", "bailian"]
    label: str
    description: str
    key_url: str


class SetupItem(BaseModel):
    capability: str
    state: Literal["configured", "preserved", "unavailable"]
    model: str = ""
    message: str


class QuickSetupRead(BaseModel):
    settings: schemas.SettingsRead
    connection_id: str
    items: list[SetupItem]


@router.get("/settings/quick-setup", response_model=list[QuickPresetRead])
def presets():
    return [QuickPresetRead(provider=name, **{k: p[k] for k in ("label", "description", "key_url")})
            for name, p in PRESETS.items()]


def pick(names, available):
    return next((name for name in names if name in available), "")


def occupied(value, legacy_ref, settings):
    # Preserve partial/manual configuration and disabled-but-configured services too.
    return bool(value or service_credentials.key(value, legacy_ref, settings))


@router.post("/settings/quick-setup", response_model=QuickSetupRead)
async def configure(value: QuickSetupWrite):
    preset = PRESETS[value.provider]
    secret = value.api_key.strip()
    if not secret or any(char in secret for char in "\r\n\0"):
        raise HTTPException(400, "请粘贴完整的 API Key，不要包含换行。")
    connection_id = "conn_" + uuid4().hex[:16]
    try:
        catalog = await provider.discover_models(schemas.ProviderWrite(
            id=connection_id, provider_type=value.provider, label=preset["label"],
            model_url=preset["url"], api_key=secret))
    except provider.ConfigurationError as error:
        raise HTTPException(400, str(error)) from None
    available = {row["name"]: row for row in catalog}
    preferred = [(name, vision) for name, vision in preset["chat"] if name in available]
    if not preferred:
        raise HTTPException(400, "当前账户未返回推荐对话模型，请确认模型权限，或使用「手动添加连接」选择模型。")
    models = []
    # Include a visual alternative when the main model is text-only.
    for name, vision in preferred[:1] + ([] if preferred[0][1] else [p for p in preferred[1:] if p[1]][:1]):
        model = {"name": name, "vision_enabled": vision, "thinking_mode": "auto",
                 "default_thinking_enabled": False,
                 "context_tokens": min(available[name].get("context_tokens", 32768), 65536)}
        if value.provider == "siliconflow" and "deepseek" in name.lower():
            model.update(thinking_mode="reasoning_effort", reasoning_efforts=["high", "max"],
                         default_reasoning_effort="high")
        models.append(model)
    async with lock:
        with Session() as db:
            settings = db.get(Settings, config.PROFILE_ID)
            profiles = model_profiles.profiles(settings)
            label = preset["label"] + " · 快速配置"
            suffix = 2
            while any(p["label"] == label for p in profiles):
                label = preset["label"] + f" · 快速配置 {suffix}"
                suffix += 1
            profiles.append({"id": connection_id, "provider_type": value.provider, "label": label,
                             "model_url": preset["url"], "default_model": models[0]["name"], "models": models})
            previous = next((p for p in profiles[:-1] if p["id"] == settings.default_provider), None)
            keep_default = bool(previous and previous["default_model"] and
                                config.secret_get(model_profiles.secret_ref(previous["id"])))
            settings.model_providers = profiles
            if not keep_default:
                settings.default_provider = connection_id
                model_profiles.sync_default(settings)
            items = [SetupItem(capability="对话与图片理解" if models[0]["vision_enabled"] else "对话",
                               state="configured", model=models[0]["name"],
                               message="模型列表已读取，实际调用待使用时确认。"),
                     SetupItem(capability="默认模型", state="preserved" if keep_default else "configured",
                               model=previous["default_model"] if keep_default else models[0]["name"],
                               message="保留当前默认模型。" if keep_default else "已设为默认对话模型。")]
            binding = {"credential_connection_id": connection_id}
            for field, capability, names, legacy_ref in (
                ("embedding_config", "语义检索", preset["embedding"], "embedding"),
                ("image_generation_config", "图片生成", preset["image"], "image_generation"),
            ):
                saved = dict(getattr(settings, field) or {})
                # Bailian's compatible catalog may omit its native image and
                # embedding services; use the documented preset in that case.
                model = pick(names, available) or (names[0] if value.provider == "bailian" else "")
                if occupied(saved, legacy_ref, settings):
                    items.append(SetupItem(capability=capability, state="preserved", model=saved.get("model", ""),
                                           message="保留已有设置。"))
                elif not model:
                    items.append(SetupItem(capability=capability, state="unavailable", message="模型列表未返回推荐型号，可稍后单独配置。"))
                else:
                    configured = {**binding, "enabled": True, "url": preset["url"], "model": model}
                    if field == "image_generation_config":
                        configured.update(size=("auto" if value.provider == "bailian" else
                                                "1328x1328" if model == "Qwen/Qwen-Image" else "1024x1024"),
                                          response_format="auto")
                    setattr(settings, field, configured)
                    items.append(SetupItem(capability=capability, state="configured", model=model,
                                           message=("已配置共享密钥，实际调用待使用时确认。" if model in available else
                                                    "已填服务商推荐预设，实际调用待使用时确认。")))
            for field, capability, kind in (("speech_config", "语音输入", "speech"),
                                            ("tts_config", "语音朗读", "tts")):
                saved = deepcopy(getattr(settings, field) or {})
                selected = saved.get("selected", "siliconflow" if kind == "speech" else "bailian")
                current = saved.get("profiles", {}).get(selected, {})
                target = saved.get("profiles", {}).get(value.provider, {})
                if (occupied(current, ("speech:" if kind == "speech" else "tts:") + selected, settings)
                        or occupied(target, ("speech:" if kind == "speech" else "tts:") + value.provider, settings)):
                    items.append(SetupItem(capability=capability, state="preserved", model=current.get("model", ""),
                                           message="保留已有设置及所选服务商。"))
                    continue
                # Some catalogs omit audio models. These are explicit provider presets,
                # not a claim that an account has passed an audio generation test.
                profile = {**binding, "model": preset[kind], "url": preset["url"]}
                if kind == "tts":
                    from .tts import PRESETS as TTS_PRESETS
                    profile.update(url=next(p.url for p in TTS_PRESETS if p.provider == value.provider), voice=preset["voice"])
                saved.setdefault("profiles", {})[value.provider] = profile
                saved["selected"] = value.provider
                setattr(settings, field, saved)
                items.append(SetupItem(capability=capability, state="configured", model=preset[kind],
                                       message="已填服务商语音预设，实际调用待使用时确认。"))
            items.append(SetupItem(capability="联网搜索", state="preserved" if config.secret_get("search") else "unavailable",
                                   message="沿用现有搜索连接。" if config.secret_get("search") else "可在能力连接中单独配置搜索服务。"))
            ref = model_profiles.secret_ref(connection_id)
            try:
                config.secret_set(ref, secret)
                db.commit()
            except Exception:
                db.rollback()
                try:
                    config.secret_set(ref, "")
                except Exception:
                    pass
                raise HTTPException(503, "快速配置未完成，请检查系统凭据存储后重试。") from None
            from .main import settings_read
            return QuickSetupRead(settings=settings_read(db), connection_id=connection_id, items=items)
