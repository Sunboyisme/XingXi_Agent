import json
import os
from contextlib import nullcontext

import pytest

from app import db, mcp_env, mcp_service
from .test_app import API
from .test_mcp import create, discover, call_tool


@pytest.mark.skipif(os.name != "nt", reason="Windows environment registry")
def test_windows_user_environment_and_machine_fallback(monkeypatch):
    import winreg
    monkeypatch.setattr(winreg, "OpenKey", lambda hive, path: nullcontext(hive))
    def read(hive, name):
        if hive == winreg.HKEY_CURRENT_USER:
            raise FileNotFoundError
        assert name == "MCP_QA_REGISTRY"
        return "registry-synthetic-value", winreg.REG_SZ
    monkeypatch.setattr(winreg, "QueryValueEx", read)
    assert mcp_env.windows_environment("MCP_QA_REGISTRY") == "registry-synthetic-value"
    monkeypatch.setattr(winreg, "QueryValueEx", lambda hive, name: ("user-synthetic-value", winreg.REG_SZ))
    assert mcp_env.windows_environment("MCP_QA_REGISTRY") == "user-synthetic-value"


def test_expansion_is_one_pass_and_process_overrides_windows(monkeypatch):
    monkeypatch.setenv("MCP_QA_FIRST", "literal-${MCP_QA_SECOND}")
    monkeypatch.setenv("MCP_QA_SECOND", "second")
    monkeypatch.setattr(mcp_env, "windows_environment", lambda name: "registry")
    value, secrets = mcp_env.resolve("Bearer ${MCP_QA_FIRST}/${MCP_QA_SECOND}", header=True)
    assert value == "Bearer literal-${MCP_QA_SECOND}/second"
    assert secrets == ["literal-${MCP_QA_SECOND}", "second"]
    monkeypatch.delenv("MCP_QA_FIRST")
    assert mcp_env.resolve("${MCP_QA_FIRST}")[0] == "registry"
    assert mcp_env.resolve("$MCP_QA_FIRST")[0] == "$MCP_QA_FIRST"


@pytest.mark.parametrize("value", ["${BAD-NAME}", "Bearer ${unfinished", "${}"])
def test_invalid_reference_never_contains_raw_credential(value):
    with pytest.raises(mcp_env.EnvironmentReferenceError, match="引用格式无效"):
        mcp_env.resolve(value + "private-literal")


def test_missing_empty_and_header_injection(monkeypatch):
    monkeypatch.setattr(mcp_env, "environment", lambda name: None)
    with pytest.raises(mcp_env.EnvironmentReferenceError, match="MCP_QA_ABSENT"):
        mcp_env.resolve("Bearer ${MCP_QA_ABSENT}", header=True)
    monkeypatch.setattr(mcp_env, "environment", lambda name: "")
    with pytest.raises(mcp_env.EnvironmentReferenceError):
        mcp_env.resolve("${MCP_QA_EMPTY}")
    monkeypatch.setattr(mcp_env, "environment", lambda name: "private\r\nX-Injected: value")
    with pytest.raises(mcp_env.EnvironmentReferenceError) as error:
        mcp_env.resolve("${MCP_QA_BAD}", header=True)
    assert "private" not in str(error.value)
    assert "\n" in mcp_env.resolve("${MCP_QA_BAD}")[0]  # stdio env can contain multiline values


def test_reference_round_trip_saves_without_resolving_or_exposing_secrets(client, monkeypatch):
    def forbidden(name):
        raise AssertionError("Saving/reading settings must not access environment values")
    monkeypatch.setattr(mcp_env, "environment", forbidden)
    response = client.post(API + "/mcp/servers", json={
        "name": "References", "transport": "streamable_http", "url": "https://example.invalid/mcp",
        "headers": {"Authorization": "Bearer ${MCP_QA_TOKEN}", "X-Literal": "private-literal",
                    "X-Mixed": "private-literal-${MCP_QA_TOKEN}"},
    })
    assert response.status_code == 200
    value = response.json()
    assert value["headers_templates"] == {"Authorization": "Bearer ${MCP_QA_TOKEN}"}
    assert "private-literal" not in json.dumps(value)
    with db.Session() as session:
        assert "MCP_QA_TOKEN" not in json.dumps(session.get(db.MCPServer, value["id"]).config)


def test_missing_variable_fails_before_contacting_remote_server(client, monkeypatch):
    monkeypatch.setattr(mcp_env, "environment", lambda name: None)
    response = client.post(API + "/mcp/servers", json={
        "name": "Missing", "transport": "streamable_http", "url": "https://example.invalid/mcp",
        "headers": {"Authorization": "Bearer ${MCP_QA_MISSING}"},
    })
    server = response.json()
    result = client.post(f"{API}/mcp/servers/{server['id']}/test").json()
    assert result["status"] == "error"
    assert "MCP_QA_MISSING" in result["error"]
    assert "未找到或为空" in result["error"]


def test_http_reference_authenticates_against_local_mcp(
    client, http_mcp_url, monkeypatch
):
    monkeypatch.setenv("MCP_QA_HTTP_KEY", "synthetic-mcp-secret")
    response = client.post(API + "/mcp/servers", json={
        "name": "HTTP reference", "transport": "streamable_http", "url": http_mcp_url,
        "headers": {"X-Test-Key": "${MCP_QA_HTTP_KEY}"}, "enabled": True,
    })
    assert response.status_code == 200
    assert discover(client, response.json())


def test_stdio_expansion_and_cached_value_redaction_after_rotation(client, monkeypatch):
    monkeypatch.setenv("MCP_QA_TOKEN", "old-synthetic-key")
    server, value = create(client, enabled=True, env={"MCP_FIXTURE_TOKEN": "${MCP_QA_TOKEN}"})
    echo = next(tool for tool in discover(client, server) if tool["name"] == "echo")
    client.patch(f"{API}/tools/{echo['id']}", json={"enabled": True})
    monkeypatch.setenv("MCP_QA_TOKEN", "new-synthetic-key")
    result, run_id = call_tool(client, echo["id"], {"text": "unchanged"})
    assert result["structured_content"]["fixture_token"] == "[已隐藏]"
    assert "old-synthetic-key" not in json.dumps(client.get(f"{API}/runs/{run_id}/tools").json())
    client.post(f"{API}/mcp/servers/{server['id']}/test")
    result, _ = call_tool(client, echo["id"], {"text": "again"})
    assert result["structured_content"]["fixture_token"] == "[已隐藏]"
    assert mcp_service.manager.workers[server["id"]].resolved_secrets[-1] == "new-synthetic-key"
