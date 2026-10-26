"""Model-facing task receipts. Never mutate the durable tool result."""

import json


# Explicit content reads already express a need for the selected original text.
DIRECT_READS = {"read_task_result", "read_context_record", "read_file", "read_local_file", "load_skill", "read_skill_file"}
EXACT_FIELDS = {
    "id", "record_id", "file_id", "artifact_id", "url", "path", "name", "title",
    "status", "operation", "error", "category", "message", "warnings", "media_errors",
    "needs_confirmation", "needs_clarification", "not_executed", "retryable", "recoverable",
    "partial", "truncated", "next_offset", "next_start", "occurrence_start", "target_date",
    "local_start", "local_end", "start", "end", "timezone", "missing", "read",
}


def receipt(value, record_id, *, status="completed", limit=4000):
    """Keep short results intact; describe omitted text with retrievable JSON paths."""
    raw = json.dumps(value, ensure_ascii=False)
    if len(raw) <= limit:
        return value
    omitted = []
    remaining = limit

    def preview(item, path="", field=""):
        nonlocal remaining
        # Preserve execution facts and identifiers verbatim, even over budget.
        if field in EXACT_FIELDS or field.endswith("_id"):
            return item
        if isinstance(item, str):
            size = min(600, max(0, remaining))
            remaining -= min(len(item), size)
            if len(item) > size:
                omitted.append(path)
                return item[:size] + "…[摘录]"
            return item
        if isinstance(item, list):
            if len(item) > 5:
                omitted.append(path)
            return [preview(part, f"{path}/{index}") for index, part in enumerate(item[:5])]
        if isinstance(item, dict):
            return {key: preview(part, path + "/" + key.replace("~", "~0").replace("/", "~1"), key)
                    for key, part in item.items()}
        return item

    result = preview(value)
    if not omitted:
        return value
    compact = {
        "record_id": record_id, "execution_status": status, "result": result,
        "truncated": True, "total_chars": len(raw),
        "omitted_paths": omitted[:20], "omitted_path_count": len(omitted),
        "notice": "result仅为摘录，非完整原文。用read_task_result(record_id, path)读取所需字段；"
                  "path来自omitted_paths（JSON Pointer），空path读取整条原始记录，按next_offset续读。"
                  "字段、列表省略不表示没有更多结果；不得把摘录当完整证据。",
    }
    return compact if len(json.dumps(compact, ensure_ascii=False)) < len(raw) else value


def tool_response(value, record_id, tool_id, *, status="completed"):
    # Never shorten an actionable failure, confirmation, or explicit detail read.
    if status != "completed" or tool_id in DIRECT_READS:
        return json.dumps(value, ensure_ascii=False)
    return json.dumps(receipt(value, record_id, status=status), ensure_ascii=False)


def select_path(value, path):
    """Select a JSON Pointer without executing expressions or accessing attributes."""
    if not path:
        return value
    if not path.startswith("/"):
        raise ValueError("path须为空或以/开头的JSON Pointer")
    for part in path[1:].split("/"):
        key = part.replace("~1", "/").replace("~0", "~")
        if isinstance(value, dict) and key in value:
            value = value[key]
        elif isinstance(value, list) and key.isascii() and key.isdigit() and int(key) < len(value):
            value = value[int(key)]
        else:
            raise ValueError("记录中不存在该path，请核对目录或省略字段路径")
    return value
