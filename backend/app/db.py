from datetime import datetime, timezone
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    event,
    literal_column,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

from .config import DATABASE_URL, PROFILE_ID


def uid() -> str:
    return str(uuid4())


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="microseconds")


class Base(DeclarativeBase):
    pass


class Record:
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=uid)
    profile_id: Mapped[str] = mapped_column(String(36), default=PROFILE_ID, index=True)
    created_at: Mapped[str] = mapped_column(String(40), default=now)
    updated_at: Mapped[str] = mapped_column(String(40), default=now, onupdate=now)


class Settings(Base):
    __tablename__ = "settings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=PROFILE_ID)
    model_url: Mapped[str] = mapped_column(Text, default="https://api.openai.com/v1")
    model_name: Mapped[str] = mapped_column(String(200), default="")
    vision_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    timezone: Mapped[str] = mapped_column(String(100), default="Asia/Shanghai")
    memory_mode: Mapped[str] = mapped_column(String(20), default="auto")
    model_providers: Mapped[list] = mapped_column(JSON, default=list)
    default_provider: Mapped[str] = mapped_column(String(30), default="custom")
    embedding_config: Mapped[dict] = mapped_column(JSON, default=dict)
    image_generation_config: Mapped[dict] = mapped_column(JSON, default=dict)


class Conversation(Record, Base):
    __tablename__ = "conversations"
    title: Mapped[str] = mapped_column(String(200), default="新对话")


class MCPServer(Record, Base):
    __tablename__ = "mcp_servers"
    __table_args__ = (UniqueConstraint("profile_id", "name"),)
    name: Mapped[str] = mapped_column(String(100))
    transport: Mapped[str] = mapped_column(String(30))
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    tested_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class MCPTool(Base):
    __tablename__ = "mcp_tools"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    server_id: Mapped[str] = mapped_column(
        ForeignKey("mcp_servers.id", ondelete="CASCADE"), index=True
    )
    remote_name: Mapped[str] = mapped_column(Text)
    description: Mapped[str] = mapped_column(Text, default="")
    input_schema: Mapped[dict] = mapped_column(JSON, default=dict)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    present: Mapped[bool] = mapped_column(Boolean, default=True)


class BuiltinToolState(Base):
    __tablename__ = "builtin_tool_states"
    id: Mapped[str] = mapped_column(String(100), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)


class Message(Record, Base):
    __tablename__ = "messages"
    conversation_id: Mapped[str] = mapped_column(
        ForeignKey("conversations.id", ondelete="CASCADE"), index=True
    )
    role: Mapped[str] = mapped_column(String(20))
    content: Mapped[str] = mapped_column(Text)
    attachment_ids: Mapped[list] = mapped_column(JSON, default=list)
    provider_context: Mapped[dict] = mapped_column(JSON, default=dict)
    reasoning: Mapped[str] = mapped_column(Text, default="")
    run_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)


# SQLite insertion order breaks ties when several messages share a clock tick.
MESSAGE_ORDER = literal_column("messages.rowid")


class ConversationSummary(Base):
    __tablename__ = "conversation_summaries"
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), primary_key=True)
    content: Mapped[str] = mapped_column(Text, default="")
    through_message_id: Mapped[str] = mapped_column(String(36))


class MemoryVector(Base):
    __tablename__ = "memory_vectors"
    memory_id: Mapped[str] = mapped_column(ForeignKey("memories.id", ondelete="CASCADE"), primary_key=True)
    revision: Mapped[int] = mapped_column(Integer)
    content_hash: Mapped[str] = mapped_column(String(64))
    signature: Mapped[str] = mapped_column(String(64))
    vector: Mapped[list] = mapped_column(JSON)


