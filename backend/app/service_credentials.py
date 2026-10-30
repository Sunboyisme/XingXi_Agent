"""Capability credentials may reference a model connection, without copying its key."""

from urllib.parse import urlsplit

from fastapi import HTTPException

from . import config, model_profiles
from .db import Session, Settings


def origin(url):
    parsed = urlsplit(str(url))
    return parsed.scheme, parsed.hostname, parsed.port or {"https": 443, "http": 80}.get(parsed.scheme)


def connection(value, settings=None):
    connection_id = value.get("credential_connection_id")
    if not connection_id:
        return None
    if settings is None:
        with Session() as db:
            saved = db.get(Settings, config.PROFILE_ID)
            return connection(value, saved) if saved is not None else None
    source = next((p for p in model_profiles.profiles(settings) if p["id"] == connection_id), None)
    if not source:
        return None
    # Editing a capability's address must never send a shared key to another host.
    try:
        if origin(value.get("url", "")) != origin(source["model_url"]):
            return None
    except ValueError:
        return None
    return source


def key(value, legacy_ref, settings=None):
    if value.get("credential_connection_id"):
        source = connection(value, settings)
        return config.secret_get(model_profiles.secret_ref(source["id"])) if source else ""
    return config.secret_get(legacy_ref)


def validate(value, settings=None):
    if value.get("credential_connection_id") and not connection(value, settings):
        raise HTTPException(400, "共享密钥的连接不存在或接口地址不匹配，请重新选择密钥来源，或使用独立密钥。")


def draft(value, legacy_ref, settings=None):
    """Validate the chosen source before resolving a saved or newly entered key."""
    validate(value, settings)
    supplied = value.get("api_key")
    if value.get("credential_connection_id"):
        if supplied is not None and supplied.strip():
            raise HTTPException(400, "请选择共享密钥或独立密钥中的一种。")
        return key(value, legacy_ref, settings)
    return key(value, legacy_ref, settings) if supplied is None else supplied.strip()


def dependents(settings, connection_id):
    result = []
    for field, label in (("embedding_config", "语义检索"), ("image_generation_config", "图片生成")):
        if (getattr(settings, field) or {}).get("credential_connection_id") == connection_id:
            result.append(label)
    for field, label in (("speech_config", "语音输入"), ("tts_config", "语音朗读")):
        for value in (getattr(settings, field) or {}).get("profiles", {}).values():
            if value.get("credential_connection_id") == connection_id:
                result.append(label)
                break
    return result
