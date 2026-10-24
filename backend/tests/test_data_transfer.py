import io
import shutil
import zipfile
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app import config, data_transfer as transfer, db, main


@pytest.fixture(autouse=True)
def clean_transfers():
    for name in ("pending-import", "import-candidates", "exports", "backups"):
        shutil.rmtree(config.DATA_DIR / name, ignore_errors=True)
    for name in ("restore-journal", "last-import.json"):
        (config.DATA_DIR / name).unlink(missing_ok=True)
    yield
    for name in ("pending-import", "import-candidates"):
        shutil.rmtree(config.DATA_DIR / name, ignore_errors=True)


def headers():
    return {"Authorization": "Bearer " + config.AUTH_TOKEN}


def test_export_import_restores_content_vectors_images_and_preserves_local_connections():
    attachment_id = str(uuid4())
    with TestClient(main.app, headers=headers()) as client:
        with db.Session() as session:
            memory = db.Memory(content="福袋每三个月体内驱虫", revision=3)
            session.add(memory)
            session.flush()
            memory_id = memory.id
            session.add(db.MemoryVector(memory_id=memory_id, revision=3,
                content_hash="abc", signature="model-fingerprint", vector=[0.1, 0.9]))
            session.add(db.Attachment(id=attachment_id, name="猫.jpg", media_type="image/jpeg", width=10, height=10))
            session.commit()
        Image.new("RGB", (10, 10)).save(config.ATTACHMENTS_DIR / f"{attachment_id}.jpg")
        response = client.post("/api/v1/settings/data/export")
        assert response.status_code == 200, response.text
        exported = response.json()
        with zipfile.ZipFile(exported["path"]) as archive:
            assert "auth-token" not in archive.namelist()
            assert "checkpoints.sqlite" in archive.namelist()
            assert f"attachments/{attachment_id}.jpg" in archive.namelist()
        with transfer.connect(config.DATA_DIR / "bai.sqlite") as connection:
            connection.execute("UPDATE memories SET content='导出之后修改的内容' WHERE id=?", (memory_id,))
            connection.execute("UPDATE settings SET model_name='本机当前模型'")
        raw = open(exported["path"], "rb").read()
        preview = client.post("/api/v1/settings/data/inspect", files={"file": ("data.zip", raw)})
        assert preview.status_code == 200, preview.text
        assert preview.json()["counts"]["memory_vectors"] == 1
        assert client.post("/api/v1/settings/data/import", json={"id": preview.json()["id"]}).status_code == 200
        assert client.get("/api/v1/settings/data").json()["pending"] is True
        # Staging leaves live data untouched.
        assert client.get("/api/v1/memories").json()[0]["content"] == "导出之后修改的内容"
    with TestClient(main.app, headers=headers()) as client:
        assert client.get("/api/v1/memories").json()[0]["content"] == "福袋每三个月体内驱虫"
        assert client.get("/api/v1/settings").json()["model_name"] == "本机当前模型"
        status = client.get("/api/v1/settings/data").json()
        assert status["last_import"]["ok"] is True
        assert status["pending"] is False
        backup = status["last_import"]["backup"]
        with transfer.connect(backup + "/bai.sqlite") as connection:
            assert connection.execute("SELECT content FROM memories").fetchone()[0] == "导出之后修改的内容"
        with db.Session() as session:
            assert session.get(db.MemoryVector, memory_id).vector == [0.1, 0.9]
        assert client.get(f"/api/v1/attachments/{attachment_id}/content").status_code == 200


def test_export_removes_connections_and_authentication(client):
    with db.Session() as session:
        session.get(db.Settings, config.PROFILE_ID).model_name = "personal-config"
        session.add(db.MCPServer(name="local", transport="stdio", config={"env": {"TOKEN": "synthetic-secret"}}))
        session.add(db.WechatState(id="local", data={"owner_id": "private-owner"}))
        session.commit()
    value = client.post("/api/v1/settings/data/export").json()
    with zipfile.ZipFile(value["path"]) as archive:
        raw = archive.read("bai.sqlite")
        assert b"synthetic-secret" not in raw
        assert b"private-owner" not in raw
        assert b"personal-config" not in raw
        assert config.AUTH_TOKEN.encode() not in raw
    assert client.get("/api/v1/settings/data/exports/" + value["name"]).status_code == 200
    assert client.get("/api/v1/settings/data/exports/not-a-backup.zip").status_code == 404


def test_data_actions_require_idle_and_auth(client):
    assert client.get("/api/v1/settings/data", headers={"Authorization": "bad"}).status_code == 401
    with db.Session() as session:
        session.add(db.Run(kind="chat", status="running"))
        session.commit()
    assert client.post("/api/v1/settings/data/export").status_code == 409


