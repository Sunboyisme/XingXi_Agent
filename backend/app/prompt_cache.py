"""Optional cache hints for the official OpenAI endpoint."""

import hashlib
import re
from urllib.parse import urlsplit

from . import agent_prompts


def prepare(payload, url, *, scope="chat"):
    # Compatible services can cache our stable prefix without accepting these
    # OpenAI-specific fields. Never infer API support from a model name alone.
    if urlsplit(url).hostname != "api.openai.com":
        return payload
    value = dict(payload)
    model = str(value.get("model", ""))
    extra = dict(value.get("extra_body") or {})
    digest = hashlib.sha256(f"xiaoxi:v1:{model}:{scope}".encode()).hexdigest()[:32]
    extra.setdefault("prompt_cache_key", "xiaoxi-" + digest)
    match = re.match(r"^gpt-(\d+)(?:\.(\d+))?(?:-|$)", model)
    if match and (int(match[1]), int(match[2] or 0)) >= (5, 6):
        messages = list(value.get("messages", []))
        for index, message in enumerate(messages):
            if message.get("role") not in {"system", "developer"} or not isinstance(
                message.get("content"), str
            ):
                continue
            content = message["content"]
            if not content:
                continue
            markers = (
                agent_prompts.CAPABILITY_MARKER,
                agent_prompts.RUNTIME_MARKER,
                agent_prompts.CLOCK_MARKER,
            )
            cuts = sorted(
                {
                    content.index(marker)
                    for marker in markers
                    if marker in content and content.index(marker) > 0
                }
            )
            points = [0, *cuts, len(content)]
            blocks = [
                {"type": "text", "text": content[start:end]}
                for start, end in zip(points, points[1:])
                if start < end
            ]
            blocks[0]["prompt_cache_breakpoint"] = {"mode": "explicit"}
            if len(blocks) > 2 and blocks[-1]["text"].startswith(
                agent_prompts.CLOCK_MARKER
            ):
                blocks[-2]["prompt_cache_breakpoint"] = {"mode": "explicit"}
            messages[index] = {**message, "content": blocks}
            break
        value["messages"] = messages
    value["extra_body"] = extra
    return value
