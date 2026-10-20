import asyncio
import json
import os
import sys
import time
from pathlib import Path

import pytest
from app import db, mcp_service, tools

from .test_app import API, wait_run

FIXTURE = str(Path(__file__).with_name("mcp_fixture.py"))


def create(client, **extra):
    data = {
        "name": "Local fixture",
        "transport": "stdio",
        "command": sys.executable,
        "args": [FIXTURE],
        **extra,
    }
    response = client.post(API + "/mcp/servers", json=data)
    assert response.status_code == 200, response.text
    return response.json(), data


def discover(client, server):
    response = client.post(f"{API}/mcp/servers/{server['id']}/test")
    assert response.status_code == 200, response.text
    value = response.json()
    assert not value["error"], value
    return [
        x for x in client.get(API + "/tools").json() if x["server_id"] == server["id"]
    ]


def start_run():
    with db.Session() as session:
        conversation = db.Conversation(title="MCP fixture")
        session.add(conversation)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id)
        session.add(run)
        session.commit()
        return run.id, conversation.id


def call_tool(client, key, args):
    async def invoke():
        run_id, conversation_id = start_run()
        built = await tools.prepare_tools(run_id, conversation_id)
        value = await next(x for x in built if x.name == key).ainvoke(args)
        return json.loads(value), run_id

    return client.portal.call(invoke)


def test_save_import_never_starts_process_and_conflicts_are_atomic(client, tmp_path):
    marker = tmp_path / "pid"
    server, _ = create(client, args=[FIXTURE, "--pid-file", str(marker)])
    assert server["status"] == "disabled" and server["tool_count"] == 0
    assert not marker.exists() and not mcp_service.manager.workers
    response = client.post(
        API + "/mcp/servers/import",
        json={
            "mcpServers": {
                "New": {"url": "https://example.invalid/mcp"},
                "Local fixture": {"command": "unknown"},
            }
        },
    )
    assert response.status_code == 400
    assert len(client.get(API + "/mcp/servers").json()) == 1
    assert not marker.exists()


@pytest.mark.parametrize(
    "patch",
    [
        {"transport": "sse", "url": "https://example.invalid"},
        {
            "transport": "streamable_http",
            "command": "",
            "args": [],
            "url": "https://user:synthetic-secret@example.invalid/mcp",
        },
        {"extra": "synthetic-secret"},
        {"env": {"BAI_MODEL_API_KEY": "synthetic-secret"}},
        {
            "transport": "streamable_http",
            "command": "",
            "args": [],
            "url": "https://example.invalid/mcp",
            "headers": {"Authorization": "bad\r\nsynthetic-secret"},
        },
    ],
)
def test_invalid_config_does_not_echo_credentials(client, patch):
    response = client.post(
        API + "/mcp/servers",
        json={"name": "invalid", "transport": "stdio", "command": "python", **patch},
    )
    assert response.status_code == 422
    assert "synthetic-secret" not in response.text
    assert client.get(API + "/mcp/servers").json() == []


