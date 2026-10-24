import asyncio
import hashlib
import json
import os
from pathlib import Path

import pytest
from app import artifacts, db, local_files, model_profiles, restricted_files as files, tools


@pytest.fixture
def task(configured, tmp_path, monkeypatch):
    # Test documents are synthetic. Permit pytest's temp directory without
    # weakening the production policy protecting the real AppData tree.
    for key in ("APPDATA", "LOCALAPPDATA"):
        monkeypatch.setenv(key, str(tmp_path / key))
    chat = configured.post("/api/v1/file-sessions").json()["conversation_id"]
    with db.Session() as session:
        model = model_profiles.resolve(session.get(db.Settings, "local"))
    selection = {"provider_id": model["provider_id"], "model_name": model["model_name"]}
    response = configured.post(f"/api/v1/file-sessions/{chat}/authorize", json={"paths": [str(tmp_path)], "model_selection": selection})
    assert response.status_code == 200, response.text
    with db.Session() as session:
        run = db.Run(kind="chat", conversation_id=chat, status="running", model_config=model)
        session.add(run)
        session.commit()
        run_id = run.id
    return configured, chat, run_id, tmp_path, selection


def make_request(task, content=b"report"):
    client, chat, run, root, _ = task
    artifact = artifacts.save_file(run, "report.txt", content)
    request = files.request_save(chat, artifact["id"])
    return files.save_target(request["id"], str(root / "output.txt"))


def test_explicit_scope_nonrecursive_sensitive_and_quota(task):
    client, chat, run, root, _ = task
    source = root / "notes.txt"
    source.write_text("authorized text", encoding="utf-8")
    assert files.snapshot(source, run, chat)[0] == b"authorized text"
    child = root / "child"
    child.mkdir()
    (child / "nested.txt").write_text("nested")
    with pytest.raises(ValueError, match="授权范围"):
        files.snapshot(child / "nested.txt", run, chat)
    (root / ".env").write_text("SYNTHETIC_KEY=never send")
    with pytest.raises(ValueError, match="敏感"):
        files.snapshot(root / ".env", run, chat)
    listing = local_files.scan_folder(str(root), run, chat, recursive=True)
    assert [x["name"] for x in listing["entries"]] == ["notes.txt"]
    for i in range(19):
        path = root / f"{i}.txt"
        path.write_text(str(i))
        files.snapshot(path, run, chat)
    extra = root / "extra.txt"
    extra.write_text("extra")
    with pytest.raises(ValueError, match="上限"):
        files.snapshot(extra, run, chat)
    assert files.snapshot(source, run, chat)[0] == b"authorized text"


def test_save_requires_exact_target_content_and_never_overwrites(task):
    client, chat, run, root, _ = task
    request = make_request(task)
    assert not Path(request["target"]).exists()
    wrong = files.ConfirmInput(digest="0" * 64, target=request["target"])
    with pytest.raises(ValueError, match="不一致"):
        files.confirm_save(request["id"], wrong)
    payload = files.ConfirmInput(digest=request["digest"], target=request["target"])
    Path(request["target"]).write_text("existing user document")
    result = files.confirm_save(request["id"], payload)
    assert result["status"] == "failed"
    assert Path(request["target"]).read_text() == "existing user document"
    request = files.request_save(chat, request["artifact_id"])
    request = files.save_target(request["id"], str(root / "new.txt"))
    payload = files.ConfirmInput(digest=request["digest"], target=request["target"])
    assert files.confirm_save(request["id"], payload)["status"] == "saved"
    assert files.confirm_save(request["id"], payload)["status"] == "saved"
    assert (root / "new.txt").read_bytes() == b"report"
    assert len([e for e in files.session_read(chat)["events"] if e["action"] == "saved"]) == 1


