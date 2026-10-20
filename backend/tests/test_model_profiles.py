import json
import sqlite3
import time
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from langchain_core.messages import HumanMessage

from app import db, model_profiles, provider
from . import mock_provider


def profile(
    id="custom",
    url="https://example.com/v1",
    names=("first", "second"),
    mode="thinking",
    key=None,
):
    return {
        "id": id,
        "model_url": url,
        "default_model": names[-1] if names else "",
        "api_key": key,
        "models": [{"name": x, "thinking_mode": mode} for x in names],
    }


def test_presets_legacy_key_and_independent_provider_credentials(configured, isolate):
    value = configured.get("/api/v1/settings").json()
    assert {x["id"] for x in value["provider_presets"]} == {
        x[0] for x in model_profiles.PRESETS
    }
    presets = {x["id"]: x for x in value["provider_presets"]}
    assert [x["name"] for x in presets["bailian"]["models"]] == [
        "qwen3.7-flash",
        "qwen-plus",
    ]
    assert [x["name"] for x in presets["zhipu"]["models"]] == [
        "glm-4.7-flash",
        "glm-4.7",
    ]
    assert [x["name"] for x in presets["siliconflow"]["models"]] == [
        "deepseek-ai/DeepSeek-V4-Flash",
        "Qwen/Qwen3-8B",
    ]
    assert all(
        x["thinking_control"] != "auto"
        for preset in presets.values()
        for x in preset["models"]
    )
    assert value["default_provider"] == "custom" and value["model_configured"]
    assert next(x for x in value["providers"] if x["id"] == "custom")["key_configured"]
    result = configured.put(
        "/api/v1/settings",
        json={
            "providers": [
                profile("deepseek", key="synthetic-deepseek-key"),
                profile("kimi", key="synthetic-kimi-key"),
            ],
            "default_provider": "deepseek",
        },
    )
    assert result.status_code == 200
    assert result.json()["model_name"] == "second"
    assert isolate["model"] == "synthetic-key"
    assert isolate["model:deepseek"] == "synthetic-deepseek-key"
    assert "synthetic-" not in result.text
    # Saving another profile neither clears keys nor changes the default model.
    result = configured.put(
        "/api/v1/settings", json={"providers": [profile("kimi")]}
    ).json()
    assert result["default_provider"] == "deepseek" and result["model_name"] == "second"
    assert isolate["model:kimi"] == "synthetic-kimi-key"
    configured.put(
        "/api/v1/settings", json={"providers": [profile("deepseek", key="")]}
    ).raise_for_status()
    assert not configured.get("/api/v1/settings").json()["model_configured"]
    assert isolate["model:kimi"] == "synthetic-kimi-key"
    with db.Session() as session:
        raw = json.dumps(session.get(db.Settings, "local").model_providers)
        assert "api_key" not in raw and "synthetic-" not in raw


@pytest.mark.parametrize(
    "change",
    [
        {"models": [{"name": "same"}, {"name": " same "}]},
        {"default_model": "not-added"},
        {"model_url": "https://user:password@example.com/v1"},
        {"model_url": "https://example.com/v1?api_key=secret"},
    ],
)
def test_invalid_profiles_do_not_write_keys(client, isolate, change):
    value = {**profile(key="synthetic-invalid"), **change}
    response = client.put("/api/v1/settings", json={"providers": [value]})
    assert response.status_code == 422 and "model" not in isolate
    assert "synthetic-invalid" not in response.text


def test_multiple_connections_to_same_provider_and_delete_default(client, isolate):
    first = {
        **profile("conn_work", key="synthetic-work"),
        "provider_type": "deepseek",
        "label": "工作",
    }
    second = {
        **profile(
            "conn_personal",
            url="https://second.example.com/v1",
            names=("backup",),
            key="synthetic-personal",
        ),
        "provider_type": "deepseek",
        "label": "个人",
    }
    client.put(
        "/api/v1/settings",
        json={"providers": [first, second], "default_provider": "conn_work"},
    ).raise_for_status()
    value = client.get("/api/v1/settings").json()
    assert len(value["providers"]) == 2 and value["model_name"] == "second"
    assert isolate["model:conn_work"] == "synthetic-work"
    assert isolate["model:conn_personal"] == "synthetic-personal"
    value = client.delete("/api/v1/settings/providers/conn_work").json()
    assert (
        value["default_provider"] == "conn_personal" and value["model_name"] == "backup"
    )
    assert not isolate["model:conn_work"] and isolate["model:conn_personal"]
    value = client.delete("/api/v1/settings/providers/conn_personal").json()
    assert value["providers"] == [] and not value["model_configured"]


