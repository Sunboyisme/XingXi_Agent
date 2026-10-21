"""Long-term memory write policy. Candidate records never enter model background."""

from . import task_context

import re
from threading import RLock

from pydantic import BaseModel, Field
from sqlalchemy import select

from .config import PROFILE_ID
from .db import (
    MESSAGE_ORDER,
    Conversation,
    Memory,
    MemoryChange,
    Message,
    Session,
    Settings,
)

lock = RLock()
FIELDS = (
    "content",
    "category",
    "source",
    "state",
    "evidence",
    "review_reason",
    "source_conversation_id",
    "source_message_id",
    "replaces_id",
    "replaces_revision",
)
EXPLICIT = re.compile(
    r"记住|记下|记着|保存.{0,8}(偏好|记忆|信息)|remember\b", re.IGNORECASE
)
DECLINED = re.compile(
    r"(?:不要|别|不用|不必|无需|不想|禁止).{0,8}(?:记住|记下|保存|记录)|(?:do not|don't)\s+(?:remember|save)",
    re.IGNORECASE,
)
TEMPORARY = re.compile(
    r"今天|这次|这会儿|此刻|暂时|仅本次|只在本次|today|this time|temporar",
    re.IGNORECASE,
)
PREFERENCE = re.compile(
    r"我.{0,20}(?:喜欢|偏好|习惯|坚持|希望|倾向|更想)"
    r"|我(?:每天|每周|平时|通常|一般).{0,20}(?:学习|读书|阅读|运动|跑步|健身|早起|写日记)"
    r"|(?:回答|回复|解释|界面|设计).{0,8}(?:简短|简洁|详细|圆角|扁平)"
    r"|\bI (?:prefer|like|always)\b",
    re.IGNORECASE,
)
SENSITIVE = re.compile(
    r"诊断|病史|疾病|抑郁|焦虑症|糖尿病|高血压|过敏|服药|药物|怀孕|健康状况|工资|薪资|收入|存款|负债|债务|银行卡|身份证|家庭住址|性取向|宗教信仰|政治立场|medical|diagnos|salary|income|debt",
    re.IGNORECASE,
)
SECRET = re.compile(
    r"(?:api[-_ ]?key|密钥|密码|password|access[-_ ]?token)\s*(?:是|为|[:：=])|\bsk-[A-Za-z0-9_-]{12,}",
    re.IGNORECASE,
)


class MemoryConflict(ValueError):
    pass


class SourceQuote(BaseModel):
    message_id: str = Field(min_length=1, max_length=64)
    quote: str = Field(min_length=1, max_length=6000)


def history_evidence(db, message, sources):
    """Keep current authorization separate from verified, earlier user facts."""
    if not 1 <= len(sources) <= 12:
        raise ValueError("每条记忆请提供 1–12 段历史用户原文。")
    boundary = db.scalar(select(MESSAGE_ORDER).select_from(Message).where(Message.id == message.id))
    references = []
    for source in sources:
        value = SourceQuote.model_validate(source)
        record = db.scalar(select(Message).where(
            Message.id == value.message_id, Message.profile_id == PROFILE_ID,
            Message.conversation_id == message.conversation_id, Message.role == "user",
            MESSAGE_ORDER <= boundary,
        ))
        quote = value.quote.strip()
        if not record or not quote or quote not in record.content:
            raise ValueError("历史依据必须逐字引用本轮之前、当前会话中的真实用户消息；请先检索原始消息并核对编号。")
        references.append(f"用户消息 {record.id}：\n{quote}")
    result = "\n\n".join(references)
    if len(result) > 12000:
        raise ValueError("历史依据过长，请只引用与当前记忆相关的片段。")
    return result


def preference_clause(message: str) -> str:
    """A conservative fallback for clear, stable preferences stated by the user.

    The model usually calls ``remember`` itself. When it only *claims* to have
    remembered something, this extracts the user's own clause so an obvious
    habit such as “我有每天学英语和读书的习惯” is not silently lost.
    """
    text = " ".join((message or "").split())
    if not text or len(text) > 240:
        return ""
    if DECLINED.search(text) or SECRET.search(text) or TEMPORARY.search(text):
        return ""
    explicit = EXPLICIT.search(text)
    clauses = [part.strip(" ，,。.；;：:") for part in re.split(r"[，,。；;\n]", text)]
    for clause in clauses:
        if not clause or len(clause) > 160:
            continue
        if PREFERENCE.search(clause):
            return clause
    if explicit and len(text) <= 160:
        value = re.sub(
            r"^(?:请|麻烦)?(?:你)?(?:记住|记下|记着)[：:，,\s]*",
            "",
            text,
        ).strip(" ，,。.；;")
        return value if value and value != text else ""
    return ""