def test_stdio_discovery_switches_audit_secrets_and_cleanup(
    client, isolate, tmp_path, monkeypatch
):
    monkeypatch.setenv("BAI_MODEL_API_KEY", "do-not-inherit")
    pid = tmp_path / "fixture.pid"
    server, value = create(
        client,
        cwd=str(tmp_path),
        args=[FIXTURE, "--pid-file", str(pid)],
        env={"MCP_FIXTURE_TOKEN": "synthetic-mcp-secret"},
    )
    assert server["env"] == {"MCP_FIXTURE_TOKEN": True}
    assert "synthetic-mcp-secret" not in json.dumps(server)
    with db.Session() as session:
        assert "synthetic-mcp-secret" not in json.dumps(
            session.get(db.MCPServer, server["id"]).config
        )
    discovered = discover(client, server)
    assert len(discovered) == 4 and all(not item["enabled"] for item in discovered)
    assert not mcp_service.manager.workers  # disabled test releases its process
    server = client.put(
        f"{API}/mcp/servers/{server['id']}", json={**value, "env": {}, "enabled": True}
    ).json()
    discovered = discover(client, server)
    echo = next(x for x in discovered if x["name"] == "echo")
    client.patch(f"{API}/tools/{echo['id']}", json={"enabled": True})
    result, run_id = call_tool(client, echo["id"], {"text": "hello"})
    structured = result["structured_content"]
    assert structured["text"] == "hello" and structured["cwd"] == str(tmp_path)
    assert not structured["model_key_present"]
    assert structured["fixture_token"] == "[已隐藏]"
    events = client.get(f"{API}/runs/{run_id}/tools").json()
    assert events[0]["data"]["tool_id"] == echo["id"]
    assert (
        events[0]["data"]["status"] == "completed"
        and events[0]["data"]["duration_ms"] >= 0
    )
    assert "synthetic-mcp-secret" not in json.dumps(events)
    client.patch(f"{API}/tools/{echo['id']}", json={"enabled": False})
    assert echo["id"] not in client.portal.call(
        lambda: asyncio.sleep(0, result=[x.name for x in tools.build_tools("", "")])
    )
    assert client.delete(f"{API}/mcp/servers/{server['id']}").status_code == 200
    assert not mcp_service.manager.workers
    assert not any(isolate.values())


def test_builtin_switch_checked_again_after_tool_list_was_created(client):
    run_id, conversation_id = start_run()
    built = tools.build_tools(run_id, conversation_id)
    calculate = next(x for x in built if x.name == "calculate")
    client.patch(API + "/tools/calculate", json={"enabled": False})

    async def invoke():
        return json.loads(await calculate.ainvoke({"expression": "1+2"}))

    assert "error" in client.portal.call(invoke)
    assert "calculate" not in {
        x.name for x in tools.build_tools(run_id, conversation_id)
    }


def test_missing_runtime_is_localized_and_does_not_block_builtins(client):
    server, _ = create(client, command="bai-no-such-runtime", enabled=True)
    response = client.post(f"{API}/mcp/servers/{server['id']}/test").json()
    assert response["status"] == "error" and "启动命令" in response["error"]
    assert "calculate" in {x.name for x in tools.build_tools("", "")}


def test_http_authentication_discovery_and_server_error(client, http_mcp_url):
    response = client.post(
        API + "/mcp/servers",
        json={
            "name": "HTTP fixture",
            "transport": "streamable_http",
            "url": http_mcp_url,
            "headers": {"X-Test-Key": "synthetic-mcp-secret"},
            "enabled": True,
        },
    )
    assert response.status_code == 200, response.text
    server = response.json()
    discovered = discover(client, server)
    fail = next(x for x in discovered if x["name"] == "fail")
    client.patch(f"{API}/tools/{fail['id']}", json={"enabled": True})
    result, run_id = call_tool(client, fail["id"], {})
    assert "error" in result
    assert (
        client.get(f"{API}/runs/{run_id}/tools").json()[0]["data"]["status"] == "error"
    )
    bad = {
        "name": server["name"],
        "transport": server["transport"],
        "url": http_mcp_url,
        "headers": {"X-Test-Key": "bad-token"},
        "enabled": True,
    }
    client.put(f"{API}/mcp/servers/{server['id']}", json=bad)
    assert (
        client.post(f"{API}/mcp/servers/{server['id']}/test").json()["status"]
        == "error"
    )


def test_timeout_does_not_replay_business_call(client, tmp_path, monkeypatch):
    server, _ = create(client, enabled=True)
    discovered = discover(client, server)
    slow = next(x for x in discovered if x["name"] == "slow")
    client.patch(f"{API}/tools/{slow['id']}", json={"enabled": True})
    monkeypatch.setattr(mcp_service, "CALL_TIMEOUT", 0.15)
    counter = tmp_path / "counter"
    result, _ = call_tool(
        client, slow["id"], {"seconds": 5, "counter_file": str(counter)}
    )
    assert "超时" in result["error"]
    assert counter.read_text() == "1"