@pytest.mark.parametrize(
    "mode,enabled,expected",
    [
        ("thinking", True, {"thinking": {"type": "enabled"}}),
        ("thinking", False, {"thinking": {"type": "disabled"}}),
        ("enable_thinking", True, {"enable_thinking": True}),
        ("enable_thinking", False, {"enable_thinking": False}),
        ("reasoning_effort", True, {"reasoning_effort": "high"}),
        ("reasoning_effort", False, {"reasoning_effort": "none"}),
    ],
)
@pytest.mark.asyncio
async def test_thinking_switch_reaches_actual_http_request(
    client, mock_server, monkeypatch, mode, enabled, expected
):
    captured = []
    original = mock_provider.reply

    def observe(body):
        captured.append(body)
        return original(body)

    monkeypatch.setattr(mock_provider, "reply", observe)
    client.put(
        "/api/v1/settings",
        json={"providers": [profile(url=mock_server, mode=mode, key="synthetic-key")]},
    ).raise_for_status()
    with db.Session() as session:
        config = model_profiles.resolve(session.get(db.Settings, "local"))
    config["thinking_enabled"] = enabled
    await provider.model(config).ainvoke([HumanMessage(content="test")])
    assert captured[0]["model"] == "second"
    for key, value in expected.items():
        assert captured[0][key] == value


def wait_run(client, id):
    for _ in range(100):
        value = client.get(f"/api/v1/runs/{id}").json()
        if value["status"] not in {"queued", "running"}:
            assert value["status"] == "completed", value
            return
        time.sleep(0.03)
    pytest.fail("run did not finish")


def test_selected_model_reasoning_survives_stream_tools_and_next_turn(
    client, mock_server, monkeypatch
):
    captured = []
    original = mock_provider.reply

    def observe(body):
        captured.append(body)
        return {
            **original(body),
            "reasoning_content": "synthetic reasoning for tool round",
        }

    monkeypatch.setattr(mock_provider, "reply", observe)
    client.put(
        "/api/v1/settings",
        json={"providers": [profile(url=mock_server, key="synthetic-key")]},
    ).raise_for_status()
    conversation = client.post("/api/v1/conversations", json={}).json()["id"]
    selection = {
        "provider_id": "custom",
        "model_name": "first",
        "thinking_enabled": True,
    }
    response = client.post(
        f"/api/v1/conversations/{conversation}/messages",
        json={"content": "帮我计算 1+1", "model_selection": selection},
    )
    response.raise_for_status()
    wait_run(client, response.json()["id"])
    assert len(captured) == 2
    assert all(x["model"] == "first" for x in captured)
    tool_round = next(x for x in captured[1]["messages"] if x.get("tool_calls"))
    assert tool_round["reasoning_content"] == "synthetic reasoning for tool round"
    assert captured[1]["thinking"] == {"type": "enabled"}
    # New turns retain the provider's prior assistant context without exposing it in the UI API.
    response2 = client.post(
        f"/api/v1/conversations/{conversation}/messages",
        json={"content": "继续", "model_selection": selection},
    )
    response2.raise_for_status()
    wait_run(client, response2.json()["id"])
    previous = next(x for x in captured[-1]["messages"] if x["role"] == "assistant")
    assert previous["reasoning_content"] == "synthetic reasoning for tool round"
    assert (
        "reasoning_content"
        not in client.get(f"/api/v1/conversations/{conversation}/messages").text
    )
    with db.Session() as session:
        run = session.get(db.Run, response.json()["id"])
        assert (
            run.model_config["model_name"] == "first"
            and run.model_config["thinking_enabled"]
        )
        assert "api_key" not in run.model_config


@pytest.mark.parametrize(
    "url,name,mode",
    [
        ("https://api.deepseek.com/v1", "deepseek-v4-pro", "thinking"),
        ("https://api.moonshot.cn/v1", "kimi-k2.6", "thinking"),
        ("https://api.moonshot.cn/v1", "kimi-k3", "always"),
        ("https://open.bigmodel.cn/api/paas/v4", "glm-4.7", "thinking"),
        ("https://open.bigmodel.cn/api/paas/v4", "glm-5.3", "always"),
        ("https://api.siliconflow.cn/v1", "Qwen/Qwen3-8B", "enable_thinking"),
        ("https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-V4-Flash", "thinking"),
        ("https://api.siliconflow.cn/v1", "deepseek-ai/DeepSeek-R1", "always"),
        (
            "https://dashscope.aliyuncs.com/compatible-mode/v1",
            "qwen-plus",
            "enable_thinking",
        ),
        ("https://example.com/v1", "unknown", "none"),
    ],
)
def test_capabilities_are_provider_and_model_specific(url, name, mode):
    assert model_profiles.thinking_control(url, {"name": name}) == mode


def test_model_migration_preserves_old_settings_and_history(tmp_path):
    root = Path(__file__).resolve().parents[1]
    path = tmp_path / "upgrade-models.sqlite"
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "migrations"))
    config.set_main_option("sqlalchemy.url", "sqlite:///" + path.as_posix())
    command.upgrade(config, "0004")
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO settings (id,model_url,model_name,vision_enabled,timezone,memory_mode) VALUES ('local','https://example.com/v1','old-model',1,'Asia/Shanghai','confirm')"
        )
    command.upgrade(config, "head")
    with sqlite3.connect(path) as connection:
        value = connection.execute(
            "SELECT model_name,vision_enabled,memory_mode,default_provider,model_providers FROM settings"
        ).fetchone()
        assert value == ("old-model", 1, "confirm", "custom", "[]")
