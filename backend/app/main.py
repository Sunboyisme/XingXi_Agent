import asyncio
import hmac
import io
import json
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import Depends, FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver
from langgraph.types import Command
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import select

from . import features, skills, office, complex_tasks, conversation_cleanup, projects, artifacts, local_files, learning_sessions, learning_handoff, usage_cost, restricted_files, learning_workflows
from .learning_public import LEARNING_KINDS, public as public_learning
from . import composer_suggestions
from . import (
    agent,
    data_transfer,
    learning,
    mcp_service,
    memory,
    model_profiles,
    provider,
    reminders,
    plans,
    retrieval,
    runs,
    tools,
    wechat,
)
from . import (
    db as store,
)
from . import (
    schemas as s,
)
from .config import (
    ATTACHMENTS_DIR,
    AUTH_TOKEN,
    DATA_DIR,
    PROFILE_ID,
    frontend_origins,
    secret_get,
    secret_set,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    data_transfer.recover_interrupted()
    store.migrate()
    data_transfer.apply_pending()
    restricted_files.recover()
    usage_cost.recover_interrupted()
    office.recover_uploads()
    complex_tasks.recover()
    skills.ensure_builtin()
    retrieval.last_error = ""
    retrieval_task = asyncio.create_task(retrieval.worker())
    mcp_service.manager = mcp_service.MCPManager()
    with store.Session() as db:
        for server in db.scalars(
            select(store.MCPServer).where(store.MCPServer.enabled.is_(True))
        ):
            mcp_service.manager.start(server)
    async with AsyncSqliteSaver.from_conn_string(
        str(DATA_DIR / "checkpoints.sqlite")
    ) as saver:
        await saver.setup()
        app.state.tutor = learning.build_graph(saver)
        scheduler = AsyncIOScheduler(timezone="UTC")
        scheduler.add_job(
            reminders.tick,
            "interval",
            seconds=3,
            id="reminders",
            max_instances=1,
            coalesce=True,
        )
        scheduler.start()
        await reminders.tick()
        app.state.wechat = wechat.WechatChannel()
        app.state.wechat.start()
        yield
        await composer_suggestions.close()
        await app.state.wechat.close()
        await skills.close()
        await office.close()
        retrieval_task.cancel()
        await asyncio.gather(retrieval_task, return_exceptions=True)
        scheduler.shutdown(wait=False)
        outstanding = list(runs.tasks.values())
        for task in outstanding:
            task.cancel()
        if outstanding:
            await asyncio.gather(*outstanding, return_exceptions=True)
        await mcp_service.manager.close()


app = FastAPI(title="XiaoXi API", version="0.1.8", lifespan=lifespan)


# Pydantic's default response includes the rejected input, including credentials.
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, error: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "detail": "输入格式无效，请检查必填项、配置字段和地址；密钥应填写在请求头或环境变量中。"
        },
    )


app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://127.0.0.1:5186",
        "http://localhost:5186",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
        *frontend_origins(),
    ],
    allow_methods=["*"],
    allow_headers=["Authorization", "Content-Type"],
)


def auth(request: Request):
    value = request.headers.get("Authorization", "")
    if not hmac.compare_digest(value, "Bearer " + AUTH_TOKEN):
        raise HTTPException(401, "应用连接未认证，请通过 XiaoXi 启动。")


def database():
    with store.Session() as db:
        yield db


def item(db, model, item_id):
    value = db.get(model, item_id)
    if not value or getattr(value, "profile_id", PROFILE_ID) != PROFILE_ID:
        raise HTTPException(404, "记录不存在")
    return value


def goal_read(db, goal):
    values = {
        key: getattr(goal, key) for key in s.GoalRead.model_fields if key not in {"nodes", "active_run_id"}
    }
    nodes = [
        s.NodeRead.model_validate(n)
        for n in db.scalars(
            select(store.KnowledgeNode)
            .where(store.KnowledgeNode.goal_id == goal.id)
            .order_by(store.KnowledgeNode.ordinal)
        )
    ]
    active = db.scalar(select(store.Run.id).where(store.Run.goal_id == goal.id, store.Run.status.in_(["queued", "running"])))
    return s.GoalRead(**values, nodes=nodes, active_run_id=active)


def settings_read(db):
    value = db.get(store.Settings, PROFILE_ID)
    profiles = model_profiles.profiles(value)
    for profile in profiles:
        profile["key_configured"] = bool(secret_get(model_profiles.secret_ref(profile["id"])))
    return s.SettingsRead(
        model_url=value.model_url,
        model_name=value.model_name,
        vision_enabled=value.vision_enabled,
        timezone=value.timezone,
        memory_mode=value.memory_mode,
        model_configured=bool(value.model_name.strip() and secret_get(model_profiles.secret_ref(value.default_provider))),
        search_configured=bool(secret_get("search")),
        providers=profiles,
        default_provider=value.default_provider,
        provider_presets=model_profiles.presets(),
    )


def create_run(db, kind, conversation_id=None, goal_id=None, *, commit=True):
    if kind in LEARNING_KINDS:
        learning_workflows.assert_open(goal_id)
    query = select(store.Run).where(store.Run.status.in_(["queued", "running"]))
    query = (
        query.where(store.Run.conversation_id == conversation_id)
        if conversation_id
        else query.where(store.Run.goal_id == goal_id) if goal_id
        else query.where(store.Run.kind == kind, store.Run.conversation_id.is_(None))
    )
    if db.scalar(query):
        raise HTTPException(409, "当前还有任务正在执行，请等待或停止后重试。")
    value = store.Run(kind=kind, conversation_id=conversation_id, goal_id=goal_id)
    db.add(value)
    if commit:
        db.commit()
    else:
        db.flush()
    return value


@app.get("/api/v1/health")
def health():
    return {"service": "bai-agent", "version": "0.1.8"}


from fastapi import APIRouter

router = APIRouter(prefix="/api/v1", dependencies=[Depends(auth)])


def data_idle():
    with store.Session() as db:
        active = db.scalar(select(store.Run.id).where(store.Run.status.in_(["queued", "running"])))
    if active or runs.tasks or retrieval.indexing or office.tasks:
        raise HTTPException(409, "请等待当前任务、文件解析和记忆索引完成后再操作数据。")
    if wechat.read_state().get("enabled"):
        raise HTTPException(409, "请先暂停微信连接，再操作数据。")


@router.get("/settings/data", response_model=s.DataRead)
def data_settings():
    return data_transfer.info()


@router.post("/settings/data/export", response_model=s.DataExportRead)
async def export_data():
    data_idle()
    return data_transfer.create_archive()


@router.get("/settings/data/exports/{name}")
def download_data(name: str):
    import re
    if not re.fullmatch(r"XiaoXi-data-[A-Za-z0-9-]+\.zip", name):
        raise HTTPException(404, "数据文件不存在")
    path = DATA_DIR / "exports" / name
    if not path.is_file():
        raise HTTPException(404, "数据文件不存在")
    return FileResponse(path, media_type="application/zip", filename=name)