def test_interactive_input_is_explicitly_unsupported(client):
    server, _ = create(client, enabled=True)
    discovered = discover(client, server)
    interactive = next(x for x in discovered if x["name"] == "interactive")
    client.patch(f"{API}/tools/{interactive['id']}", json={"enabled": True})
    result, _ = call_tool(client, interactive["id"], {})
    assert "交互式输入" in result["error"]


def test_mock_model_sequentially_combines_builtin_and_mcp(configured):
    server, _ = create(configured, enabled=True)
    echo = next(x for x in discover(configured, server) if x["name"] == "echo")
    configured.patch(f"{API}/tools/{echo['id']}", json={"enabled": True})
    conversation = configured.post(API + "/conversations", json={}).json()
    run = wait_run(
        configured,
        configured.post(
            f"{API}/conversations/{conversation['id']}/messages",
            json={"content": "组合MCP，先计算再回显"},
        ),
    )
    assert run["status"] == "completed", run
    events = configured.get(f"{API}/runs/{run['id']}/tools").json()
    assert [x["data"]["tool_id"] for x in events] == ["calculate", echo["id"]]
    assert [x["data"]["source"] for x in events] == ["builtin", "mcp"]


def test_cancel_and_delete_release_pending_calls_without_replay(client, tmp_path):
    server, _ = create(client, enabled=True)
    slow = next(x for x in discover(client, server) if x["name"] == "slow")
    client.patch(f"{API}/tools/{slow['id']}", json={"enabled": True})
    counter = tmp_path / "cancel-counter"

    async def cancel():
        run_id, conversation_id = start_run()
        built = await tools.prepare_tools(run_id, conversation_id)
        task = asyncio.create_task(
            next(x for x in built if x.name == slow["id"]).ainvoke(
                {"seconds": 20, "counter_file": str(counter)}
            )
        )
        for _ in range(100):
            if counter.exists():
                break
            await asyncio.sleep(0.02)
        assert counter.exists()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        return run_id

    run_id = client.portal.call(cancel)
    events = client.get(f"{API}/runs/{run_id}/tools").json()
    assert events[0]["data"]["status"] == "cancelled"
    assert counter.read_text() == "1"
    assert client.delete(f"{API}/mcp/servers/{server['id']}").status_code == 200
    assert not mcp_service.manager.workers


def test_catalog_refresh_preserves_selection_and_marks_missing_tools(
    client, monkeypatch
):
    server, _ = create(client, enabled=True)
    echo = next(x for x in discover(client, server) if x["name"] == "echo")
    client.patch(f"{API}/tools/{echo['id']}", json={"enabled": True})
    discover(client, server)
    after = client.get(API + "/tools").json()
    assert next(x for x in after if x["id"] == echo["id"])["enabled"]
    with db.Session() as session:
        remote = session.get(db.MCPTool, echo["id"])
        remote.enabled = False
        session.commit()

    async def tool_names():
        return [x.name for x in await tools.prepare_tools("", "")]

    assert echo["id"] not in client.portal.call(tool_names)


def test_old_database_upgrade_preserves_domain_records(tmp_path):
    import sqlite3

    from alembic import command
    from alembic.config import Config

    root = Path(__file__).resolve().parents[1]
    path = tmp_path / "old.sqlite"
    value = Config(str(root / "alembic.ini"))
    value.set_main_option("script_location", str(root / "migrations"))
    value.set_main_option("sqlalchemy.url", "sqlite:///" + path.as_posix())
    command.upgrade(value, "0003")
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO conversations (id, profile_id, created_at, updated_at, title) VALUES ('old', 'local', 'now', 'now', 'keep me')"
        )
        connection.execute(
            "INSERT INTO wechat_state (id, data) VALUES ('old-channel', '{}')"
        )
    command.upgrade(value, "head")
    with sqlite3.connect(path) as connection:
        assert (
            connection.execute("SELECT title FROM conversations").fetchone()[0]
            == "keep me"
        )
        assert (
            connection.execute("SELECT id FROM wechat_state").fetchone()[0]
            == "old-channel"
        )
        assert connection.execute("SELECT count(*) FROM mcp_servers").fetchone()[0] == 0


