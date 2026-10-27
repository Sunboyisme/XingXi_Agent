"""Goal interviews, one-question reviews, and coordinated learning shutdown."""
import asyncio
import json
from collections import defaultdict

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import select, update

from . import db as store, learning, learning_sessions as sessions, provider, runs, schemas as s
from . import knowledge
from .config import PROFILE_ID
from .learning_public import LEARNING_KINDS, public

router = APIRouter()
locks = defaultdict(asyncio.Lock)
closing = False
closing_goals = set()


def assert_open(goal_id=None):
    if closing or goal_id in closing_goals:
        raise HTTPException(409, "正在结束学习，请稍后再操作。")


class IntakeRead(s.RecordRead):
    messages: list[dict]
    summary: dict
    draft: str
    draft_revision: int
    status: str
    goal_id: str | None
    active_run_id: str | None


class IntakeMessage(BaseModel):
    message_id: str = Field(min_length=1, max_length=100)
    content: str = Field(min_length=1, max_length=12000)
    use_beginner_defaults: bool = False


class IntakeDraft(BaseModel):
    answer: str = Field(default="", max_length=12000)
    revision: int = Field(ge=0)


class IntakeCreate(IntakeMessage):
    creation_id: str = Field(min_length=1, max_length=100)


class IntakeForm(BaseModel):
    summary: dict[str, str] = Field(max_length=6)

    @field_validator("summary")
    @classmethod
    def safe_fields(cls, value):
        if set(value) - {"title", "objective", "foundation", "outcome", "weekly_minutes", "target_date"} or any(len(item) > 4000 for item in value.values()):
            raise ValueError("目标摘要字段无效或过长。")
        return value


class IntakeResult(BaseModel):
    title: str = Field(default="", max_length=200)
    objective: str = Field(default="", max_length=4000)
    foundation: str = Field(default="", max_length=4000)
    question: str = Field(default="", max_length=2000)


class ReviewCreate(BaseModel):
    goal_id: str
    session_id: str | None = None


class ReviewRead(s.RecordRead):
    goal_id: str
    session_id: str | None
    node_id: str
    source: dict
    exercise: str
    turns: list[dict]
    draft: dict
    draft_revision: int
    status: str
    active_run_id: str | None

    @field_validator("source", "turns")
    @classmethod
    def display_data(cls, value):
        return public(value)


class ReviewQuestion(BaseModel):
    exercise: str = Field(min_length=1, max_length=12000)
    criteria: str = Field(min_length=1, max_length=12000)


class ReviewDraft(BaseModel):
    answer: str = Field(default="", max_length=30000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=4)
    revision: int = Field(ge=0)


def active_run(db, row):
    run = db.get(store.Run, row.active_run_id) if row.active_run_id else None
    return run if run and run.status in store.ACTIVE_RUN_STATUSES else None


def new_run(db, kind, row, key, goal_id=None):
    from .main import create_run
    assert_open(goal_id)
    run = create_run(db, kind, goal_id=goal_id, commit=False)
    db.flush()
    row.active_run_id = run.id
    run.result = {key: row.id}
    db.commit()
    return run


@router.post("/learning/intakes", response_model=IntakeRead)
async def create_intake(value: IntakeCreate):
    assert_open()
    async with locks["create:" + value.creation_id]:
        with store.Session() as db:
            row = db.scalar(select(store.LearningIntake).where(
                store.LearningIntake.creation_id == value.creation_id,
                store.LearningIntake.profile_id == PROFILE_ID))
            if row:
                first = next((x for x in row.messages if x.get("role") == "user"), {})
                if first.get("content") != value.content.strip():
                    raise HTTPException(409, "这次创建请求已经用于另一个学习方向。")
                return IntakeRead.model_validate(row)
            if not value.content.strip():
                raise HTTPException(422, "请先告诉 XiaoXi 你想学什么。")
            row = store.LearningIntake(creation_id=value.creation_id, messages=[
                {"role": "assistant", "content": "你想学会什么，或解决什么问题？"},
                {"role": "user", "content": value.content.strip(), "message_id": value.message_id}])
            db.add(row)
            db.flush()
            run = new_run(db, "learning_intake", row, "intake_id")
            intake_id = row.id
            runs.launch(run.id, lambda: interview(intake_id, run.id, value.use_beginner_defaults))
            return IntakeRead.model_validate(row)