@router.post("/settings/data/inspect", response_model=s.DataImportRead)
async def inspect_data(file: UploadFile = File(...)):
    import tempfile
    size = 0
    with tempfile.TemporaryFile() as temporary:
        while chunk := await file.read(1024 * 1024):
            size += len(chunk)
            if size > data_transfer.LIMIT:
                raise HTTPException(413, "数据文件不能超过 512 MB")
            temporary.write(chunk)
        temporary.seek(0)
        return data_transfer.inspect_archive(temporary)


@router.post("/settings/data/import")
async def import_data(value: s.DataImportWrite):
    data_idle()
    return data_transfer.stage_import(value.id)


@router.delete("/settings/data/import")
async def cancel_data_import():
    return data_transfer.cancel_import()


@router.get("/settings", response_model=s.SettingsRead)
def get_settings(db=Depends(database)):
    return settings_read(db)


@router.get("/settings/embedding", response_model=s.EmbeddingRead)
def embedding_settings():
    return retrieval.status()


@router.get("/settings/image-generation", response_model=s.ImageGenerationRead)
def image_generation_settings():
    from . import image_generation
    return image_generation.settings()


@router.put("/settings/image-generation", response_model=s.ImageGenerationRead)
def save_image_generation(value: s.ImageGenerationWrite, db=Depends(database)):
    from . import image_generation
    key = secret_get("image_generation") if value.api_key is None else value.api_key.strip()
    if value.enabled and not key:
        raise HTTPException(400, "请填写图片生成 API 密钥。")
    secret_set("image_generation", value.api_key)
    db.get(store.Settings, PROFILE_ID).image_generation_config = value.model_dump(
        mode="json", exclude={"api_key"}
    )
    db.commit()
    return image_generation.settings()


@router.post("/settings/image-generation/test", response_model=s.ImageGenerationTestRead)
async def test_image_generation(value: s.ImageGenerationWrite):
    from . import image_generation
    key = secret_get("image_generation") if value.api_key is None else value.api_key.strip()
    if not value.model:
        raise HTTPException(400, "请填写图片模型名称。")
    if not key:
        raise HTTPException(400, "请填写图片 API 密钥。")
    return await image_generation.probe(value.model_dump(mode="json", exclude={"api_key"}), key)


@router.put("/settings/embedding", response_model=s.EmbeddingRead)
def save_embedding(value: s.EmbeddingWrite, db=Depends(database)):
    key = secret_get("embedding") if value.api_key is None else value.api_key.strip()
    if value.enabled and not key:
        raise HTTPException(400, "请填写 Embedding API 密钥。")
    secret_set("embedding", value.api_key)
    db.get(store.Settings, PROFILE_ID).embedding_config = {
        "enabled": value.enabled, "url": str(value.url).rstrip("/"), "model": value.model,
    }
    db.commit()
    retrieval.last_error = ""
    return retrieval.status()


@router.post("/settings/embedding/test")
async def test_embedding():
    value = retrieval.settings()
    if not value.get("model") or not secret_get("embedding"):
        raise HTTPException(400, "请先保存 Embedding 模型与密钥。")
    try:
        vector = retrieval.checked(await retrieval.client(value, purpose="connection_test").aembed_query("连接测试"))
        return {"ok": True, "dimensions": len(vector)}
    except Exception:
        raise HTTPException(400, "Embedding 连接失败，请检查地址、模型和密钥。") from None


@router.post("/memories/retrieval/preview", response_model=s.RetrievalRead)
async def preview_retrieval(value: s.RetrievalInput):
    if not value.query.strip():
        raise HTTPException(400, "请输入检索问题。")
    _, trace = await retrieval.retrieve_detailed(value.query)
    return trace


@router.get("/runs/{run_id}/retrieval", response_model=list[s.RetrievalRead])
def run_retrieval(run_id: str, db=Depends(database)):
    item(db, store.Run, run_id)
    return [event.data for event in db.scalars(select(store.RunEvent).where(
        store.RunEvent.run_id == run_id, store.RunEvent.kind == "retrieval"
    ).order_by(store.RunEvent.id))]


@router.get("/tools", response_model=list[s.ToolRead])
def get_tools():
    return tools.tool_catalog()


@router.patch("/tools/{tool_id}", response_model=s.ToolRead)
def update_tool(tool_id: str, value: s.ToolUpdate):
    try:
        return tools.set_tool_enabled(tool_id, value.enabled)
    except LookupError as error:
        raise HTTPException(404, str(error)) from None


@router.get("/mcp/servers", response_model=list[s.MCPServerRead])
def get_mcp_servers():
    return mcp_service.list_servers()


@router.post("/mcp/servers", response_model=s.MCPServerRead)
async def create_mcp_server(value: s.MCPServerWrite):
    try:
        server_id = mcp_service.save_servers([value])[0]
        await mcp_service.manager.reload(server_id)
        return next(x for x in mcp_service.list_servers() if x["id"] == server_id)
    except ValueError as error:
        raise HTTPException(400, str(error)) from None
    except Exception:
        raise HTTPException(503, "MCP 配置保存失败，请检查系统凭据存储") from None


@router.post("/mcp/servers/import", response_model=list[s.MCPServerRead])
async def import_mcp_servers(value: s.MCPImport):
    try:
        # Validate the complete batch before writing any configuration.
        ids = mcp_service.save_servers(mcp_service.parse_import(value))
        return [x for x in mcp_service.list_servers() if x["id"] in ids]
    except ValueError:
        raise HTTPException(
            400, "导入失败：配置字段、传输类型或服务名称无效，请检查预览"
        ) from None
    except Exception:
        raise HTTPException(503, "导入保存失败，请检查系统凭据存储") from None


@router.put("/mcp/servers/{server_id}", response_model=s.MCPServerRead)
async def update_mcp_server(server_id: str, value: s.MCPServerWrite):
    try:
        mcp_service.save_servers([value], server_id)
        await mcp_service.manager.reload(server_id)
        return next(x for x in mcp_service.list_servers() if x["id"] == server_id)
    except LookupError as error:
        raise HTTPException(404, str(error)) from None
    except ValueError as error:
        raise HTTPException(400, str(error)) from None
    except Exception:
        raise HTTPException(503, "MCP 配置保存失败，请检查系统凭据存储") from None


@router.delete("/mcp/servers/{server_id}")
async def delete_mcp_server(server_id: str):
    try:
        async with mcp_service.manager.changes:
            await mcp_service.manager.stop(server_id)
            with store.Session() as db:
                server = mcp_service.require_server(db, server_id)
                for kind in ("headers", "env"):
                    for ref in server.config.get(kind, {}).values():
                        mcp_service.vault.secret_set(ref, "")
                db.delete(server)
                db.commit()
        return {"deleted": True}
    except LookupError as error:
        raise HTTPException(404, str(error)) from None


@router.post("/mcp/servers/{server_id}/test", response_model=s.MCPServerRead)
async def test_mcp_server(server_id: str):
    try:
        await mcp_service.manager.test(server_id)
        return next(x for x in mcp_service.list_servers() if x["id"] == server_id)
    except LookupError as error:
        raise HTTPException(404, str(error)) from None


