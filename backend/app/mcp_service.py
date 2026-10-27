"""Private MCP configuration and per-server connection owners.

Saving configuration never executes it. Only explicit tests / enabled servers
connect. Business calls are never replayed after an uncertain result.
"""

import asyncio
import contextlib
import hashlib
import json
import os
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from sqlalchemy import select

from . import config as vault
from . import mcp_env
from .config import PROFILE_ID
from .db import MCPServer, MCPTool, NotFound, Session, now, uid
from .schemas import MCPImport, MCPServerWrite

CONNECT_TIMEOUT = 15
CALL_TIMEOUT = 60
MAX_RESULT = 24000


def tool_id(server_id: str, name: str) -> str:
    return (
        "mcp_"
        + server_id.replace("-", "")
        + "_"
        + hashlib.sha256(name.encode()).hexdigest()[:16]
    )


def require_server(db, server_id):
    server = db.get(MCPServer, server_id)
    if not server or server.profile_id != PROFILE_ID:
        raise NotFound("MCP 服务不存在")
    return server


def secret_values(server):
    values = [
        vault.secret_get(ref)
        for kind in ("headers", "env")
        for ref in server.config.get(kind, {}).values()
    ]
    secrets = list(values)
    for value in values:
        try:
            resolved, variables = mcp_env.resolve(value)
            secrets.extend([resolved, *variables])
        except mcp_env.EnvironmentReferenceError:
            pass
    worker = manager.workers.get(server.id)
    if worker:
        secrets.extend(worker.resolved_secrets)
    return secrets


def connection_values(server, kind, secrets):
    values = {}
    for key, ref in server.config.get(kind, {}).items():
        raw = vault.secret_get(ref)
        resolved, variables = mcp_env.resolve(raw, header=kind == "headers")
        values[key] = resolved
        secrets.extend([raw, resolved, *variables])
    return values


def redact(value, secrets=(), *, limit=True):
    """Bound model/audit output and remove configured credentials recursively."""
    tokens = sorted(
        {
            part
            for secret in secrets
            if secret
            for part in (secret, secret.removeprefix("Bearer "))
            if part
        },
        key=len,
        reverse=True,
    )

    def scrub(item):
        if isinstance(item, str):
            if item in tokens:
                return "[已隐藏]"
            for token in tokens:
                if len(token) >= 4:
                    item = item.replace(token, "[已隐藏]")
            return item
        if isinstance(item, dict):
            return {scrub(str(key)): scrub(child) for key, child in item.items()}
        if isinstance(item, list):
            return [scrub(child) for child in item]
        if (
            isinstance(item, (int, float))
            and str(item) in tokens
            and len(str(item)) >= 4
        ):
            return "[已隐藏]"
        return item

    clean = scrub(value)
    text = json.dumps(clean, ensure_ascii=False, default=str)
    if limit and len(text) > MAX_RESULT:
        result = {"summary": text[:MAX_RESULT], "truncated": True}
        if isinstance(clean, dict) and clean.get("error"):
            result["error"] = str(clean["error"])[:2000]
        if isinstance(clean, dict):
            for key in ("artifacts", "sources", "media_errors", "image_urls", "exit_code",
                        "workspace_key", "workspace_files", "not_executed"):
                if key in clean:
                    result[key] = clean[key]
            for key in ("stdout", "stderr"):
                if key in clean:
                    result[key] = str(clean[key])[:4000]
        return result
    return clean


def read_server(server):
    worker = manager.workers.get(server.id)
    with Session() as db:
        count = len(
            db.scalars(
                select(MCPTool).where(
                    MCPTool.server_id == server.id, MCPTool.present.is_(True)
                )
            ).all()
        )
    return {
        "id": server.id,
        "name": server.name,
        "transport": server.transport,
        **{
            key: server.config.get(key, [] if key == "args" else "")
            for key in ("url", "command", "args", "cwd")
        },
        **{
            kind: {
                key: bool(vault.secret_get(ref))
                for key, ref in server.config.get(kind, {}).items()
            }
            for kind in ("headers", "env")
        },
        **{
            kind + "_templates": {
                key: value
                for key, ref in server.config.get(kind, {}).items()
                if (value := mcp_env.template(vault.secret_get(ref)))
            }
            for kind in ("headers", "env")
        },
        "enabled": server.enabled,
        "status": worker.status
        if worker and (server.enabled or worker.status == "error")
        else "disconnected"
        if server.enabled
        else "disabled",
        "error": worker.error if worker else "",
        "tested_at": server.tested_at,
        "tool_count": count,
    }


