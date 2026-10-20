import asyncio
import base64
import io
import json
import os
import sys
import zipfile
from pathlib import Path

import pytest
from app import artifacts, data_transfer, db, feature_tools, skills, tools
from app import calendar_service as calendar
from fastapi import HTTPException
from PIL import Image

from .test_app import API


def event(**changes):
    return {
        "title": "读书",
        "start": "2026-10-20T09:00:00+08:00",
        "end": "2026-10-20T10:00:00+08:00",
        **changes,
    }


def make_run():
    with db.Session() as session:
        run = db.Run(kind="chat", status="completed")
        session.add(run)
        session.commit()
        return run.id


def import_example(client, script=None):
    files = [
        (
            "files",
            (
                "SKILL.md",
                b"---\nname: text-notes\ndescription: Make a note\n---\nRead references/format.md and run scripts/make_note.py\n",
            ),
        ),
        ("files", ("references/format.md", b"Write outputs in XIAOXI_OUTPUT_DIR")),
        (
            "files",
            (
                "scripts/make_note.py",
                script
                or b'import os\nfrom pathlib import Path\nPath(os.environ["XIAOXI_OUTPUT_DIR"], "note.txt").write_text("hello")\nprint("done")\n',
            ),
        ),
    ]
    response = client.post(API + "/skills/preview", files=files)
    assert response.status_code == 200, response.text
    preview = response.json()
    response = client.post(
        API + "/skills/import",
        json={
            "preview_id": preview["preview_id"],
            "replace_id": preview["existing_id"],
        },
    )
    assert response.status_code == 200, response.text
    return response.json()


def authorize(client, row):
    assert (
        client.patch(
            f"{API}/skills/{row['id']}", json={"enabled": True, "scripts_allowed": True}
        ).status_code
        == 200
    )
    assert (
        client.put(API + "/skill-runtimes", json={"python": sys.executable}).status_code
        == 200
    )


def test_calendar_range_all_day_and_atomic_batch(client):
    response = client.post(
        API + "/calendar/events/batch",
        json={
            "events": [
                event(),
                event(title="跨日", all_day=True, start="2026-10-19", end="2026-10-22"),
            ]
        },
    )
    assert response.status_code == 200, response.text
    timed, all_day = response.json()
    assert timed["start"] == "2026-10-20T01:00:00.000000+00:00"
    assert all_day["start"] == "2026-10-19"
    assert (
        len(client.get(API + "/calendar/events?start=2026-10-21&end=2026-10-22").json())
        == 1
    )
    assert not client.get(
        API + "/calendar/events?start=2026-10-22&end=2026-10-23"
    ).json()
    invalid = client.post(
        API + "/calendar/events/batch",
        json={"events": [event(), event(end="2026-10-19T10:00:00+08:00")]},
    )
    assert invalid.status_code == 422
    assert len(client.get(API + "/calendar/events").json()) == 2
    assert (
        client.post(
            API + "/calendar/events", json=event(timezone="unknown")
        ).status_code
        == 422
    )
    assert (
        client.post(
            API + "/calendar/events", json=event(start="2026-10-20T09:00:00")
        ).status_code
        == 422
    )
    assert (
        client.get(API + "/calendar/events", headers={"Authorization": ""}).status_code
        == 401
    )


def test_calendar_reminder_edit_complete_cancel_delete(client):
    row = client.post(
        API + "/calendar/events", json=event(reminder_enabled=True)
    ).json()
    reminder = client.get(API + "/reminders").json()[0]
    assert reminder["calendar_event_id"] == row["id"]
    updated = client.put(
        f"{API}/calendar/events/{row['id']}",
        json=event(
            title="散步",
            reminder_enabled=True,
            start="2026-10-20T11:00:00+08:00",
            end="2026-10-20T12:00:00+08:00",
        ),
    ).json()
    assert updated["reminder_id"] == row["reminder_id"]
    reminder = client.get(API + "/reminders").json()[0]
    assert reminder["title"] == "散步" and "03:00:00" in reminder["due_at"]
    assert (
        client.post(
            f"{API}/reminders/{reminder['id']}/action", json={"action": "complete"}
        ).status_code
        == 200
    )
    assert client.get(API + "/calendar/events").json()[0]["status"] == "completed"
    client.put(f"{API}/calendar/events/{row['id']}", json=event(reminder_enabled=True))
    client.post(f"{API}/reminders/{reminder['id']}/action", json={"action": "cancel"})
    assert not client.get(API + "/calendar/events").json()[0]["reminder_enabled"]
    client.delete(f"{API}/calendar/events/{row['id']}")
    assert client.get(API + "/reminders").json()[0]["status"] == "cancelled"
    all_day = client.post(
        API + "/calendar/events",
        json=event(
            all_day=True, start="2026-10-21", end="2026-10-22", reminder_enabled=True
        ),
    ).json()
    assert (
        "01:00:00"
        in next(
            x
            for x in client.get(API + "/reminders").json()
            if x["id"] == all_day["reminder_id"]
        )["due_at"]
    )