@router.get("/runs/{run_id}/tools")
def get_run_tools(run_id: str, db=Depends(database)):
    item(db, store.Run, run_id)
    return [
        {"kind": event.kind, "data": event.data}
        for event in db.scalars(
            select(store.RunEvent)
            .where(
                store.RunEvent.run_id == run_id,
                store.RunEvent.kind.in_(["tool", "memory", "reasoning", "context"]),
            )
            .order_by(store.RunEvent.id)
        )
    ]


@router.put("/settings", response_model=s.SettingsRead)
def update_settings(value: s.SettingsUpdate, db=Depends(database)):
    settings = db.get(store.Settings, PROFILE_ID)
    profiles = {x["id"]: x for x in model_profiles.profiles(settings)}
    default_provider = value.default_provider or settings.default_provider
    if value.providers is not None:
        for profile in value.providers:
            profiles[profile.id] = profile.model_dump(mode="json", exclude={"api_key"})
        if value.default_provider and value.default_provider not in profiles:
            raise HTTPException(400, "默认模型连接不存在。")
        if default_provider not in profiles and profiles:
            default_provider = next(iter(profiles))
    try:
        if value.providers is None:
            secret_set("model", value.model_key)
        else:
            for profile in value.providers:
                secret_set(model_profiles.secret_ref(profile.id), profile.api_key)
        secret_set("search", value.search_key)
    except Exception:
        raise HTTPException(
            503, "系统凭据存储不可用，密钥未写入普通文件。请检查 Windows 凭据管理。"
        )
    if value.providers is None:
        settings.model_url = str(value.model_url).rstrip("/")
        settings.model_name = value.model_name.strip()
        settings.vision_enabled = value.vision_enabled
        # Keep the original API compatible with existing integrations.
        settings.default_provider = "custom"
        settings.model_providers = [x for x in settings.model_providers if x["id"] != "custom"]
    else:
        settings.default_provider = default_provider
        settings.model_providers = [{k: v for k, v in x.items() if k in {"id", "provider_type", "label", "model_url", "models", "default_model"}} for x in profiles.values()]
        model_profiles.sync_default(settings)
    settings.timezone = value.timezone
    if value.memory_mode is not None:
        settings.memory_mode = value.memory_mode
    db.commit()
    return settings_read(db)


@router.delete("/settings/providers/{provider_id}", response_model=s.SettingsRead)
def delete_model_provider(provider_id: str, db=Depends(database)):
    settings = db.get(store.Settings, PROFILE_ID)
    profiles = model_profiles.profiles(settings)
    if not any(x["id"] == provider_id for x in profiles):
        raise HTTPException(404, "模型连接不存在。")
    try:
        secret_set(model_profiles.secret_ref(provider_id), "")
    except Exception:
        raise HTTPException(503, "清除密钥失败，请检查系统凭据存储。") from None
    settings.model_providers = [x for x in profiles if x["id"] != provider_id]
    if settings.default_provider == provider_id:
        settings.default_provider = next((x["id"] for x in settings.model_providers if x["models"]), "custom")
        # Do not recreate a just-deleted legacy connection from the compatibility fields.
        settings.model_name = ""
    model_profiles.sync_default(settings)
    db.commit()
    return settings_read(db)


@router.patch("/settings/memory", response_model=s.SettingsRead)
def update_memory_settings(value: s.MemorySettingsUpdate, db=Depends(database)):
    db.get(store.Settings, PROFILE_ID).memory_mode = value.memory_mode
    db.commit()
    return settings_read(db)


@router.post("/settings/test")
async def test_connection(value: s.ModelSelection | None = None):
    try:
        from langchain_core.messages import HumanMessage

        with store.Session() as db:
            config = model_profiles.resolve(db.get(store.Settings, PROFILE_ID), value)
        await provider.model(config).ainvoke([HumanMessage(content="请只回复：连接成功")])
        return {"ok": True, "message": "模型接口连接成功"}
    except Exception as error:
        raise HTTPException(400, provider.safe_error(error))


@router.post("/settings/providers/models", response_model=list[s.ModelOptionRead])
async def discover_connection_models(value: s.ProviderWrite):
    try:
        return await provider.discover_models(value)
    except provider.ConfigurationError as error:
        raise HTTPException(400, str(error)) from None
    except Exception:
        raise HTTPException(400, "拉取模型失败，请检查当前接口和密钥后重试。") from None


@router.get("/conversations", response_model=list[s.ConversationRead])
def conversations(db=Depends(database)):
    return db.scalars(
        select(store.Conversation).order_by(store.Conversation.updated_at.desc())
    ).all()


@router.post("/conversations", response_model=s.ConversationRead)
def new_conversation(value: s.ConversationCreate, db=Depends(database)):
    if value.project_id:
        projects.require(db, value.project_id)
    record = store.Conversation(title=value.title, project_id=value.project_id,
                                pinned_at=store.now() if value.pinned else None)
    db.add(record)
    db.commit()
    return record


@router.get(
    "/conversations/{conversation_id}/messages", response_model=list[s.MessageRead]
)
def messages(conversation_id: str, db=Depends(database)):
    item(db, store.Conversation, conversation_id)
    records = db.scalars(
        select(store.Message)
        .where(store.Message.conversation_id == conversation_id)
        .order_by(store.Message.created_at, store.MESSAGE_ORDER)
    ).all()
    run_details = {row.id: row for row in db.execute(select(store.Run.id, store.Run.status, store.Run.task_id).where(
        store.Run.conversation_id == conversation_id,
    )).all()}
    learning_cards = set(db.scalars(select(store.RunEvent.run_id).join(store.Run, store.Run.id == store.RunEvent.run_id).where(
        store.Run.conversation_id == conversation_id, store.RunEvent.kind == "learning_continuation")))
    return [s.MessageRead.model_validate(record).model_copy(update={
        "run_status": run_details[record.run_id].status if record.run_id in run_details else None,
        "task_id": run_details[record.run_id].task_id if record.run_id in run_details else None,
        "has_learning_continuation": record.run_id in learning_cards,
    }) for record in records]