def list_servers():
    with Session() as db:
        return [
            read_server(x)
            for x in db.scalars(
                select(MCPServer)
                .where(MCPServer.profile_id == PROFILE_ID)
                .order_by(MCPServer.created_at)
            )
        ]


def save_servers(values: list[MCPServerWrite], server_id=None):
    """Commit non-secret config atomically; compensate vault writes on failure."""
    changed = []
    old_secrets = {}
    with Session() as db:
        try:
            names = [x.name for x in values]
            if len(names) != len(set(names)):
                raise ValueError("服务名称重复，请先重命名")
            for value in values:
                server = (
                    require_server(db, server_id)
                    if server_id
                    else MCPServer(id=uid(), profile_id=PROFILE_ID)
                )
                duplicate = db.scalar(
                    select(MCPServer).where(
                        MCPServer.profile_id == PROFILE_ID,
                        MCPServer.name == value.name,
                        MCPServer.id != server.id,
                    )
                )
                if duplicate:
                    raise ValueError("服务名称已存在，请先重命名")
                old = server.config or {}
                data = {
                    key: getattr(value, key)
                    for key in ("url", "command", "args", "cwd")
                }
                for kind in ("env", "headers"):
                    refs = dict(old.get(kind, {}))
                    # Changing transport clears credentials belonging to the old one.
                    clear = set(getattr(value, "clear_" + kind))
                    if (kind == "env") != (value.transport == "stdio"):
                        clear.update(refs)
                    for key, secret in getattr(value, kind).items():
                        if not secret:
                            continue  # masked/blank editor values retain the existing secret
                        ref = (
                            refs.get(key)
                            or f"mcp-{server.id}-{kind}-{hashlib.sha256(key.encode()).hexdigest()[:16]}"
                        )
                        old_secrets.setdefault(ref, vault.secret_get(ref))
                        vault.secret_set(ref, secret)
                        refs[key] = ref
                    for key in clear:
                        if key in refs:
                            ref = refs.pop(key)
                            old_secrets.setdefault(ref, vault.secret_get(ref))
                            vault.secret_set(ref, "")
                    data[kind] = refs
                server.name, server.transport = value.name, value.transport
                server.enabled, server.config = value.enabled, data
                # A changed endpoint invalidates stale catalog availability until discovery.
                if old and any(old.get(k) != data.get(k) for k in data):
                    for remote in db.scalars(
                        select(MCPTool).where(MCPTool.server_id == server.id)
                    ):
                        remote.present = False
                    server.tested_at = None
                db.add(server)
                changed.append(server.id)
            db.commit()
        except BaseException:
            db.rollback()
            for ref, secret in old_secrets.items():
                vault.secret_set(ref, secret)
            raise
    return changed


def parse_import(value: MCPImport) -> list[MCPServerWrite]:
    result = []
    for name, config in value.mcpServers.items():
        data = dict(config)
        if "type" in data and "transport" in data:
            raise ValueError("不能同时指定 type 与 transport")
        transport = data.pop("transport", data.pop("type", None))
        if transport not in {
            None,
            "stdio",
            "http",
            "streamable-http",
            "streamable_http",
        }:
            raise ValueError("仅支持 stdio 和 Streamable HTTP")
        # Importing a config is never authorization to start its commands.
        if "enabled" in data or "name" in data or "disabled" in data:
            raise ValueError(
                "导入配置不支持 enabled、disabled 或 name 字段，请在界面中启用"
            )
        result.append(
            MCPServerWrite(
                name=name,
                transport="stdio"
                if transport == "stdio" or (transport is None and "command" in data)
                else "streamable_http",
                **data,
            )
        )
    return result


def cache_tools(server_id, remote_tools):
    with Session() as db:
        server = require_server(db, server_id)
        for row in db.scalars(select(MCPTool).where(MCPTool.server_id == server_id)):
            row.present = False
        for tool in remote_tools:
            key = tool_id(server_id, tool.name)
            row = db.get(MCPTool, key)
            if row is None:
                row = MCPTool(
                    id=key, server_id=server_id, remote_name=tool.name, enabled=False
                )
                db.add(row)
            row.description = str(
                redact(tool.description or "", secret_values(server))
            )[:4000]
            schema = tool.args_schema
            row.input_schema = redact(
                schema if isinstance(schema, dict) else schema.model_json_schema(),
                secret_values(server),
            )
            row.present = True
        server.tested_at = now()
        db.commit()


