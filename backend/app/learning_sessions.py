"""Learning continuity is saved data; reading it never calls a model."""

from fastapi import APIRouter, HTTPException
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from . import schemas as s
from .config import PROFILE_ID
from .db import ACTIVE_RUN_STATUSES, Attachment, Attempt, Goal, KnowledgeNode, LearningSession, Lesson, Run, Session, now

router = APIRouter()


def draft_attachment_ids(db, goal_id=None):
    query = select(LearningSession.drafts)
    if goal_id is not None:
        query = query.where(LearningSession.goal_id == goal_id)
    return {key for drafts in db.scalars(query) for draft in (drafts or {}).values()
            for key in draft.get("attachment_ids", [])}


def require(db, model, key):
    row = db.get(model, key) if key else None
    if row is None or row.profile_id != PROFILE_ID:
        raise HTTPException(404, "学习记录不存在或已经删除")
    return row


def goal_options(value):
    return {"outcome": value.outcome.strip(), "weekly_minutes": value.weekly_minutes,
            "target_date": value.target_date}


def current_node(db, goal, node_id=None):
    if node_id:
        node = require(db, KnowledgeNode, node_id)
        if node.goal_id != goal.id:
            raise HTTPException(409, "知识点不属于这个学习目标")
        return node
    if goal.current_node_id:
        node = db.get(KnowledgeNode, goal.current_node_id)
        if node and node.goal_id == goal.id and node.profile_id == PROFILE_ID:
            return node
    return db.scalar(select(KnowledgeNode).where(KnowledgeNode.goal_id == goal.id,
        KnowledgeNode.profile_id == PROFILE_ID).order_by(KnowledgeNode.ordinal))


def latest_lesson(db, node_id):
    if not node_id:
        return None
    return db.scalar(select(Lesson).where(Lesson.node_id == node_id, Lesson.profile_id == PROFILE_ID)
                     .order_by(Lesson.created_at.desc(), Lesson.id.desc()))


def unfinished(db, goal_id):
    return db.scalar(select(LearningSession).where(LearningSession.goal_id == goal_id,
        LearningSession.profile_id == PROFILE_ID, LearningSession.status != "ended")
        .order_by(LearningSession.updated_at.desc()))


def ensure_idle(db, goal_id):
    if db.scalar(select(Run.id).where(Run.goal_id == goal_id,
                                     Run.status.in_(ACTIVE_RUN_STATUSES))):
        raise HTTPException(409, "学习任务正在运行，请先停止当前任务")


def validate_session(db, session_id, node, lesson_id=None):
    if not session_id:
        return None
    row = require(db, LearningSession, session_id)
    if row.goal_id != node.goal_id or row.node_id != node.id:
        raise HTTPException(409, "会话与当前学习目标或知识点不一致，请重新接续")
    if row.status == "ended":
        raise HTTPException(409, "本次学习已结束，请先开始新的学习会话")
    if lesson_id:
        lesson = require(db, Lesson, lesson_id)
        if lesson.node_id != node.id:
            raise HTTPException(409, "课程与当前知识点不一致")
        if row.lesson_id and row.lesson_id != lesson.id:
            raise HTTPException(409, "当前课程已经更新，请重新读取后提交")
    return row


def record_lesson(db, row, lesson):
    if row is None:
        return
    row.lesson_id = lesson.id
    row.last_studied_at = now()
    node = db.get(KnowledgeNode, lesson.node_id)
    row.summary = f"已开始学习：{node.title}" if node else "已开始本次学习"
    row.next_step = "完成当前小练习，或就不理解的地方继续提问。"


def record_feedback(db, row, lesson, feedback, submission=None):
    if row is None:
        return
    row.lesson_id = lesson.id
    row.last_studied_at = now()
    row.summary = str(feedback.get("explanation", ""))[:2400]
    row.gaps = [str(value)[:600] for value in feedback.get("gaps", []) if value][:12]
    row.next_step = str(feedback.get("next_step", ""))[:2400]
    drafts = dict(row.drafts or {})
    pending = drafts.get(lesson.node_id)
    if pending and submission and pending.get("answer", "") == submission.get("answer", "") and \
            pending.get("attachment_ids", []) == submission.get("attachment_ids", []):
        drafts.pop(lesson.node_id, None)
        expected_revision = row.draft_revision
        # Persist the feedback, then clear only the exact draft version inspected
        # above. A newer edit from another window must survive this response.
        db.flush()
        db.execute(update(LearningSession).where(LearningSession.id == row.id,
            LearningSession.draft_revision == expected_revision).values(
                drafts=drafts, draft_revision=expected_revision + 1)
            .execution_options(synchronize_session=False))
        db.refresh(row)