class Run(Record, Base):
    __tablename__ = "runs"
    kind: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(20), default="queued")
    conversation_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    goal_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    usage: Mapped[dict] = mapped_column(JSON, default=dict)
    model_config: Mapped[dict] = mapped_column(JSON, default=dict)
    task_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    source_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class ComplexTask(Record, Base):
    __tablename__ = "complex_tasks"
    conversation_id: Mapped[str] = mapped_column(ForeignKey("conversations.id", ondelete="CASCADE"), index=True)
    source_message_id: Mapped[str] = mapped_column(String(36))
    status: Mapped[str] = mapped_column(String(30), default="planning")
    revision: Mapped[int] = mapped_column(Integer, default=1)
    goal: Mapped[str] = mapped_column(Text)
    requirements: Mapped[dict] = mapped_column(JSON, default=dict)
    model_config: Mapped[dict] = mapped_column(JSON, default=dict)
    message_ids: Mapped[list] = mapped_column(JSON, default=list)
    pending_message_ids: Mapped[list] = mapped_column(JSON, default=list)
    reason: Mapped[str] = mapped_column(Text, default="")
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class TaskStep(Record, Base):
    __tablename__ = "task_steps"
    task_id: Mapped[str] = mapped_column(ForeignKey("complex_tasks.id", ondelete="CASCADE"), index=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)
    ordinal: Mapped[int] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    instruction: Mapped[str] = mapped_column(Text)
    source_message_id: Mapped[str] = mapped_column(String(36))
    repeat_operation_ids: Mapped[list] = mapped_column(JSON, default=list)
    dependencies: Mapped[list] = mapped_column(JSON, default=list)
    tools: Mapped[list] = mapped_column(JSON, default=list)
    formats: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(30), default="pending")
    output: Mapped[dict] = mapped_column(JSON, default=dict)


class TaskOperation(Record, Base):
    __tablename__ = "task_operations"
    task_id: Mapped[str] = mapped_column(ForeignKey("complex_tasks.id", ondelete="CASCADE"), index=True)
    step_id: Mapped[str] = mapped_column(ForeignKey("task_steps.id", ondelete="CASCADE"), index=True)
    run_id: Mapped[str] = mapped_column(String(36))
    revision: Mapped[int] = mapped_column(Integer, default=1)
    tool_id: Mapped[str] = mapped_column(String(100))
    fingerprint: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(30), default="started")
    policy: Mapped[str] = mapped_column(String(30), default="external")
    arguments: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)


class RunEvent(Base):
    __tablename__ = "run_events"
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    run_id: Mapped[str] = mapped_column(
        ForeignKey("runs.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(30))
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class Goal(Record, Base):
    __tablename__ = "goals"
    title: Mapped[str] = mapped_column(String(200))
    objective: Mapped[str] = mapped_column(Text, default="")
    foundation: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="draft")
    course_version: Mapped[int] = mapped_column(Integer, default=1)
    current_node_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class KnowledgeNode(Record, Base):
    __tablename__ = "knowledge_nodes"
    goal_id: Mapped[str] = mapped_column(
        ForeignKey("goals.id", ondelete="CASCADE"), index=True
    )
    ordinal: Mapped[int] = mapped_column(Integer)
    module: Mapped[str] = mapped_column(String(200))
    title: Mapped[str] = mapped_column(String(200))
    objective: Mapped[str] = mapped_column(Text)
    prerequisites: Mapped[list] = mapped_column(JSON, default=list)
    exercise_type: Mapped[str] = mapped_column(String(40), default="question")
    criteria: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(30), default="not_started")
    review_at: Mapped[str | None] = mapped_column(String(40), nullable=True)


class Lesson(Record, Base):
    __tablename__ = "lessons"
    node_id: Mapped[str] = mapped_column(
        ForeignKey("knowledge_nodes.id", ondelete="CASCADE"), index=True
    )
    content: Mapped[str] = mapped_column(Text)
    exercise: Mapped[str] = mapped_column(Text)
    hints: Mapped[list] = mapped_column(JSON, default=list)
    criteria: Mapped[str] = mapped_column(Text)
    feedback: Mapped[dict] = mapped_column(JSON, default=dict)
    graph_thread_id: Mapped[str] = mapped_column(String(100), unique=True)
    state: Mapped[str] = mapped_column(String(30), default="awaiting_submission")


class Attempt(Record, Base):
    __tablename__ = "attempts"
    lesson_id: Mapped[str] = mapped_column(
        ForeignKey("lessons.id", ondelete="CASCADE"), index=True
    )
    submission_id: Mapped[str] = mapped_column(String(100), unique=True)
    answer: Mapped[str] = mapped_column(Text)
    attachment_ids: Mapped[list] = mapped_column(JSON, default=list)
    feedback: Mapped[dict] = mapped_column(JSON, default=dict)


