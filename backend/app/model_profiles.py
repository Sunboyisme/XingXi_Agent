"""Non-secret provider presets and validated model selection."""

from copy import deepcopy
from urllib.parse import urlsplit

PRESETS = [
    (
        "bailian",
        "阿里云百炼",
        "https://dashscope.aliyuncs.com/compatible-mode/v1",
        ["qwen3.7-flash", "qwen-plus"],
    ),
    (
        "deepseek",
        "DeepSeek",
        "https://api.deepseek.com/v1",
        ["deepseek-flash", "deepseek-v4-pro"],
    ),
    ("kimi", "Kimi", "https://api.moonshot.cn/v1", ["kimi-k2.6"]),
    (
        "zhipu",
        "智谱",
        "https://open.bigmodel.cn/api/paas/v4",
        ["glm-4.7-flash", "glm-4.7"],
    ),
    (
        "siliconflow",
        "硅基流动",
        "https://api.siliconflow.cn/v1",
        ["deepseek-ai/DeepSeek-V4.1-Flash", "zai-org/GLM-5.3-Flash"],
    ),
    ("custom", "自定义兼容接口", "https://api.openai.com/v1", []),
]


def secret_ref(provider_id):
    # Existing credentials stay where they are; no migration to plaintext.
    return "model" if provider_id == "custom" else f"model:{provider_id}"


def thinking_control(url, model, provider_type=None):
    mode = model.get("thinking_mode", "auto")
    if mode != "auto":
        return mode
    host = urlsplit(url).hostname or ""
    name = model["name"].strip().lower()
    leaf = name.rsplit("/", 1)[-1]
    provider = provider_type or ""

    # Model families keep the same switch even when reached through an aggregator.
    if (
        leaf.startswith(("deepseek-r1", "deepseek-reasoner"))
        or leaf.endswith("-thinking")
        or "thinking" in leaf
    ):
        return "always"
    if leaf.startswith("deepseek-"):
        return "enable_thinking" if provider == "siliconflow" or host == "api.siliconflow.cn" else "thinking"
    if provider == "kimi" or host in {"api.moonshot.cn", "api.moonshot.ai"}:
        if leaf.startswith(("kimi-k3", "kimi-k2.7-code")):
            return "always"
        if leaf.startswith(("kimi-k2.5", "kimi-k2.6", "kimi-k2.7")):
            return "thinking"
    if provider == "zhipu" or host == "open.bigmodel.cn":
        if leaf.startswith("glm-5.3"):
            return "always"
        if leaf.startswith(("glm-4.5", "glm-4.6", "glm-4.7", "glm-5")):
            return "thinking"
    if (provider == "siliconflow" or host == "api.siliconflow.cn") and leaf.startswith("glm-5.3"):
        return "always"
    qwen_endpoint = (
        provider in {"bailian", "siliconflow"}
        or host.endswith("aliyuncs.com")
        or host == "api.siliconflow.cn"
    )
    if qwen_endpoint and "qwen" in leaf and "instruct" not in leaf:
        return "enable_thinking"
    return "none"


EFFORT_LEVELS = ("minimal", "low", "medium", "high", "xhigh", "max", "ultra")


def reasoning_capabilities(url, model):
    """Effort support belongs to the endpoint, not just the model's name."""
    levels = model.get("reasoning_efforts")
    default = model.get("default_reasoning_effort")
    if levels is None:
        host = urlsplit(url).hostname or ""
        name = model["name"].lower()
        if host == "api.deepseek.com" and name in {"deepseek-flash", "deepseek-v4-pro"}:
            levels, default = ["low", "high", "max"], default or "high"
        elif host == "api.siliconflow.cn" and name in {"deepseek-ai/deepseek-v4.1-flash", "deepseek-ai/deepseek-v4-flash"}:
            levels, default = ["high", "max"], default or "high"
        elif model.get("thinking_mode") == "reasoning_effort":
            levels, default = ["low", "medium", "high"], default or "high"
        else:
            levels = []
    levels = list(dict.fromkeys(level for level in levels if level in EFFORT_LEVELS))
    return {"reasoning_efforts": levels,
            "default_reasoning_effort": default if default in levels else None}


