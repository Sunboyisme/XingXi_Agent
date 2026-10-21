import asyncio
from collections.abc import Awaitable, Callable
from .db import Session, Run, RunEvent
from .provider import safe_error

tasks: dict[str, asyncio.Task] = {}
RUN_TIMEOUT_SECONDS = 720


def emit(run_id: str, kind: str, data: dict):
    with Session() as db:
        db.add(RunEvent(run_id=run_id, kind=kind, data=data))
        db.commit()


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
                result = await operation()
            with Session() as db:
                run = db.get(Run, run_id)
                run.status = "completed"
                run.result = result
                db.commit()
            emit(run_id, "done", {"result": result})
        except asyncio.CancelledError:
            from .complex_tasks import pause_run
            pause_run(run_id, "已停止，已有成果保留，发送“继续”后恢复。")
            with Session() as db:
                run = db.get(Run, run_id)
                run.status = "cancelled"
                db.commit()
            emit(run_id, "cancelled", {})
        except Exception as error:
            from .complex_tasks import pause_run
            is_task = pause_run(run_id, "执行未完成，已有成果保留，发送“继续”后恢复。")
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
                failed_run = db.get(Run, run_id)
                model_config = failed_run.model_config if failed_run.kind == "chat" else None
            message = (
                "执行超时，请缩小问题范围后重试。"
                if isinstance(error, TimeoutError)
                else safe_error(error, model_config=model_config)
            )
            with Session() as db:
                run = db.get(Run, run_id)
                run.status = "failed"
                run.error = message
                db.commit()
            emit(run_id, "error", {"message": message})
        finally:
            tasks.pop(run_id, None)

    tasks[run_id] = asyncio.create_task(execute())