def read_session(db, row, details=False):
    values = {key: getattr(row, key) for key in s.LearningSessionRead.model_fields
              if key not in {"draft", "turns"}}
    values["draft"] = (row.drafts or {}).get(row.node_id or "", {
        "node_id": row.node_id, "lesson_id": row.lesson_id, "answer": "", "attachment_ids": []})
    values["turns"] = list(db.scalars(select(Attempt).where(Attempt.session_id == row.id,
        Attempt.profile_id == PROFILE_ID).order_by(Attempt.created_at, Attempt.id))) if details else []
    return s.LearningSessionRead(**values)


def continuation(db, goal):
    row = unfinished(db, goal.id)
    node = current_node(db, goal, row.node_id if row else None)
    lesson = latest_lesson(db, node.id if node else None)
    feedback = lesson.feedback if lesson else {}
    gap_values = row.gaps if row else feedback.get("gaps", [])
    summary = row.summary if row else str(feedback.get("explanation", ""))[:2400]
    next_step = row.next_step if row else str(feedback.get("next_step", ""))[:2400]
    if not summary:
        summary = f"上次停在：{node.title}" if node and lesson else "还没有开始本目标的学习。"
    if not next_step:
        next_step = "继续当前练习或提问。" if lesson else "从当前知识点开始一个小任务。" if node else "先生成学习框架。"
    if goal.status == "completed":
        next_step = "本课程学习已结束，可从目录回看讲解或复习尚未通过的练习。"
    last_attempt = db.scalar(select(Attempt).join(Lesson, Attempt.lesson_id == Lesson.id)
        .join(KnowledgeNode, KnowledgeNode.id == Lesson.node_id)
        .where(KnowledgeNode.goal_id == goal.id, Attempt.profile_id == PROFILE_ID)
        .order_by(Attempt.created_at.desc(), Attempt.id.desc()))
    return s.LearningContinuationRead(goal_id=goal.id, goal_title=goal.title, goal_status=goal.status,
        node_id=node.id if node else None, node_title=node.title if node else "",
        lesson_id=lesson.id if lesson else None, session_id=row.id if row else None,
        status=row.status if row else "not_started", summary=summary,
        gaps=[str(value) for value in gap_values if value], next_step=next_step,
        last_studied_at=(row.last_studied_at if row else None) or
            (last_attempt.created_at if last_attempt else lesson.created_at if lesson else None))


def list_continuations():
    with Session() as db:
        return [continuation(db, goal).model_dump() for goal in db.scalars(select(Goal)
            .where(Goal.profile_id == PROFILE_ID).order_by(Goal.updated_at.desc()))]


def start_session(db, goal, value, row=None):
    from .learning_workflows import assert_open
    assert_open(goal.id)
    ensure_idle(db, goal.id)
    row = row or unfinished(db, goal.id)
    node = current_node(db, goal, value.node_id or (row.node_id if row else None))
    if row is None:
        previous = continuation(db, goal)
        ended = db.scalar(select(LearningSession).where(LearningSession.goal_id == goal.id,
            LearningSession.profile_id == PROFILE_ID, LearningSession.status == "ended")
            .order_by(LearningSession.ended_at.desc()))
        row = LearningSession(goal_id=goal.id, node_id=node.id if node else None,
            target_minutes=value.target_minutes, summary=previous.summary,
            gaps=previous.gaps, next_step=previous.next_step,
            drafts=dict(ended.drafts or {}) if ended else {})
        db.add(row)
    elif row.status == "ended":
        raise HTTPException(409, "已结束的会话只能查看，请从目标开始新的学习")
    if node:
        if row.node_id != node.id:
            row.summary = f"学习位置已切换到：{node.title}；之前的草稿和提交已保留。"
            row.gaps = []
            row.next_step = "继续已有课程或开始这个知识点的小任务。"
        row.node_id = node.id
        row.visited_node_ids = list(dict.fromkeys([*(row.visited_node_ids or []), node.id]))
        lesson = latest_lesson(db, node.id)
        row.lesson_id = lesson.id if lesson else None
        goal.current_node_id = node.id
    if value.target_minutes is not None:
        row.target_minutes = value.target_minutes
    row.status = "active"
    row.paused_at = None
    row.last_studied_at = now()
    goal.updated_at = now()
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "这个目标已有未结束的会话，请刷新后继续") from None
    return read_session(db, row, details=True)


@router.put("/learning/goals/{goal_id}", response_model=s.GoalRead)
def update_goal(goal_id: str, value: s.GoalUpdate):
    from .learning import goal_intake
    with Session() as db:
        goal = require(db, Goal, goal_id)
        ensure_idle(db, goal.id)
        details, missing = goal_intake(value.title, value.objective, value.foundation, value.use_beginner_defaults)
        if missing:
            raise HTTPException(422, "请补充" + "、".join(missing))
        for key, content in {**details, **goal_options(value)}.items():
            setattr(goal, key, content)
        db.commit()
        # Imported lazily to share the established public Goal response shape.
        from .main import goal_read
        return goal_read(db, goal)