@router.get("/learning/intakes", response_model=list[IntakeRead])
def list_intakes():
    with store.Session() as db:
        return [IntakeRead.model_validate(row) for row in db.scalars(select(store.LearningIntake).where(
            store.LearningIntake.profile_id == PROFILE_ID).order_by(store.LearningIntake.created_at.desc()))
            if any(x.get("role") == "user" for x in row.messages) or row.draft.strip()]


@router.delete("/learning/intakes/{intake_id}")
async def delete_intake(intake_id: str):
    async with locks[intake_id]:
        with store.Session() as db:
            row = sessions.require(db, store.LearningIntake, intake_id)
            if active_run(db, row):
                raise HTTPException(409, "请先停止生成，再删除这份草稿。")
            if row.goal_id:
                raise HTTPException(409, "已创建课程，请从课程卡片删除。")
            db.delete(row)
            db.commit()
            return {"deleted": True}


@router.get("/learning/intakes/{intake_id}", response_model=IntakeRead)
def get_intake(intake_id: str):
    with store.Session() as db:
        return IntakeRead.model_validate(sessions.require(db, store.LearningIntake, intake_id))


@router.put("/learning/intakes/{intake_id}/draft", response_model=IntakeRead)
def intake_draft(intake_id: str, value: IntakeDraft):
    with store.Session() as db:
        row = sessions.require(db, store.LearningIntake, intake_id)
        if row.status == "confirmed" or active_run(db, row):
            raise HTTPException(409, "当前访谈已提交，请刷新后继续。")
        saved = db.execute(update(store.LearningIntake).where(store.LearningIntake.id == row.id,
            store.LearningIntake.draft_revision == value.revision).values(
                draft=value.answer, draft_revision=value.revision + 1, updated_at=store.now()))
        if saved.rowcount != 1:
            raise HTTPException(409, "访谈草稿已经更新，当前输入仍保留，请刷新后重试。")
        db.commit()
        db.refresh(row)
        return IntakeRead.model_validate(row)


@router.put("/learning/intakes/{intake_id}/summary", response_model=IntakeRead)
def intake_summary(intake_id: str, value: IntakeForm):
    with store.Session() as db:
        row = sessions.require(db, store.LearningIntake, intake_id)
        if row.status == "confirmed" or active_run(db, row):
            raise HTTPException(409, "目标已提交或正在生成，请稍后再调整。")
        row.summary = value.summary
        db.commit()
        return IntakeRead.model_validate(row)


async def interview(intake_id, run_id, beginner):
    with store.Session() as db:
        row = sessions.require(db, store.LearningIntake, intake_id)
        text = json.dumps({"messages": row.messages[-40:], "summary": row.summary,
                           "explicit_beginner": beginner}, ensure_ascii=False)
        text += learning.context(db, " ".join(x["content"] for x in row.messages[-6:] if x["role"] == "user"))
    text += await knowledge.context(text[:4000], run_id)
    result = await provider.ask_json(IntakeResult, learning.TUTOR_RULES + "\n你正在帮助用户建立学习目标。"
        "从真实用户回答及明确的个人背景提取title、objective、foundation，保留已知答案，不猜测经验。"
        "每轮只问一个尚未明确的核心问题，按主题、想具备的能力、目前基础的顺序补齐；已有答案绝不重复追问。"
        "用户说零基础或明确选择入门默认时可如实填写基础。不知道基础不等于零基础。"
        "用户明确选择入门默认时，可把未说明的目标设为从零认识主题并完成一个入门小实践。"
        "不追问时间、年龄或不必要的细节。三项齐全时question留空，界面将展示可编辑摘要供用户确认。"
        "不要声称课程已创建，不输出练习、评分标准或示例表单。", text)
    values = result.model_dump()
    with store.Session() as db:
        row = sessions.require(db, store.LearningIntake, intake_id)
        summary = {key: values[key].strip() or row.summary.get(key, "") for key in ("title", "objective", "foundation")}
        summary, missing = learning.goal_intake(**summary, use_beginner_defaults=beginner)
        question = values["question"].strip() if missing else "目标已经整理好了，你可以检查或修改下面的摘要，再生成学习路线。"
        if missing and not question:
            question = f"请告诉我你的{missing[0]}。"
        row.summary = {**row.summary, **summary}
        row.status = "draft" if missing else "ready"
        row.messages = [*row.messages, {"role": "assistant", "content": question, "run_id": run_id, "knowledge_sources": knowledge.sources_for_run(run_id)}]
        db.commit()
    return {"intake_id": intake_id}


