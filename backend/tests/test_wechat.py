import asyncio
import json
import sqlite3
from pathlib import Path

import httpx
import pytest
from alembic import command
from alembic.config import Config
from app import db, wechat
from sqlalchemy import select


@pytest.fixture(autouse=True)
def wechat_vault(monkeypatch):
    vault = {}
    monkeypatch.setattr(wechat, "secret_get", lambda key: vault.get(key, ""))
    monkeypatch.setattr(
        wechat, "secret_set", lambda key, value: vault.__setitem__(key, value)
    )
    return vault


def bind(vault):
    wechat.update_state(
        enabled=True,
        account_id="bot",
        owner_id="owner",
        reminders_enabled=True,
        reminders_since="1970-01-01T00:00:00Z",
    )
    vault.update(wechat_token="synthetic-bot-token", wechat_context="synthetic-context")


def incoming(number=1, owner="owner"):
    return {
        "message_id": number,
        "message_type": 1,
        "from_user_id": owner,
        "context_token": "new-context",
        "item_list": [{"type": 1, "text_item": {"text": "你好"}}],
    }


async def fake_chat(run_id, conversation_id):
    with db.Session() as session:
        session.add(
            db.Message(
                conversation_id=conversation_id,
                role="assistant",
                content="你好，我是XiaoXi",
            )
        )
        session.commit()
    return {"content": "你好，我是XiaoXi"}


def note(status="pending"):
    with db.Session() as session:
        reminder = db.Reminder(title="喝水", due_at=db.now())
        session.add(reminder)
        session.flush()
        row = db.Notification(
            reminder_id=reminder.id,
            occurrence_at=reminder.due_at,
            title="喝水",
            body="休息一下",
            status=status,
        )
        session.add(row)
        session.commit()
        return row.id


def deliveries():
    with db.Session() as session:
        return session.scalars(select(db.WechatDelivery)).all()


def test_disabled_default_and_authenticated_status(client, monkeypatch):
    async def forbidden(*args, **kwargs):
        pytest.fail("Disabled channel must not request any external service")

    monkeypatch.setattr(wechat, "request", forbidden)
    assert (
        client.get("/api/v1/wechat/status", headers={"Authorization": ""}).status_code
        == 401
    )
    status = client.get("/api/v1/wechat/status").json()
    assert status["enabled"] is False
    assert status["bound"] is False
    assert status["deliveries"] == []
    assert (
        client.put("/api/v1/wechat/options", json={"enabled": True}).status_code == 400
    )


@pytest.mark.parametrize(
    "url",
    [
        "http://ilinkai.weixin.qq.com",
        "https://evil.example",
        "https://weixin.qq.com.evil.example",
        "https://x@ilinkai.weixin.qq.com",
        "https://ilinkai.weixin.qq.com:8080",
        "https://ilinkai.weixin.qq.com/path",
    ],
)
def test_reject_untrusted_api_hosts(url):
    with pytest.raises(ValueError):
        wechat.trusted_url(url)


async def test_request_authentication_and_safe_errors(monkeypatch):
    captured = []

    def handle(request):
        captured.append(request)
        return httpx.Response(200, json={"ret": -2, "errmsg": "secret-should-not-leak"})

    original = httpx.AsyncClient
    monkeypatch.setattr(
        wechat.httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs),
    )
    with pytest.raises(wechat.ChannelError) as failure:
        await wechat.request(
            "/ilink/bot/sendmessage", body={"msg": {}}, token="private-token"
        )
    assert "secret-should-not-leak" not in str(failure.value)
    assert captured[0].headers["Authorization"] == "Bearer private-token"
    assert json.loads(captured[0].content)["base_info"]["bot_agent"].startswith(
        "XiaoXi/"
    )


async def test_qr_binding_stores_credentials_outside_status(monkeypatch, wechat_vault):
    channel = wechat.WechatChannel()

    async def api(path, **kwargs):
        if path.endswith("get_bot_qrcode"):
            return {
                "qrcode": "test-qr",
                "qrcode_img_content": "https://example.com/qr-test",
            }
        return {
            "status": "confirmed",
            "bot_token": "private-token",
            "ilink_user_id": "owner",
            "ilink_bot_id": "bot",
            "baseurl": wechat.BASE_URL,
        }

    monkeypatch.setattr(wechat, "request", api)
    monkeypatch.setattr(channel, "start", lambda: None)
    status = await channel.connect()
    assert status["phase"] == "waiting"
    assert status["qr_image"].startswith("data:image/png;base64,")
    await channel.pairing
    status = channel.status()
    assert status["phase"] == "connecting" and status["bound"]
    assert status["qr_image"] == ""
    assert "private-token" not in json.dumps(status)
    assert "private-token" not in json.dumps(wechat.read_state())
    assert wechat_vault["wechat_token"] == "private-token"
    await channel.disconnect()
    assert not channel.status()["bound"]
    assert wechat_vault["wechat_token"] == ""


