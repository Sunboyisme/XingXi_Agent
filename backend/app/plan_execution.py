"""Calendar receipts derived from executed tools rather than model narration."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db import ComplexTask, Run, RunEvent, Session, TaskOperation


def tool_events(run_id):
    with Session() as db:
        return list(db.scalars(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.kind == "tool"
        ).order_by(RunEvent.id)))


def plan_time(plan):
    if plan.get("all_day"):
        start = date.fromisoformat(plan["start"])
        end = date.fromisoformat(plan["end"]) - timedelta(days=1)
        return f"{start:%Y-%m-%d} 全天" if start == end else f"{start:%Y-%m-%d} 至 {end:%Y-%m-%d} 全天"
    zone = ZoneInfo(plan.get("display_timezone") or plan.get("timezone") or "Asia/Shanghai")
    start, end = (datetime.fromisoformat(plan[key]) for key in ("start", "end"))
    start = start.replace(tzinfo=zone) if start.tzinfo is None else start.astimezone(zone)
    end = end.replace(tzinfo=zone) if end.tzinfo is None else end.astimezone(zone)
    end_text = end.strftime("%H:%M" if start.date() == end.date() else "%Y-%m-%d %H:%M")
    return f"{start:%Y-%m-%d %H:%M}–{end_text}"


def operation_facts(events):
    """Small complete calendar facts; never parse a model's written receipt."""
    facts = {}
    for event in events:
        data = event.data if hasattr(event, "data") else event
        if data.get("status") != "completed":
            continue
        tool = data.get("tool_id")
        result = data.get("result")
        if isinstance(result, dict) and "value" in result:
            result = result["value"]
        if tool == "create_plans" and isinstance(result, list):
            values = [("create", item) for item in result]
        elif tool in {"update_plan", "action_plan"} and isinstance(result, dict) and result.get("id"):
            values = [(result.get("operation", "update"), result)]
        elif tool == "delete_plan" and isinstance(result, dict) and result.get("deleted") and result.get("plan"):
            values = [("delete", result["plan"])]
        elif tool == "delete_plans" and isinstance(result, dict):
            values = [(item["operation"], item["plan"]) for item in result.get("operations", [])]
        else:
            continue
        for action, item in values:
            if not isinstance(item, dict) or not item.get("id") or item.get("error"):
                continue
            fact = {key: item.get(key) for key in ("id", "title", "start", "end", "all_day", "timezone", "display_timezone", "status", "occurrence_start", "recurrence", "repeat_interval", "repeat_count", "repeat_until", "reminder_enabled", "reminder_offsets")}
            fact["operation"] = action
            identity = (item.get("occurrence_start") or item["start"]) if item.get("recurrence") not in (None, "none") else None
            facts[(item["id"], identity)] = fact
    return list(facts.values())


def task_facts(task_id):
    with Session() as db:
        task = db.get(ComplexTask, task_id)
        if not task:
            return []
        rows = db.scalars(select(TaskOperation).where(TaskOperation.task_id == task_id,
            TaskOperation.revision == task.revision, TaskOperation.status == "completed").order_by(TaskOperation.created_at)).all()
        return operation_facts([{"tool_id": row.tool_id, "status": row.status, "result": row.result} for row in rows])