@router.post("/conversations/{conversation_id}/messages", response_model=s.RunRead)
async def send_message(conversation_id: str, value: s.ChatInput, db=Depends(database)):
    conversation = item(db, store.Conversation, conversation_id)
    if conversation.restricted_files and (value.attachment_ids or value.local_references):
        raise HTTPException(400, "受限文件任务请通过上方授权面板选择资料，不使用普通附件上传")
    try:
        local_references = local_files.validate_references(value.local_references, len(value.attachment_ids))
    except (ValueError, OSError) as error:
        raise HTTPException(400, str(error)) from None
    active = db.scalar(select(store.Run).where(store.Run.conversation_id == conversation_id,
        store.Run.status.in_(["queued", "running"])))
    if active:
        if not active.task_id:
            raise HTTPException(409, "请等待当前回答完成，或先停止生成。")
        task = complex_tasks.require(db, active.task_id)
        try:
            provider.user_content(value.content, value.attachment_ids, task.model_config)
        except Exception as error:
            raise HTTPException(400, provider.safe_error(error))
        office.claim(db, value.attachment_ids, conversation_id)
        message = store.Message(conversation_id=conversation_id, role="user",
            content=value.content, attachment_ids=value.attachment_ids, local_references=local_references)
        db.add(message)
        db.flush()
        complex_tasks.queue_message(db, task, message)
        db.commit()
        complex_tasks.publish(active.id, task.id)
        return active
    try:
        config = model_profiles.resolve(db.get(store.Settings, PROFILE_ID), value.model_selection)
        restricted_files.check_model(conversation_id, config)
        provider.model(config)
        provider.user_content(value.content, value.attachment_ids, config)
    except Exception as error:
        raise HTTPException(400, provider.safe_error(error))
    run = create_run(db, "chat", conversation_id=conversation_id, commit=False)
    office.claim(db,value.attachment_ids,conversation_id)
    run.model_config = config
    message = store.Message(
            conversation_id=conversation_id,
            role="user",
            content=value.content,
            attachment_ids=value.attachment_ids,
            local_references=local_references,
        )
    db.add(message)
    db.flush()
    run.source_message_id = message.id
    if conversation.title == "新对话":
        conversation.title = value.content[:30]
    conversation.updated_at = store.now()
    db.commit()
    async def operation():
        handoff = None if conversation.restricted_files or value.attachment_ids or local_references else await learning_handoff.handle(run.id, conversation_id, value.content)
        return handoff if handoff is not None else await agent.chat(run.id, conversation_id)
    runs.launch(run.id, operation)
    return run


@router.post("/conversations/{conversation_id}/retry", response_model=s.RunRead)
async def retry_message(conversation_id: str, value: s.ChatRetry | None = None, db=Depends(database)):
    item(db, store.Conversation, conversation_id)
    if db.scalar(select(store.Run.id).where(store.Run.conversation_id == conversation_id,
        store.Run.status.in_(["queued", "running"]))):
        raise HTTPException(409, "请等待当前回答完成，或先停止生成。")
    latest = db.scalar(
        select(store.Message)
        .where(store.Message.conversation_id == conversation_id)
        .order_by(store.Message.created_at.desc(), store.MESSAGE_ORDER.desc())
    )
    previous = db.get(store.Run, value.source_run_id) if value and value.source_run_id else db.scalar(select(store.Run).where(store.Run.conversation_id == conversation_id).order_by(store.Run.created_at.desc()))
    if not previous or previous.conversation_id != conversation_id or retry_action(db, previous) == "none":
        raise HTTPException(409, "这条回答的状态已变化，请刷新后继续当前任务或发送新的要求。")
    source = db.get(store.Message, previous.source_message_id) if previous.source_message_id else None
    if source is None:
        source = db.scalar(select(store.Message).where(
            store.Message.conversation_id == conversation_id, store.Message.role == "user",
        ).order_by(store.Message.created_at.desc(), store.MESSAGE_ORDER.desc()))
    if not source or source.conversation_id != conversation_id:
        raise HTTPException(409, "原始用户消息不存在")
    selection = value.model_selection if value else None
    if selection is None and previous.model_config:
        selection = s.ModelSelection(
            provider_id=previous.model_config["provider_id"],
            model_name=previous.model_config["model_name"],
            thinking_enabled=previous.model_config.get("thinking_enabled", False),
        )
    try:
        config = model_profiles.resolve(db.get(store.Settings, PROFILE_ID), selection)
        restricted_files.check_model(conversation_id, config)
        provider.model(config)
        provider.user_content(source.content, source.attachment_ids, config)
    except Exception as error:
        raise HTTPException(400, provider.safe_error(error))
    run = create_run(db, "chat", conversation_id=conversation_id, commit=False)
    run.model_config = config
    run.source_message_id = source.id
    if previous.task_id:
        run.task_id = previous.task_id
        task = complex_tasks.require(db, previous.task_id)
        task.model_config = config
        task.status, task.reason = "running", ""
    db.commit()
    runs.launch(run.id, lambda: agent.chat(run.id, conversation_id))
    return run


@router.get("/conversations/{conversation_id}/tasks", response_model=list[s.TaskRead])
def conversation_tasks(conversation_id: str, db=Depends(database)):
    item(db, store.Conversation, conversation_id)
    values = db.scalars(select(store.ComplexTask).where(
        store.ComplexTask.conversation_id == conversation_id,
        store.ComplexTask.profile_id == PROFILE_ID,
    ).order_by(store.ComplexTask.updated_at.desc()).limit(30)).all()
    return [complex_tasks.detail(value.id) for value in values]


@router.get("/tasks/{task_id}", response_model=s.TaskRead)
def task_detail(task_id: str):
    return complex_tasks.detail(task_id)


@router.post("/tasks/{task_id}/resume", response_model=s.RunRead)
async def resume_task(task_id: str, value: s.ChatRetry | None = None, db=Depends(database)):
    task = complex_tasks.require(db, task_id)
    if task.status in complex_tasks.TERMINAL:
        raise HTTPException(409, "任务已经结束，请发送新的要求。")
    if task.status == "waiting_input":
        raise HTTPException(409, "请先补充任务要求或核实未知操作结果，再继续任务。")
    if db.scalar(select(store.Run.id).where(
        store.Run.conversation_id == task.conversation_id,
        store.Run.status.in_(["queued", "running"]),
    )):
        raise HTTPException(409, "当前对话仍在执行，请等待完成或先停止。")
    selection = value.model_selection if value else None
    if selection is None and task.model_config:
        selection = s.ModelSelection(provider_id=task.model_config["provider_id"], model_name=task.model_config["model_name"], thinking_enabled=task.model_config.get("thinking_enabled", False))
    try:
        task.model_config = model_profiles.resolve(db.get(store.Settings, PROFILE_ID), selection)
        provider.model(task.model_config)
    except Exception as error:
        raise HTTPException(400, provider.safe_error(error)) from None
    task.status, task.reason = "running", ""
    run = create_run(db, "chat", conversation_id=task.conversation_id, commit=False)
    run.task_id, run.model_config = task.id, task.model_config
    message = store.Message(conversation_id=task.conversation_id, role="user", content="继续此任务。")
    db.add(message)
    db.flush()
    task.message_ids = [*task.message_ids, message.id]
    run.source_message_id = message.id
    db.commit()
    runs.launch(run.id, lambda: agent.chat(run.id, task.conversation_id))
    return run


@router.post("/tasks/{task_id}/cancel", response_model=s.TaskRead)
async def end_task(task_id: str, db=Depends(database)):
    task = complex_tasks.require(db, task_id)
    active = db.scalar(select(store.Run).where(store.Run.task_id == task_id,
        store.Run.status.in_(["queued", "running"])))
    task.status, task.reason = "cancelled", "已结束任务，已有成果保留。"
    db.commit()
    if active and active.id in runs.tasks:
        runs.tasks[active.id].cancel()
    return complex_tasks.detail(task_id)


