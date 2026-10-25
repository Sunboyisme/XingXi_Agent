from datetime import datetime
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    field_validator,
    model_validator,
)


class ReadModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


class RecordRead(ReadModel):
    id: str
    created_at: str
    updated_at: str


class DataRead(BaseModel):
    directory: str
    database: str
    attachments: str
    storage: str
    counts: dict[str, int]
    pending: bool
    last_import: dict | None = None


class DataExportRead(BaseModel):
    name: str
    path: str
    counts: dict[str, int]


class DataImportRead(BaseModel):
    id: str
    created_at: str
    counts: dict[str, int]


class DataImportWrite(BaseModel):
    id: str = Field(pattern=r"^[a-f0-9]{32}$")


ProviderId = Literal["bailian", "deepseek", "kimi", "zhipu", "siliconflow", "custom"]
ThinkingMode = Literal[
    "auto", "none", "always", "enable_thinking", "thinking", "reasoning_effort"
]


class ModelOption(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    vision_enabled: bool = False
    thinking_mode: ThinkingMode = "auto"

    @field_validator("name")
    @classmethod
    def model_name(cls, value):
        if not value.strip():
            raise ValueError("模型名称不能为空")
        return value.strip()


class ModelOptionRead(ModelOption):
    thinking_control: ThinkingMode


class ProviderWrite(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    provider_type: ProviderId = "custom"
    label: str = Field(default="", max_length=100)
    model_url: HttpUrl
    models: list[ModelOption] = Field(default_factory=list, max_length=50)
    default_model: str = Field(default="", max_length=200)
    api_key: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def valid_models(self):
        self.default_model = self.default_model.strip()
        if (
            self.model_url.username
            or self.model_url.password
            or self.model_url.query
            or self.model_url.fragment
        ):
            raise ValueError("接口地址不能包含凭据、查询参数或片段")
        names = [x.name for x in self.models]
        if len(set(names)) != len(names) or (
            self.default_model and self.default_model not in names
        ):
            raise ValueError("模型名称不能重复，默认模型必须在模型列表中")
        if names and not self.default_model:
            self.default_model = names[0]
        return self


class ProviderRead(BaseModel):
    id: str
    provider_type: ProviderId
    label: str
    model_url: str
    models: list[ModelOptionRead]
    default_model: str
    key_configured: bool


class ProviderPresetRead(BaseModel):
    id: ProviderId
    label: str
    model_url: str
    models: list[ModelOptionRead]


class ModelSelection(BaseModel):
    provider_id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    model_name: str = Field(min_length=1, max_length=200)
    thinking_enabled: bool = False


class SettingsRead(BaseModel):
    model_url: str
    model_name: str
    vision_enabled: bool
    timezone: str
    memory_mode: Literal["auto", "confirm"]
    model_configured: bool
    search_configured: bool
    providers: list[ProviderRead]
    default_provider: str
    provider_presets: list[ProviderPresetRead]


class ToolRead(BaseModel):
    id: str
    name: str
    description: str
    available: bool
    note: str
    enabled: bool
    source: Literal["builtin", "mcp"]
    source_label: str
    server_id: str | None = None
    parameters: dict = Field(default_factory=dict)


class ToolUpdate(BaseModel):
    enabled: bool


class MCPServerWrite(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=100)
    transport: Literal["stdio", "streamable_http"]
    url: str = Field(default="", max_length=2048)
    command: str = Field(default="", max_length=2048)
    args: list[str] = Field(default_factory=list, max_length=100)
    cwd: str = Field(default="", max_length=2048)
    headers: dict[str, str | None] = Field(default_factory=dict)
    env: dict[str, str | None] = Field(default_factory=dict)
    clear_headers: list[str] = Field(default_factory=list)
    clear_env: list[str] = Field(default_factory=list)
    enabled: bool = False

    @model_validator(mode="after")
    def connection(self):
        import re
        from pathlib import Path
        from urllib.parse import urlsplit

        if self.transport == "stdio":
            if not self.command or self.url or self.headers:
                raise ValueError("本地服务需要命令，不能同时配置 URL 或请求头")
            if self.cwd and not Path(self.cwd).is_absolute():
                raise ValueError("工作目录需要绝对路径")
        else:
            try:
                value = urlsplit(self.url)
                valid = value.scheme in {"http", "https"} and bool(value.hostname)
                valid = valid and not (
                    value.username or value.password or value.fragment or value.query
                )
                _ = value.port  # also validates numeric port syntax
            except ValueError:
                valid = False
            if not valid or self.command or self.args or self.cwd or self.env:
                raise ValueError(
                    "远程服务需要无凭据及查询参数的 HTTP(S) 地址；密钥请填请求头"
                )
        if len(self.headers) + len(self.env) > 100:
            raise ValueError("凭据字段过多")
        for name, value in self.env.items():
            if not re.fullmatch(
                r"[A-Za-z_][A-Za-z0-9_]*", name
            ) or name.upper().startswith("BAI_"):
                raise ValueError("环境变量名称无效或为XiaoXi保留名称")
            if value and (len(value) > 8192 or "\0" in value):
                raise ValueError("环境变量值无效")
        for name, value in self.headers.items():
            if not re.fullmatch(r"[A-Za-z0-9_-]+", name) or name.lower() in {
                "host",
                "content-length",
                "connection",
            }:
                raise ValueError("请求头名称无效")
            if value and (len(value) > 8192 or any(c in value for c in "\r\n\0")):
                raise ValueError("请求头值无效")
        if any(
            "\0" in x or len(x) > 8192 for x in [self.command, self.cwd, *self.args]
        ):
            raise ValueError("命令或参数无效")
        return self


class MCPServerRead(BaseModel):
    id: str
    name: str
    transport: Literal["stdio", "streamable_http"]
    url: str
    command: str
    args: list[str]
    cwd: str
    headers: dict[str, bool]
    env: dict[str, bool]
    headers_templates: dict[str, str] = Field(default_factory=dict)
    env_templates: dict[str, str] = Field(default_factory=dict)
    enabled: bool
    status: Literal["disabled", "disconnected", "connecting", "connected", "error"]
    error: str
    tested_at: str | None
    tool_count: int


class MCPImport(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mcpServers: dict[str, dict] = Field(min_length=1, max_length=50)


class WechatDeliveryRead(BaseModel):
    id: str
    status: str
    error: str
    created_at: str
    diagnostics: dict = Field(default_factory=dict)


class WechatStatus(BaseModel):
    enabled: bool
    bound: bool
    reminders_enabled: bool
    phase: str
    qr_image: str
    error: str
    deliveries: list[WechatDeliveryRead]
    receive_error: str = ""
    send_error: str = ""
    send_state: str = "unbound"
    last_connected_at: str = ""
    last_received_at: str = ""
    last_send_at: str = ""


class WechatTestMessage(BaseModel):
    request_id: str = Field(pattern=r"^[0-9a-fA-F-]{36}$")


class WechatOptions(BaseModel):
    enabled: bool
    reminders_enabled: bool = False


class WechatVerify(BaseModel):
    code: str = Field(pattern=r"^[0-9]{4,8}$")


class SettingsUpdate(BaseModel):
    model_url: HttpUrl = "https://api.openai.com/v1"
    model_name: str = Field(default="", max_length=200)
    model_key: str | None = Field(default=None, max_length=4096)
    search_key: str | None = Field(default=None, max_length=4096)
    vision_enabled: bool = False
    timezone: str = "Asia/Shanghai"
    memory_mode: Literal["auto", "confirm"] | None = None
    providers: list[ProviderWrite] | None = Field(default=None, max_length=50)
    default_provider: str | None = Field(
        default=None, pattern=r"^[a-z][a-z0-9_-]{0,63}$"
    )

    @model_validator(mode="after")
    def provider_list(self):
        if self.providers is not None:
            ids = [x.id for x in self.providers]
            if len(set(ids)) != len(ids):
                raise ValueError("服务商不能重复")
        return self

    @field_validator("model_url")
    @classmethod
    def credentials(cls, value):
        if value.username or value.password:
            raise ValueError("接口地址不能包含用户名或密码，请单独填写 API 密钥")
        return value

    @field_validator("timezone")
    @classmethod
    def zone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("无效时区")
        return value


class MemorySettingsUpdate(BaseModel):
    memory_mode: Literal["auto", "confirm"]


class ConversationCreate(BaseModel):
    title: str = Field(default="新对话", max_length=200)
    project_id: str | None = None
    pinned: bool = False


class ConversationUpdate(BaseModel):
    project_id: str | None = None
    pinned: bool | None = None
    title: str | None = Field(default=None, min_length=1, max_length=200)


class ConversationRead(RecordRead):
    title: str
    restricted_files: bool = False
    project_id: str | None = None
    pinned_at: str | None = None


class ProjectWrite(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    instructions: str = Field(default="", max_length=12000)
    workspace_path: str = Field(default="", max_length=4096)


class ProjectRead(RecordRead):
    name: str
    instructions: str
    workspace_path: str = ""


class ProjectMaterialCreate(BaseModel):
    file_id: str
    conversation_id: str


class MessageRead(RecordRead):
    role: str
    content: str
    attachment_ids: list[str]
    local_references: list[dict] = Field(default_factory=list)
    reasoning: str = ""
    run_id: str | None = None
    run_status: str | None = None
    task_id: str | None = None
    has_learning_continuation: bool = False


class ImageGenerationWrite(BaseModel):
    enabled: bool = False
    url: HttpUrl = "https://api.openai.com/v1"
    model: str = Field(default="", max_length=200)
    api_key: str | None = Field(default=None, max_length=4096)
    size: str = Field(default="", max_length=32, pattern=r"^(?:|auto|[1-9]\d{1,4}x[1-9]\d{1,4})$")
    response_format: Literal["auto", "b64_json", "url"] = "auto"

    @model_validator(mode="after")
    def valid_connection(self):
        if isinstance(self.url, str):
            self.url = HttpUrl(self.url)
        if self.url.username or self.url.password or self.url.query or self.url.fragment:
            raise ValueError("接口地址不能包含凭据、查询参数或片段")
        self.model = self.model.strip()
        if self.enabled and not self.model:
            raise ValueError("请填写图片生成模型名称")
        return self


class ImageGenerationRead(BaseModel):
    enabled: bool = False
    url: str = "https://api.openai.com/v1"
    model: str = ""
    size: str = ""
    response_format: Literal["auto", "b64_json", "url"] = "auto"
    key_configured: bool = False


class ImageGenerationTestRead(BaseModel):
    ok: bool
    message: str
    protocol: str
    endpoint: str
    model: str
    width: int | None = None
    height: int | None = None
    http_status: int | None = None


class EmbeddingWrite(BaseModel):
    enabled: bool = False
    url: HttpUrl = "https://api.openai.com/v1"
    model: str = Field(default="", max_length=200)
    api_key: str | None = Field(default=None, max_length=4096)

    @model_validator(mode="after")
    def valid_embedding(self):
        if isinstance(self.url, str):
            self.url = HttpUrl(self.url)
        if (
            self.url.username
            or self.url.password
            or self.url.query
            or self.url.fragment
        ):
            raise ValueError("接口地址不能包含凭据、查询参数或片段")
        self.model = self.model.strip()
        if self.enabled and not self.model:
            raise ValueError("请填写 Embedding 模型名称")
        return self


class EmbeddingRead(BaseModel):
    enabled: bool = False
    url: str = "https://api.openai.com/v1"
    model: str = ""
    key_configured: bool = False
    indexed: int = 0
    total: int = 0
    indexing: bool = False
    error: str = ""


class RetrievalInput(BaseModel):
    query: str = Field(min_length=1, max_length=4000)


class RetrievalCandidateRead(BaseModel):
    id: str
    content: str
    source: str
    revision: int
    keyword_score: float = 0
    semantic_score: float | None = None
    fusion_score: float = 0
    selected: bool = False
    reason: str


class RetrievalRead(BaseModel):
    query: str
    purpose: str = "preview"
    mode: Literal["hybrid", "keyword"]
    fallback_reason: str = ""
    indexed: int
    total: int
    threshold: float
    token_budget: int
    tokens_used: int
    duration_ms: int
    selected_ids: list[str]
    candidates: list[RetrievalCandidateRead]


class ChatInput(BaseModel):
    content: str = Field(min_length=1, max_length=30000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=4)
    local_references: list[str] = Field(default_factory=list, max_length=4)
    model_selection: ModelSelection | None = None


class ChatRetry(BaseModel):
    model_selection: ModelSelection | None = None
    source_run_id: str | None = None


class RunRead(RecordRead):
    retry_action: Literal["none", "retry", "continue"] = "none"
    task_status: str | None = None
    task_id: str | None = None
    kind: str
    status: str
    conversation_id: str | None
    goal_id: str | None
    result: dict
    error: str | None
    usage: dict


class TaskRead(RecordRead):
    resume_run_id: str | None = None
    conversation_id: str
    source_message_id: str
    source_run_id: str | None = None
    status: str
    revision: int
    goal: str
    title: str = ""
    reason: str
    requirements: dict
    steps: list[dict]
    artifacts: list[dict]
    pending_messages: int
    result: dict
    operations: list[dict]


class TaskResolution(BaseModel):
    operation_id: str
    resolution: Literal["retry", "skip", "completed"]


class GoalCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    objective: str = Field(default="", max_length=4000)
    foundation: str = Field(default="", max_length=4000)
    use_beginner_defaults: bool = False
    outcome: str = Field(default="", max_length=4000)
    weekly_minutes: int | None = Field(default=None, ge=1, le=10080)
    target_date: str | None = None

    @field_validator("target_date")
    @classmethod
    def valid_target_date(cls, value):
        if value is None or value == "":
            return None
        if len(value) != 10:
            raise ValueError("目标日期须为 YYYY-MM-DD")
        datetime.strptime(value, "%Y-%m-%d")
        return value


class GoalUpdate(GoalCreate):
    pass


class NodeRead(RecordRead):
    goal_id: str
    ordinal: int
    module: str
    title: str
    objective: str
    prerequisites: list[str]
    exercise_type: str
    status: str
    review_at: str | None


class GoalRead(RecordRead):
    active_run_id: str | None = None
    title: str
    objective: str
    foundation: str
    outcome: str = ""
    weekly_minutes: int | None = None
    target_date: str | None = None
    status: str
    course_version: int
    current_node_id: str | None
    nodes: list[NodeRead]


class LessonRead(RecordRead):
    knowledge_sources: list[dict] = Field(default_factory=list)
    node_id: str
    content: str
    exercise: str
    hints: list[str]
    feedback: dict
    state: str
    session_id: str | None = None

    @field_validator("feedback")
    @classmethod
    def public_feedback(cls, value):
        from .learning_public import public
        return public(value)


class LearningTurnRead(RecordRead):
    lesson_id: str
    submission_id: str
    answer: str
    attachment_ids: list[str]
    feedback: dict
    session_id: str | None = None

    @field_validator("feedback")
    @classmethod
    def public_feedback(cls, value):
        from .learning_public import public
        return public(value)


class Submission(BaseModel):
    submission_id: str = Field(min_length=1, max_length=100)
    answer: str = Field(max_length=30000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=4)
    session_id: str | None = None


class LearningSessionStart(BaseModel):
    node_id: str | None = None
    target_minutes: int | None = Field(default=None, ge=1, le=480)


class LearningLessonRequest(BaseModel):
    session_id: str | None = None


class LearningDraftWrite(BaseModel):
    node_id: str | None = None
    lesson_id: str | None = None
    answer: str = Field(default="", max_length=30000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=4)
    revision: int | None = Field(default=None, ge=0)


class LearningSessionRead(RecordRead):
    goal_id: str
    node_id: str | None
    lesson_id: str | None
    target_minutes: int | None
    status: Literal["active", "paused", "ended"]
    summary: str
    gaps: list[str]
    next_step: str
    started_at: str
    paused_at: str | None
    ended_at: str | None
    last_studied_at: str | None
    visited_node_ids: list[str]
    draft: dict
    draft_revision: int
    turns: list[LearningTurnRead] = Field(default_factory=list)


class LearningContinuationRead(BaseModel):
    goal_id: str
    goal_title: str
    goal_status: str
    node_id: str | None
    node_title: str
    lesson_id: str | None
    session_id: str | None
    status: str
    summary: str
    gaps: list[str]
    next_step: str
    last_studied_at: str | None


class MemoryCreate(BaseModel):
    content: str = Field(min_length=1, max_length=6000)
    category: Literal["fact", "preference", "project"] = "fact"
    source: str = Field(default="用户手动记录", max_length=1000)
    state: Literal["confirmed", "candidate"] = "confirmed"
    revision: int | None = Field(default=None, ge=1)


class MemoryRead(RecordRead):
    project_id: str | None = None
    content: str
    category: str
    source: str
    state: str
    evidence: str
    review_reason: str
    source_conversation_id: str | None
    source_message_id: str | None
    replaces_id: str | None
    revision: int


class MemoryConfirm(BaseModel):
    revision: int = Field(ge=1)


class ReminderCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    body: str = Field(default="", max_length=6000)
    due_at: datetime
    timezone: str = "Asia/Shanghai"
    recurrence: Literal["none", "daily", "weekly"] = "none"

    @field_validator("due_at")
    @classmethod
    def aware(cls, value):
        if value.tzinfo is None:
            raise ValueError("提醒时间必须包含时区")
        return value

    @field_validator("timezone")
    @classmethod
    def zone(cls, value):
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError("无效时区")
        return value


class ReminderRead(RecordRead):
    calendar_event_id: str | None = None
    title: str
    body: str
    due_at: str
    timezone: str
    recurrence: str
    status: str


class ReminderAction(BaseModel):
    action: Literal["complete", "cancel", "snooze", "reactivate"]
    minutes: int = Field(default=10, ge=1, le=10080)


class NotificationRead(RecordRead):
    reminder_id: str
    occurrence_at: str
    title: str
    body: str
    status: str
    overdue: bool
    todo_id: str | None = None
    plan_id: str | None = None
    plan_occurrence_start: str | None = None
    snoozed_until: str | None = None
    generation: int = 0


class NotificationSnooze(BaseModel):
    minutes: int = Field(default=10, ge=1, le=10080)


class AttachmentRead(RecordRead):
    name: str
    media_type: str
    width: int
    height: int
    size: int = 0
    file_status: str | None = None
    error: str = ""
    warnings: list[str] = Field(default_factory=list)
    parts: int = 0


class CourseNode(BaseModel):
    key: str = Field(min_length=1, max_length=100)
    module: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    objective: str = Field(min_length=1, max_length=4000)
    prerequisites: list[str] = Field(default_factory=list)
    exercise_type: Literal["question", "practice", "case", "code"]
    criteria: str = Field(min_length=1, max_length=4000)


class CoursePlan(BaseModel):
    overview: str
    nodes: list[CourseNode] = Field(min_length=3, max_length=30)

    @field_validator("nodes")
    @classmethod
    def validate_order(cls, nodes):
        seen = set()
        for node in nodes:
            if node.key in seen or any(key not in seen for key in node.prerequisites):
                raise ValueError("知识点不能重名，前置知识点必须在当前点之前")
            seen.add(node.key)
        return nodes


class LessonContent(BaseModel):
    content: str = Field(min_length=1)
    exercise: str = Field(min_length=1, description="需要用户回答的要求按1.、2.、3.的Markdown有序列表逐项列出，一个问题对应一个序号。")
    hints: list[str]
    criteria: str = Field(min_length=1)


class Feedback(BaseModel):
    explanation: str = Field(description="首先输出可直接展示给用户的简短解答或反馈，再输出其他字段。")
    response_type: Literal["feedback", "discussion"] = "feedback"
    passed: bool
    strengths: list[str]
    gaps: list[str]
    next_step: str
    evidence: str
    reference_answer: str = Field(default="", description="练习未通过或用户求助时，直接给出当前题的完整参考答案与简短原因，不要求反复补填。")
    next_exercise: str = Field(default="", description="仅在本节尚未给过巩固题且用户愿意继续时，可给一道可选的小题；否则留空。")
    next_criteria: str = Field(default="", description="与新题配套的简明判断标准；不沿用原题中已不相关的要求。")

    @model_validator(mode="after")
    def validate_feedback(self):
        if bool(self.next_exercise.strip()) != bool(self.next_criteria.strip()):
            raise ValueError("新题和新题判断标准必须配套返回")
        if self.response_type == "feedback" and not self.passed:
            if not self.reference_answer.strip():
                raise ValueError("练习未通过时必须直接给参考答案")
        return self