@dataclass
class Request:
    name: str
    args: dict
    future: asyncio.Future
    cancelled: asyncio.Event = field(default_factory=asyncio.Event)


class Worker:
    def __init__(self, server):
        self.server = server
        self.resolved_secrets = []
        self.status, self.error = "connecting", ""
        self.queue = asyncio.Queue()
        self.ready = asyncio.get_running_loop().create_future()
        self.task = asyncio.create_task(self.serve(), name=f"mcp-{server.id}")

    async def serve(self):
        active = None
        try:
            from fastmcp import Client
            from fastmcp.client.elicitation import ElicitResult
            from fastmcp.client.transports import (
                StdioTransport,
                StreamableHttpTransport,
            )
            from langchain.mcp import MCPAdapter

            data = self.server.config
            if self.server.transport == "stdio":
                command = shutil.which(data["command"])
                if not command:
                    raise FileNotFoundError
                if data.get("cwd") and not Path(data["cwd"]).is_dir():
                    raise NotADirectoryError
                essentials = {
                    "PATH",
                    "SYSTEMROOT",
                    "WINDIR",
                    "TEMP",
                    "TMP",
                    "USERPROFILE",
                    "APPDATA",
                    "LOCALAPPDATA",
                    "COMSPEC",
                    "PATHEXT",
                    "HOMEDRIVE",
                    "HOMEPATH",
                    "LANG",
                }
                env = {k: v for k, v in os.environ.items() if k.upper() in essentials}
                env.update(connection_values(self.server, "env", self.resolved_secrets))
                transport = StdioTransport(
                    command,
                    data.get("args", []),
                    env=env,
                    cwd=data.get("cwd") or None,
                    keep_alive=False,
                    log_file=Path(os.devnull),
                )
            else:
                transport = StreamableHttpTransport(
                    data["url"],
                    headers=connection_values(self.server, "headers", self.resolved_secrets),
                )

            elicited = False

            async def decline(*_):
                nonlocal elicited
                elicited = True
                return ElicitResult(action="decline")

            async def discard_log(*_):
                pass

            client = Client(
                transport,
                timeout=CALL_TIMEOUT,
                init_timeout=CONNECT_TIMEOUT,
                elicitation_handler=decline,
                log_handler=discard_log,
                input_required_max_rounds=0,
            )
            adapter = MCPAdapter(client)
            # Owner task both enters and exits the connection context.
            async with contextlib.AsyncExitStack() as stack:
                async with asyncio.timeout(CONNECT_TIMEOUT):
                    await stack.enter_async_context(adapter)
                    discovered = await adapter.list_tools(cache_mode="refresh")
                remote = {tool.name: tool for tool in discovered}
                cache_tools(self.server.id, discovered)
                self.status = "connected"
                self.ready.set_result(True)
                while True:
                    active = await self.queue.get()
                    if active.future.cancelled():
                        active = None
                        continue
                    elicited = False

                    async def invoke(request):
                        from langchain_core.messages import ToolMessage

                        with Session() as db:
                            server = require_server(db, self.server.id)
                            item = db.get(MCPTool, tool_id(server.id, request.name))
                            if (
                                not server.enabled
                                or not item
                                or not item.enabled
                                or not item.present
                            ):
                                return {"error": "工具已停用或不可用"}
                        message = await remote[request.name].ainvoke(
                            {
                                "type": "tool_call",
                                "id": uid(),
                                "name": request.name,
                                "args": request.args,
                            }
                        )
                        if elicited:  # noqa: B023 - serial call finishes before the next iteration resets it
                            return {
                                "error": "此工具需要交互式输入，当前版本不支持；未自动重试"
                            }
                        if not isinstance(message, ToolMessage):
                            return {"error": "MCP 返回格式无法处理"}
                        content = message.content
                        media = []
                        if isinstance(content, list):
                            media = [x for x in content if isinstance(x, dict) and x.get("type") in {"image", "image_url", "file"}]
                            unsupported = [x for x in content if not isinstance(x, dict) or x.get("type") not in {"text", "image", "image_url", "file"}]
                            if unsupported:
                                return {"error": "工具返回了暂不支持的内容类型；未自动重试"}
                            content = "\n".join(x.get("text", "") for x in content if isinstance(x, dict) and x.get("type") == "text")
                        result = {"text": content, "media_blocks": media}
                        if message.artifact:
                            result["structured_content"] = message.artifact.get(
                                "structured_content"
                            )
                        if message.status == "error":
                            result["error"] = content or "MCP 工具报告执行失败"
                            if any(
                                word in str(content).lower()
                                for word in (
                                    "elicitation",
                                    "input_required",
                                    "input required",
                                )
                            ):
                                result["error"] = (
                                    "此工具需要交互式输入，当前版本不支持；未自动重试"
                                )
                        return redact(result, secret_values(self.server), limit=False)

                    operation = asyncio.create_task(invoke(active))
                    cancelled = asyncio.create_task(active.cancelled.wait())
                    try:
                        done, _ = await asyncio.wait(
                            [operation, cancelled],
                            timeout=CALL_TIMEOUT,
                            return_when=asyncio.FIRST_COMPLETED,
                        )
                        if operation in done:
                            result = operation.result()
                        elif cancelled in done:
                            result = {"error": "已取消；外部操作可能已执行，请核对结果"}
                        else:
                            result = {"error": "MCP 调用超时，执行结果未知；未自动重试"}
                        if not active.future.done():
                            active.future.set_result(result)
                    except Exception:  # noqa: BLE001 - third-party transport boundary; never expose exceptions containing credentials
                        self.error = "MCP 调用中断，执行结果未知；未自动重试。可测试连接后继续使用。"
                        self.status = "error"
                        if not active.future.done():
                            active.future.set_result({"error": self.error})
                        break
                    finally:
                        for task in (operation, cancelled):
                            if not task.done():
                                task.cancel()
                        await asyncio.gather(
                            operation, cancelled, return_exceptions=True
                        )
                    active = None
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - third-party startup boundary
            self.status = "error"
            self.error = (
                str(error)
                if isinstance(error, mcp_env.EnvironmentReferenceError)
                else "未找到启动命令，请安装或指定 MCP 所需的运行环境。"
                if isinstance(error, FileNotFoundError)
                else "工作目录不存在。"
                if isinstance(error, NotADirectoryError)
                else "MCP 连接失败或超时，请检查地址、认证、依赖及协议。"
            )
        finally:
            if not self.ready.done():
                self.ready.set_result(False)
            if active and not active.future.done():
                active.future.set_result(
                    {"error": "连接已关闭，外部执行结果未知；未自动重试"}
                )
            while not self.queue.empty():
                pending = self.queue.get_nowait()
                if not pending.future.done():
                    pending.future.set_result({"error": "连接已关闭，工具未执行"})
            if self.status != "error":
                self.status = "disconnected"

    async def call(self, name, args):
        if self.task.done() or self.status != "connected":
            return {"error": "MCP 未连接，请先测试连接"}
        request = Request(name, args, asyncio.get_running_loop().create_future())
        self.queue.put_nowait(request)
        try:
            return await request.future
        except asyncio.CancelledError:
            request.cancelled.set()
            raise

    async def close(self):
        if not self.task.done():
            self.task.cancel()
        await asyncio.gather(self.task, return_exceptions=True)