@router.post("/tasks/{task_id}/resolve", response_model=s.TaskRead)
def resolve_task_operation(task_id: str, value: s.TaskResolution, db=Depends(database)):
    task = complex_tasks.require(db, task_id)
    if task.status in complex_tasks.TERMINAL:
        raise HTTPException(409, "任务已经结束，已有操作记录保留；重新执行请提出新要求。")
    if db.scalar(select(store.Run.id).where(store.Run.task_id == task_id,
        store.Run.status.in_(["queued", "running"]))):
        raise HTTPException(409, "请先停止任务，再核实操作结果。")
    operation = db.get(store.TaskOperation, value.operation_id)
    if not operation or operation.task_id != task_id or operation.status != "unknown":
        raise HTTPException(409, "该操作不需要核实或状态已经变化。")
    labels = {"retry": "我已核对结果，明确要求重新提交此操作。", "skip": "请跳过该操作并调整后续任务。",
              "completed": "我已在外部核实该操作已经完成，请复用此结果，不要再次提交。"}
    message = store.Message(conversation_id=task.conversation_id, role="user",
        content=f"针对任务“{task.goal[:100]}”的操作 {operation.tool_id}：{labels[value.resolution]}")
    db.add(message)
    db.flush()
    task.message_ids = [*task.message_ids, message.id]
    operation.status = {"retry": "failed", "skip": "skipped", "completed": "completed"}[value.resolution]
    if value.resolution == "completed":
        operation.result = {**operation.result, "error": None, "user_verified": True,
            "summary": "用户已在外部核实操作完成；不代表已取得本机文件。"}
    if value.resolution == "skip":
        task.pending_message_ids = [message.id]
    task.status, task.reason = "paused", "核实结果已保存，发送“继续”后恢复。"
    db.commit()
    return complex_tasks.detail(task_id)


@router.delete("/conversations/{conversation_id}")
def delete_conversation(conversation_id: str, db=Depends(database)):
    record = item(db, store.Conversation, conversation_id)
    if db.scalar(
        select(store.Run).where(
            store.Run.conversation_id == conversation_id,
            store.Run.status.in_(["queued", "running"]),
        )
    ):
        raise HTTPException(409, "请先停止正在执行的对话")
    return conversation_cleanup.remove(db, record)


@router.get("/runs", response_model=list[s.RunRead])
def list_runs(
    conversation_id: str | None = None, goal_id: str | None = None, db=Depends(database)
):
    query = select(store.Run).order_by(store.Run.created_at.desc()).limit(30)
    if conversation_id:
        query = query.where(store.Run.conversation_id == conversation_id)
    if goal_id:
        query = query.where(store.Run.goal_id == goal_id)
    return [run_read(db, value) for value in db.scalars(query)]


def retry_action(db, run):
    if not run.conversation_id or run.status in {"queued", "running"}:
        return "none"
    latest_user = db.scalar(select(store.Message).where(store.Message.conversation_id == run.conversation_id, store.Message.role == "user").order_by(store.Message.created_at.desc(), store.MESSAGE_ORDER.desc()))
    if run.task_id:
        task = db.get(store.ComplexTask, run.task_id)
        if task and task.status == "paused" and latest_user and latest_user.id in [*task.message_ids, *task.pending_message_ids]:
            return "continue"
        return "none"
    return "retry" if run.status in {"failed", "cancelled"} and latest_user and latest_user.id == run.source_message_id else "none"


def run_read(db, run):
    task = db.get(store.ComplexTask, run.task_id) if run.task_id else None
    return s.RunRead.model_validate(run).model_copy(update={"retry_action": retry_action(db, run), "task_status": task.status if task else None,
        "result": public_learning(run.result) if run.kind in LEARNING_KINDS else run.result})


@router.get("/runs/{run_id}", response_model=s.RunRead)
def get_run(run_id: str, db=Depends(database)):
    return run_read(db, item(db, store.Run, run_id))


@router.post("/runs/{run_id}/cancel", response_model=s.RunRead)
async def cancel_run(run_id: str, db=Depends(database)):
    value = item(db, store.Run, run_id)
    if restricted_files.restricted(value.conversation_id):
        await asyncio.to_thread(restricted_files.stop, value.conversation_id)
    task = runs.tasks.get(run_id)
    if task:
        task.cancel()
        _, pending = await asyncio.wait({task}, timeout=10)
        if pending:
            raise HTTPException(409, "正在停止当前回答，请稍候再发送。")
    db.refresh(value)
    if value.status in {"queued", "running"}:
        raise HTTPException(409, "当前回答的停止状态尚未同步，请稍候再试。")
    return run_read(db, value)