class Memory(Record, Base):
    __tablename__ = "memories"
    content: Mapped[str] = mapped_column(Text)
    category: Mapped[str] = mapped_column(String(30), default="fact")
    source: Mapped[str] = mapped_column(Text, default="用户手动记录")
    state: Mapped[str] = mapped_column(String(20), default="confirmed")
    evidence: Mapped[str] = mapped_column(Text, default="")
    review_reason: Mapped[str] = mapped_column(String(300), default="")
    source_conversation_id: Mapped[str | None] = mapped_column(
        String(36), nullable=True
    )
    source_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    replaces_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    replaces_revision: Mapped[int | None] = mapped_column(Integer, nullable=True)
    revision: Mapped[int] = mapped_column(Integer, default=1)


class MemoryChange(Record, Base):
    __tablename__ = "memory_changes"
    memory_id: Mapped[str] = mapped_column(String(36), index=True)
    run_id: Mapped[str] = mapped_column(String(36), index=True)
    source_message_id: Mapped[str] = mapped_column(String(36), index=True)
    before: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after: Mapped[dict] = mapped_column(JSON)
    undone: Mapped[bool] = mapped_column(Boolean, default=False)


class Reminder(Record, Base):
    __tablename__ = "reminders"
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    due_at: Mapped[str] = mapped_column(String(40), index=True)
    timezone: Mapped[str] = mapped_column(String(100), default="Asia/Shanghai")
    recurrence: Mapped[str] = mapped_column(String(20), default="none")
    status: Mapped[str] = mapped_column(String(30), default="active")
    plan_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    offset_minutes: Mapped[int] = mapped_column(Integer, default=0)
    position: Mapped[int] = mapped_column(Integer, default=0)
    plan_occurrence_start: Mapped[str | None] = mapped_column(String(40), nullable=True)


class Notification(Record, Base):
    __tablename__ = "notifications"
    __table_args__ = (UniqueConstraint("reminder_id", "occurrence_at"),)
    reminder_id: Mapped[str] = mapped_column(
        ForeignKey("reminders.id", ondelete="CASCADE"), index=True
    )
    occurrence_at: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    overdue: Mapped[bool] = mapped_column(Boolean, default=False)
    plan_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    plan_occurrence_start: Mapped[str | None] = mapped_column(String(40), nullable=True)
    snoozed_until: Mapped[str | None] = mapped_column(String(40), nullable=True)
    generation: Mapped[int] = mapped_column(Integer, default=0)


class WechatState(Base):
    __tablename__ = "wechat_state"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    data: Mapped[dict] = mapped_column(JSON, default=dict)


class WechatInbox(Base):
    __tablename__ = "wechat_inbox"
    id: Mapped[str] = mapped_column(Text, primary_key=True)
    run_id: Mapped[str] = mapped_column(String(36))


class WechatDelivery(Record, Base):
    __tablename__ = "wechat_deliveries"
    source_key: Mapped[str] = mapped_column(Text, unique=True)
    account_id: Mapped[str] = mapped_column(Text)
    notification_id: Mapped[str | None] = mapped_column(String(36), nullable=True)
    content: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30), default="pending")
    error: Mapped[str] = mapped_column(Text, default="")


class CalendarEvent(Record, Base):
    __tablename__ = "calendar_events"
    title: Mapped[str] = mapped_column(String(300))
    notes: Mapped[str] = mapped_column(Text, default="")
    start: Mapped[str] = mapped_column(String(40), index=True)
    end: Mapped[str] = mapped_column(String(40))
    all_day: Mapped[bool] = mapped_column(Boolean, default=False)
    timezone: Mapped[str] = mapped_column(String(100), default="Asia/Shanghai")
    status: Mapped[str] = mapped_column(String(20), default="planned")
    reminder_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    reminder_time: Mapped[str] = mapped_column(String(5), default="09:00")
    reminder_at: Mapped[str | None] = mapped_column(String(40), nullable=True)
    recurrence: Mapped[str] = mapped_column(String(20), default="none")
    repeat_interval: Mapped[int] = mapped_column(Integer, default=1)
    repeat_until: Mapped[str | None] = mapped_column(String(10), nullable=True)
    repeat_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    calendar_display: Mapped[str] = mapped_column(String(20), default="summary")
    reminder_offsets: Mapped[list] = mapped_column(JSON, default=lambda: [0])
    reminder_id: Mapped[str | None] = mapped_column(ForeignKey("reminders.id", ondelete="SET NULL"), nullable=True)
    source_message_id: Mapped[str | None] = mapped_column(String(36), nullable=True)