@router.post("/learning/intakes/{intake_id}/messages", response_model=s.RunRead)
async def intake_message(intake_id: str, value: IntakeMessage):
    async with locks[intake_id]:
        with store.Session() as db:
            row = sessions.require(db, store.LearningIntake, intake_id)
            assert_open()
            running = active_run(db, row)
            if running:
                return s.RunRead.model_validate(running)
            if row.status == "confirmed":
                raise HTTPException(409, "目标已创建，请打开目标继续学习。")
            previous = next((x for x in row.messages if x.get("message_id") == value.message_id), None)
            if previous and previous["content"] != value.content:
                raise HTTPException(409, "这次提交编号已经用于其他内容。")
            if previous and any(x.get("run_id") == row.active_run_id for x in row.messages):
                return s.RunRead.model_validate(db.get(store.Run, row.active_run_id))
            if not previous:
                if len(row.messages) >= 80:
                    raise HTTPException(422, "访谈已较长，请在目标摘要中补齐核心信息后确认。")
                row.messages = [*row.messages, {"role": "user", "content": value.content.strip(), "message_id": value.message_id}]
            row.draft = ""
            row.draft_revision += 1
            run = new_run(db, "learning_intake", row, "intake_id")
            runs.launch(run.id, lambda: interview(intake_id, run.id, value.use_beginner_defaults))
            return s.RunRead.model_validate(run)


@router.post("/learning/intakes/{intake_id}/confirm", response_model=s.RunRead)
async def confirm_intake(intake_id: str, value: s.GoalCreate):
    async with locks[intake_id]:
        with store.Session() as db:
            row = sessions.require(db, store.LearningIntake, intake_id)
            assert_open(row.goal_id)
            running = active_run(db, row)
            if running:
                return s.RunRead.model_validate(running)
            if row.goal_id:
                goal = sessions.require(db, store.Goal, row.goal_id)
                if db.scalar(select(store.KnowledgeNode.id).where(store.KnowledgeNode.goal_id == goal.id)):
                    return s.RunRead.model_validate(db.get(store.Run, row.active_run_id))
            else:
                details, missing = learning.goal_intake(value.title, value.objective, value.foundation, value.use_beginner_defaults)
                if missing:
                    raise HTTPException(422, "请补充" + "、".join(missing))
                goal = store.Goal(**details, **sessions.goal_options(value))
                db.add(goal)
                db.flush()
                row.goal_id = goal.id
                row.summary = {**details, **sessions.goal_options(value)}
                row.status = "confirmed"
            run = new_run(db, "course", row, "intake_id", goal.id)
            run.result = {"intake_id": intake_id, "goal_id": goal.id}
            db.commit()
            goal_id = goal.id
            runs.launch(run.id, lambda: learning.generate_course(goal_id, run.id))
            return s.RunRead.model_validate(run)


def review_source(db, goal):
    candidates = []
    for node in db.scalars(select(store.KnowledgeNode).where(store.KnowledgeNode.goal_id == goal.id).order_by(store.KnowledgeNode.ordinal)):
        lesson = sessions.latest_lesson(db, node.id)
        if not lesson:
            continue
        last_review = db.scalar(select(store.LearningReview).where(store.LearningReview.node_id == node.id)
            .order_by(store.LearningReview.created_at.desc()))
        candidates.append((0 if node.status == "needs_practice" else 1,
                           last_review.created_at if last_review else "", node.ordinal, node, lesson))
    if not candidates:
        raise HTTPException(409, "还没有可复习的教学内容，请先开始一个知识点。")
    _, _, _, node, lesson = min(candidates, key=lambda x: x[:3])
    turns = learning.node_turns(db, node.id, limit=8)
    source = {"node_title": node.title, "node_objective": node.objective,
              "lesson_id": lesson.id, "lesson": lesson.content[:14000],
              "exercise": lesson.exercise, "criteria": lesson.criteria,
              "attempts": [{"id": turn.id, "answer": turn.answer[:4000],
                            "attachment_ids": turn.attachment_ids, "feedback": turn.feedback} for turn in turns],
              "basis": "根据之前的练习与反馈" if turns else "尚未作答，根据已学内容安排复习"}
    return node, source