@router.get("/runs/{run_id}/events")
async def run_events(
    run_id: str, request: Request, after: int = 0, db=Depends(database)
):
    item(db, store.Run, run_id)

    async def stream():
        cursor = after
        while not await request.is_disconnected():
            with store.Session() as session:
                # Observe terminal status before taking the event snapshot. A
                # run finishing between these reads must not lose its tail.
                run = session.get(store.Run, run_id)
                events = session.scalars(
                    select(store.RunEvent)
                    .where(store.RunEvent.run_id == run_id, store.RunEvent.id > cursor)
                    .order_by(store.RunEvent.id)
                ).all()
            for event in events:
                cursor = event.id
                data = public_learning(event.data) if run.kind in LEARNING_KINDS else event.data
                yield f"id: {event.id}\ndata: {json.dumps({'kind': event.kind, 'data': data}, ensure_ascii=False)}\n\n"
            if run.status not in ("queued", "running"):
                break
            if not events:
                yield ": keepalive\n\n"
            await asyncio.sleep(0.08)

    return StreamingResponse(
        stream(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no"}
    )


@router.get("/learning/goals", response_model=list[s.GoalRead])
def goals(db=Depends(database)):
    return [
        goal_read(db, x)
        for x in db.scalars(select(store.Goal).order_by(store.Goal.updated_at.desc()))
    ]


@router.post("/learning/goals", response_model=s.GoalRead)
def create_goal(value: s.GoalCreate, db=Depends(database)):
    details, missing = learning.goal_intake(value.title, value.objective, value.foundation, value.use_beginner_defaults)
    if missing:
        raise HTTPException(422, "请先补充" + "、".join(missing) + "，或明确选择按零基础入门安排。")
    goal = store.Goal(**details, **learning_sessions.goal_options(value))
    db.add(goal)
    db.commit()
    return goal_read(db, goal)


@router.get("/learning/goals/{goal_id}", response_model=s.GoalRead)
def get_goal(goal_id: str, db=Depends(database)):
    return goal_read(db, item(db, store.Goal, goal_id))


@router.post("/learning/goals/{goal_id}/plan", response_model=s.RunRead)
async def plan_course(goal_id: str, db=Depends(database)):
    item(db, store.Goal, goal_id)
    if db.scalar(
        select(store.KnowledgeNode).where(store.KnowledgeNode.goal_id == goal_id)
    ):
        raise HTTPException(409, "已有课程，不会覆盖当前进度")
    run = create_run(db, "course", goal_id=goal_id)
    runs.launch(run.id, lambda: learning.generate_course(goal_id, run.id))
    return run


@router.delete("/learning/goals/{goal_id}")
async def delete_goal(goal_id: str, request: Request, stop: bool = False, db=Depends(database)):
    from sqlalchemy import delete
    goal = item(db, store.Goal, goal_id)
    active = list(db.scalars(select(store.Run).where(store.Run.goal_id == goal_id, store.Run.status.in_(["queued", "running"]))))
    if active and not stop:
        raise HTTPException(409, "学习任务正在运行，请选择停止任务并删除")
    pending = []
    for run in active:
        if run.id in runs.tasks:
            task = runs.tasks[run.id]
            task.cancel()
            pending.append(task)
        else:
            run.status = "cancelled"
    if pending:
        try:
            await asyncio.wait_for(asyncio.gather(*pending, return_exceptions=True), 15)
        except TimeoutError:
            raise HTTPException(409, "学习任务仍在停止中，请稍后再删除") from None
    lesson_ids = select(store.Lesson.id).join(store.KnowledgeNode, store.KnowledgeNode.id == store.Lesson.node_id).where(store.KnowledgeNode.goal_id == goal_id)
    threads = list(db.scalars(select(store.Lesson.graph_thread_id).where(store.Lesson.id.in_(lesson_ids))))
    image_ids = set()
    image_ids.update(learning_sessions.draft_attachment_ids(db, goal_id))
    image_ids.update(learning_workflows.review_attachment_ids(db, goal_id))
    for ids in db.scalars(select(store.Attempt.attachment_ids).where(store.Attempt.lesson_id.in_(lesson_ids))):
        image_ids.update(ids)
    run_ids = select(store.Run.id).where(store.Run.goal_id == goal_id)
    outputs = list(db.scalars(select(store.Artifact.storage_name).where(store.Artifact.run_id.in_(run_ids))))
    db.execute(delete(store.Run).where(store.Run.goal_id == goal_id))
    db.delete(goal)
    db.flush()
    referenced = set(db.scalars(select(store.ProjectMaterial.file_id)))
    for ids in db.scalars(select(store.Message.attachment_ids)):
        referenced.update(ids)
    for ids in db.scalars(select(store.Attempt.attachment_ids)):
        referenced.update(ids)
    referenced.update(learning_sessions.draft_attachment_ids(db))
    referenced.update(learning_workflows.review_attachment_ids(db))
    image_ids.difference_update(referenced)
    db.execute(delete(store.Attachment).where(store.Attachment.id.in_(image_ids)))
    db.commit()
    failures = projects.unlink_files(image_ids)
    for name in outputs:
        path = artifacts.root() / name
        if path.resolve().is_relative_to(artifacts.root().resolve()):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                failures += 1
    for thread_id in threads:
        try:
            await request.app.state.tutor.checkpointer.adelete_thread(thread_id)
        except Exception:
            failures += 1
    return {"deleted": True, "cleanup_pending": failures}


@router.get("/learning/nodes/{node_id}/lesson", response_model=s.LessonRead | None)
def get_lesson(node_id: str, db=Depends(database)):
    item(db, store.KnowledgeNode, node_id)
    return db.scalar(
        select(store.Lesson)
        .where(store.Lesson.node_id == node_id)
        .order_by(store.Lesson.created_at.desc())
    )


@router.post("/learning/nodes/{node_id}/lesson", response_model=s.RunRead)
async def teach_node(node_id: str, request: Request, value: s.LearningLessonRequest | None = None, db=Depends(database)):
    node = item(db, store.KnowledgeNode, node_id)
    learning_sessions.validate_session(db, value.session_id if value else None, node)
    previous = db.scalar(
        select(store.Lesson)
        .where(store.Lesson.node_id == node_id)
        .order_by(store.Lesson.created_at.desc())
    )
    if previous and previous.state == "awaiting_submission":
        raise HTTPException(409, "当前练习尚未提交，请继续已有教学")
    run = create_run(db, "lesson", goal_id=node.goal_id)
    lesson_id = store.uid()

    async def operation():
        await request.app.state.tutor.ainvoke(
            {"node_id": node_id, "lesson_id": lesson_id, "run_id": run.id, "session_id": value.session_id if value else None},
            config={"configurable": {"thread_id": lesson_id}},
        )
        return {"lesson_id": lesson_id, "node_id": node_id}

    runs.launch(run.id, operation)
    return run


@router.post("/learning/lessons/{lesson_id}/submit", response_model=s.RunRead)
async def submit(
    lesson_id: str, value: s.Submission, request: Request, db=Depends(database)
):
    lesson = item(db, store.Lesson, lesson_id)
    if not value.answer.strip() and not value.attachment_ids:
        raise HTTPException(422, "请输入回答或提交图片")
    previous = db.scalar(
        select(store.Attempt).where(store.Attempt.submission_id == value.submission_id)
    )
    if previous:
        raise HTTPException(409, "这份练习已经提交，请查看保存的反馈")
    if lesson.state not in {"awaiting_submission", "reviewed"}:
        raise HTTPException(409, "这次教学已结束，请从当前知识点继续")
    try:
        provider.user_content(value.answer, value.attachment_ids)
    except Exception as error:
        raise HTTPException(400, provider.safe_error(error))
    node = item(db, store.KnowledgeNode, lesson.node_id)
    learning_sessions.validate_session(db, value.session_id, node, lesson.id)
    run = create_run(db, "assessment", goal_id=node.goal_id)
    followup = lesson.state == "reviewed"

    async def operation():
        if followup:
            result = await learning.assess({"run_id": run.id, "node_id": node.id,
                "lesson_id": lesson_id, "submission": value.model_dump(), "session_id": value.session_id})
            return {"lesson_id": lesson_id, "node_id": node.id, **result}
        # Failed assessment leaves a checkpoint at the assessment node, not a new interrupt.
        config = {"configurable": {"thread_id": lesson.graph_thread_id}}
        state = await request.app.state.tutor.aget_state(config)
        await request.app.state.tutor.aupdate_state(config, {"run_id": run.id, "session_id": value.session_id})
        command = (
            Command(resume=value.model_dump())
            if "await_submission" in state.next
            else None
        )
        if command is None:
            await request.app.state.tutor.aupdate_state(
                config, {"submission": value.model_dump()}
            )
        result = await request.app.state.tutor.ainvoke(command, config=config)
        return {"lesson_id": lesson_id, "feedback": result.get("feedback", {})}

    runs.launch(run.id, operation)
    return run


@router.get("/learning/nodes/{node_id}/turns", response_model=list[s.LearningTurnRead])
def learning_turns(node_id: str, db=Depends(database)):
    item(db, store.KnowledgeNode, node_id)
    return learning.node_turns(db, node_id)


@router.post("/learning/nodes/{node_id}/skip", response_model=s.NodeRead)
def skip_node(node_id: str, db=Depends(database)):
    node = item(db, store.KnowledgeNode, node_id)
    if db.scalar(
        select(store.Run).where(
            store.Run.goal_id == node.goal_id,
            store.Run.status.in_(["queued", "running"]),
        )
    ):
        raise HTTPException(409, "请先停止当前学习任务")
    node.status = "skipped"
    for lesson in db.scalars(
        select(store.Lesson).where(
            store.Lesson.node_id == node_id, store.Lesson.state == "awaiting_submission"
        )
    ):
        lesson.state = "skipped"
    goal = item(db, store.Goal, node.goal_id)
    learning.update_goal_progress(db, goal)
    db.commit()
    return node


@router.post("/learning/nodes/{node_id}/complete", response_model=s.NodeRead)
def complete_learning_section(node_id: str, db=Depends(database)):
    node = item(db, store.KnowledgeNode, node_id)
    learning_sessions.ensure_idle(db, node.goal_id)
    if not learning_sessions.latest_lesson(db, node.id):
        raise HTTPException(409, "请先查看本节讲解，再结束本节学习")
    if node.status not in ("passed", "skipped", "needs_practice"):
        node.status = "needs_practice"
        node.review_at = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat(timespec="microseconds")
    goal = item(db, store.Goal, node.goal_id)
    learning.update_goal_progress(db, goal)
    db.commit()
    return node


@router.get("/memories", response_model=list[s.MemoryRead])
def memories(db=Depends(database)):
    return db.scalars(
        select(store.Memory)
        .where(store.Memory.profile_id == PROFILE_ID)
        .order_by(store.Memory.updated_at.desc())
    ).all()


@router.post("/memories", response_model=s.MemoryRead)
def add_memory(value: s.MemoryCreate, db=Depends(database)):
    record = store.Memory(**value.model_dump(exclude={"revision"}))
    db.add(record)
    db.commit()
    return record


@router.put("/memories/{memory_id}", response_model=s.MemoryRead)
def edit_memory(memory_id: str, value: s.MemoryCreate, db=Depends(database)):
    try:
        return memory.edit(
            memory_id, value.model_dump(exclude={"revision"}), value.revision
        )
    except LookupError as error:
        raise HTTPException(404, str(error))
    except memory.MemoryConflict as error:
        raise HTTPException(409, str(error))


@router.post("/memories/{memory_id}/confirm", response_model=s.MemoryRead)
def confirm_memory(memory_id: str, value: s.MemoryConfirm):
    try:
        return memory.confirm(memory_id, value.revision)
    except LookupError as error:
        raise HTTPException(404, str(error))
    except memory.MemoryConflict as error:
        raise HTTPException(409, str(error))


@router.post("/memory-changes/{change_id}/undo")
def undo_memory(change_id: str):
    try:
        return memory.undo(change_id)
    except LookupError as error:
        raise HTTPException(404, str(error))
    except memory.MemoryConflict as error:
        raise HTTPException(409, str(error))


@router.delete("/memories/{memory_id}")
def remove_memory(memory_id: str, db=Depends(database)):
    try:
        memory.discard(memory_id)
    except LookupError as error:
        raise HTTPException(404, str(error))
    return {"deleted": True}


# Legacy endpoints remain adapters. They never own or create a second kind of item.
def legacy_reminder(row):
    return {**s.ReminderRead.model_validate(row).model_dump(), "calendar_event_id": row.plan_id,
            "status": "cancelled" if row.status in {"disabled", "removed"} else row.status}


@router.get("/reminders", response_model=list[s.ReminderRead])
def reminder_list(db=Depends(database)):
    return [legacy_reminder(row) for row in db.scalars(select(store.Reminder).where(store.Reminder.status != "removed").order_by(store.Reminder.due_at))]


@router.post("/reminders", response_model=s.ReminderRead)
def add_reminder(value: s.ReminderCreate, db=Depends(database)):
    due = value.due_at
    plan = plans.create_events([plans.PlanWrite(title=value.title, notes=value.body, start=reminders.utc_text(due), end=reminders.utc_text(due + timedelta(minutes=1)), timezone=value.timezone, recurrence=value.recurrence, reminder_enabled=True, reminder_offsets=[0])])[0]
    return legacy_reminder(db.get(store.Reminder, plan["reminder_id"]))


@router.put("/reminders/{reminder_id}", response_model=s.ReminderRead)
def edit_reminder(reminder_id: str, value: s.ReminderCreate, db=Depends(database)):
    record = item(db, store.Reminder, reminder_id)
    if not record.plan_id:
        raise HTTPException(409, "请重启以完成旧提醒迁移")
    plan = plans.find(db, record.plan_id)
    duration = datetime.fromisoformat(plan.end) - datetime.fromisoformat(plan.start) if not plan.all_day else timedelta(minutes=1)
    plans.update_event(plan.id, plans.PlanWrite(title=value.title, notes=value.body, start=reminders.utc_text(value.due_at), end=reminders.utc_text(value.due_at + duration), timezone=value.timezone, recurrence=value.recurrence, reminder_enabled=True, reminder_offsets=[0]))
    db.expire_all()
    return legacy_reminder(db.get(store.Reminder, reminder_id))


@router.post("/reminders/{reminder_id}/action", response_model=s.ReminderRead)
def reminder_action(reminder_id: str, value: s.ReminderAction, db=Depends(database)):
    record = item(db, store.Reminder, reminder_id)
    note = db.scalar(select(store.Notification).where(store.Notification.reminder_id == reminder_id, store.Notification.status != "cancelled").order_by(store.Notification.created_at.desc()).limit(1))
    if value.action == "snooze":
        if not note:
            raise HTTPException(409, "只有已触发的通知可以稍后提醒")
        snooze_notification(note.id, s.NotificationSnooze(minutes=value.minutes), db)
    elif record.plan_id:
        if value.action == "reactivate":
            plan = plans.find(db, record.plan_id)
            data = plans.serialize(db, plan)
            data.update(status="planned", reminder_enabled=True)
            plans.update_event(plan.id, plans.PlanWrite(**data))
        else:
            action = "complete" if value.action == "complete" else "disable_reminders"
            plans.act(record.plan_id, plans.PlanAction(action=action, occurrence_start=note.plan_occurrence_start if note else record.plan_occurrence_start))
    else:
        raise HTTPException(409, "请重启以完成旧提醒迁移")
    db.expire_all()
    return legacy_reminder(db.get(store.Reminder, reminder_id))


@router.get("/notifications", response_model=list[s.NotificationRead])
def notifications(pending_only: bool = False, unread_only: bool = False,
                  offset: int = 0, limit: int = 50, db=Depends(database)):
    if offset < 0 or not 1 <= limit <= 200:
        raise HTTPException(422, "通知分页范围无效")
    query = (
        select(store.Notification)
        .where(store.Notification.status != "cancelled")
        .order_by(store.Notification.created_at.desc(), store.Notification.id.desc())
    )
    if pending_only:
        query = query.where(store.Notification.status == "pending")
    elif unread_only:
        # The app shell and reminder window need every actionable notification.
        query = query.where(store.Notification.status.in_(["pending", "presented"]))
        return db.scalars(query).all()
    return db.scalars(query.offset(offset).limit(limit)).all()


@router.post("/notifications/{notification_id}/ack", response_model=s.NotificationRead)
def ack_notification(notification_id: str, read: bool = False, db=Depends(database)):
    with plans.lock:
        record = item(db, store.Notification, notification_id)
        if record.status != "cancelled":
            if read:
                record.status, record.snoozed_until = "read", None
            elif record.status == "pending":
                record.status = "presented"
        db.commit()
        return record


@router.post("/notifications/{notification_id}/snooze", response_model=s.NotificationRead)
def snooze_notification(notification_id: str, value: s.NotificationSnooze, db=Depends(database)):
    with plans.lock:
        record = item(db, store.Notification, notification_id)
        if record.status == "cancelled":
            raise HTTPException(409, "这条通知对应的提醒已取消")
        if record.plan_id:
            plan = plans.find(db, record.plan_id)
            if plan.status != "planned" or plans.completed(db, plan, record.plan_occurrence_start):
                raise HTTPException(409, "这次计划已完成、已取消或系列已结束")
        for delivery in db.scalars(select(store.WechatDelivery).where(store.WechatDelivery.notification_id == record.id, store.WechatDelivery.status == "pending")):
            delivery.status = "cancelled"
        record.status = "snoozed"
        record.snoozed_until = reminders.utc_text(datetime.now(timezone.utc) + timedelta(minutes=value.minutes))
        record.generation += 1
        db.commit()
        return record


@router.post("/attachments", response_model=s.AttachmentRead)
async def upload(file: UploadFile = File(...), db=Depends(database)):
    raw = await file.read(10 * 1024 * 1024 + 1)
    if len(raw) > 10 * 1024 * 1024:
        raise HTTPException(413, "图片不能超过 10 MB")
    try:
        image = Image.open(io.BytesIO(raw))
        if image.width * image.height > 25_000_000:
            raise ValueError("图片像素过大")
        image = ImageOps.exif_transpose(image).convert("RGB")
        image.thumbnail((2048, 2048))
        record = store.Attachment(
            name=Path(file.filename or "图片.jpg").name[:300],
            media_type="image/jpeg",
            width=image.width,
            height=image.height,
        )
        db.add(record)
        db.flush()
        image.save(ATTACHMENTS_DIR / f"{record.id}.jpg", "JPEG", quality=88)
        db.commit()
        return record
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError):
        raise HTTPException(422, "无法读取图片，请上传有效的 JPG、PNG 或 WebP 图片")


