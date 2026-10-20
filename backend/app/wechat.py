"""Opt-in iLink text channel. Never log tokens, QR payloads or HTTP bodies.

Wire reference: Tencent/openclaw-weixin/docs/protocol_zh_CN.md.
Protocol compatibility and delivery to a real phone require a user-authorized bind.
"""

import asyncio
import base64
import contextlib
import io
import secrets
from urllib.parse import urlsplit

import httpx
import qrcode
from sqlalchemy import select

from . import agent, runs
from .config import PROFILE_ID, secret_get, secret_set
from .db import (
    Conversation,
    Memory,
    Message,
    Notification,
    Run,
    Session,
    WechatDelivery,
    WechatInbox,
    WechatState,
    now,
)

BASE_URL = "https://ilinkai.weixin.qq.com"
DEFAULTS = {
    "enabled": False,
    "reminders_enabled": False,
    "account_id": "",
    "owner_id": "",
    "base_url": BASE_URL,
    "cursor": "",
    "conversation_id": "",
    "reminders_since": "",
    "last_error": "",
}


def read_state():
    with Session() as db:
        row = db.get(WechatState, PROFILE_ID)
        return DEFAULTS | (row.data if row else {})


def update_state(**changes):
    with Session() as db:
        row = db.get(WechatState, PROFILE_ID)
        if row is None:
            row = WechatState(id=PROFILE_ID, data=DEFAULTS | changes)
            db.add(row)
        else:
            row.data = DEFAULTS | row.data | changes
        db.commit()


def trusted_url(value):
    parsed = urlsplit(value)
    host = parsed.hostname or ""
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port not in (None, 443)
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or not (host == "weixin.qq.com" or host.endswith(".weixin.qq.com"))
    ):
        raise ValueError("微信返回的服务地址不受信任，已停止连接。")
    return value.rstrip("/")


class ChannelError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(f"微信接口未接受请求（代码 {code}）")


async def request(path, *, body=None, params=None, token="", base=BASE_URL, timeout=15):
    base = trusted_url(base)
    headers = {"iLink-App-Id": "bot", "iLink-App-ClientVersion": "256"}
    if body is not None:
        headers |= {
            "Content-Type": "application/json",
            "AuthorizationType": "ilink_bot_token",
            "X-WECHAT-UIN": base64.b64encode(
                str(secrets.randbits(32)).encode()
            ).decode(),
        }
        if token:
            headers["Authorization"] = "Bearer " + token
            body = body | {
                "base_info": {"channel_version": "0.1.2", "bot_agent": "XiaoXi/0.1.2"}
            }
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
        response = await client.request(
            "POST" if body is not None else "GET",
            base + path,
            headers=headers,
            json=body,
            params=params,
        )
        if response.status_code != 200:
            raise ChannelError(f"HTTP {response.status_code}")
        value = response.json()
        if not isinstance(value, dict):
            raise ChannelError("无效响应")
        for key in ("ret", "errcode"):
            if value.get(key) not in (None, 0):
                # Codes are not arbitrary server error strings, which may contain credentials.
                code = value[key] if isinstance(value[key], int) else "未知"
                raise ChannelError(code)
        if path.endswith("/sendmessage") and value.get("ret") != 0:
            raise ValueError("微信未确认发送结果")
        return value