class MCPManager:
    def __init__(self):
        self.workers = {}
        self.changes = asyncio.Lock()

    def start(self, server):
        worker = self.workers.get(server.id)
        if worker is None or worker.task.done():
            worker = Worker(server)
            self.workers[server.id] = worker
        return worker

    async def reload(self, server_id):
        async with self.changes:
            await self.stop(server_id)
            with Session() as db:
                server = db.get(MCPServer, server_id)
                if server and server.enabled:
                    self.start(server)

    async def stop(self, server_id):
        worker = self.workers.pop(server_id, None)
        if worker:
            await worker.close()

    async def prepare(self):
        with Session() as db:
            servers = db.scalars(
                select(MCPServer).where(
                    MCPServer.profile_id == PROFILE_ID, MCPServer.enabled.is_(True)
                )
            ).all()
        await asyncio.gather(
            *(asyncio.shield(self.start(server).ready) for server in servers)
        )

    async def test(self, server_id):
        async with self.changes:
            await self.stop(server_id)
            with Session() as db:
                server = require_server(db, server_id)
            worker = self.start(server)
            await asyncio.shield(worker.ready)
            if not server.enabled and worker.status != "error":
                await self.stop(server_id)

    async def close(self):
        await asyncio.gather(
            *(worker.close() for worker in list(self.workers.values()))
        )
        self.workers.clear()


manager = MCPManager()