@router.post("/files", response_model=s.AttachmentRead)
async def upload_office_file(file: UploadFile = File(...)):
    raw = await file.read(office.LIMIT + 1)
    return office.save_upload(file.filename or "文件", raw)


@router.get("/files/{file_id}", response_model=s.AttachmentRead)
def office_file_status(file_id: str):
    return office.describe(file_id)


@router.post("/files/{file_id}/retry", response_model=s.AttachmentRead)
async def retry_office_parse(file_id: str):
    office.describe(file_id)
    with store.Session() as db:
        row = db.get(store.OfficeFile,file_id)
        if not row:
            raise HTTPException(404,"文件不存在")
        if row.status != "failed":
            return office.describe(file_id)
        row.status, row.error = "queued", ""
        db.commit()
    office.launch_parse(file_id)
    return office.describe(file_id)


@router.get("/attachments/{attachment_id}/content")
def attachment_content(attachment_id: str, db=Depends(database)):
    record = item(db, store.Attachment, attachment_id)
    return FileResponse(ATTACHMENTS_DIR / f"{record.id}.jpg", media_type="image/jpeg")


@router.get("/attachments/{attachment_id}", response_model=s.AttachmentRead)
def attachment_info(attachment_id: str, db=Depends(database)):
    record=item(db,store.Attachment,attachment_id)
    return office.describe(attachment_id) if db.get(store.OfficeFile,attachment_id) else record