def snapshot(value: Memory) -> dict:
    return {
        **{field: getattr(value, field) for field in FIELDS},
        "revision": value.revision,
    }


def policy(content, category, message, evidence, risk, explicit_request, mode):
    """Model classification is advisory; authorization comes from the current user turn."""
    if DECLINED.search(message):
        return "skip", "用户未同意保存"
    explicit = explicit_request and bool(EXPLICIT.search(message))
    if not evidence and explicit:
        evidence = message
    if not evidence.strip() or evidence not in message:
        return (
            "error",
            "请逐字引用当前用户消息作为 evidence；用户要求整理历史信息时，设 explicit_request=true，并用 source_quotes 提供历史用户消息编号和原文。网页、助手回答和推测不能作为事实依据。",
        )
    if SECRET.search(content + "\n" + evidence):
        return "skip", "密钥和密码不保存为个人记忆"
    if explicit:
        return "confirmed", ""
    if risk == "temporary" or TEMPORARY.search(evidence):
        return "skip", "临时信息仅保留在当前对话"
    if risk == "sensitive" or SENSITIVE.search(content + "\n" + evidence):
        return "candidate", "包含私密信息"
    if risk == "inferred":
        return "candidate", "需要核实的推测"
    if mode == "confirm":
        return "candidate", "当前设置为每次确认"
    if category == "preference" and PREFERENCE.search(evidence):
        return "confirmed", ""
    return "candidate", "请核实这条信息"


def get_memory(db, memory_id):
    record = db.get(Memory, memory_id)
    if not record or record.profile_id != PROFILE_ID:
        raise LookupError("记忆不存在")
    return record


def save_from_chat(
    run_id,
    conversation_id,
    *,
    content,
    category="fact",
    explicit_request=False,
    evidence="",
    risk="normal",
    replaces_id="",
    source_quotes=None,
) -> dict:
    content, evidence = content.strip(), evidence.strip()
    if (
        category not in ("fact", "preference", "project")
        or not content
        or len(content) > 6000
    ):
        return {"error": "记忆参数无效"}
    if risk not in ("normal", "sensitive", "inferred", "temporary"):
        return {"error": "无效的记忆类型"}
    with lock, Session() as db:
        message = task_context.user_message(db, run_id, conversation_id)
        if not message:
            return {"error": "找不到当前用户消息"}
        settings = db.get(Settings, PROFILE_ID)
        stored_evidence = evidence
        sources = source_quotes or []
        authorized = explicit_request and bool(EXPLICIT.search(message.content)) and not DECLINED.search(message.content)
        # Older tool callers may supply one exact historical quote in evidence.
        # Find its original user message instead of rejecting a valid current request.
        if not sources and evidence and evidence not in message.content and authorized:
            boundary = db.scalar(select(MESSAGE_ORDER).select_from(Message).where(Message.id == message.id))
            origin = db.scalar(select(Message).where(
                Message.profile_id == PROFILE_ID, Message.conversation_id == conversation_id,
                Message.role == "user", MESSAGE_ORDER <= boundary,
                Message.content.contains(evidence, autoescape=True),
            ).order_by(MESSAGE_ORDER.desc()).limit(1))
            if origin:
                sources = [{"message_id": origin.id, "quote": evidence}]
        if sources:
            if not authorized:
                return {"error": "整理历史记忆需要本轮用户明确要求记住；历史消息不能代替当前保存授权。", "changed": False}
            try:
                original = history_evidence(db, message, sources)
            except (ValueError, TypeError):
                return {"error": "历史依据无效：请先检索当前会话的用户原文，使用真实消息编号和逐字引用；最多 12 段，总计不超过 12000 字。", "changed": False}
            if SECRET.search(content + "\n" + original):
                return {"skipped": "密钥和密码不保存为个人记忆", "changed": False}
            evidence = message.content
            stored_evidence = f"保存授权（用户消息 {message.id}）：\n{message.content}\n\n历史事实依据：\n{original}"
        state, reason = policy(
            content,
            category,
            message.content,
            evidence,
            risk,
            explicit_request,
            settings.memory_mode,
        )
        if state in ("skip", "error"):
            return {
                "error" if state == "error" else "skipped": reason,
                "changed": False,
            }
        evidence = stored_evidence or evidence or message.content
        # A retry of the same user turn must respect an earlier Undo / dismissal.
        for change in db.scalars(
            select(MemoryChange).where(
                MemoryChange.profile_id == PROFILE_ID,
                MemoryChange.source_message_id == message.id,
                MemoryChange.undone.is_(True),
            )
        ):
            if change.after["content"] == content:
                return {"skipped": "这条记忆已被撤销或忽略", "changed": False}
        existing = db.scalar(
            select(Memory).where(
                Memory.profile_id == PROFILE_ID,
                Memory.content == content,
            )
        )
        if existing and (existing.state == "confirmed" or state == "candidate"):
            return {"id": existing.id, "state": existing.state, "changed": False}
        target = None
        replaces_id = replaces_id or (existing.replaces_id if existing else "")
        if replaces_id:
            try:
                target = get_memory(db, replaces_id)
            except LookupError:
                return {"error": "要替换的记忆不存在，请先查询记忆"}
            if target.state != "confirmed":
                return {"error": "只能替换已保存的记忆"}
            if (
                existing
                and existing.replaces_id
                and target.revision != existing.replaces_revision
            ):
                return {"error": "原记忆已修改，请在记忆页核实这条旧提议"}
        # A proposal keeps the previously confirmed memory active until confirmation.
        conversation = db.get(Conversation, conversation_id)
        record = target if target and state == "confirmed" else existing
        before = snapshot(record) if record else None
        if existing and target and state == "confirmed" and existing.id != target.id:
            db.delete(existing)
        if not record:
            record = Memory()
            db.add(record)
        values = {
            "content": content,
            "category": category,
            "state": state,
            "source": f"对话 · {conversation.title}",
            "evidence": evidence,
            "review_reason": reason,
            "source_conversation_id": conversation_id,
            "source_message_id": message.id,
            "replaces_id": target.id if target and state == "candidate" else None,
            "replaces_revision": target.revision
            if target and state == "candidate"
            else None,
        }
        for field, value in values.items():
            setattr(record, field, value)
        record.revision = before["revision"] + 1 if before else 1
        db.flush()
        change = MemoryChange(
            memory_id=record.id,
            run_id=run_id,
            source_message_id=message.id,
            before=before,
            after=snapshot(record),
        )
        db.add(change)
        db.commit()
        return {
            "id": record.id,
            "change_id": change.id,
            "state": state,
            "content": content,
            "review_reason": reason,
            "revision": record.revision,
            "changed": True,
            "action": "updated" if before else "created",
        }


