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
    if value.get("credential_reset_required") or reset_required(settings, legacy_ref):
        return ""
    return config.secret_get(legacy_ref)


def validate(value, settings=None):
    if value.get("credential_connection_id") and not connection(value, settings):
        raise HTTPException(400, "共享密钥的连接不存在或接口地址不匹配，请重新选择密钥来源，或使用独立密钥。")


def draft(value, legacy_ref, settings=None):
    """Validate the chosen source before resolving a saved or newly entered key."""
    validate(value, settings)
    supplied = value.get("api_key")
    if supplied is None and not value.get("credential_connection_id") and reset_required(settings, legacy_ref):
        return ""
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


def reset_required(settings, legacy_ref):
    if settings is None:
        with Session() as db:
            saved = db.get(Settings, config.PROFILE_ID)
            return bool(saved and reset_required(saved, legacy_ref))
    field = {"embedding": "embedding_config", "image_generation": "image_generation_config"}.get(legacy_ref)
    if field:
        return bool((getattr(settings, field) or {}).get("credential_reset_required"))
    kind, _, provider = legacy_ref.partition(":")
    field = {"speech": "speech_config", "tts": "tts_config"}.get(kind)
    return bool(field and ((getattr(settings, field) or {}).get("profiles", {}).get(provider) or {}).get("credential_reset_required"))


def preserve_reset(settings, legacy_ref, value):
    return {"credential_reset_required": bool(reset_required(settings, legacy_ref)
        and not value.get("credential_connection_id") and not (value.get("api_key") or "").strip())}


def detach(settings, connection_id):
    from copy import deepcopy
    affected = dependents(settings, connection_id)
    for field in ("embedding_config", "image_generation_config", "speech_config", "tts_config"):
        value = deepcopy(getattr(settings, field) or {})
        targets = list(value.get("profiles", {}).values()) if field in {"speech_config", "tts_config"} else [value]
        for target in targets:
            if target.get("credential_connection_id") == connection_id:
                target["credential_connection_id"] = None
                target["credential_reset_required"] = True
        setattr(settings, field, value)
    return affected