async def test_owner_only_and_inbound_deduplication(monkeypatch, wechat_vault):
    bind(wechat_vault)
    calls = []

    async def chat(*args):
        calls.append(args)
        return await fake_chat(*args)

    monkeypatch.setattr(wechat.agent, "chat", chat)
    channel = wechat.WechatChannel()
    await channel.receive(incoming(owner="stranger"))
    assert not calls
    await channel.receive(incoming())
    await channel.receive(incoming())
    assert len(calls) == 1
    assert len(deliveries()) == 1
    assert deliveries()[0].content == "你好，我是XiaoXi"
    with db.Session() as session:
        assert len(session.scalars(select(db.Message)).all()) == 2
    wechat.update_state(enabled=False)
    await channel.receive(incoming(2))
    assert len(calls) == 1


async def test_recover_completed_reply_without_rerunning_agent(wechat_vault):
    bind(wechat_vault)
    with db.Session() as session:
        run = db.Run(kind="chat", status="completed", result={"content": "已完成"})
        session.add(run)
        session.flush()
        session.add(db.WechatInbox(id="bot:replayed", run_id=run.id))
        session.commit()
    channel = wechat.WechatChannel()
    await channel.recover_replies()
    await channel.recover_replies()
    assert len(deliveries()) == 1
    assert deliveries()[0].content == "已完成"


async def test_reminder_delivery_independent_from_desktop_ack(
    monkeypatch, wechat_vault
):
    bind(wechat_vault)
    note("read")
    channel = wechat.WechatChannel()
    channel.queue_reminders()
    channel.queue_reminders()
    assert len(deliveries()) == 1
    calls = []

    async def send(path, **kwargs):
        calls.append(kwargs)
        return {"ret": 0}

    monkeypatch.setattr(wechat, "request", send)
    await channel.deliver()
    await channel.deliver()
    assert len(calls) == 1
    assert calls[0]["body"]["msg"]["context_token"] == "synthetic-context"
    assert deliveries()[0].status == "accepted"


async def test_unknown_result_is_not_automatically_resent(monkeypatch, wechat_vault):
    bind(wechat_vault)
    channel = wechat.WechatChannel()
    note()
    channel.queue_reminders()
    calls = []

    async def uncertain(*args, **kwargs):
        calls.append(1)
        raise httpx.ReadTimeout("request contained private-token")

    monkeypatch.setattr(wechat, "request", uncertain)
    await channel.deliver()
    await channel.deliver()
    row = deliveries()[0]
    assert len(calls) == 1 and row.status == "uncertain"
    assert "private-token" not in row.error


async def test_expired_context_waits_for_new_message(monkeypatch, wechat_vault):
    bind(wechat_vault)
    channel = wechat.WechatChannel()
    note()
    channel.queue_reminders()
    calls = []

    async def expired(*args, **kwargs):
        calls.append(1)
        raise wechat.ChannelError(-2)

    monkeypatch.setattr(wechat, "request", expired)
    await channel.deliver()
    await channel.deliver()
    assert len(calls) == 1 and deliveries()[0].status == "blocked"
    monkeypatch.setattr(wechat.agent, "chat", fake_chat)
    await channel.receive(incoming())
    assert deliveries()[0].status == "pending"


async def test_cancelled_notification_is_not_sent(monkeypatch, wechat_vault):
    bind(wechat_vault)
    channel = wechat.WechatChannel()
    notification_id = note()
    channel.queue_reminders()
    with db.Session() as session:
        session.get(db.Notification, notification_id).status = "cancelled"
        session.commit()

    async def forbidden(*args, **kwargs):
        pytest.fail("Cancelled notification must not be sent")

    monkeypatch.setattr(wechat, "request", forbidden)
    await channel.deliver()
    assert deliveries()[0].status == "cancelled"


async def test_restart_recovers_inflight_as_uncertain(wechat_vault):
    bind(wechat_vault)
    channel = wechat.WechatChannel()
    channel.enqueue("chat:interrupted", "测试", "bot")
    with db.Session() as session:
        session.scalars(select(db.WechatDelivery)).first().status = "sending"
        session.commit()
    wechat.update_state(enabled=False)
    channel.start()
    await asyncio.sleep(0)
    assert deliveries()[0].status == "uncertain"
    await channel.close()


def test_schema_upgrade_preserves_existing_conversations(tmp_path):
    path = tmp_path / "upgrade.sqlite"
    backend = Path(__file__).resolve().parents[1]
    config = Config(str(backend / "alembic.ini"))
    config.set_main_option("script_location", str(backend / "migrations"))
    config.set_main_option("sqlalchemy.url", "sqlite:///" + path.as_posix())
    command.upgrade(config, "0002")
    with sqlite3.connect(path) as connection:
        connection.execute(
            "INSERT INTO conversations (id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            ("existing", "local", "保留历史", db.now(), db.now()),
        )
    command.upgrade(config, "head")
    with sqlite3.connect(path) as connection:
        assert (
            connection.execute(
                "SELECT title FROM conversations WHERE id='existing'"
            ).fetchone()[0]
            == "保留历史"
        )
        assert (
            connection.execute(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name LIKE 'wechat_%'"
            ).fetchone()[0]
            == 3
        )
