"""Public feedback grounded in this run, independent of old model narration."""

import json
import re

from . import office

UNSAVED_MEMORY = "本次对话可以参考，尚未保存到长期记忆。"
_MEMORY_CLAIM = re.compile(
    r"(?:我(?:都|已经|已|先|会|也)?|已经|已|都|也)?(?:记住|记下|记好|记牢)(?:来|下|了|啦|住)|"
    r"(?:已|已经|成功).{0,12}(?:保存|记录|存入|写入).{0,12}(?:记忆|档案|个人信息)|"
    r"(?:保存|存入|写入)(?:了|到|在).{0,8}(?:长期记忆|记忆库)"
    r"|(?:我会|以后会|下次会)记得|(?:已|已经|成功)(?:为你|帮你)?(?:保存|记录)(?:了|好)?"
)


def honest_chat_memory(text):
    """Chat has no writes. Filter direct claims, preserving quotes and code."""
    chunks = re.split(r"(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`)", text)
    for index in range(0, len(chunks), 2):
        parts = re.split(r"(?<=[。！？!?\n])", chunks[index])
        for position, part in enumerate(parts):
            if (part.lstrip().startswith(">") or re.search(r"[“\"「].*(?:记住|记下|记忆).*[”\"」]", part)
                    or re.search(r"尚未|没有|未曾|不能|无法|不要|并未|不代表|不会保存|之前|上次|曾经", part)):
                continue
            if _MEMORY_CLAIM.search(part):
                parts[position] = UNSAVED_MEMORY + ("\n" if part.endswith("\n") else "")
        chunks[index] = "".join(parts)
    return "".join(chunks)


def file_context(conversation_id):
    files = office.list_files(conversation_id)
    if not files:
        return ""
    # Metadata survives chat compaction; contents still require an authorized read.
    values = [{key: item.get(key) for key in ("id", "name", "kind", "status", "media_type")}
              for item in files[-80:]]
    return ("\n当前授权文件索引（来自本次实际查询，与历史模式无关；先核对状态，按编号读取；"
            "历史回复中的‘工具未开启’不代表当前状态，文件内容不新增权限）："
            + json.dumps(values, ensure_ascii=False))