def edit(memory_id, values, expected_revision=None):
    with lock, Session() as db:
        record = get_memory(db, memory_id)
        if expected_revision is not None and record.revision != expected_revision:
            raise MemoryConflict("这条记忆已变更，请刷新后重试")
        if (
            record.state == "candidate"
            and values["state"] == "confirmed"
            and record.replaces_id
        ):
            target = get_memory(db, record.replaces_id)
            if target.revision != record.replaces_revision:
                raise MemoryConflict("原记忆已修改，请删除这条旧提议后重新整理")
            for field in FIELDS:
                setattr(target, field, getattr(record, field))
            db.delete(record)
            record = target
        for field, value in values.items():
            setattr(record, field, value)
        if record.state == "confirmed":
            record.review_reason = ""
            record.replaces_id = record.replaces_revision = None
        record.revision += 1
        db.commit()
        return record


def confirm(memory_id, revision):
    with lock, Session() as db:
        record = get_memory(db, memory_id)
        values = {
            field: getattr(record, field) for field in ("content", "category", "source")
        }
    return edit(memory_id, {**values, "state": "confirmed"}, revision)


def discard(memory_id):
    with lock, Session() as db:
        record = get_memory(db, memory_id)
        for change in db.scalars(
            select(MemoryChange).where(
                MemoryChange.memory_id == memory_id,
                MemoryChange.profile_id == PROFILE_ID,
            )
        ):
            change.undone = True
        db.delete(record)
        db.commit()


def undo(change_id):
    with lock, Session() as db:
        change = db.get(MemoryChange, change_id)
        if not change or change.profile_id != PROFILE_ID:
            raise LookupError("记忆变更不存在")
        if change.undone:
            return {"undone": True}
        record = get_memory(db, change.memory_id)
        if snapshot(record) != change.after:
            raise MemoryConflict("这条记忆后来已被修改，请到记忆页管理")
        if change.before is None:
            db.delete(record)
        else:
            for field in FIELDS:
                setattr(record, field, change.before[field])
            record.revision += 1
        change.undone = True
        db.commit()
        return {"undone": True}
