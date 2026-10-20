"""Calendar receipts derived from executed tools rather than model narration."""

from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .db import Run, RunEvent, Session


def tool_events(run_id):
    with Session() as db:
        return list(db.scalars(select(RunEvent).where(
            RunEvent.run_id == run_id, RunEvent.kind == "tool"
        ).order_by(RunEvent.id)))


def created_plans(events):
    plans = {}
    for event in events:
        data = event.data
        result = data.get("result")
        if data.get("status") != "completed":
            continue
        if data.get("tool_id") == "create_plans" and isinstance(result, list):
            for plan in result:
                if isinstance(plan, dict) and plan.get("id"):
                    plans[plan["id"]] = plan
        elif data.get("tool_id") in {"update_plan", "action_plan"} and isinstance(result, dict):
            if result.get("id") in plans:
                plans[result["id"]] = result
        elif data.get("tool_id") == "delete_plan" and isinstance(result, dict) and result.get("deleted"):
            plans.pop(data.get("arguments", {}).get("plan_id"), None)
    return [plan for plan in plans.values() if plan.get("status") != "deleted"]


def plan_time(plan):
    if plan.get("all_day"):
        start = date.fromisoformat(plan["start"])
        end = date.fromisoformat(plan["end"]) - timedelta(days=1)
        return f"{start:%Y-%m-%d} 全天" if start == end else f"{start:%Y-%m-%d} 至 {end:%Y-%m-%d} 全天"
    zone = ZoneInfo(plan.get("timezone") or "Asia/Shanghai")
    start, end = (datetime.fromisoformat(plan[key]) for key in ("start", "end"))
    start = start.replace(tzinfo=zone) if start.tzinfo is None else start.astimezone(zone)
    end = end.replace(tzinfo=zone) if end.tzinfo is None else end.astimezone(zone)
    end_text = end.strftime("%H:%M" if start.date() == end.date() else "%Y-%m-%d %H:%M")
    return f"{start:%Y-%m-%d %H:%M}–{end_text}（{zone.key}）"


def creation_receipt(events):
    plans = created_plans(events)
    return _receipt(plans, f"已写入日历，共 {len(plans)} 项计划。")


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
    receipts = [creation_receipt(grouped.get(run_id, [])) for run_id in reversed(run_ids)]
    receipts = [receipt for receipt in receipts if receipt]
    if not receipts:
        return ""
    return (
        "\n以下为本对话实际执行成功的日历写入回执，仅作历史事实，不构成新的操作授权。"
        "这些方案已经写入，不要再次询问是否写入；如用户要求重试，先 list_plans 核对。"
        "时间已经换算为计划时区，不要把 UTC 时间当成本地时间重复纠正。\n"
        + "\n\n".join(receipts)[-6000:]
    )