@pytest.mark.parametrize("name", ["../escape", "attachments/../../escape", "auth-token"])
def test_import_rejects_extra_paths_without_writing_outside_stage(client, name):
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as archive:
        archive.writestr(name, "untrusted")
    response = client.post("/api/v1/settings/data/inspect", files={"file": ("bad.zip", raw.getvalue())})
    assert response.status_code == 422
    assert not (config.DATA_DIR / "pending-import").exists()


def test_modified_database_is_rejected(client):
    value = client.post("/api/v1/settings/data/export").json()
    with zipfile.ZipFile(value["path"]) as original:
        data = {name: original.read(name) for name in original.namelist()}
    path = config.DATA_DIR / "malformed.sqlite"
    path.write_bytes(data["bai.sqlite"])
    with transfer.connect(path) as connection:
        connection.execute("CREATE TRIGGER injected AFTER INSERT ON memories BEGIN DELETE FROM messages; END")
    data["bai.sqlite"] = path.read_bytes()
    raw = io.BytesIO()
    with zipfile.ZipFile(raw, "w") as archive:
        for name, content in data.items():
            archive.writestr(name, content)
    assert client.post("/api/v1/settings/data/inspect", files={"file": ("bad.zip", raw.getvalue())}).status_code == 422


def test_missing_image_prevents_export_without_leaving_partial_archive(client):
    with db.Session() as session:
        session.add(db.Attachment(id=str(uuid4()), name="丢失图片.jpg", media_type="image/jpeg", width=10, height=10))
        session.commit()
    response = client.post("/api/v1/settings/data/export")
    assert response.status_code == 409
    assert not list((config.DATA_DIR / "exports").glob("*.zip"))


def test_cancel_pending_import_leaves_live_data(client):
    exported = client.post("/api/v1/settings/data/export").json()
    with open(exported["path"], "rb") as source:
        preview = transfer.inspect_archive(source)
    assert client.post("/api/v1/settings/data/import", json={"id": preview["id"]}).status_code == 200
    assert client.delete("/api/v1/settings/data/import").json() == {"pending": False}
    assert client.get("/api/v1/settings/data").json()["pending"] is False


def test_failed_restore_rolls_back_and_retains_backup(monkeypatch):
    with db.Session() as session:
        session.add(db.Memory(content="导出时"))
        session.commit()
    exported = transfer.create_archive()
    with open(exported["path"], "rb") as source:
        preview = transfer.inspect_archive(source)
    transfer.stage_import(preview["id"])
    with db.Session() as session:
        session.query(db.Memory).first().content = "导入前"
        session.commit()
    original = transfer.shutil.copy2
    def broken_once(source, target):
        if source == config.DATA_DIR / "pending-import" / "bai.sqlite":
            raise OSError("simulated disk failure")
        return original(source, target)
    monkeypatch.setattr(transfer.shutil, "copy2", broken_once)
    transfer.apply_pending()
    with db.Session() as session:
        assert session.query(db.Memory).first().content == "导入前"
    assert transfer.info()["last_import"]["ok"] is False
    assert not (config.DATA_DIR / "restore-journal").exists()
    assert list((config.DATA_DIR / "backups").glob("*/bai.sqlite"))


def test_interrupted_restore_recovers_before_services_start():
    name = transfer.stamp()
    backup = config.DATA_DIR / "backups" / name
    backup.mkdir(parents=True)
    with db.Session() as session:
        session.add(db.Memory(content="应恢复的原数据"))
        session.commit()
    transfer.snapshot(config.DATA_DIR / "bai.sqlite", backup / "bai.sqlite")
    shutil.copytree(config.ATTACHMENTS_DIR, backup / "attachments")
    with db.Session() as session:
        session.query(db.Memory).delete()
        session.commit()
    (config.DATA_DIR / "restore-journal").write_text(name, "utf-8")
    transfer.recover_interrupted()
    with db.Session() as session:
        assert session.query(db.Memory).first().content == "应恢复的原数据"
    assert transfer.info()["last_import"]["ok"] is False


def test_schema_constraint_order_is_equivalent_but_modified_sql_is_not():
    left = {"t": "CREATE TABLE t (id TEXT, note TEXT DEFAULT 'a,b', PRIMARY KEY (id), UNIQUE (note))"}
    right = {"t": "CREATE TABLE t (id TEXT, note TEXT DEFAULT 'a,b', UNIQUE (note), PRIMARY KEY (id))"}
    assert transfer.same_schema(left, right)
    assert not transfer.same_schema(left, {"t": right["t"].replace("'a,b'", "'a, b'")})
    assert not transfer.same_schema(left, {"t": right["t"].replace("UNIQUE (note)", "UNIQUE (id)")})
    assert not transfer.same_schema(left, {"t": right["t"].replace("id TEXT, note TEXT", "note TEXT, id TEXT")})
    assert not transfer.same_schema(left, {**right, "extra": "CREATE TABLE extra (id TEXT)"})
