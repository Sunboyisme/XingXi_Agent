"""Portable user data snapshots. Credentials and executable connections stay local."""

import json
import re
import shutil
import sqlite3
import tempfile
import zipfile
from contextlib import closing, contextmanager
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from fastapi import HTTPException

from . import config, db

LIMIT = 512 * 1024 * 1024
LOCAL_TABLES = {"settings", "mcp_servers", "mcp_tools", "builtin_tool_states",
                "wechat_state", "wechat_inbox", "wechat_deliveries", "skills", "skill_runtimes"}
COUNTS = {"conversations": "对话", "messages": "消息", "memories": "记忆",
          "projects": "项目", "project_materials": "项目资料", "plan_day_orders": "自定义日排序",
          "memory_vectors": "向量", "reminders": "提醒时间", "goals": "学习目标",
          "attachments": "附件", "office_files": "办公资料", "calendar_events": "计划", "plan_occurrences": "单次状态记录", "plan_segments": "重复规则调整", "artifacts": "工具产物", "complex_tasks": "复杂任务"}


def root():
    return config.DATA_DIR


@contextmanager
def connect(path):
    # sqlite3.Connection's own context manager commits but does not close on Windows.
    with closing(sqlite3.connect(path)) as connection:
        with connection:
            yield connection


def stamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid4().hex[:8]


def snapshot(source, target):
    with connect(source) as original, connect(target) as copy:
        original.backup(copy)


def schema(connection):
    return dict(connection.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ))


def counts(connection):
    return {table: connection.execute(f'SELECT count(*) FROM "{table}"').fetchone()[0]
            for table in COUNTS}


def info():
    with connect(root() / "bai.sqlite") as connection:
        values = counts(connection)
    pending = root() / "pending-import" / ".ready"
    return {"directory": str(root()), "database": str(root() / "bai.sqlite"),
            "attachments": str(config.ATTACHMENTS_DIR), "storage": "SQLite",
            "counts": values, "pending": pending.exists(),
            "last_import": json.loads((root() / "last-import.json").read_text("utf-8"))
            if (root() / "last-import.json").exists() else None}


def create_archive():
    folder = root() / "exports"
    folder.mkdir(exist_ok=True)
    name = f"XiaoXi-data-{stamp()}.zip"
    with tempfile.TemporaryDirectory(dir=root()) as temporary:
        stage = Path(temporary)
        snapshot(root() / "bai.sqlite", stage / "bai.sqlite")
        with connect(stage / "bai.sqlite") as connection:
            # Never move MCP environment variables, provider setup or channel binding.
            for table in LOCAL_TABLES:
                connection.execute(f'DELETE FROM "{table}"')
            connection.commit()
            connection.execute("VACUUM")
            revision = connection.execute("SELECT version_num FROM alembic_version").fetchone()[0]
            values = counts(connection)
            ids = [row[0] for row in connection.execute("SELECT id FROM attachments")]
            documents = {row[0] for row in connection.execute("SELECT id FROM office_files")}
            outputs = [row[0] for row in connection.execute("SELECT storage_name FROM artifacts")]
        checkpoint = root() / "checkpoints.sqlite"
        if checkpoint.exists():
            snapshot(checkpoint, stage / "checkpoints.sqlite")
        target = folder / name
        try:
            with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
                archive.write(stage / "bai.sqlite", "bai.sqlite")
                if (stage / "checkpoints.sqlite").exists():
                    archive.write(stage / "checkpoints.sqlite", "checkpoints.sqlite")
                for attachment_id in ids:
                    image = config.ATTACHMENTS_DIR / "files" / f"{attachment_id}.bin" if attachment_id in documents else config.ATTACHMENTS_DIR / f"{attachment_id}.jpg"
                    if not image.is_file():
                        raise HTTPException(409, "有图片文件缺失，请检查数据目录后重试导出。")
                    archive.write(image, f"attachments/files/{attachment_id}.bin" if attachment_id in documents else f"attachments/{attachment_id}.jpg")
                for storage_name in outputs:
                    if not re.fullmatch(r"[a-f0-9-]{36}\.bin", storage_name):
                        raise HTTPException(409, "工具产物记录无效")
                    artifact = config.ATTACHMENTS_DIR / "artifacts" / storage_name
                    if not artifact.is_file():
                        raise HTTPException(409, "有工具产物缺失，请检查数据目录")
                    archive.write(artifact, f"attachments/artifacts/{storage_name}")
                archive.writestr("manifest.json", json.dumps({
                    "format": "xiaoxi-data", "version": 1, "schema": revision,
                    "created_at": datetime.now(timezone.utc).isoformat(), "counts": values,
                }, ensure_ascii=False))
                if sum(entry.file_size for entry in archive.infolist()) > LIMIT:
                    raise HTTPException(413, "导出内容超过 512 MB，请先整理不需要的数据。")
        except Exception:
            target.unlink(missing_ok=True)
            raise
    return {"name": name, "path": str(target), "counts": values}


