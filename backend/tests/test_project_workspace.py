import sqlite3
import zipfile

import pytest

from app import local_files, projects
from app.db import Run, Session

API = "/api/v1"


async def test_project_workspace_authorizes_only_member_chats(client, tmp_path):
    root = tmp_path / "中文 工作目录"
    root.mkdir()
    path = root / "notes.md"
    path.write_text("项目中的本地资料", encoding="utf-8")
    project = client.post(API + "/projects", json={"name": "学习", "workspace_path": str(root)}).json()
    assert project["workspace_path"] == str(root.resolve())
    assert project["workspace_paths"] == [str(root.resolve())]
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
        assert connection.execute("SELECT workspace_paths FROM projects").fetchone()[0] == "[]"
    assert client.get(API + "/projects").json()[0]["workspace_path"] == project["workspace_path"]
    with open(export["path"], "rb") as stream:
        inspected = client.post(API + "/settings/data/inspect", files={"file": ("export.zip", stream)})
    assert inspected.status_code == 200, inspected.text


async def test_multiple_workspaces_deduplicate_and_revoke_individually(client, tmp_path):
    roots = [tmp_path / name for name in ("方案", "资料", "未关联")]
    for folder in roots:
        folder.mkdir()
        (folder / "note.md").write_text(folder.name, encoding="utf-8")
    response = client.post(API + "/projects", json={
        "name": "多文件夹", "workspace_paths": [str(roots[0]), str(roots[1]), str(roots[0])],
    })
    assert response.status_code == 200, response.text
    project = response.json()
    assert project["workspace_paths"] == [str(folder.resolve()) for folder in roots[:2]]
    assert project["workspace_path"] == str(roots[0].resolve())
    chat = client.post(API + "/conversations", json={"project_id": project["id"]}).json()
    other = client.post(API + "/conversations", json={}).json()
    with Session() as db:
        run = Run(kind="chat", conversation_id=chat["id"], status="completed")
        db.add(run)
        db.commit()
        run_id = run.id
    for folder in roots[:2]:
        result = await local_files.read_file(str(folder / "note.md"), run_id, chat["id"])
        assert folder.name in result["parts"][0]["text"]
        assert str(folder.resolve()) in projects.instructions(chat["id"])
    for folder, chat_id in ((roots[2], chat["id"]), (roots[1], other["id"])):
        with pytest.raises(ValueError):
            await local_files.read_file(str(folder / "note.md"), run_id, chat_id)
    with Session() as db:
        db.get(Run, run_id).status = "running"
        db.commit()
    update = {"name": "多文件夹", "workspace_paths": [str(roots[0])]}
    assert client.put(API + f"/projects/{project['id']}", json=update).status_code == 409
    with Session() as db:
        db.get(Run, run_id).status = "completed"
        db.commit()
    saved = client.put(API + f"/projects/{project['id']}", json=update)
    assert saved.status_code == 200, saved.text
    assert saved.json()["workspace_paths"] == [str(roots[0].resolve())]
    with pytest.raises(ValueError):
        await local_files.read_file(str(roots[1] / "note.md"), run_id, chat["id"])
    assert (await local_files.read_file(str(roots[0] / "note.md"), run_id, chat["id"]))["parts"]