def test_calendar_tool_requires_confirmation_and_retry_is_idempotent(client):
    conversation = client.post(API + "/conversations", json={"title": "规划"}).json()
    with db.Session() as session:
        session.add(
            db.Message(
                conversation_id=conversation["id"], role="user", content="安排明天"
            )
        )
        session.commit()
    tool = next(
        x
        for x in tools.build_tools(make_run(), conversation["id"])
        if x.name == "create_plans"
    )
    proposal = json.loads(tool.invoke({"plans": [event()]}))
    assert proposal["status"] == "needs_confirmation"
    assert len(calendar.list_events()) == 0
    same_turn = json.loads(
        tool.invoke({"plans": [event()], "confirm": True})
    )
    assert "本轮" in same_turn["error"]
    assert len(calendar.list_events()) == 0
    with db.Session() as session:
        session.add(
            db.Message(
                conversation_id=conversation["id"], role="user", content="确认创建"
            )
        )
        session.commit()
    confirmed = next(
        x
        for x in tools.build_tools(make_run(), conversation["id"])
        if x.name == "create_plans"
    )
    first = json.loads(
        confirmed.invoke({"plans": [event()], "confirm": True})
    )
    again = json.loads(
        confirmed.invoke({"plans": [event()], "confirm": True})
    )
    assert first == again and len(calendar.list_events()) == 1
    with db.Session() as session:
        session.add(
            db.Message(
                conversation_id=conversation["id"],
                role="user",
                content="明确安排另一个计划",
            )
        )
        session.commit()
    explicit = next(
        x
        for x in tools.build_tools(make_run(), conversation["id"])
        if x.name == "create_plans"
    )
    created = json.loads(
        explicit.invoke(
            {
                "plans": [event(title="明确计划")],
                "explicit_request": True,
            }
        )
    )
    assert created[0]["title"] == "明确计划"
    assert len(calendar.list_events()) == 2


def test_learning_goal_tool_requires_a_later_user_confirmation(client):
    conversation = client.post(API + "/conversations", json={"title": "学习"}).json()
    with db.Session() as session:
        session.add(
            db.Message(
                conversation_id=conversation["id"], role="user", content="我想学做饭"
            )
        )
        session.commit()
    tool = next(
        x
        for x in tools.build_tools(make_run(), conversation["id"])
        if x.name == "create_learning_goal"
    )
    direct = json.loads(
        tool.invoke({"title": "学习做饭", "confirm": True})
    )
    assert "待确认" in direct["error"]
    proposal = json.loads(
        tool.invoke({"title": "学习做饭", "objective": "能独立做晚餐"})
    )
    assert proposal["status"] == "needs_confirmation"
    same_turn = json.loads(
        tool.invoke(
            {
                "title": "学习做饭",
                "objective": "能独立做晚餐",
                "confirm": True,
            }
        )
    )
    assert "本轮" in same_turn["error"]
    assert client.get(API + "/learning/goals").json() == []


def test_skill_preview_defaults_replacement_and_traversal(client):
    row = import_example(client)
    assert not row["enabled"] and not row["scripts_allowed"]
    assert not skills.catalog()
    authorize(client, row)
    assert skills.read_file(row["id"], "references/format.md")["text"]
    with pytest.raises(HTTPException):
        skills.read_file(row["id"], "../auth-token")
    replacement = import_example(client, b'print("new")')
    assert replacement["id"] == row["id"]
    assert not replacement["scripts_allowed"] and not replacement["enabled"]
    for name in (
        "../SKILL.md",
        "C:/SKILL.md",
        "a/../../SKILL.md",
        "NUL.txt",
        "a/evil:stream",
    ):
        result = client.post(API + "/skills/preview", files={"files": (name, b"bad")})
        assert result.status_code == 422
    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w") as zip:
        zip.writestr("../SKILL.md", "bad")
    assert (
        client.post(
            API + "/skills/preview", files={"files": ("bad.zip", archive.getvalue())}
        ).status_code
        == 422
    )


def test_skill_exec_permissions_outputs_errors_and_missing_runtime(client):
    row = import_example(client)
    run = make_run()
    client.patch(f"{API}/skills/{row['id']}", json={"enabled": True})
    result = client.portal.call(
        skills.run_script, row["id"], "scripts/make_note.py", [], run
    )
    assert "尚未授权" in result["error"]
    authorize(client, row)
    result = client.portal.call(
        skills.run_script, row["id"], "scripts/make_note.py", [], run
    )
    assert result.get("exit_code") == 0, result
    assert "done" in result["stdout"]
    artifact = result["artifacts"][0]
    response = client.get(f"{API}/artifacts/{artifact['id']}/content")
    assert (
        response.content == b"hello"
        and "attachment" in response.headers["content-disposition"]
    )
    assert (
        client.get(
            f"{API}/artifacts/{artifact['id']}/content", headers={"Authorization": ""}
        ).status_code
        == 401
    )
    # A configured but vanished interpreter fails clearly and never auto-installs.
    with db.Session() as session:
        session.merge(
            db.SkillRuntime(name="python", path="C:/does-not-exist/python.exe")
        )
        session.commit()
    missing = client.portal.call(
        skills.run_script, row["id"], "scripts/make_note.py", [], run
    )
    assert "缺少 python" in missing["error"]
    row = import_example(
        client, b'import sys\nprint("failure", file=sys.stderr)\nsys.exit(7)'
    )
    authorize(client, row)
    failed = client.portal.call(
        skills.run_script, row["id"], "scripts/make_note.py", [], make_run()
    )
    assert (
        failed["exit_code"] == 7 and "failure" in failed["stderr"] and failed["error"]
    )