@router.get("/files/{file_id}/preview")
async def uploaded_file_preview(file_id: str, page: int = 1):
    info=office.describe(file_id)
    if info["file_status"] not in {"ready","partial"}:
        raise HTTPException(409,info["error"] or "文件尚未解析完成")
    if Path(info["name"]).suffix.lower() == ".md":
        return office.markdown_preview((office.root()/f"{file_id}.bin").read_bytes())
    with store.Session() as db:
        detail=db.get(store.OfficeFile,file_id)
        if info["media_type"] != "application/pdf":
            return {"kind":"text","parts":detail.chunks[:100],"warnings":detail.warnings,"notice":"上传原件内容预览","truncated":len(detail.chunks)>100}
    try:
        return await office.worker("pdf_page",data=__import__("base64").b64encode((office.root()/f"{file_id}.bin").read_bytes()).decode(),page=page)
    except ValueError as error:
        raise HTTPException(422,str(error)) from None


@router.get("/files/{file_id}/content")
def uploaded_file_content(file_id: str):
    info=office.describe(file_id)
    path=office.root()/f"{file_id}.bin"
    if not path.is_file():
        raise HTTPException(404,"原文件缺失")
    return FileResponse(path,media_type=info["media_type"],filename=info["name"],headers={"X-Content-Type-Options":"nosniff","Content-Security-Policy":"default-src 'none'; sandbox"})


@router.get("/wechat/status", response_model=s.WechatStatus)
def wechat_status(request: Request):
    return request.app.state.wechat.status()


@router.post("/wechat/connect", response_model=s.WechatStatus)
async def wechat_connect(request: Request):
    try:
        return await request.app.state.wechat.connect()
    except Exception:
        request.app.state.wechat.phase = "error"
        wechat.update_state(last_error="暂时无法获取微信二维码，请检查网络后重试。")
        raise HTTPException(400, "暂时无法获取微信二维码，请检查网络后重试。")


@router.post("/wechat/test-message", response_model=s.WechatDeliveryRead)
async def wechat_test_message(value: s.WechatTestMessage, request: Request):
    try:
        return await request.app.state.wechat.test_message(value.request_id)
    except ValueError as error:
        raise HTTPException(400, str(error)) from None


@router.get("/wechat/deliveries/{delivery_id}", response_model=s.WechatDeliveryRead)
def wechat_delivery(delivery_id: str, db=Depends(database)):
    row = item(db, store.WechatDelivery, delivery_id)
    if row.account_id != wechat.read_state()["account_id"]:
        raise HTTPException(404, "投递记录不存在")
    return {"id": row.id, "status": row.status, "error": row.error, "created_at": row.created_at, "diagnostics": row.diagnostics}


@router.put("/wechat/options", response_model=s.WechatStatus)
async def wechat_options(value: s.WechatOptions, request: Request):
    try:
        return await request.app.state.wechat.options(
            value.enabled, value.reminders_enabled
        )
    except ValueError as error:
        raise HTTPException(400, str(error))


@router.post("/wechat/verify", response_model=s.WechatStatus)
async def wechat_verify(value: s.WechatVerify, request: Request):
    channel = request.app.state.wechat
    if channel.phase != "need_verifycode":
        raise HTTPException(400, "当前不需要验证码，请刷新连接状态。")
    channel.verify_code = value.code
    return channel.status()


@router.delete("/wechat/connection", response_model=s.WechatStatus)
async def wechat_disconnect(request: Request):
    try:
        return await request.app.state.wechat.disconnect()
    except Exception:
        raise HTTPException(400, "连接已停止，但清除系统凭据失败，请重试解除绑定。")


router.include_router(restricted_files.router(auth))
router.include_router(features.router)
router.include_router(projects.router)
router.include_router(learning_sessions.router)
router.include_router(learning_workflows.router)
router.include_router(learning_handoff.router)
router.include_router(usage_cost.router)
router.include_router(composer_suggestions.router)
app.include_router(router)