class CalendarBatch(Base):
    __tablename__ = "calendar_batches"
    source_message_id: Mapped[str] = mapped_column(String(36), primary_key=True)
    event_ids: Mapped[list] = mapped_column(JSON, default=list)


class PlanOccurrence(Base):
    __tablename__ = "plan_occurrences"
    plan_id: Mapped[str] = mapped_column(ForeignKey("calendar_events.id", ondelete="CASCADE"), primary_key=True)
    start: Mapped[str] = mapped_column(String(40), primary_key=True)
    status: Mapped[str] = mapped_column(String(20), default="completed")
    completed_at: Mapped[str] = mapped_column(String(40), default=now)
    override: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class PlanSegment(Base):
    __tablename__ = "plan_segments"
    plan_id: Mapped[str] = mapped_column(ForeignKey("calendar_events.id", ondelete="CASCADE"), primary_key=True)
    from_day: Mapped[str] = mapped_column(String(10), primary_key=True)
    value: Mapped[dict] = mapped_column(JSON)


class Skill(Record, Base):
    __tablename__ = "skills"
    __table_args__ = (UniqueConstraint("profile_id", "name"),)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str] = mapped_column(Text)
    body: Mapped[str] = mapped_column(Text)
    digest: Mapped[str] = mapped_column(String(64))
    files: Mapped[list] = mapped_column(JSON, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    scripts_allowed: Mapped[bool] = mapped_column(Boolean, default=False)


class SkillRuntime(Base):
    __tablename__ = "skill_runtimes"
    name: Mapped[str] = mapped_column(String(20), primary_key=True)
    path: Mapped[str] = mapped_column(Text, default="")


class Artifact(Record, Base):
    __tablename__ = "artifacts"
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(300))
    media_type: Mapped[str] = mapped_column(String(100))
    storage_name: Mapped[str] = mapped_column(String(100))
    source_url: Mapped[str] = mapped_column(Text, default="")


class Attachment(Record, Base):
    __tablename__ = "attachments"
    name: Mapped[str] = mapped_column(String(300))
    media_type: Mapped[str] = mapped_column(String(60))
    width: Mapped[int] = mapped_column(Integer)
    height: Mapped[int] = mapped_column(Integer)


class OfficeFile(Base):
    __tablename__ = "office_files"
    id: Mapped[str] = mapped_column(ForeignKey("attachments.id", ondelete="CASCADE"), primary_key=True)
    conversation_id: Mapped[str | None] = mapped_column(ForeignKey("conversations.id", ondelete="SET NULL"), nullable=True, index=True)
    size: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(20), default="queued")
    error: Mapped[str] = mapped_column(Text, default="")
    chunks: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)


engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 20}
    if DATABASE_URL.startswith("sqlite")
    else {},
)
if DATABASE_URL.startswith("sqlite"):

    @event.listens_for(engine, "connect")
    def configure_sqlite(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")


Session = sessionmaker(engine, expire_on_commit=False)


def migrate() -> None:
    from pathlib import Path

    from alembic import command
    from alembic.config import Config

    config = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    config.set_main_option(
        "script_location", str(Path(__file__).resolve().parents[1] / "migrations")
    )
    config.set_main_option("sqlalchemy.url", DATABASE_URL.replace("%", "%%"))
    command.upgrade(config, "head")
    with Session() as db:
        if not db.get(Settings, PROFILE_ID):
            db.add(Settings(id=PROFILE_ID))
        # A crashed process cannot continue a half-finished provider request.
        for run in db.query(Run).filter(Run.status.in_(["queued", "running"])):
            run.status = "failed"
            run.error = "服务已重启，之前的执行被中断。请重试。"
        db.commit()