def validate(stage):
    manifest = json.loads((stage / "manifest.json").read_text("utf-8"))
    if manifest.get("format") != "xiaoxi-data" or manifest.get("version") != 1:
        raise ValueError("不是 XiaoXi 数据文件")
    with connect(stage / "bai.sqlite") as incoming, connect(root() / "bai.sqlite") as current:
        incoming.execute("PRAGMA trusted_schema=OFF")
        incoming_schema, current_schema = schema(incoming), schema(current)
        incoming_revision = incoming.execute("SELECT version_num FROM alembic_version").fetchone()
        current_revision = current.execute("SELECT version_num FROM alembic_version").fetchone()
        if current_revision == ("0019",) and incoming_revision in {("0016",), ("0017",), ("0018",)}:
            additions = {"projects", "project_materials", "plan_day_orders"}
            expected = {name: sql for name, sql in current_schema.items() if name not in additions}
            for name in ("conversations", "memories"):
                expected[name] = re.sub(r",\s*project_id VARCHAR\(36\)", "", expected[name])
            expected["conversations"] = re.sub(r",\s*pinned_at VARCHAR\(40\)", "", expected["conversations"])
            if incoming_revision in {("0016",), ("0017",)}:
                expected["wechat_deliveries"] = re.sub(r",\s*diagnostics JSON DEFAULT '\{\}' NOT NULL", "", expected["wechat_deliveries"])
            if incoming_revision == ("0016",):
                expected.pop("plan_creations", None)
            normalized = lambda value: re.sub(r"\s+", " ", value).strip()
            if set(expected) == set(incoming_schema) and all(normalized(expected[name]) == normalized(incoming_schema[name]) for name in expected) and not incoming.execute("SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')").fetchone()[0]:
                if incoming_revision == ("0016",):
                    incoming.execute(current_schema["plan_creations"])
                if incoming_revision != ("0018",):
                    incoming.execute("ALTER TABLE wechat_deliveries ADD COLUMN diagnostics JSON DEFAULT '{}' NOT NULL")
                incoming.execute("ALTER TABLE conversations ADD COLUMN project_id VARCHAR(36)")
                incoming.execute("ALTER TABLE conversations ADD COLUMN pinned_at VARCHAR(40)")
                incoming.execute("ALTER TABLE memories ADD COLUMN project_id VARCHAR(36)")
                for name in ("projects", "project_materials", "plan_day_orders"):
                    incoming.execute(current_schema[name])
                for name, sql in current.execute("SELECT name,sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL"):
                    if name.startswith(("ix_projects_", "ix_project_materials_", "ix_plan_day_orders_", "ix_conversations_project_id", "ix_memories_project_id")):
                        incoming.execute(sql)
                incoming.execute("UPDATE alembic_version SET version_num='0019'")
                incoming_schema = schema(incoming)
        # Upgrade only the exact known predecessor in the staging copy. User
        # databases and channel credentials are never used as migration probes.
        if current_revision == ("0018",) and incoming_revision in {("0016",), ("0017",)}:
            expected = dict(current_schema)
            expected["wechat_deliveries"] = re.sub(r",\s*diagnostics JSON DEFAULT '\{\}' NOT NULL", "", expected["wechat_deliveries"])
            if incoming_revision == ("0016",):
                expected.pop("plan_creations", None)
            same = set(expected) == set(incoming_schema) and all(
                (re.sub(r"\s+", " ", incoming_schema[name]).strip() == re.sub(r"\s+", " ", sql).strip())
                if name == "wechat_deliveries" else incoming_schema[name] == sql
                for name, sql in expected.items()
            )
            if same and not incoming.execute("SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')").fetchone()[0]:
                if incoming_revision == ("0016",):
                    incoming.execute(current_schema["plan_creations"])
                incoming.execute("ALTER TABLE wechat_deliveries ADD COLUMN diagnostics JSON DEFAULT '{}' NOT NULL")
                incoming.execute("UPDATE alembic_version SET version_num='0018'")
                incoming_schema = schema(incoming)
        # This additive migration must not invalidate the preceding 0.1.5 exports.
        # Only the exact known predecessor schema is upgraded, in the staging copy.
        if (incoming_revision == ("0016",) and current_revision == ("0017",)
            and incoming_schema == {name: sql for name, sql in current_schema.items() if name != "plan_creations"}
            and not incoming.execute("SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')").fetchone()[0]):
            incoming.execute(current_schema["plan_creations"])
            incoming.execute("UPDATE alembic_version SET version_num='0017' WHERE version_num='0016'")
            incoming_schema = schema(incoming)
        # Reject SQL objects supplied by other applications or modified archives.
        if incoming_schema != current_schema or incoming.execute(
            "SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')"
        ).fetchone()[0]:
            raise ValueError("数据结构不兼容，请使用当前版本导出的文件")
        if incoming.execute("SELECT version_num FROM alembic_version").fetchone() != current.execute(
            "SELECT version_num FROM alembic_version"
        ).fetchone():
            raise ValueError("数据版本不兼容，请使用当前版本导出的文件")
        if incoming.execute("PRAGMA quick_check").fetchone()[0] != "ok" or incoming.execute(
            "PRAGMA foreign_key_check"
        ).fetchone():
            raise ValueError("数据库校验失败")
        values = counts(incoming)
        ids = [row[0] for row in incoming.execute("SELECT id FROM attachments")]
        documents = {row[0] for row in incoming.execute("SELECT id FROM office_files")}
        for attachment_id in ids:
            if not re.fullmatch(r"[a-f0-9-]{36}", attachment_id) or not (
                (stage / "attachments" / "files" / f"{attachment_id}.bin") if attachment_id in documents else (stage / "attachments" / f"{attachment_id}.jpg")
            ).is_file():
                raise ValueError("图片附件不完整")
        for (storage_name,) in incoming.execute("SELECT storage_name FROM artifacts"):
            if not re.fullmatch(r"[a-f0-9-]{36}\.bin", storage_name) or not (stage / "attachments" / "artifacts" / storage_name).is_file():
                raise ValueError("工具产物不完整")
    checkpoint = stage / "checkpoints.sqlite"
    if checkpoint.exists():
        with connect(checkpoint) as connection:
            connection.execute("PRAGMA trusted_schema=OFF")
            if connection.execute("PRAGMA quick_check").fetchone()[0] != "ok":
                raise ValueError("学习进度数据损坏")
            if connection.execute("SELECT count(*) FROM sqlite_master WHERE type IN ('trigger','view')").fetchone()[0]:
                raise ValueError("学习进度数据包含不支持的结构")
            # LangGraph reads only its known checkpoint tables.
            allowed = {"checkpoints", "writes", "checkpoint_migrations"}
            if set(schema(connection)) - allowed:
                raise ValueError("学习进度数据不兼容")
    return {"created_at": manifest.get("created_at", ""), "counts": values}


