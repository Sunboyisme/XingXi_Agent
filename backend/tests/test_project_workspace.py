import io
import sqlite3
import zipfile

import pytest

from app import config, local_files, projects
from app.db import Run, Session

API = "/api/v1"


async def test_project_workspace_authorizes_only_member_chats(client, tmp_path):
    root = tmp_path / "中文 工作目录"
    root.mkdir()
    path = root / "notes.md"
    path.write_text("项目中的本地资料", encoding="utf-8")
    project = client.post(API + "/projects", json={"name": "学习", "workspace_path": str(root)}).json()
    assert project["workspace_path"] == str(root.resolve())
    chat = client.post(API + "/conversations", json={"project_id": project["id"]}).json()
    other = client.post(API + "/conversations", json={}).json()
    with Session() as db:
        run = Run(kind="chat", conversation_id=chat["id"], status="completed")
        db.add(run)
        db.commit()
        run_id = run.id
    result = await local_files.read_file(str(path), run_id, chat["id"])
    assert "项目中的本地资料" in result["parts"][0]["text"]
    with pytest.raises(ValueError):
        await local_files.read_file(str(path), "", other["id"])
    assert str(root) in projects.instructions(chat["id"])
    saved = client.put(API + f"/projects/{project['id']}", json={"name": "学习", "workspace_path": ""})
    assert saved.status_code == 200
    with pytest.raises(ValueError):
        await local_files.read_file(str(path), run_id, chat["id"])


def test_workspace_validation_rename_and_running_move_guards(client, tmp_path):
    assert client.post(API + "/projects", json={"name": "错误", "workspace_path": "relative"}).status_code == 422
    assert client.post(API + "/projects", json={"name": "错误", "workspace_path": str(tmp_path / "missing")}).status_code == 422
    project = client.post(API + "/projects", json={"name": "目标", "workspace_path": str(tmp_path)}).json()
    chat = client.post(API + "/conversations", json={"title": "原名"}).json()
    renamed = client.patch(API + f"/conversations/{chat['id']}", json={"title": " 新名称 "})
    assert renamed.status_code == 200 and renamed.json()["title"] == "新名称"
    assert client.patch(API + f"/conversations/{chat['id']}", json={"title": "  "}).status_code == 422
    with Session() as db:
        db.add(Run(kind="chat", conversation_id=chat["id"], status="running"))
        db.commit()
    assert client.patch(API + f"/conversations/{chat['id']}", json={"project_id": project["id"]}).status_code == 409
    assert client.patch(API + f"/conversations/{chat['id']}", json={"title": "运行中仍可改名"}).status_code == 200


def test_portable_archive_drops_local_workspace_grants(client, tmp_path):
    project = client.post(API + "/projects", json={"name": "本机项目", "workspace_path": str(tmp_path)}).json()
    export = client.post(API + "/settings/data/export").json()
    with zipfile.ZipFile(export["path"]) as archive:
        snapshot = tmp_path / "export.sqlite"
        snapshot.write_bytes(archive.read("bai.sqlite"))
    with sqlite3.connect(snapshot) as connection:
        assert connection.execute("SELECT workspace_path FROM projects").fetchone()[0] == ""
    assert client.get(API + "/projects").json()[0]["workspace_path"] == project["workspace_path"]
    with open(export["path"], "rb") as stream:
        inspected = client.post(API + "/settings/data/inspect", files={"file": ("export.zip", stream)})
    assert inspected.status_code == 200, inspected.text