def test_changed_artifact_cancel_expire_stop_and_restart(task):
    client, chat, run, root, _ = task
    request = make_request(task)
    with db.Session() as session:
        artifact = session.get(db.Artifact, request["artifact_id"])
        (artifacts.root() / artifact.storage_name).write_bytes(b"changed")
    with pytest.raises(ValueError, match="内容已变化"):
        files.confirm_save(request["id"], files.ConfirmInput(digest=request["digest"], target=request["target"]))
    files.stop(chat)
    with pytest.raises(ValueError, match="停止或过期"):
        files.confirm_save(request["id"], files.ConfirmInput(digest=request["digest"], target=request["target"]))
    assert not Path(request["target"]).exists()
    assert files.session_read(chat)["saves"][0]["status"] == "cancelled"
    files.recover()
    assert files.session_read(chat)["status"] == "stopped"
    assert files.session_read(chat)["grants"] == []


@pytest.mark.asyncio
async def test_tools_cannot_bypass_or_leak_remote_images(task, monkeypatch):
    client, chat, run, root, _ = task
    selected = await tools.prepare_tools(run, chat)
    assert {tool.name for tool in selected} == files.ALLOWED_TOOLS
    originals = {tool.name: tool for tool in tools.builtin_tools(run, chat)}
    forbidden = next(x for x in tools.tool_catalog() if x["id"] == "web_search")
    call = tools._guard_tool(forbidden, originals, run)
    result = json.loads(await call(query="stolen content"))
    assert result["not_executed"]
    assert "不允许" in result["error"]
    response = client.post(f"/api/v1/runs/{run}/images", json={"url": "https://example.com/secret.png"})
    assert response.status_code == 403
    path = root / "notes.txt"
    path.write_text("PRIVATE BODY should not be in audit", encoding="utf-8")
    reader = next(tool for tool in selected if tool.name == "read_local_file")
    result = json.loads(await reader.ainvoke({"path": str(path)}))
    assert "PRIVATE BODY" in result["parts"][0]["text"]
    with db.Session() as session:
        events = session.query(db.RunEvent).filter_by(run_id=run).all()
        assert "PRIVATE BODY" not in json.dumps([event.data for event in events])


def test_model_changes_and_attachment_bypass_blocked(task):
    client, chat, run, root, _ = task
    with db.Session() as session:
        model = session.get(db.Run, run).model_config
    with pytest.raises(ValueError, match="模型连接"):
        files.check_model(chat, {**model, "model_url": "https://evil.invalid/v1"})
    response = client.post(f"/api/v1/conversations/{chat}/messages", json={"content": "read", "local_references": [str(root)]})
    assert response.status_code == 400
    assert "授权面板" in response.text


def test_artifact_ownership_and_one_shot_confirmation(task):
    client, chat, run, root, _ = task
    other = client.post("/api/v1/conversations", json={"title": "other"}).json()["id"]
    with db.Session() as session:
        foreign_run = db.Run(kind="chat", conversation_id=other)
        session.add(foreign_run)
        session.commit()
        foreign_id = foreign_run.id
    artifact = artifacts.save_file(foreign_id, "other.txt", b"foreign")
    with pytest.raises(ValueError, match="本文件任务"):
        files.request_save(chat, artifact["id"])
    request = make_request(task)
    response = client.post(f"/api/v1/file-save-requests/{request['id']}/confirm", json={"confirm": True})
    assert response.status_code == 422
    response = client.post(f"/api/v1/file-save-requests/{request['id']}/cancel")
    assert response.json()["status"] == "cancelled"
    assert not Path(request["target"]).exists()


def test_expiration_and_link_escape(task):
    client, chat, run, root, _ = task
    source = root / "source.txt"
    source.write_text("data")
    link = root / "alias.txt"
    os.link(source, link)
    with pytest.raises(ValueError):
        files.snapshot(link, run, chat)
    request = make_request(task)
    with db.Session() as session:
        session.get(db.FileSaveRequest, request["id"]).expires_at = "2000-01-01"
        session.commit()
    with pytest.raises(ValueError, match="过期"):
        files.confirm_save(request["id"], files.ConfirmInput(digest=request["digest"], target=request["target"]))
    with db.Session() as session:
        row = session.query(db.FileSession).filter_by(conversation_id=chat).one()
        row.expires_at = "2000-01-01"
        session.commit()
    with pytest.raises(ValueError, match="过期"):
        files.snapshot(source, run, chat)


