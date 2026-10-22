"""Validate calendar selections against user dates and real query results."""

import re
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException
from sqlalchemy import select

from . import plans, task_context
from .db import Run, RunEvent, Session


def check_date_words(text, target, today):
    """Validate explicit date components; never shift a day based on UTC text."""
    full = re.findall(r"(?<!\d)(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日|号)?(?!\d)", text)
    if full:
        if target not in {datetime(int(y), int(m), int(d)).date() for y, m, d in full}:
            raise ValueError("目标日期与用户原话不一致，请重新核对日期。")
        return
    month_days = re.findall(r"(?<!\d)(\d{1,2})月(\d{1,2})(?:日|号)?", text)
    if month_days:
        if (target.month, target.day) not in {(int(m), int(d)) for m, d in month_days}:
            raise ValueError("目标月日与用户原话不一致，请重新核对日期。")
        return
    days = re.findall(r"(?<!\d)(\d{1,2})[日号]", text)
    if days:
        if target.day not in {int(day) for day in days}:
            raise ValueError("目标日与用户原话不一致，请勿操作相邻日期的计划。")
        months = {int(month) for month in re.findall(r"(?<!\d)(\d{1,2})月", text)}
        years = {int(year) for year in re.findall(r"(?<!\d)(20\d{2})年", text)}
        if (months and target.month not in months) or (years and target.year not in years):
            raise ValueError("目标月份或年份与用户原话不一致。")
        return
    relative = {"今天": 0, "明天": 1, "后天": 2, "昨天": -1, "前天": -2}
    matched = {today + timedelta(days=offset) for word, offset in relative.items() if word in text}
    for prefix, day in re.findall(r"(本周|这周|下周|上周)([一二三四五六日天])", text):
        weekday = "一二三四五六日".index("日" if day == "天" else day)
        week = {"本周": 0, "这周": 0, "下周": 1, "上周": -1}[prefix]
        matched.add(today + timedelta(days=weekday - today.weekday() + week * 7))
    if matched and target not in matched:
        raise ValueError("目标日期与用户要求的相对日期不一致，请先核对日期。")


def validate(run_id, conversation_id, plan_id, target_date, occurrence_start="", date_evidence=""):
    if not target_date:
        raise ValueError("修改、删除或恢复前，请传入查询核对后的 target_date（用户时区 YYYY-MM-DD）。")
    target = datetime.strptime(target_date, "%Y-%m-%d").date()
    with Session() as db:
        zone = plans.user_timezone(db)
        message = task_context.user_message(db, run_id, conversation_id)
        if not message:
            raise ValueError("未找到本次操作的用户要求。")
        text = message.content
        point = datetime.fromisoformat(message.created_at).astimezone(ZoneInfo(zone)).date()
        # Even a quoted short fragment cannot bypass an explicit date in the
        # complete current user request.
        check_date_words(text, target, point)
        references = r"(?<!\d)(?:20\d{2}[-年/.]\d{1,2}[-月/.]\d{1,2}(?:日|号)?|\d{1,2}月\d{1,2}[日号]?|\d{1,2}[日号]|[本这上下]周[一二三四五六日天]|今天|明天|后天|昨天|前天)"
        multiple_dates = len(set(re.findall(references, text))) > 1
        if date_evidence:
            if date_evidence not in text:
                raise ValueError("date_evidence 必须逐字引用本次用户要求。")
            text = date_evidence
        # Multi-target instructions must supply the exact clause for this action.
        if multiple_dates and (not date_evidence or len(set(re.findall(references, date_evidence))) != 1):
            raise ValueError("本条要求包含多个日期，请用 date_evidence 只引用当前操作对应的一个日期片段。")
        check_date_words(text, target, point)
        run = db.get(Run, run_id)
        run_ids = [run_id]
        if run and run.task_id:
            run_ids = list(db.scalars(select(Run.id).where(Run.task_id == run.task_id)))
        queried = []
        for event in db.scalars(select(RunEvent).where(RunEvent.run_id.in_(run_ids), RunEvent.kind == "tool").order_by(RunEvent.id)):
            data = event.data
            if data.get("tool_id") == "list_plans" and data.get("status") == "completed":
                result = data.get("result")
                if isinstance(result, dict):
                    result = result.get("value", [])
                if isinstance(result, list):
                    queried.extend(value for value in result if isinstance(value, dict))
    candidates = plans.list_events(target_date, (target + timedelta(days=1)).isoformat(), zone, include_deleted=True)
    selected = next((value for value in candidates if value["id"] == plan_id and
                     (not occurrence_start or value["occurrence_start"] == plans.occurrence_key(occurrence_start))), None)
    if not selected:
        raise HTTPException(409, "所选计划不在用户指定的本地日期，未执行操作。请重新查询并核对编号与本次时间。")
    if selected["recurrence"] != "none" and not occurrence_start:
        raise ValueError("重复计划必须使用查询结果中的 occurrence_start 指定本次。")
    proof = next((value for value in reversed(queried) if value.get("id") == plan_id and
                  value.get("occurrence_start") == selected["occurrence_start"]), None)
    if not proof:
        raise ValueError("请先查询目标日期的实际计划，再使用查询结果的编号和 occurrence_start 操作；恢复时查询 include_deleted=true。")
    if any(proof.get(field) != selected.get(field) for field in plans.PlanWrite.model_fields):
        raise HTTPException(409, "计划在查询后已改变，未使用旧记录执行操作；请重新查询。")
    return selected


def require_scope(run_id, conversation_id, scope):
    if scope == "this":
        return
    with Session() as db:
        message = task_context.user_message(db, run_id, conversation_id)
        text = message.content if message else ""
    pattern = r"整个|全部|所有|(?:这个|该|结束).{0,3}系列|(?:停止|不再).{0,6}重复" if scope == "series" else r"以后|之后|后续|从.{0,20}开始"
    if not re.search(pattern, text):
        raise ValueError("用户尚未明确要求修改整个系列或后续范围；请仅操作本次，范围有歧义时先询问。")