def profiles(settings):
    values = deepcopy(settings.model_providers or [])
    if (
        not any(x["id"] == "custom" for x in values)
        and settings.default_provider == "custom"
        and settings.model_name
    ):
        values.append(
            {
                "id": "custom",
                "provider_type": "custom",
                "label": "原有模型连接",
                "model_url": settings.model_url,
                "default_model": settings.model_name,
                "models": [
                    {
                        "name": settings.model_name,
                        "vision_enabled": settings.vision_enabled,
                        "thinking_mode": "auto",
                    }
                ],
            }
        )
    for value in values:
        preset = next(
            (x for x in PRESETS if x[0] == value.get("provider_type", value["id"])),
            PRESETS[-1],
        )
        value.setdefault("provider_type", preset[0])
        value["label"] = value.get("label") or preset[1]
        for model in value["models"]:
            model["thinking_control"] = thinking_control(
                value["model_url"], model, value["provider_type"]
            )
            model.update(reasoning_capabilities(value["model_url"], model))
            model["default_thinking_enabled"] = (
                model["thinking_control"] == "always"
                or (
                    model["thinking_control"] != "none"
                    and bool(model.get("default_thinking_enabled"))
                )
            )
    return values


def presets():
    return [
        {
            "id": id,
            "label": label,
            "model_url": url,
            "models": [
                {
                    "name": name,
                    "thinking_control": thinking_control(url, {"name": name}, id),
                    **reasoning_capabilities(url, {"name": name}),
                }
                for name in names
            ],
        }
        for id, label, url, names in PRESETS
    ]


def resolve(settings, selection=None):
    provider_id = selection.provider_id if selection else settings.default_provider
    profile = next((x for x in profiles(settings) if x["id"] == provider_id), None)
    name = (
        selection.model_name
        if selection
        else profile["default_model"]
        if profile
        else ""
    )
    model = (
        next((x for x in profile["models"] if x["name"] == name), None)
        if profile
        else None
    )
    if not model:
        raise ValueError("请先添加模型并选择默认模型。")
    enabled = (
        selection.thinking_enabled
        if selection and selection.thinking_enabled is not None
        else model.get("default_thinking_enabled", False)
    )
    if enabled and model["thinking_control"] == "none":
        raise ValueError("这个模型尚未配置思考开关，请到模型设置选择支持的参数。")
    effort = selection.reasoning_effort if selection else None
    if effort and effort not in model["reasoning_efforts"]:
        raise ValueError("这个模型不支持所选思考强度，请重新选择。")
    enabled = enabled or model["thinking_control"] == "always"
    return {
        "provider_id": provider_id,
        "model_url": profile["model_url"],
        "model_name": name,
        "vision_enabled": model["vision_enabled"],
        "thinking_control": model["thinking_control"],
        "thinking_enabled": enabled,
        "reasoning_effort": (effort or model["default_reasoning_effort"]) if enabled else None,
        "context_tokens": (selection.context_tokens if selection else None) or model.get("context_tokens", 500000),
        **chat_options(selection.model_dump() if selection else None),
    }


def chat_options(config):
    """Conversation options carried with a run: mode and which context to retrieve."""
    config = config or {}
    return {
        "mode": "chat" if config.get("mode") == "chat" else "agent",
        "use_memory": config.get("use_memory", True) is not False,
        "use_knowledge": config.get("use_knowledge", True) is not False,
    }


def saved_selection(config):
    """Rebuild a model selection from the config stored on a run or task."""
    if not config:
        return None
    from .schemas import ModelSelection

    return ModelSelection(
        provider_id=config["provider_id"],
        model_name=config["model_name"],
        thinking_enabled=bool(config.get("thinking_enabled")),
        reasoning_effort=config.get("reasoning_effort"),
        context_tokens=config.get("context_tokens"),
        **chat_options(config),
    )


def sync_default(settings):
    profile = next(
        (x for x in profiles(settings) if x["id"] == settings.default_provider), None
    )
    if not profile:
        settings.model_url = "https://api.openai.com/v1"
        settings.model_name = ""
        settings.vision_enabled = False
        return
    model = next(
        (x for x in profile["models"] if x["name"] == profile["default_model"]), None
    )
    settings.model_url = profile["model_url"]
    settings.model_name = profile["default_model"]
    settings.vision_enabled = bool(model and model["vision_enabled"])