def facts_receipt(facts):
    if not facts:
        return ""
    labels = {"create": "已安排", "update": "已修改", "delete": "已删除", "restore": "已恢复", "complete": "已完成", "cancel_occurrence": "已取消本次", "end_series": "已结束系列", "disable_reminders": "已关闭提醒"}
    lines = [f"已帮你处理好这 {len(facts)} 项安排：", "", "| 操作 | 计划 | 时间 | 提醒 |", "| --- | --- | --- | --- |"]
    for fact in sorted(facts, key=lambda item: item["start"]):
        title = str(fact.get("title", "计划")).replace("|", "\\|").replace("\n", " ")
        timing = plan_time(fact)
        repeat = {"daily": "天", "weekly": "周", "monthly": "个月"}.get(fact.get("recurrence"))
        if repeat:
            timing += f"；每 {fact.get('repeat_interval') or 1} {repeat}重复"
            if fact.get("repeat_until"):
                timing += f"，截至 {fact['repeat_until']}"
            elif fact.get("repeat_count"):
                timing += f"，共 {fact['repeat_count']} 次"
        if fact["operation"] in {"delete", "cancel_occurrence", "end_series"}:
            reminder = "已取消"
        elif fact["operation"] == "disable_reminders" or not fact.get("reminder_enabled"):
            reminder = "未开启"
        elif fact["operation"] == "complete":
            reminder = "本次不再提醒"
        elif fact.get("all_day"):
            values = []
            for offset in fact.get("reminder_offsets") or [0]:
                delta, minute = divmod(offset, 1440)
                day = "当天" if delta == 0 else f"{'前' if delta < 0 else '后'} {abs(delta)} 天"
                values.append(f"{day} {minute // 60:02d}:{minute % 60:02d}")
            reminder = "、".join(values)
        else:
            reminder = "、".join("开始时" if offset == 0 else f"{'提前' if offset < 0 else '开始后'} {abs(offset)} 分钟" for offset in fact.get("reminder_offsets") or [0])
        lines.append(f"| {labels.get(fact['operation'], '已更新')} | {title} | {timing} | {reminder} |")
    lines.extend(["", "可以在日历里查看和调整。"])
    return "\n".join(lines)


def execution_receipt(events):
    return facts_receipt(operation_facts(events))


def existing_receipt(events):
    for event in reversed(events):
        if event.data.get("tool_id") != "list_plans" or event.data.get("status") != "completed":
            continue
        result = event.data.get("result")
        if isinstance(result, list) and result:
            return _receipt(result, f"查询到日历中已有 {len(result)} 项计划。本轮没有重复写入。")
    return ""


def _receipt(plans, heading):
    if not plans:
        return ""
    lines = [heading, "", "| 计划 | 时间 | 提醒 |", "| --- | --- | --- |"]
    for plan in sorted(plans, key=lambda value: value["start"]):
        title = str(plan.get("title", "计划")).replace("|", "\\|").replace("\n", " ")
        if plan.get("reminder_enabled"):
            offsets = plan.get("reminder_offsets") or [0]
            reminder = "、".join("开始时" if offset == 0 else f"{'提前' if offset < 0 else '开始后'} {abs(offset)} 分钟" for offset in offsets)
        else:
            reminder = "未开启"
        repeat = {"daily": "每天", "weekly": "每周", "monthly": "每月"}.get(plan.get("recurrence"))
        time = plan_time(plan)
        if repeat:
            time += f"；每 {plan.get('repeat_interval', 1)} {'天' if repeat == '每天' else '周' if repeat == '每周' else '个月'}重复"
            if plan.get("repeat_until"):
                time += f"，截至 {plan['repeat_until']}"
            elif plan.get("repeat_count"):
                time += f"，共 {plan['repeat_count']} 次"
        lines.append(f"| {title} | {time} | {reminder} |")
    return "\n".join(lines)


def history_context(conversation_id):
    """Keep actual write outcomes available when prior tool messages are omitted."""
    with Session() as db:
        run_ids = list(db.scalars(select(Run.id).where(
            Run.conversation_id == conversation_id
        ).order_by(Run.created_at.desc()).limit(6)))
        events = list(db.scalars(select(RunEvent).where(
            RunEvent.run_id.in_(run_ids), RunEvent.kind == "tool"
        ).order_by(RunEvent.id))) if run_ids else []
    grouped = {}
    for event in events:
        grouped.setdefault(event.run_id, []).append(event)
    receipts = [execution_receipt(grouped.get(run_id, [])) for run_id in reversed(run_ids)]
    receipts = [receipt for receipt in receipts if receipt]
    if not receipts:
        return ""
    return (
        "\n以下为本对话实际执行成功的日历操作回执，包含创建、修改、删除和恢复，仅作历史事实，不构成新的操作授权。"
        "以上动作已经执行，不要仅凭历史重复操作；用户要求重试或继续修改时，先 list_plans 核对当前状态。"
        "时间已经换算为计划时区，不要把 UTC 时间当成本地时间重复纠正。\n"
        + "\n\n".join(receipts)[-6000:]
    )