@pytest.mark.asyncio
async def test_generate_document_then_save(task):
    from app import office
    client, chat, run, root, _ = task
    with pytest.raises(ValueError, match="暂不支持"):
        await office.generate(run, chat, "document", "foreign-image", "docx", blocks=[{"kind": "image", "file_id": "project-image"}])
    result = await office.generate(run, chat, "document", "summary", "docx", title="摘要", blocks=[{"kind": "paragraph", "text": "真实生成的测试文档"}])
    request = files.request_save(chat, result["artifacts"][0]["id"])
    request = files.save_target(request["id"], str(root / "summary.docx"))
    saved = files.confirm_save(request["id"], files.ConfirmInput(digest=request["digest"], target=request["target"]))
    assert saved["status"] == "saved", saved
    from docx import Document
    document = Document(root / "summary.docx")
    assert "真实生成的测试文档" in "\n".join(p.text for p in document.paragraphs)


def test_racing_target_creation_does_not_overwrite(task, monkeypatch):
    request = make_request(task)
    original = os.rename if os.name == "nt" else os.link
    def racing(source, target):
        Path(target).write_bytes(b"another writer")
        return original(source, target)
    monkeypatch.setattr(files.os, "rename" if os.name == "nt" else "link", racing)
    result = files.confirm_save(request["id"], files.ConfirmInput(digest=request["digest"], target=request["target"]))
    assert result["status"] == "failed"
    assert Path(request["target"]).read_bytes() == b"another writer"


def test_read_cumulative_size_limit(task):
    _, chat, run, root, _ = task
    source = root / "two-megabytes.txt"
    source.write_bytes(b"a" * (2 * 1024 * 1024))
    with db.Session() as session:
        row = session.query(db.FileSession).filter_by(conversation_id=chat).one()
        row.reads = {"prior": 99 * 1024 * 1024}
        session.commit()
    with pytest.raises(ValueError, match="上限"):
        files.snapshot(source, run, chat)


def test_export_drops_authority_but_preserves_restricted_marker(task):
    import sqlite3
    import zipfile
    from app import data_transfer
    client, chat, _, root, _ = task
    make_request(task)
    archive = data_transfer.create_archive()
    extracted = root / "export.sqlite"
    with zipfile.ZipFile(archive["path"]) as source:
        extracted.write_bytes(source.read("bai.sqlite"))
    with sqlite3.connect(extracted) as connection:
        assert connection.execute("select restricted_files from conversations where id=?", (chat,)).fetchone()[0] == 1
        for table in ("file_sessions", "file_save_requests", "file_audits"):
            assert connection.execute(f"select count(*) from {table}").fetchone()[0] == 0


def test_previous_schema_0023_upgrades_without_authority(client, tmp_path):
    from alembic import command
    from alembic.config import Config
    from app import data_transfer
    import sqlite3
    stage = tmp_path / "previous"
    stage.mkdir()
    (stage / "manifest.json").write_text(json.dumps({"format": "xiaoxi-data", "version": 1, "schema": "0023"}), encoding="utf-8")
    root = Path(__file__).resolve().parents[1]
    migration = Config(str(root / "alembic.ini"))
    migration.set_main_option("script_location", str(root / "migrations"))
    migration.set_main_option("sqlalchemy.url", "sqlite:///" + (stage / "bai.sqlite").as_posix())
    command.upgrade(migration, "0023")
    with sqlite3.connect(stage / "bai.sqlite") as connection:
        connection.execute("insert into conversations (id,profile_id,created_at,updated_at,title) values ('old','local','now','now','旧会话')")
    assert data_transfer.validate(stage)["counts"]["conversations"] == 1
    with sqlite3.connect(stage / "bai.sqlite") as connection:
        assert connection.execute("select version_num from alembic_version").fetchone()[0] == "0024"
        assert connection.execute("select restricted_files from conversations").fetchone()[0] == 0
        assert connection.execute("select count(*) from file_sessions").fetchone()[0] == 0