def inspect_archive(source):
    identifier = uuid4().hex
    stage = root() / "import-candidates" / identifier
    candidates = stage.parent
    if candidates.exists():
        previous = sorted((path for path in candidates.iterdir()
                           if path.is_dir() and re.fullmatch(r"[a-f0-9]{32}", path.name)),
                          key=lambda path: path.stat().st_mtime, reverse=True)
        for old in previous[2:]:
            shutil.rmtree(old)
    stage.mkdir(parents=True)
    try:
        with zipfile.ZipFile(source) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(names) != len(set(names)) or len(names) > 20003:
                raise ValueError("压缩包包含重复文件或文件数量过多")
            if sum(entry.file_size for entry in entries) > LIMIT:
                raise ValueError("解压后的数据不能超过 512 MB")
            for entry in entries:
                name = entry.filename
                if name not in {"manifest.json", "bai.sqlite", "checkpoints.sqlite"} and not re.fullmatch(
                    r"attachments/(?:[a-f0-9-]{36}\.jpg|(?:artifacts|files)/[a-f0-9-]{36}\.bin)", name
                ):
                    raise ValueError("压缩包包含不支持的文件")
                target = stage / name
                target.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(entry) as data, target.open("wb") as output:
                    shutil.copyfileobj(data, output)
        details = validate(stage)
        return {"id": identifier, **details}
    except (ValueError, OSError, KeyError, sqlite3.Error, zipfile.BadZipFile, RuntimeError):
        shutil.rmtree(stage)
        raise HTTPException(422, "数据文件无效、附件缺失或版本不兼容。请使用当前版本导出的完整 ZIP 文件（最多 512 MB）。")