class WechatChannel:
    def __init__(self):
        self.worker = None
        self.sender = None
        self.pairing = None
        self.qr = ""
        self.qr_base = BASE_URL
        self.qr_image = ""
        self.phase = ""
        self.verify_code = ""
        self.control_lock = asyncio.Lock()

    def status(self):
        state = read_state()
        with Session() as db:
            recent = db.scalars(
                select(WechatDelivery)
                .order_by(WechatDelivery.created_at.desc())
                .limit(5)
            ).all()
            deliveries = [
                {
                    "id": row.id,
                    "status": row.status,
                    "error": row.error,
                    "created_at": row.created_at,
                }
                for row in recent
            ]
        phase = self.phase or ("connected" if state["enabled"] else "paused")
        if not state["account_id"] and not self.phase:
            phase = "unbound"
        return {
            "enabled": state["enabled"],
            "bound": bool(state["account_id"]),
            "reminders_enabled": state["reminders_enabled"],
            "phase": phase,
            "qr_image": self.qr_image,
            "error": state["last_error"],
            "deliveries": deliveries,
        }

    async def stop_task(self, name):
        task = getattr(self, name)
        if task:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        setattr(self, name, None)

    def start(self):
        # A request interrupted by process exit may have reached WeChat. Do not resend blindly.
        with Session() as db:
            for row in db.scalars(
                select(WechatDelivery).where(WechatDelivery.status == "sending")
            ):
                row.status = "uncertain"
                row.error = "上次发送被中断，是否送达未知；未自动重发。"
            db.commit()
        self.worker = asyncio.create_task(self.loop())
        self.sender = asyncio.create_task(self.send_loop())

    async def close(self):
        await self.stop_task("pairing")
        await self.stop_task("worker")
        await self.stop_task("sender")
        self.qr_image = ""

    async def connect(self):
        async with self.control_lock:
            await self.close()
            self.phase, self.qr = "", ""
            update_state(enabled=False, last_error="")
            value = await request(
                "/ilink/bot/get_bot_qrcode",
                body={"local_token_list": []},
                params={"bot_type": 3},
            )
            self.qr = value.get("qrcode", "")
            content = value.get("qrcode_img_content", "")
            if (
                not self.qr
                or not isinstance(content, str)
                or not 0 < len(content) <= 8192
            ):
                raise ValueError("微信未返回有效二维码，请稍后重试。")
            output = io.BytesIO()
            qrcode.make(content).save(output, format="PNG")
            self.qr_image = (
                "data:image/png;base64," + base64.b64encode(output.getvalue()).decode()
            )
            self.qr_base, self.verify_code, self.phase = BASE_URL, "", "waiting"
            self.pairing = asyncio.create_task(self.pair())
            return self.status()

    async def pair(self):
        try:
            async with asyncio.timeout(240):
                while True:
                    params = {"qrcode": self.qr}
                    if self.verify_code:
                        params["verify_code"] = self.verify_code
                    value = await request(
                        "/ilink/bot/get_qrcode_status",
                        params=params,
                        base=self.qr_base,
                        timeout=40,
                    )
                    status = value.get("status")
                    if status in (
                        "scaned_but_redirect",
                        "binded_redirect",
                    ) and value.get("redirect_host"):
                        host = value["redirect_host"]
                        self.qr_base = trusted_url(
                            host if "://" in host else "https://" + host
                        )
                    elif status == "confirmed":
                        token, owner, account = (
                            value.get("bot_token"),
                            value.get("ilink_user_id"),
                            value.get("ilink_bot_id"),
                        )
                        base = trusted_url(value.get("baseurl") or BASE_URL)
                        if not all(
                            isinstance(x, str) and x for x in (token, owner, account)
                        ):
                            raise ValueError("微信绑定信息不完整，请刷新二维码。")
                        secret_set("wechat_token", token)
                        secret_set("wechat_context", "")
                        update_state(
                            enabled=True,
                            # Connecting WeChat is the user's opt-in for reminder
                            # delivery; the switch in settings can still turn it off.
                            reminders_enabled=True,
                            account_id=account,
                            owner_id=owner,
                            base_url=base,
                            cursor="",
                            conversation_id="",
                            reminders_since=now(),
                            last_error="",
                        )
                        self.phase, self.qr_image = "connected", ""
                        self.start()
                        return
                    elif status in ("expired", "verify_code_blocked"):
                        self.phase, self.qr_image = "expired", ""
                        return
                    elif status == "need_verifycode":
                        self.phase = "need_verifycode"
                    elif status in ("wait", "scaned"):
                        self.phase = "scanned" if status == "scaned" else "waiting"
                    await asyncio.sleep(1)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - Never expose upstream bodies or credential errors.
            self.phase, self.qr_image = "error", ""
            update_state(last_error="微信绑定未完成，请检查网络后刷新二维码。")

    async def options(self, enabled, reminders_enabled):
        async with self.control_lock:
            state = read_state()
            if enabled and not state["account_id"]:
                raise ValueError("请先扫码连接微信。")
            await self.stop_task("worker")
            await self.stop_task("sender")
            changes = {"enabled": enabled, "reminders_enabled": reminders_enabled}
            if reminders_enabled and (
                not state["reminders_enabled"] or not state["enabled"]
            ):
                changes["reminders_since"] = now()
            update_state(**changes)
            self.phase = "connected" if enabled else "paused"
            if enabled:
                self.start()
            return self.status()

    async def disconnect(self):
        async with self.control_lock:
            await self.close()
            # Disable before deleting credentials so even a vault error leaves the channel stopped.
            update_state(**DEFAULTS)
            with Session() as db:
                for row in db.scalars(
                    select(WechatDelivery).where(
                        WechatDelivery.status.in_(["pending", "blocked"])
                    )
                ):
                    row.status = "cancelled"
                db.commit()
            self.phase, self.qr, self.verify_code = "unbound", "", ""
            secret_set("wechat_token", "")
            secret_set("wechat_context", "")
            return self.status()

    async def receive(self, value):
        state = read_state()
        if (
            not state["enabled"]
            or value.get("message_type") != 1
            or value.get("from_user_id") != state["owner_id"]
            or value.get("group_id")
        ):
            return
        message_id = value.get("message_id")
        if message_id is None:
            return
        inbox_id = state["account_id"] + ":" + str(message_id)
        with Session() as db:
            if db.get(WechatInbox, inbox_id):
                return
        # The same conversation can also be opened on the desktop. Finish its
        # existing turn before appending the next WeChat message to the context.
        while state["conversation_id"]:
            with Session() as db:
                active = db.scalar(
                    select(Run.id).where(
                        Run.conversation_id == state["conversation_id"],
                        Run.status.in_(["queued", "running"]),
                    )
                )
            if not active:
                break
            await asyncio.sleep(0.5)
            if not read_state()["enabled"]:
                return
        if isinstance(value.get("context_token"), str) and value["context_token"]:
            secret_set("wechat_context", value["context_token"])
            with Session() as db:
                for row in db.scalars(
                    select(WechatDelivery).where(
                        WechatDelivery.account_id == state["account_id"],
                        WechatDelivery.status == "blocked",
                    )
                ):
                    row.status, row.error = "pending", ""
                db.commit()
        with Session() as db:
            if db.get(WechatInbox, inbox_id):
                return  # Never execute Agent/tools twice for a redelivered message.
            conversation = (
                db.get(Conversation, state["conversation_id"])
                if state["conversation_id"]
                else None
            )
            if conversation is None:
                conversation = Conversation(title="微信 · XiaoXi")
                db.add(conversation)
                db.flush()
            text = "\n".join(
                item.get("text_item", {}).get("text", "")
                for item in value.get("item_list", [])
                if item.get("type") == 1
            ).strip()
            run = Run(kind="chat", conversation_id=conversation.id)
            db.add(run)
            db.flush()
            db.add(WechatInbox(id=inbox_id, run_id=run.id))
            db.add(
                Message(
                    conversation_id=conversation.id,
                    role="user",
                    content=text[:30000] or "[微信非文字消息]",
                )
            )
            conversation.updated_at = now()
            run_id, conversation_id = run.id, conversation.id
            db.commit()
        update_state(conversation_id=conversation_id, last_error="")
        if text:
            runs.launch(run_id, lambda: agent.chat(run_id, conversation_id))
            await runs.tasks[run_id]
            with Session() as db:
                run = db.get(Run, run_id)
                content = (
                    run.result.get("content", "")
                    if run.status == "completed"
                    else "这次处理未完成，请到XiaoXi桌面查看执行记录。"
                )
                candidates = list(
                    db.scalars(
                        select(Memory).where(
                            Memory.source_conversation_id == conversation_id,
                            Memory.state == "candidate",
                        )
                    )
                )
                if candidates:
                    content += "\n有记忆待确认，请在桌面「记忆」页查看。"
        else:
            content = "微信入口目前支持文字，图片、语音和文件请在XiaoXi桌面使用。"
            with Session() as db:
                run = db.get(Run, run_id)
                run.status, run.result = "completed", {"content": content}
                db.commit()
        self.enqueue("chat:" + inbox_id, content, state["account_id"])

    def enqueue(self, source, content, account, notification_id=None):
        with Session() as db:
            if not db.scalar(
                select(WechatDelivery).where(WechatDelivery.source_key == source)
            ):
                db.add(
                    WechatDelivery(
                        source_key=source,
                        account_id=account,
                        notification_id=notification_id,
                        content=content[:16000],
                    )
                )
                db.commit()

    def queue_reminders(self):
        state = read_state()
        if (
            not state["enabled"]
            or not state["reminders_enabled"]
            or not state["reminders_since"]
        ):
            return
        with Session() as db:
            notes = db.scalars(
                select(Notification).where(
                    Notification.created_at >= state["reminders_since"],
                    Notification.status.not_in(["cancelled", "snoozed"]),
                )
            ).all()
        for note in notes:
            self.enqueue(
                "reminder:" + note.id + ":" + state["account_id"] + (f":snooze{note.generation}" if note.generation else ""),
                "XiaoXi提醒你：" + note.title + ("\n" + note.body if note.body else ""),
                state["account_id"],
                note.id,
            )

    async def deliver(self):
        state = read_state()
        if not state["enabled"] or not state["account_id"]:
            return
        context = secret_get("wechat_context")
        if not context:
            update_state(last_error="请先在微信里给XiaoXi发一条消息，激活回复与提醒。")
            return
        with Session() as db:
            rows = db.scalars(
                select(WechatDelivery)
                .where(
                    WechatDelivery.account_id == state["account_id"],
                    WechatDelivery.status == "pending",
                )
                .order_by(WechatDelivery.created_at)
                .limit(5)
            ).all()
        for row in rows:
            if row.notification_id:
                with Session() as db:
                    note = db.get(Notification, row.notification_id)
                    if (
                        not state["reminders_enabled"]
                        or not note
                        or note.status in {"cancelled", "snoozed"}
                        or note.created_at < state["reminders_since"]
                    ):
                        item = db.get(WechatDelivery, row.id)
                        item.status = "cancelled"
                        db.commit()
                        continue
            with Session() as db:
                db.get(WechatDelivery, row.id).status = "sending"
                db.commit()
            status, error = "accepted", ""
            try:
                await request(
                    "/ilink/bot/sendmessage",
                    base=state["base_url"],
                    token=secret_get("wechat_token"),
                    body={
                        "msg": {
                            "from_user_id": "",
                            "to_user_id": state["owner_id"],
                            "client_id": row.id,
                            "message_type": 2,
                            "message_state": 2,
                            "context_token": context,
                            "item_list": [
                                {"type": 1, "text_item": {"text": row.content}}
                            ],
                        }
                    },
                )
            except ChannelError as exc:
                status = "blocked" if exc.code == -2 else "failed"
                error = (
                    "微信会话不可用，请在微信里重新发一条消息。"
                    if exc.code == -2
                    else str(exc)
                )
                if exc.code == -14:
                    self.phase = "needs_login"
                    update_state(enabled=False)
                    error = "微信登录已失效，请重新扫码。"
            except asyncio.CancelledError:
                raise  # Persisted 'sending' is recovered as uncertain, never blindly resent.
            except Exception:  # noqa: BLE001 - Unknown network outcomes must not be retried.
                status, error = "uncertain", "发送结果未知，请到微信确认；未自动重发。"
            with Session() as db:
                item = db.get(WechatDelivery, row.id)
                item.status, item.error = status, error
                db.commit()
            update_state(last_error=error)
            if status != "accepted":
                break

    async def recover_replies(self):
        # Recover the reply after an exit between Agent completion and enqueue.
        state = read_state()
        with Session() as db:
            entries = db.scalars(
                select(WechatInbox).where(
                    WechatInbox.id.startswith(state["account_id"] + ":")
                )
            ).all()
            for entry in entries:
                run = db.get(Run, entry.run_id)
                if run and run.status not in ("running", "queued"):
                    self.enqueue(
                        "chat:" + entry.id,
                        run.result.get("content", "")
                        if run.status == "completed"
                        else "上次处理已中断，请到桌面查看；未重复执行。",
                        state["account_id"],
                    )

    async def send_loop(self):
        while read_state()["enabled"]:
            try:
                self.queue_reminders()
                await self.deliver()
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 - Keep the channel alive without leaking secrets.
                update_state(last_error="微信提醒处理失败，请查看连接状态。")
            await asyncio.sleep(2)

    async def loop(self):
        failures = 0
        recovered = False
        while True:
            try:
                state = read_state()
                if not state["enabled"] or not state["account_id"]:
                    return
                token = secret_get("wechat_token")
                if not token:
                    self.phase = "needs_login"
                    update_state(
                        enabled=False, last_error="微信登录已失效，请重新扫码。"
                    )
                    return
                if not recovered:
                    await self.recover_replies()
                    recovered = True
                value = await request(
                    "/ilink/bot/getupdates",
                    body={"get_updates_buf": state["cursor"]},
                    token=token,
                    base=state["base_url"],
                    timeout=40,
                )
                for message in value.get("msgs", []):
                    await self.receive(message)
                if value.get("get_updates_buf"):
                    update_state(cursor=value["get_updates_buf"])
                failures = 0
                self.phase = "connected"
                await asyncio.sleep(0.5)
            except asyncio.CancelledError:
                raise
            except ChannelError as exc:
                if exc.code == -14:
                    self.phase = "needs_login"
                    update_state(
                        enabled=False, last_error="微信登录已失效，请重新扫码。"
                    )
                    return
                self.phase = "reconnecting"
                update_state(last_error=str(exc))
                failures += 1
                await asyncio.sleep(min(30, 2 ** min(failures, 5)))
            except httpx.ReadTimeout:
                pass  # Normal long-poll timeout; do not advance the cursor.
            except Exception:  # noqa: BLE001 - Never log upstream error text containing tokens.
                self.phase = "reconnecting"
                update_state(last_error="微信连接暂时中断，正在重连。")
                failures += 1
                await asyncio.sleep(min(30, 2 ** min(failures, 5)))
