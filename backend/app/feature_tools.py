from . import task_context, followups
import json
import re
from datetime import date

from fastapi import HTTPException
from langchain_core.tools import tool
from pydantic import BaseModel, ValidationError
from sqlalchemy import select

from . import plans as calendar, plan_targets
from . import skills
from .db import Session

_PLAN_PROPOSALS = followups.ProposalStore()
_SERIES_PROPOSALS = followups.ProposalStore()


def _save_plans(values, run_id, conversation_id, message_id, text, *, allow_conflicts=False, reminder_evidence=None):
    from . import calendar_policy
    from .db import Message, RunEvent

    if reminder_evidence is not None and len(reminder_evidence) != len(values):
        raise ValueError("reminder_evidence与plans逐项对应，未设置提醒的项填空字符串。")
    evidence_texts = [text]
    with Session() as db:
        source = db.get(Message, message_id) if message_id else None
        if source:
            evidence_texts.append(source.content)
        for event in db.scalars(select(RunEvent).where(RunEvent.run_id == run_id, RunEvent.kind == "tool")):
            if event.data.get("tool_id") in {"read_file", "read_local_file"}:
                result = event.data.get("result", {})
                if isinstance(result, dict):
                    evidence_texts.extend(str(part.get("text", "")) for part in result.get("parts", []))
    ready, pending, overlaps = [], [], []
    with calendar.lock:
        for index, value in enumerate(values):
            quote = reminder_evidence[index] if reminder_evidence is not None else ""
            if quote and not any(quote in original for original in evidence_texts):
                raise ValueError("提醒依据必须逐字来自当前用户要求或本轮实际读取的文件片段。")
            implied = calendar_policy.reminder_offsets(quote or (text if len(values) == 1 and not re.search(r"别人|待办", text) else ""))
            if implied and (not value.reminder_enabled or sorted(value.reminder_offsets or []) != implied):
                raise ValueError(f"提醒与原文不符，reminder_offsets应为{implied}，请修正后提交；未写入。")
            start, end = calendar_policy.date_window(value)
            existing = calendar.list_events(start, end, value.timezone)
            conflicts = [] if allow_conflicts else calendar_policy.conflicts(value, existing)
            if conflicts:
                pending.append(value.model_dump())
                overlaps.extend(conflicts)
            else:
                ready.append(value)
        saved = calendar.create_events(ready, message_id or None) if ready else []
    if pending:
        _PLAN_PROPOSALS.put(conversation_id, {"plans": pending, "run_id": run_id,
            "user_message_id": message_id, "status": "pending", "result": None, "conflict": True})
        return {"value": saved, "status": "needs_confirmation", "plans": pending,
                "conflicts": list({(item["id"], item["occurrence_start"]): item for item in overlaps}.values()),
                "message": f"已保存{len(saved)}项无冲突安排。其余安排与已有日程重叠，请确认仍要安排还是调整时间。"}
    _PLAN_PROPOSALS.pop(conversation_id)
    return saved


class RemovalTarget(BaseModel):
    plan_id: str
    occurrence_start: str = ""


class ExistingPlanCheck(BaseModel):
    plan_id: str
    expected: calendar.PlanWrite
    occurrence_start: str = ""


def _plan_signature(value: dict) -> tuple:
    return (
        " ".join(str(value.get("title", "")).split()),
        value.get("start"),
        value.get("end"),
        bool(value.get("all_day")),
        value.get("recurrence", "none"),
        int(value.get("repeat_interval") or 1),
        value.get("repeat_until"),
        value.get("repeat_count"),
        bool(value.get("reminder_enabled")),
        tuple(value.get("reminder_offsets") or []),
    )


def _short_confirmation(text: str) -> bool:
    return followups.is_confirmation(text)


