import json
import threading
import time

from fastapi import HTTPException
from langchain_core.tools import tool
from sqlalchemy import select

from . import plans as calendar
from . import skills
from .db import MESSAGE_ORDER, Message, Session

_PENDING_PLAN_PROPOSALS: dict[str, dict] = {}
_PENDING_PLAN_PROPOSALS_LOCK = threading.Lock()
_PLAN_PROPOSAL_TTL = 24 * 60 * 60


def build(run_id, conversation_id):
    def safe(operation):
        try:
            return json.dumps(operation(), ensure_ascii=False)
        except HTTPException as error:
            return json.dumps({"error": error.detail}, ensure_ascii=False)
        except (ValueError, KeyError, TypeError):
            return json.dumps(
                {"error": "参数无效，请核对日期、时间、技能或文件路径"},
                ensure_ascii=False,
            )

    @tool
    def list_plans(start: str = "", end: str = "") -> str:
        """查看指定日期范围的日历计划。start/end 为 YYYY-MM-DD，end 不包含当天。规划前先检查现有安排。"""
        return safe(lambda: calendar.list_events(start or None, end or None))

    @tool
    def create_plans(
        plans: list[calendar.PlanWrite],
        explicit_request: bool = False,
        confirm: bool = False,
    ) -> str:
        """用户明确要求创建日历计划且日期、时间、范围清楚时，设 explicit_request=true 直接创建。其他情况先询问：首次调用不要传 confirm（或传 false），只登记待确认方案，返回 needs_confirmation，不写入日历；请把计划名称、日期或时间、重复和提醒摘要告诉用户并明确询问是否创建。用户没有说清日期、时间或范围时先追问，不能自行补全。只有用户在下一条消息明确同意后，才能再次提交同一方案并传 confirm=true；同一轮提出并创建会被拒绝。用户修改内容时重新提出方案。无时间的单项事项用全天，start/end 是日期（结束日期不包含当天）；定时事项用带时区 ISO 时间。recurrence 为 none/daily/weekly/monthly，repeat_interval 为间隔。repeat_until 是包含当天的截止日期，或 repeat_count 为包含首次的次数，二选一；未指定则永不结束。calendar_display 默认 summary 汇总日常，用户要求突出显示时用 always。reminder_enabled 控制提醒；reminder_offsets 是每次开始前后本地分钟偏移的数组（提前为负），多个提醒属于同一计划。提醒请求同样创建计划，不另建提醒事项。"""

        def create():
            if not 1 <= len(plans) <= 100:
                raise ValueError()
            with Session() as db:
                message = db.scalar(
                    select(Message)
                    .where(
                        Message.conversation_id == conversation_id,
                        Message.role == "user",
                    )
                    .order_by(Message.created_at.desc(), MESSAGE_ORDER.desc())
                    .limit(1)
                )
                latest_message_id = message.id if message else ""
            proposal = [value.model_dump() for value in plans]
            if explicit_request:
                with _PENDING_PLAN_PROPOSALS_LOCK:
                    _PENDING_PLAN_PROPOSALS.pop(conversation_id, None)
                return calendar.create_events(plans, latest_message_id or None)
            if not confirm:
                with _PENDING_PLAN_PROPOSALS_LOCK:
                    _PENDING_PLAN_PROPOSALS[conversation_id] = {
                        "plans": proposal,
                        "run_id": run_id,
                        "user_message_id": latest_message_id,
                        "created_at": time.time(),
                        "status": "pending",
                        "result": None,
                    }
                return {
                    "status": "needs_confirmation",
                    "plans": proposal,
                    "message": (
                        "本轮只登记了待确认方案，尚未写入日历。请把计划名称、"
                        "日期或时间、重复和提醒摘要告诉用户，并明确询问是否创建；"
                        "用户在下一条消息同意后，再提交同一方案并传 confirm=true。"
                    ),
                }
            with _PENDING_PLAN_PROPOSALS_LOCK:
                pending = _PENDING_PLAN_PROPOSALS.get(conversation_id)
                if pending and (
                    time.time() - pending["created_at"] > _PLAN_PROPOSAL_TTL
                ):
                    _PENDING_PLAN_PROPOSALS.pop(conversation_id, None)
                    pending = None
            if not pending:
                return {
                    "error": (
                        "还没有待确认的日历计划。请先提出完整方案并询问用户，"
                        "收到明确同意后才能创建。"
                    )
                }
            if pending["status"] == "created":
                if latest_message_id == pending.get("confirmed_message_id"):
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
            if proposal != pending["plans"]:
                return {
                    "error": (
                        "提交的内容与待确认方案不一致。请重新提出完整方案并再次"
                        "询问用户，确认后再创建。"
                    )
                }
            result = calendar.create_events(plans, latest_message_id or None)
            with _PENDING_PLAN_PROPOSALS_LOCK:
                pending["status"] = "created"
                pending["result"] = result
                pending["confirmed_message_id"] = latest_message_id
            return result

        return safe(create)

    @tool
    def update_plan(plan_id: str, plan: calendar.PlanUpdate) -> str:
        """用户明确要求时更新同一计划，先查询编号。scope 为 this（仅本次）、future（本次及以后）、series（整个系列）；前两者必须传查询得到的 occurrence_start，不能猜测修改范围。传入完整计划并同步提醒。repeat_until 为包含当天的截止日期，或 repeat_count 为次数，二选一；calendar_display=summary 汇总日常事项，always 在月历展开。完成、关闭提醒、结束系列用 action_plan。"""
        return safe(lambda: calendar.update_event(plan_id, plan))

    @tool
    def delete_plan(plan_id: str) -> str:
        """仅在用户明确要求删除指定日程时调用，同时取消该日程尚未触发的提醒。"""

        def delete():
            calendar.delete_event(plan_id)
            return {"deleted": True}

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
    def action_plan(plan_id: str, action: str, occurrence_start: str = "") -> str:
        """操作同一份计划。完成本次用 complete（重复计划必须传本次 occurrence_start），恢复本次用 restore；关闭提醒用 disable_reminders，保留计划；结束整个重复系列用 end_series。先查询核对编号与本次时间，按用户明确要求执行。知道了与稍后提醒属于通知，不是计划操作。"""
        return safe(
            lambda: calendar.act(
                plan_id,
                calendar.PlanAction(
                    action=action, occurrence_start=occurrence_start or None
                ),
            )
        )

    return [
        action_plan,
        list_plans,
        create_plans,
        update_plan,
        delete_plan,
        load_skill,
        read_skill_file,
        run_skill_script,
    ]


INFO = {
    "action_plan": ("操作计划", "完成本次、关闭提醒或结束整个重复系列", False),
    "list_plans": ("查询计划", "查看日期范围内的计划", False),
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