async def generate_review(review_id, run_id):
    with store.Session() as db:
        row = sessions.require(db, store.LearningReview, review_id)
        goal = sessions.require(db, store.Goal, row.goal_id)
        text = json.dumps({"goal": goal.title, "foundation": goal.foundation, "source": row.source}, ensure_ascii=False)
    text += await knowledge.context(text[:4000], run_id)
    result = await provider.ask_json(ReviewQuestion, learning.TUTOR_RULES + "\n根据当前章节的真实讲解和练习记录，"
        "生成一道针对薄弱点的复习题，只问一个核心问题，用1.编号，用户能用一小段回答。"
        "优先处理实际反馈中的缺口。尚未作答时不要说用户答错过，不虚构历史；只有编号的旧图片不代表看过图片。"
        "题目应覆盖该章核心学习要求，以便根据新作答判断掌握。criteria只用于后端评分，不把答案或标准写入exercise。",
        text, on_partial=lambda fields: runs.emit(run_id, "learning_content", {
            "review_id": review_id, "stage": "review", "fields": public(fields)}))
    with store.Session() as db:
        row = sessions.require(db, store.LearningReview, review_id)
        row.exercise, row.criteria, row.status = result.exercise, result.criteria, "active"
        db.commit()
    return {"review_id": review_id}


@router.post("/learning/reviews", response_model=s.RunRead)
async def create_review(value: ReviewCreate):
    async with locks[value.goal_id]:
        with store.Session() as db:
            goal = sessions.require(db, store.Goal, value.goal_id)
            assert_open(goal.id)
            row = db.scalar(select(store.LearningReview).where(store.LearningReview.goal_id == goal.id,
                store.LearningReview.profile_id == PROFILE_ID, store.LearningReview.status != "ended")
                .order_by(store.LearningReview.created_at.desc()))
            if row and not active_run(db, row):
                previous_session = db.get(store.LearningSession, row.session_id) if row.session_id else None
                if not previous_session or previous_session.status == "ended":
                    previous_ids = row.source.get("session_ids", [row.session_id] if row.session_id else [])
                    saved = sessions.start_session(db, goal, s.LearningSessionStart())
                    row.session_id = saved.id
                    row.source = {**row.source, "session_ids": list(dict.fromkeys([*previous_ids, saved.id]))}
                    db.commit()
                elif previous_session.status == "paused":
                    sessions.start_session(db, goal, s.LearningSessionStart(), previous_session)
            if row and row.active_run_id:
                run = db.get(store.Run, row.active_run_id)
                if active_run(db, row) or row.exercise:
                    if not row.session_id or sessions.require(db, store.LearningSession, row.session_id).status == "ended":
                        previous_ids = row.source.get("session_ids", [row.session_id] if row.session_id else [])
                        saved = sessions.start_session(db, goal, s.LearningSessionStart())
                        row.session_id = saved.id
                        row.source = {**row.source, "session_ids": list(dict.fromkeys([*previous_ids, saved.id]))}
                        db.commit()
                    return s.RunRead.model_validate(run)
            sessions.ensure_idle(db, goal.id)
            if not row:
                node, source = review_source(db, goal)
                if value.session_id:
                    session = sessions.require(db, store.LearningSession, value.session_id)
                    if session.goal_id != goal.id or session.status == "ended":
                        raise HTTPException(409, "复习会话与目标不一致，请重新接续。")
                    session_id = session.id
                else:
                    session_id = sessions.start_session(db, goal, s.LearningSessionStart()).id
                row = store.LearningReview(goal_id=goal.id, node_id=node.id, source={**source, "session_ids": [session_id]}, session_id=session_id)
                db.add(row)
                db.flush()
            run = new_run(db, "learning_review", row, "review_id", goal.id)
            review_id = row.id
            runs.launch(run.id, lambda: generate_review(review_id, run.id))
            return s.RunRead.model_validate(run)


