"""Model-facing task receipts. Never mutate the durable tool result."""

import json


# Explicit content reads already express a need for the selected original text.
DIRECT_READS = {"read_task_result", "read_context_record", "search_file", "read_file", "read_local_file", "load_skill", "read_skill_file"}
EXACT_FIELDS = {
    "id", "record_id", "file_id", "artifact_id", "url", "path", "name", "title",
    "status", "operation", "error", "category", "message", "warnings", "media_errors",
    "needs_confirmation", "needs_clarification", "not_executed", "retryable", "recoverable",
    "partial", "truncated", "next_offset", "next_start", "occurrence_start", "target_date",
    "local_start", "local_end", "start", "end", "timezone", "missing", "read",
    "coverage", "document_total_parts", "series_revision", "available_paths", "searched_parts",
}


def calendar_query(value):
    """Keep every calendar row, without repeating internal scheduling metadata."""
    if isinstance(value, dict) and any(key in value for key in ("error", "plans", "conflicts", "status")):
        return value
    rows = value.get("value") if isinstance(value, dict) else value
    if not isinstance(rows, list) or any(not isinstance(item, dict) or not
            {"id", "title", "start", "end", "all_day"} <= item.keys() for item in rows):
        return value
    fields = {"id", "title", "start", "end", "all_day", "timezone", "display_timezone",
              "local_start", "local_end", "local_weekday", "status", "occurrence_start", "series_revision", "calendar_display"}
    plans = []
    for row in rows:
        item = {key: part for key, part in row.items() if key in fields}
        if row.get("notes"):
            item["notes"] = row["notes"]
        if row.get("recurrence") not in (None, "none"):
            item.update({key: row[key] for key in ("recurrence", "repeat_interval", "repeat_until", "repeat_count",
                         "series_start", "series_end", "series_status", "series_all_day", "series_title") if key in row})
        if row.get("reminder_enabled"):
            item.update({key: row[key] for key in ("reminder_enabled", "reminder_offsets", "reminder_time", "reminder_at") if key in row})
        plans.append(item)
    extra = {key: part for key, part in value.items() if key != "value"} if isinstance(value, dict) else {}
    return {**extra, "plans": plans, "count": len(plans), "all_rows_included": True,
            "notice": "包含本次查询全部条目；未列重复规则表示不重复，未列提醒表示未开启提醒。"}


def receipt(value, record_id, *, status="completed", limit=4000):
    """Keep short results intact; describe omitted text with retrievable JSON paths."""
    if status == "completed" and (isinstance(value, list) and value or
            isinstance(value, dict) and isinstance(value.get("value"), list) and value["value"]):
        compact = calendar_query(value)
        if compact is not value:
            return compact
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
    if tool_id == "list_plans":
        return json.dumps(calendar_query(value), ensure_ascii=False)
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


def path_error(value, path):
    """Describe actual roots, not a preview wrapper's fictional /result path."""
    def escape(key):
        return str(key).replace("~", "~0").replace("/", "~1")
    if isinstance(value, dict):
        available = ["/" + escape(key) for key in list(value)[:30]]
    elif isinstance(value, list):
        available = [f"/{index}" for index in range(min(len(value), 10))]
    else:
        available = [""]
    return {"error": f"字段路径{path!r}不存在，请使用返回的真实路径；空path读取整条记录。",
            "available_paths": available, "not_executed": True, "recoverable": True,
            "hint": "摘录的result仅为展示包装，原记录根节点不一定有/result。"}