def test_sse_does_not_drop_events_written_during_terminal_transition(client):
    from sqlalchemy import event

    run_id, _ = start_run()
    with db.Session() as session:
        session.get(db.Run, run_id).status = "running"
        session.commit()
    fired = False

    def finish_between_reads(connection, cursor, statement, parameters, context, many):
        nonlocal fired
        if fired or "FROM run_events" not in statement:
            return
        fired = True
        with db.Session() as session:
            session.add(
                db.RunEvent(
                    run_id=run_id, kind="delta", data={"text": "tail must survive"}
                )
            )
            session.get(db.Run, run_id).status = "completed"
            session.commit()

    event.listen(db.engine, "after_cursor_execute", finish_between_reads)
    try:
        response = client.get(f"{API}/runs/{run_id}/events")
        assert fired and "tail must survive" in response.text
    finally:
        event.remove(db.engine, "after_cursor_execute", finish_between_reads)


def test_redaction_preserves_json_types_and_error_status():
    value = {
        "count": 12,
        "value": "1",
        "error": "synthetic-private-token" + "x" * 30000,
    }
    result = mcp_service.redact(value, ["1", "synthetic-private-token"])
    assert result["truncated"] and result["error"].startswith("[已隐藏]")
    assert "synthetic-private-token" not in json.dumps(result)
    assert mcp_service.redact({"count": 12, "value": "1"}, ["1"]) == {
        "count": 12,
        "value": "[已隐藏]",
    }


def test_new_and_removed_tools_do_not_inherit_unrelated_permissions(client):
    server, value = create(client, enabled=True)
    echo = next(x for x in discover(client, server) if x["name"] == "echo")
    client.patch(f"{API}/tools/{echo['id']}", json={"enabled": True})
    client.put(
        f"{API}/mcp/servers/{server['id']}",
        json={**value, "env": {"MCP_FIXTURE_EXTRA": "1", "MCP_FIXTURE_NO_ECHO": "1"}},
    )
    items = discover(client, server)
    assert not next(x for x in items if x["name"] == "extra")["enabled"]
    removed = next(x for x in items if x["id"] == echo["id"])
    assert not removed["available"]
    assert echo["id"] not in {x.name for x in tools.build_tools("", "")}


def test_connection_timeout_reaps_its_child_and_other_servers_still_work(
    client, tmp_path, monkeypatch
):
    import ctypes

    marker = tmp_path / "hang.pid"
    # No third-party code executes before the intentionally silent handshake.
    code = (
        "import os,time;from pathlib import Path;Path("
        + repr(str(marker))
        + ").write_text(str(os.getpid()));time.sleep(30)"
    )
    monkeypatch.setattr(mcp_service, "CONNECT_TIMEOUT", 0.4)
    server, _ = create(client, args=["-c", code])
    started = time.monotonic()
    tested = client.post(f"{API}/mcp/servers/{server['id']}/test").json()
    assert tested["status"] == "error" and time.monotonic() - started < 10
    if os.name == "nt" and marker.exists():
        kernel = ctypes.windll.kernel32
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_ulong),
        ]
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, int(marker.read_text()))
        if handle:
            try:
                code = ctypes.c_ulong()
                kernel.GetExitCodeProcess(handle, ctypes.byref(code))
                assert code.value != 259
            finally:
                kernel.CloseHandle(handle)
    assert "calculate" in {x.name for x in tools.build_tools("", "")}