def stage_import(identifier):
    if not re.fullmatch(r"[a-f0-9]{32}", identifier):
        raise HTTPException(404, "导入文件不存在，请重新选择。")
    stage = root() / "import-candidates" / identifier
    if not stage.is_dir():
        raise HTTPException(404, "导入文件不存在，请重新选择。")
    try:
        validate(stage)
    except Exception:
        raise HTTPException(422, "数据文件校验失败，请重新选择。")
    pending = root() / "pending-import"
    if pending.exists() and not (pending / ".ready").exists():
        shutil.rmtree(pending, ignore_errors=True)
    if pending.exists():
        raise HTTPException(409, "已有待导入的数据，请先取消或重新启动应用。")
    try:
        # Directory renames are unreliable in watched/synchronised Windows folders.
        # An incomplete copy is ignored at startup until the ready marker is written.
        shutil.copytree(stage, pending)
        validate(pending)
        (pending / ".ready").write_text("1", "utf-8")
    except Exception:
        shutil.rmtree(pending, ignore_errors=True)
        raise HTTPException(409, "暂时无法准备导入文件，请检查数据目录权限后重试。")
    return {"pending": True}


def cancel_import():
    pending = root() / "pending-import"
    if pending.exists():
        shutil.rmtree(pending)
    return {"pending": False}


def restore_backup(backup):
    db.engine.dispose()
    for name in ("bai.sqlite", "checkpoints.sqlite"):
        for suffix in ("-wal", "-shm"):
            (root() / (name + suffix)).unlink(missing_ok=True)
        if (backup / name).exists():
            shutil.copy2(backup / name, root() / name)
        else:
            (root() / name).unlink(missing_ok=True)
    shutil.rmtree(config.ATTACHMENTS_DIR, ignore_errors=True)
    shutil.copytree(backup / "attachments", config.ATTACHMENTS_DIR)


def recover_interrupted():
    journal = root() / "restore-journal"
    if not journal.exists():
        return
    name = journal.read_text("utf-8")
    if not re.fullmatch(r"[0-9]{8}T[0-9]{6}-[a-f0-9]{8}", name):
        raise RuntimeError("导入恢复记录无效，请保留数据目录以便检查。")
    restore_backup(root() / "backups" / name)
    stage = root() / "pending-import"
    if stage.exists():
        (stage / ".ready").unlink(missing_ok=True)
    (root() / "last-import.json").write_text(json.dumps({
        "ok": False, "error": "上次导入被中断，已恢复导入前的数据。"
    }, ensure_ascii=False), "utf-8")
    journal.unlink()


def apply_pending():
    """Called before services start; keep local connections and roll back on errors."""
    stage = root() / "pending-import"
    if not stage.exists():
        return
    if not (stage / ".ready").exists():
        shutil.rmtree(stage, ignore_errors=True)
        return
    report = root() / "last-import.json"
    backup = root() / "backups" / stamp()
    journal = root() / "restore-journal"
    swapped = False
    try:
        details = validate(stage)
        backup.mkdir(parents=True)
        for name in ("bai.sqlite", "checkpoints.sqlite"):
            if (root() / name).exists():
                snapshot(root() / name, backup / name)
        shutil.copytree(config.ATTACHMENTS_DIR, backup / "attachments")
        with connect(stage / "bai.sqlite") as incoming, connect(backup / "bai.sqlite") as current:
            incoming.execute("PRAGMA foreign_keys=OFF")
            for table in LOCAL_TABLES:
                incoming.execute(f'DELETE FROM "{table}"')
                rows = current.execute(f'SELECT * FROM "{table}"').fetchall()
                if rows:
                    placeholders = ",".join("?" for _ in rows[0])
                    incoming.executemany(f'INSERT INTO "{table}" VALUES ({placeholders})', rows)
            incoming.commit()
        db.engine.dispose()
        journal.write_text(backup.name, "utf-8")
        swapped = True
        for name in ("bai.sqlite", "checkpoints.sqlite"):
            for suffix in ("-wal", "-shm"):
                (root() / (name + suffix)).unlink(missing_ok=True)
            if (stage / name).exists():
                shutil.copy2(stage / name, root() / name)
            else:
                (root() / name).unlink(missing_ok=True)
        shutil.rmtree(config.ATTACHMENTS_DIR)
        shutil.copytree(stage / "attachments", config.ATTACHMENTS_DIR) if (stage / "attachments").exists() else config.ATTACHMENTS_DIR.mkdir()
        db.migrate()
        report.write_text(json.dumps({"ok": True, "backup": str(backup), **details}, ensure_ascii=False), "utf-8")
        journal.unlink()
        shutil.rmtree(stage)
    except Exception:
        if swapped:
            restore_backup(backup)
            journal.unlink(missing_ok=True)
        # Do not repeatedly attempt a failed restore at every startup.
        if stage.exists():
            (stage / ".ready").unlink(missing_ok=True)
        report.write_text(json.dumps({"ok": False, "error": "导入失败，当前数据已保留。请检查备份或重新选择文件。"}, ensure_ascii=False), "utf-8")