def test_skill_timeout_revocation_reaps_child_and_never_inherits_keys(
    client, monkeypatch, tmp_path
):
    marker = tmp_path / "child-pid"
    script = b'import subprocess,sys,time,os\nfrom pathlib import Path\nassert "BAI_MODEL_API_KEY" not in os.environ\np=subprocess.Popen([sys.executable,"-c","import time; time.sleep(60)"])\nPath(sys.argv[1]).write_text(str(p.pid))\ntime.sleep(60)'
    row = import_example(client, script)
    authorize(client, row)
    monkeypatch.setenv("BAI_MODEL_API_KEY", "secret-must-not-reach-child")

    async def revoke():
        task = asyncio.create_task(
            skills.run_script(
                row["id"], "scripts/make_note.py", [str(marker)], make_run()
            )
        )
        for _ in range(100):
            if marker.exists():
                break
            await asyncio.sleep(0.03)
        assert marker.exists()
        skills.stop(row["id"])
        with pytest.raises(asyncio.CancelledError):
            await task

    client.portal.call(revoke)
    if os.name == "nt":
        import ctypes

        ctypes.windll.kernel32.OpenProcess.restype = ctypes.c_void_p
        handle = ctypes.windll.kernel32.OpenProcess(
            0x1000, False, int(marker.read_text())
        )
        if handle:
            code = ctypes.c_ulong()
            ctypes.windll.kernel32.GetExitCodeProcess(
                ctypes.c_void_p(handle), ctypes.byref(code)
            )
            ctypes.windll.kernel32.CloseHandle(ctypes.c_void_p(handle))
            assert code.value != 259
    monkeypatch.setattr(skills, "SCRIPT_TIMEOUT", 0.1)
    result = client.portal.call(
        skills.run_script, row["id"], "scripts/make_note.py", [str(marker)], make_run()
    )
    assert "超时" in result["error"]


def test_image_blocks_sources_persistence_and_export(client):
    run = make_run()
    image = io.BytesIO()
    Image.new("RGBA", (20, 20), (100, 60, 40, 80)).save(image, format="PNG")
    result = client.portal.call(
        artifacts.normalize,
        run,
        {
            "text": "图片已返回",
            "media_blocks": [
                {
                    "type": "image",
                    "base64": base64.b64encode(image.getvalue()).decode(),
                    "mime_type": "image/png",
                }
            ],
            "structured_content": {
                "results": [
                    {
                        "title": "示例",
                        "url": "https://example.com/docs",
                        "content": "检索摘要",
                    }
                ]
            },
        },
    )
    assert result["artifacts"][0]["media_type"] == "image/png"
    assert result["sources"][0]["kind"] == "search"
    with db.Session() as session:
        session.add(db.RunEvent(run_id=run, kind="tool", data={"result": result}))
        session.commit()
    shown = client.get(f"{API}/runs/{run}/presentation").json()
    assert shown["artifacts"] == result["artifacts"]
    assert shown["sources"][0]["title"] == "示例"
    content = client.get(f"{API}/artifacts/{shown['artifacts'][0]['id']}/content")
    assert (
        content.content == image.getvalue()
        and content.headers["content-type"] == "image/png"
    )
    calendar.create_events([calendar.EventWrite(**event())])
    import_example(client)
    exported = data_transfer.create_archive()
    with zipfile.ZipFile(exported["path"]) as zip:
        assert any(name.startswith("attachments/artifacts/") for name in zip.namelist())
    preview = data_transfer.inspect_archive(Path(exported["path"]))
    assert preview["counts"]["calendar_events"] == 1
    assert preview["counts"]["artifacts"] == 1
    assert "skills/" not in zip.namelist()


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/x.png",
        "http://169.254.169.254/x",
        "http://[::1]/x",
        "file:///C:/secret.png",
        "https://user:pass@example.com/x",
    ],
)
def test_remote_image_rejects_local_private_and_credentials(client, url):
    response = client.post(f"{API}/runs/{make_run()}/images", json={"url": url})
    assert response.status_code == 422


def test_skill_tool_keeps_argument_array_through_langchain(client):
    row = import_example(client)
    authorize(client, row)
    tool = next(
        x for x in feature_tools.build(make_run(), "") if x.name == "run_skill_script"
    )
    assert "arguments" in tool.args_schema.model_json_schema()["properties"]

    async def invoke():
        return json.loads(
            await tool.ainvoke(
                {
                    "skill_id": row["id"],
                    "path": "scripts/make_note.py",
                    "arguments": ["one", "two"],
                }
            )
        )

    result = client.portal.call(invoke)
    assert result.get("exit_code") == 0, result