@router.get("/learning/reviews", response_model=list[ReviewRead])
def list_reviews(goal_id: str, session_id: str | None = None):
    with store.Session() as db:
        sessions.require(db, store.Goal, goal_id)
        query = select(store.LearningReview).where(store.LearningReview.goal_id == goal_id,
            store.LearningReview.profile_id == PROFILE_ID)
        result = []
        for row in db.scalars(query.order_by(store.LearningReview.created_at.desc())):
            linked = row.source.get("session_ids", [row.session_id])
            if session_id and session_id not in linked:
                continue
            value = ReviewRead.model_validate(row)
            if session_id:
                value = value.model_copy(update={"turns": [public(turn) for turn in row.turns
                    if turn.get("session_id", linked[0]) == session_id],
                    "draft": row.draft if row.session_id == session_id else {}})
            result.append(value)
        return result


@router.get("/learning/reviews/{review_id}", response_model=ReviewRead)
def get_review(review_id: str):
    with store.Session() as db:
        return ReviewRead.model_validate(sessions.require(db, store.LearningReview, review_id))


def check_review(db, row):
    assert_open(row.goal_id)
    if row.status != "active" or active_run(db, row):
        raise HTTPException(409, "当前复习正在生成或已结束，请刷新后继续。")
    if row.session_id and sessions.require(db, store.LearningSession, row.session_id).status == "ended":
        raise HTTPException(409, "本次学习已结束，请从目标重新进入复习。")


@router.put("/learning/reviews/{review_id}/draft", response_model=ReviewRead)
def review_draft(review_id: str, value: ReviewDraft):
    with store.Session() as db:
        row = sessions.require(db, store.LearningReview, review_id)
        check_review(db, row)
        for file_id in value.attachment_ids:
            sessions.require(db, store.Attachment, file_id)
        saved = db.execute(update(store.LearningReview).where(store.LearningReview.id == row.id,
            store.LearningReview.draft_revision == value.revision).values(
                draft=value.model_dump(exclude={"revision"}), draft_revision=value.revision + 1, updated_at=store.now()))
        if saved.rowcount != 1:
            raise HTTPException(409, "复习草稿已经更新，当前输入仍保留，请刷新后重试。")
        db.commit()
        db.refresh(row)
        return ReviewRead.model_validate(row)


async def assess_review(review_id, run_id, value):
    with store.Session() as db:
        row = sessions.require(db, store.LearningReview, review_id)
        text = json.dumps({"exercise": row.exercise, "criteria": row.criteria,
            "core_requirements": row.source["node_objective"], "source": row.source,
            "previous_turns": row.turns[-12:], "answer": value.answer}, ensure_ascii=False)
    text += await knowledge.context(text[:4000], run_id)
    result = await provider.ask_json(s.Feedback, learning.TUTOR_RULES + "\n这是复习对话。"
        "只有用户实际作答充分覆盖本章核心要求和当前题标准时passed=true，并在evidence说明依据。"
        "提问或求助按discussion回答，不代表掌握。答错时简短指出核心问题并提供参考答案，不强制反复补答。"
        "不追加问题，next_exercise和next_criteria留空；用户可以选择下一题或返回课程。"
        "不在explanation复述评分标准；不声称已经运行代码或看过只有编号的历史图片。",
        text, value.attachment_ids, on_partial=lambda fields: runs.emit(run_id, "learning_content", {
            "review_id": review_id, "stage": "review_assessment", "fields": public(fields)}))
    feedback = result.model_dump()
    feedback["knowledge_sources"] = knowledge.sources_for_run(run_id)
    feedback["next_exercise"] = feedback["next_criteria"] = ""
    feedback["passed"] = bool(result.passed and result.response_type == "feedback" and result.evidence.strip())
    with store.Session() as db:
        row = sessions.require(db, store.LearningReview, review_id)
        row.turns = [*row.turns, {"id": store.uid(), "created_at": store.now(),
            "session_id": row.session_id,
            "submission_id": value.submission_id, "answer": value.answer,
            "attachment_ids": value.attachment_ids, "feedback": feedback}]
        if row.draft.get("answer", "") == value.answer and row.draft.get("attachment_ids", []) == value.attachment_ids:
            row.draft = {}
            row.draft_revision += 1
        node = sessions.require(db, store.KnowledgeNode, row.node_id)
        if feedback["passed"]:
            node.status, node.review_at = "passed", None
            learning.update_goal_progress(db, sessions.require(db, store.Goal, row.goal_id))
        session = db.get(store.LearningSession, row.session_id) if row.session_id else None
        if session:
            session.summary = f"复习：{node.title}；{result.explanation}"[:2400]
            session.gaps = result.gaps
            session.last_studied_at = store.now()
        db.commit()
    return {"review_id": review_id}