def _confirmed_plans(proposal, pending, latest_text):
    """Use the plan the user actually saw when they reply “确定”.

    Models often re-send a proposal with different defaults (for example an
    omitted ``reminder_offsets``). Byte-identical JSON made a plain
    confirmation fail with a generic tool error.
    """
    if proposal == pending:
        return proposal
    if (
        len(proposal) == len(pending)
        and _short_confirmation(latest_text)
        and all(
            " ".join(str(a.get("title", "")).split())
            == " ".join(str(b.get("title", "")).split())
            for a, b in zip(proposal, pending)
        )
    ):
        return pending
    if len(proposal) == len(pending) and all(
        _plan_signature(a) == _plan_signature(b) for a, b in zip(proposal, pending)
    ):
        return proposal
    return None


def build(run_id, conversation_id):
    def safe(operation):
        try:
            return json.dumps(operation(), ensure_ascii=False)
        except HTTPException as error:
            return json.dumps({"error": error.detail, "category": "conflict" if error.status_code == 409 else "invalid_arguments", "not_executed": error.status_code < 500, "retryable": False}, ensure_ascii=False)
        except ValidationError as error:
            detail = "；".join(
                str(item.get("msg", "")).replace("Value error, ", "")
                for item in error.errors()[:3]
            )
            return json.dumps(
                {"error": f"计划参数格式不正确：{detail or '请检查日期与时间'}", "category": "invalid_arguments", "not_executed": True, "retryable": False},
                ensure_ascii=False,
            )
        except (ValueError, KeyError, TypeError) as error:
            return json.dumps(
                {"error": str(error)[:400] or "参数无效，请核对日期、时间、技能或文件路径", "category": "invalid_arguments", "not_executed": True, "retryable": False},
                ensure_ascii=False,
            )

    @tool
    def list_plans(start: date | None = None, end: date | None = None, timezone: str = "", include_deleted: bool = False) -> str:
        """查询实际计划。start/end 为用户本地 YYYY-MM-DD，end 不包含当天；timezone 留空使用用户时区。local_start/local_end 是本地时间，start/end 可能为UTC，不能截取UTC日期。修改前查询目标日，使用真实编号与 occurrence_start；恢复已删除计划时 include_deleted=true。"""
        return safe(lambda: calendar.list_events(start.isoformat() if start else None, end.isoformat() if end else None, timezone or None, include_deleted))

    @tool
    def check_existing_plans(checks: list[ExistingPlanCheck]) -> str:
        """核验用户所需安排已经存在，不创建或修改。先list_plans取得真实编号，逐项传plan_id和expected（本次所需的完整计划字段）；重复计划传原样occurrence_start。1–100项。只有全部字段与当前记录一致才返回verified；名称、时间、提醒或重复不一致时先说明差异，不用相似标题代替核验。已存在的安排用本工具提供完成证据，不为满足创建步骤重复写入。"""
        def verify():
            if not 1 <= len(checks) <= 100:
                raise ValueError("请核验1–100项已有安排。")
            keys = [(item.plan_id, item.occurrence_start) for item in checks]
            if len(set(keys)) != len(keys):
                raise ValueError("同一计划实例不能重复计入核验结果。")
            verified = []
            with calendar.lock, Session() as db:
                for item in checks:
                    row = calendar.find(db, item.plan_id)
                    actual = (calendar.read_occurrence(db, row, item.occurrence_start)
                              if item.occurrence_start else calendar.serialize(db, row))
                    expected = item.expected.model_dump()
                    differences = [key for key, value in expected.items() if actual.get(key) != value]
                    if differences or actual.get("status") not in {"planned", "completed"}:
                        return {"status": "mismatch", "not_executed": True,
                                "error": "已有安排与所需内容不一致，请核对差异，未写入。",
                                "plan_id": item.plan_id, "different_fields": differences,
                                "expected": expected, "actual": actual}
                    verified.append(actual)
            return {"status": "verified", "value": verified, "created": 0,
                    "message": f"已核验{len(verified)}项安排均已存在，未重复创建。"}
        return safe(verify)

    @tool
    def delete_plans(target_date: date, targets: list[RemovalTarget], date_evidence: str = "") -> str:
        """批量移除用户指定本地日期的实际计划。先list_plans(start=目标日,end=次日)，targets逐项使用真实plan_id及原样occurrence_start。普通计划删除，重复计划仅取消本次，不结束系列。1–100项，全部核对通过才一起写入。"""
        def remove():
            from .db import Run, RunEvent, PlanOccurrence, now
            if not 1 <= len(targets) <= 100:
                raise ValueError("请选择1–100项实际计划")
            identities = [(target.plan_id, target.occurrence_start) for target in targets]
            if len(set(identities)) != len(identities):
                raise ValueError("批量移除不能包含重复的计划实例")
            day = target_date.isoformat()
            with calendar.lock:
                with Session() as db:
                    source = task_context.user_message(db, run_id, conversation_id)
                    previous_runs = select(Run.id).where(Run.source_message_id == source.id, Run.conversation_id == conversation_id)
                    for event in db.scalars(select(RunEvent).where(RunEvent.run_id.in_(previous_runs), RunEvent.kind == "tool")):
                        args = event.data.get("arguments", {})
                        if event.data.get("tool_id") == "delete_plans" and event.data.get("status") == "completed" and args.get("target_date") == day and args.get("targets") == [target.model_dump() for target in targets]:
                            from .complex_tasks import calendar_result_current
                            if not calendar_result_current("delete_plans", event.data["result"]):
                                raise HTTPException(409, "此前移除的计划后来已有变化，请核对当前日历并提出新的调整要求；未重复写入")
                            return event.data["result"]
                selected = [plan_targets.validate(run_id, conversation_id, target.plan_id, day, target.occurrence_start, date_evidence) for target in targets]
                with Session() as db:
                    result = []
                    for before in selected:
                        row = calendar.find(db, before["id"])
                        if before["recurrence"] == "none":
                            row.status = "deleted"
                            for rule in calendar.rules(db, row.id):
                                rule.status = "cancelled"
                            calendar.cancel_notes(db, row.id)
                            result.append({"operation": "delete", "plan": before})
                        else:
                            if before["status"] not in {"planned", "cancelled"} or row.status != "planned":
                                raise HTTPException(409, "只能取消尚未完成的重复安排，本批次未写入")
                            key = before["occurrence_start"]
                            record = db.get(PlanOccurrence, (row.id, key))
                            if record is None:
                                db.add(PlanOccurrence(plan_id=row.id, start=key, status="cancelled"))
                            else:
                                record.status, record.completed_at = "cancelled", now()
                            calendar.cancel_notes(db, row.id, key)
                            db.flush()
                            calendar.sync_rules(db, row, row.reminder_offsets)
                            result.append({"operation": "cancel_occurrence", "plan": before})
                    db.commit()
                return {"removed": len(result), "operations": result, "target_date": day}
        return safe(remove)

    @tool
    def create_plans(
        plans: list[calendar.PlanWrite],
        explicit_request: bool = False,
        confirm: bool = False,
        reminder_evidence: list[str] | None = None,
    ) -> str:
        """创建用户授权的日历计划。明确安排、提醒、记一下事项，信息齐全直接执行；只讨论或先给方案则登记待确认，下一轮同意才confirm=true。无具体时刻用全天；上午/晚上等模糊时段先询问该项，其余明确项先提交。
        start/end为日期或ISO时间，无偏移按timezone解释；全天end不含当天。recurrence为none/daily/weekly/monthly，年度可monthly+repeat_interval=12。repeat_until含当天，repeat_count含首次，二者互斥。多个提醒在同一计划reminder_offsets，提前为负；提前一天=-1440。
        提醒依据reminder_evidence可逐项传当前用户或本轮已读取文件中的原文，工具校验偏移一致；不要把参数混进title。创建前查询，冲突项等待确认而不阻塞独立项；同一请求不要改标题再建一次。"""

        def create():
            if not 1 <= len(plans) <= 100:
                raise ValueError()
            with Session() as db:
                message = task_context.user_message(db, run_id, conversation_id)
                latest_message_id = message.id if message else ""
                latest_text = (
                    " ".join((message.content or "").split()) if message else ""
                )
            proposal = [value.model_dump() for value in plans]
            # A model may set both flags on an already authorized request.
            # Explicit authorization must not depend on a pending proposal.
            from .calendar_policy import creation_authorized
            pending = _PLAN_PROPOSALS.get(conversation_id)
            confirmed_reply = followups.is_confirmation(latest_text)
            with Session() as db:
                choice = followups.choice_context(db, task_context.user_message(db, run_id, conversation_id))
            chosen_option = bool(choice and not choice.get("error"))
            if pending and confirmed_reply:
                wants_confirmation = True
            else:
                wants_confirmation = confirm
            option_authorized = chosen_option and creation_authorized("\n".join(item["content"] for item in choice["selected"]))
            direct = (creation_authorized(latest_text) or option_authorized) and not (pending and confirmed_reply)
            if chosen_option:
                latest_text = latest_text + "\n已选择此前明确展示的选项：" + "\n".join(item["content"] for item in choice["selected"])
            if confirmed_reply and not pending:
                with Session() as db:
                    source = task_context.user_message(db, run_id, conversation_id)
                    direct = bool(followups.prior_context(db, source))
            if direct:
                return _save_plans(plans, run_id, conversation_id, latest_message_id, latest_text,
                                   reminder_evidence=reminder_evidence)
            if not wants_confirmation:
                _PLAN_PROPOSALS.put(conversation_id, {
                    "plans": proposal,
                    "run_id": run_id,
                    "user_message_id": latest_message_id,
                    "status": "pending",
                    "result": None,
                })
                return {
                    "status": "needs_confirmation",
                    "plans": proposal,
                    "message": (
                        "安排已整理为待确认方案，尚未写入日历。请确认名称、日期、重复和提醒后再创建。"
                    ),
                }
            pending = _PLAN_PROPOSALS.get(conversation_id)
            if not pending:
                return {
                    "error": (
                        "还没有待确认的日历计划。请先提出完整方案并询问用户，"
                        "收到明确同意后才能创建。"
                    )
                }
            if pending["status"] == "created":
                if latest_message_id == pending.get("confirmed_message_id") or _confirmed_plans(
                    proposal, pending["plans"], latest_text
                ) is not None:
                    return pending["result"]
                return {
                    "error": (
                        "上一份方案已经创建。如需新的计划，请重新提出完整方案"
                        "并询问用户，确认后再创建。"
                    )
                }
            if pending["run_id"] == run_id:
                return {
                    "error": (
                        "方案刚在本轮提出，还没有询问并获得用户确认。不要创建，"
                        "请先询问用户；下一轮用户明确同意后再提交。"
                    )
                }
            if (
                not latest_message_id
                or latest_message_id == pending["user_message_id"]
            ):
                return {
                    "error": (
                        "还没有收到用户的新回复。请先询问用户是否创建，收到明确"
                        "同意后才能创建。"
                    )
                }
            chosen = _confirmed_plans(proposal, pending["plans"], latest_text)
            if chosen is None:
                return {
                    "status": "needs_confirmation",
                    "plans": pending["plans"],
                    "message": (
                        "提交的内容与用户刚看到的方案不一致，本轮没有写入。请把"
                        "待确认方案重新完整告诉用户，并再次询问是否按这个方案创建。"
                    ),
                }
            if re.search(r"不要|不用|不同意|取消|不按|先不", latest_text) or (not confirmed_reply and not re.match(r"^(?:确认|确定|同意|就按|按这个)", latest_text)):
                return {"status": "needs_confirmation", "plans": pending["plans"], "message": "尚未收到对这份具体方案的确认，未写入日历。"}
            result = _save_plans([calendar.PlanWrite(**value) for value in chosen], run_id,
                                conversation_id, latest_message_id, latest_text,
                                allow_conflicts=bool(pending.get("conflict")))
            _PLAN_PROPOSALS.put(conversation_id, pending)
            pending = _PLAN_PROPOSALS.get(conversation_id)
            with _PLAN_PROPOSALS.lock:
                pending["status"] = "created"
                pending["result"] = result
                pending["confirmed_message_id"] = latest_message_id
            return result

        return safe(create)

    @tool
    def update_plan(plan_id: str, plan: calendar.PlanUpdate, target_date: date | None = None, date_evidence: str = "") -> str:
        """用户明确要求时更新同一计划，先查询编号。scope 为 this（仅本次）、future（本次及以后）、series（整个系列）；前两者必须传查询得到的 occurrence_start，不能猜测修改范围。传入完整计划并同步提醒。repeat_until 为包含当天的截止日期，或 repeat_count 为次数，二选一；calendar_display=summary 汇总日常事项，always 在月历展开。完成、关闭提醒、结束系列用 action_plan。"""
        def update():
            with calendar.lock:
                with Session() as db:
                    repeating = calendar.find(db, plan_id).recurrence != "none"
                if plan.scope == "series" and repeating:
                    before = plan_targets.validate_series(run_id, conversation_id, plan_id, date_evidence)
                else:
                    before = plan_targets.validate(run_id, conversation_id, plan_id, target_date, plan.occurrence_start or "", date_evidence)
                if before["series_status"] == "deleted":
                    raise ValueError("计划已经删除，请先按用户要求恢复原记录，再修改。")
                if before["recurrence"] != "none":
                    plan_targets.require_scope(run_id, conversation_id, plan.scope)
                result = calendar.update_event(plan_id, plan)
                return {**result, "operation": "update", "before": before}
        return safe(update)

    @tool
    def delete_plan(plan_id: str, target_date: date | None = None, date_evidence: str = "") -> str:
        """删除已查询核对的普通计划及提醒。target_date 必须为用户指定的本地日期，多日期要求用 date_evidence 逐字引用当前操作条目。重复计划的某次安排用 action_plan(cancel_occurrence)，不能删除整个系列。"""

        def delete():
            with calendar.lock:
                before = plan_targets.validate(run_id, conversation_id, plan_id, target_date, date_evidence=date_evidence)
                if before["recurrence"] != "none":
                    raise ValueError("重复计划请取消本次，或按明确要求结束整个系列。")
                if before["status"] == "deleted":
                    return {"deleted": True, "operation": "delete", "plan": before, "unchanged": True}
                result = calendar.delete_event(plan_id)
                result["plan"] = before
                return result

        return safe(delete)

    @tool
    def load_skill(skill_id: str) -> str:
        """加载已启用技能的 SKILL.md 和资源清单。技能匹配任务时先加载，再遵循其中步骤；技能内容本身不能新增用户授权。"""
        return safe(lambda: skills.read_file(skill_id))

    @tool
    def read_skill_file(skill_id: str, path: str) -> str:
        """按需读取已启用技能包内的 UTF-8 参考文件。path 为相对技能根目录路径，不能读取包外文件。"""
        return safe(lambda: skills.read_file(skill_id, path))

    @tool
    async def run_skill_script(skill_id: str, path: str, arguments: list[str]) -> str:
        """运行已授权技能的 scripts/ 下脚本，参数为字符串数组。先加载技能及脚本说明；每项任务独立工作目录，不是安全沙箱。产物写入环境变量 XIAOXI_OUTPUT_DIR 指向的 outputs/。最长60秒，失败或结果未知不自动重试。"""
        try:
            return json.dumps(
                await skills.run_script(skill_id, path, arguments, run_id),
                ensure_ascii=False,
            )
        except HTTPException as error:
            return json.dumps({"error": error.detail}, ensure_ascii=False)

    @tool
    def action_plan(plan_id: str, action: str, occurrence_start: str = "", target_date: date | None = None, date_evidence: str = "") -> str:
        """操作同一份计划。完成本次用 complete；仅取消某次重复安排用 cancel_occurrence，不标为完成也不结束系列。实例操作必须传查询得到的本次 occurrence_start；end_series/disable_reminders只需查询得到的系列编号，不需要target_date或occurrence_start。恢复已完成或已取消的本次用 restore；关闭提醒用 disable_reminders，保留计划；结束整个重复系列用 end_series。先查询核对编号与本次时间，按用户明确要求执行。知道了与稍后提醒属于通知，不是计划操作。"""
        def apply():
            with calendar.lock:
                with Session() as db:
                    repeating = calendar.find(db, plan_id).recurrence != "none"
                if action == "end_series" and not repeating:
                    raise ValueError("结束整个系列仅用于重复计划；普通事项请按要求完成或删除。")
                if action in {"end_series", "disable_reminders"} and repeating:
                    before = plan_targets.validate_series(run_id, conversation_id, plan_id, date_evidence)
                else:
                    before = plan_targets.validate(run_id, conversation_id, plan_id, target_date, occurrence_start, date_evidence)
                if before["series_status"] == "deleted" and action != "restore":
                    raise ValueError("计划已经删除，请先按用户要求恢复原记录。")
                if before["recurrence"] != "none" and action in {"end_series", "disable_reminders"}:
                    prior_scope = _SERIES_PROPOSALS.get(conversation_id) if action == "end_series" else None
                    with Session() as db:
                        source = task_context.user_message(db, run_id, conversation_id)
                    if not (prior_scope and prior_scope["plan_id"] == plan_id and
                            prior_scope["user_message_id"] != source.id and followups.is_confirmation(source.content)):
                        plan_targets.require_scope(run_id, conversation_id, "series")
                if action == "end_series":
                    with Session() as db:
                        source = task_context.user_message(db, run_id, conversation_id)
                    pending = _SERIES_PROPOSALS.get(conversation_id)
                    accepted = bool(re.match(r"^(?:确认|确定|同意)", source.content.strip())) or bool(pending and
                        pending["plan_id"] == plan_id and pending["user_message_id"] != source.id and
                        followups.is_confirmation(source.content))
                    if not accepted:
                        _SERIES_PROPOSALS.put(conversation_id, {"plan_id": plan_id, "user_message_id": source.id})
                        return {"status": "needs_confirmation", "plan": before,
                                "message": f"请确认结束整个‘{before['title']}’系列；后续不再安排，已有完成记录保留。"}
                    _SERIES_PROPOSALS.pop(conversation_id)
                result = calendar.act(plan_id, calendar.PlanAction(action=action, occurrence_start=occurrence_start or None))
                return {**result, "operation": action, "before": before}
        return safe(apply)

    return [
        action_plan,
        list_plans,
        check_existing_plans,
        create_plans,
        update_plan,
        delete_plan,
        delete_plans,
        load_skill,
        read_skill_file,
        run_skill_script,
    ]


INFO = {
    "delete_plans": ("批量移除当天计划", "核对后删除普通计划、取消重复事项本次，保留其他日期", False),
    "action_plan": ("操作计划", "完成、取消或恢复本次，关闭提醒或结束整个系列", False),
    "list_plans": ("查询计划", "查看日期范围内的计划", False),
    "check_existing_plans": ("核验已有计划", "逐项核对已有安排，避免重复创建", False),
    "create_plans": (
        "安排计划",
        "用户明确要求时直接创建，否则先提出计划摘要并询问确认",
        False,
    ),
    "update_plan": ("修改计划", "修改时间、内容或完成状态并同步提醒", False),
    "delete_plan": ("删除计划", "按你的要求删除指定计划", False),
    "load_skill": ("加载技能", "按任务加载已启用的技能说明", False),
    "read_skill_file": ("读取技能资料", "按需查看技能包内参考文件", False),
    "run_skill_script": ("运行技能脚本", "运行已经单独授权的技能脚本", False),
}