@router.get("/learning/continuations", response_model=list[s.LearningContinuationRead])
def all_continuations():
    return list_continuations()


@router.get("/learning/lessons/{lesson_id}", response_model=s.LessonRead)
def lesson_detail(lesson_id: str):
    with Session() as db:
        return require(db, Lesson, lesson_id)


@router.get("/learning/goals/{goal_id}/continuation", response_model=s.LearningContinuationRead)
def get_continuation(goal_id: str):
    with Session() as db:
        return continuation(db, require(db, Goal, goal_id))


@router.get("/learning/goals/{goal_id}/sessions", response_model=list[s.LearningSessionRead])
def sessions(goal_id: str):
    with Session() as db:
        require(db, Goal, goal_id)
        return [read_session(db, row) for row in db.scalars(select(LearningSession)
            .where(LearningSession.goal_id == goal_id, LearningSession.profile_id == PROFILE_ID)
            .order_by(LearningSession.started_at.desc(), LearningSession.id.desc()))]


@router.post("/learning/goals/{goal_id}/sessions", response_model=s.LearningSessionRead)
def start(goal_id: str, value: s.LearningSessionStart):
    with Session() as db:
        return start_session(db, require(db, Goal, goal_id), value)


@router.get("/learning/sessions/{session_id}", response_model=s.LearningSessionRead)
def detail(session_id: str):
    with Session() as db:
        return read_session(db, require(db, LearningSession, session_id), details=True)


@router.post("/learning/sessions/{session_id}/resume", response_model=s.LearningSessionRead)
def resume(session_id: str, value: s.LearningSessionStart):
    with Session() as db:
        row = require(db, LearningSession, session_id)
        return start_session(db, require(db, Goal, row.goal_id), value, row)


@router.post("/learning/sessions/{session_id}/pause", response_model=s.LearningSessionRead)
def pause(session_id: str):
    with Session() as db:
        row = require(db, LearningSession, session_id)
        if row.status != "ended":
            row.status = "paused"
            row.paused_at = now()
            db.commit()
        return read_session(db, row)


@router.post("/learning/sessions/{session_id}/end", response_model=s.LearningSessionRead)
async def end(session_id: str):
    from .learning_workflows import locks, closing_goals, stop_learning_runs
    with Session() as db:
        goal_id = require(db, LearningSession, session_id).goal_id
    async with locks[f"end:{goal_id}"]:
        closing_goals.add(goal_id)
        try:
            await stop_learning_runs(goal_id)
            with Session() as db:
                row = require(db, LearningSession, session_id)
                if row.status != "ended":
                    row.status, row.ended_at = "ended", now()
                    db.commit()
                return read_session(db, row, details=True)
        finally:
            closing_goals.discard(goal_id)


@router.put("/learning/sessions/{session_id}/draft", response_model=s.LearningSessionRead)
def save_draft(session_id: str, value: s.LearningDraftWrite):
    with Session() as db:
        row = require(db, LearningSession, session_id)
        if row.status == "ended":
            raise HTTPException(409, "本次学习已结束，草稿没有覆盖历史记录")
        if value.revision is not None and value.revision != row.draft_revision:
            raise HTTPException(409, "草稿已在其他操作中更新，请重新读取会话")
        node_id = value.node_id or row.node_id
        node = require(db, KnowledgeNode, node_id)
        if node.goal_id != row.goal_id:
            raise HTTPException(409, "草稿知识点不属于当前学习目标")
        lesson_id = value.lesson_id or (row.lesson_id if row.node_id == node_id else None)
        if lesson_id:
            lesson = require(db, Lesson, lesson_id)
            if lesson.node_id != node_id:
                raise HTTPException(409, "草稿与课程不一致")
            if row.node_id == node_id and row.lesson_id and row.lesson_id != lesson_id:
                raise HTTPException(409, "当前课程已经更新，旧课程草稿没有覆盖新课程")
        for file_id in value.attachment_ids:
            require(db, Attachment, file_id)
        drafts = dict(row.drafts or {})
        drafts[node_id] = {"node_id": node_id, "lesson_id": lesson_id,
                           "answer": value.answer, "attachment_ids": value.attachment_ids}
        expected_revision = row.draft_revision
        saved = db.execute(update(LearningSession).where(LearningSession.id == row.id,
            LearningSession.profile_id == PROFILE_ID, LearningSession.draft_revision == expected_revision,
            LearningSession.status != "ended").values(drafts=drafts, draft_revision=expected_revision + 1,
                                                       updated_at=now()).execution_options(synchronize_session=False))
        if saved.rowcount != 1:
            db.rollback()
            raise HTTPException(409, "草稿已在其他操作中更新，请重新读取会话")
        db.commit()
        db.refresh(row)
        return read_session(db, row)
