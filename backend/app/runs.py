import asyncio
import time
from collections.abc import Awaitable, Callable
from sqlalchemy import select
from .db import Session, Run, RunEvent, TaskStep
from .provider import error_details, safe_error

tasks: dict[str, asyncio.Task] = {}
RUN_TIMEOUT_SECONDS = 720


def queue_successor(db, run, message_ids):
    """Persist the next request before publishing the old run's completion."""
    from .db import Message, Settings
    from .config import PROFILE_ID
    from . import model_profiles
    from .schemas import ModelSelection
    source = db.get(Message, message_ids[0])
    selected = (source.provider_context or {}).get("queued_model_selection")
    config = model_profiles.resolve(db.get(Settings, PROFILE_ID), ModelSelection(**selected)) if selected else run.model_config
    successor = Run(kind="chat", conversation_id=run.conversation_id,
                    source_message_id=source.id,
                    model_config=config,
                    result={"queued_message_ids": message_ids[1:]})
    db.add(successor)
    db.flush()
    run.result = {**run.result, "next_run_id": successor.id}
    return successor.id


def emit(run_id: str, kind: str, data: dict):
    with Session() as db:
        db.add(RunEvent(run_id=run_id, kind=kind, data=data))
        db.commit()


class StreamEmitter:
    """Coalesce text chunks before committing, without changing event meaning."""

    def __init__(self, run_id, interval=0.08):
        self.run_id, self.interval = run_id, interval
        self.pending = None
        self.last_flush = 0.0

    def flush(self):
        if self.pending:
            kind, data = self.pending
            self.pending = None
            emit(self.run_id, kind, data)
            self.last_flush = time.monotonic()

    def emit(self, kind, data):
        if kind not in {"delta", "reasoning"}:
            self.flush()
            emit(self.run_id, kind, data)
            return
        if self.pending and (self.pending[0] != kind or self.pending[1].get("step") != data.get("step")):
            self.flush()
        if self.pending:
            self.pending[1]["text"] += data.get("text", "")
        else:
            self.pending = (kind, dict(data))
        if time.monotonic() - self.last_flush >= self.interval:
            self.flush()


def launch(run_id: str, operation: Callable[[], Awaitable[dict]]):
    async def execute():
        try:
            with Session() as db:
                db.get(Run, run_id).status = "running"
                db.commit()
            emit(run_id, "status", {"status": "running"})
            # A tool round can include a long image request before the model
            # writes its final answer. The run deadline is only a last-resort
            # guard; individual providers still enforce their own timeouts.
            async with asyncio.timeout(RUN_TIMEOUT_SECONDS):
                from .usage_cost import scope
                from . import model_budget
                with Session() as db:
                    source = db.get(Run, run_id)
                    from .learning_public import LEARNING_KINDS
                    purpose = "learning" if source.kind in LEARNING_KINDS else "complex_task" if source.task_id else "chat"
                with scope(run_id=run_id, purpose=purpose), model_budget.scope():
                    result = await operation()
            with Session() as db:
                run = db.get(Run, run_id)
                queued = run.result.get("queued_message_ids", [])
                if queued and not result.get("next_run_id"):
                    result = {**result, "next_run_id": queue_successor(db, run, queued)}
                    run.result = {**run.result, "queued_message_ids": []}
                run.status = "completed"
                run.result = {**run.result, **result}
                db.commit()
            emit(run_id, "done", {"result": result})
            if result.get("next_run_id"):
                from .agent import chat
                next_id = result["next_run_id"]
                launch(next_id, lambda: chat(next_id, run.conversation_id))
        except asyncio.CancelledError:
            from .complex_tasks import pause_run
            pause_run(run_id, "已停止，已有成果保留，发送“继续”后恢复。")
            with Session() as db:
                run = db.get(Run, run_id)
                run.status = "cancelled"
                db.commit()
            from .agent import persist_incomplete_reply
            persist_incomplete_reply(run_id)
            emit(run_id, "cancelled", {})
        except Exception as error:
            from .complex_tasks import pause_run
            with Session() as db:
                failed_run = db.get(Run, run_id)
                model_config = failed_run.model_config if failed_run.kind == "chat" else None
                step = db.scalar(select(TaskStep).where(
                    TaskStep.task_id == failed_run.task_id, TaskStep.status == "running",
                )) if failed_run.task_id else None
                details = error_details(error)
                details["stage"] = "task_step" if step else "task" if failed_run.task_id else failed_run.kind
                if step:
                    details["step_id"] = step.id
                if isinstance(error, TimeoutError):
                    details["category"] = "run_timeout"
            message = (
                "执行超时，请缩小问题范围后重试。"
                if isinstance(error, TimeoutError)
                else safe_error(error, model_config=model_config)
            )
            is_task = pause_run(run_id, message + " 已有成果保留，发送“继续”后恢复。")
            if isinstance(error, TimeoutError) and not is_task:
                from .agent import recover_durable_reply
                recovered = recover_durable_reply(run_id)
                if recovered:
                    with Session() as db:
                        run = db.get(Run, run_id)
                        run.status = "completed"
                        run.result = recovered
                        run.error = None
                        db.commit()
                    emit(run_id, "done", {"result": recovered})
                    return
            with Session() as db:
                run = db.get(Run, run_id)
                run.status = "failed"
                run.error = message
                run.result = {**run.result, "error_details": details}
                db.commit()
            from .agent import persist_incomplete_reply
            persist_incomplete_reply(run_id)
            emit(run_id, "error", {"message": message, "details": details})
        finally:
            tasks.pop(run_id, None)

    tasks[run_id] = asyncio.create_task(execute())