@router.post("/learning/reviews/{review_id}/submit", response_model=s.RunRead)
async def submit_review(review_id: str, value: s.Submission):
    async with locks[review_id]:
        with store.Session() as db:
            row = sessions.require(db, store.LearningReview, review_id)
            previous = next((x for x in row.turns if x["submission_id"] == value.submission_id), None)
            if previous:
                if previous["answer"] != value.answer or previous["attachment_ids"] != value.attachment_ids:
                    raise HTTPException(409, "这次提交编号已经用于其他内容。")
                return s.RunRead.model_validate(db.get(store.Run, row.active_run_id))
            check_review(db, row)
            session = db.get(store.LearningSession, row.session_id) if row.session_id else None
            if session and session.status == "paused":
                sessions.start_session(db, sessions.require(db, store.Goal, row.goal_id), s.LearningSessionStart(), session)
            if not value.answer.strip() and not value.attachment_ids:
                raise HTTPException(422, "请输入回答或提交图片。")
            for file_id in value.attachment_ids:
                sessions.require(db, store.Attachment, file_id)
            try:
                provider.user_content(value.answer, value.attachment_ids)
            except Exception as error:
                raise HTTPException(400, provider.safe_error(error)) from None
            run = new_run(db, "review_assessment", row, "review_id", row.goal_id)
            runs.launch(run.id, lambda: assess_review(review_id, run.id, value))
            return s.RunRead.model_validate(run)


@router.post("/learning/reviews/{review_id}/end", response_model=ReviewRead)
def end_review(review_id: str):
    with store.Session() as db:
        row = sessions.require(db, store.LearningReview, review_id)
        if active_run(db, row):
            raise HTTPException(409, "请先停止当前复习生成。")
        row.status = "ended"
        db.commit()
        return ReviewRead.model_validate(row)


async def stop_learning_runs(goal_id=None):
    with store.Session() as db:
        query = select(store.Run).where(store.Run.profile_id == PROFILE_ID,
            store.Run.kind.in_(LEARNING_KINDS), store.Run.status.in_(store.ACTIVE_RUN_STATUSES))
        if goal_id:
            query = query.where(store.Run.goal_id == goal_id)
        ids = [run.id for run in db.scalars(query)]
    tasks = [runs.tasks[key] for key in ids if key in runs.tasks]
    for task in tasks:
        task.cancel()
    if tasks:
        _, pending = await asyncio.wait(tasks, timeout=10)
        if pending:
            raise HTTPException(409, "学习请求仍在停止，请稍后重试结束学习。")
    with store.Session() as db:
        for key in ids:
            run = db.get(store.Run, key)
            if run and run.status in store.ACTIVE_RUN_STATUSES:
                run.status = "cancelled"
        db.commit()


@router.post("/learning/sessions/end-all")
async def end_all_sessions():
    global closing
    async with locks["desktop-close"]:
        closing = True
        try:
            await stop_learning_runs()
            with store.Session() as db:
                rows = list(db.scalars(select(store.LearningSession).where(
                    store.LearningSession.profile_id == PROFILE_ID, store.LearningSession.status != "ended")))
                for row in rows:
                    row.status, row.ended_at = "ended", store.now()
                db.commit()
                return {"ended_ids": [row.id for row in rows]}
        finally:
            closing = False


def review_attachment_ids(db, goal_id=None):
    query = select(store.LearningReview)
    if goal_id:
        query = query.where(store.LearningReview.goal_id == goal_id)
    return {key for row in db.scalars(query) for data in [row.draft, *row.turns]
            for key in data.get("attachment_ids", [])}
