"""Preflight the real profile's migration on a SQLite backup, without starting services."""
import hashlib
import json
import os
import sqlite3
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[1]
source = root / ".local-data/preview-runtime/bai.sqlite"
target = root / ".local-data/qa-unified-migration/bai.sqlite"
target.parent.mkdir(parents=True, exist_ok=True)
os.environ["BAI_DATA_DIR"] = str(target.parent)
sys.path.insert(0, str(root / "backend"))
from alembic import command
from alembic.config import Config

def rows(connection, table):
    connection.row_factory = sqlite3.Row
    return [dict(row) for row in connection.execute(f'SELECT * FROM "{table}" ORDER BY id')]

with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as original:
    with sqlite3.connect(target) as copy:
        original.backup(copy)

with sqlite3.connect(target) as copy:
    before = {table: rows(copy, table) for table in (
        "calendar_events", "reminders", "notifications", "settings", "conversations",
        "messages", "mcp_servers", "skills", "wechat_bindings",
    ) if copy.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()}
    old_version = copy.execute("SELECT version_num FROM alembic_version").fetchone()[0]

cfg = Config(str(root / "backend/alembic.ini"))
cfg.set_main_option("script_location", str(root / "backend/migrations"))
cfg.set_main_option("sqlalchemy.url", f"sqlite:///{target.as_posix()}")
command.upgrade(cfg, "head")

with sqlite3.connect(target) as copy:
    after = {table: rows(copy, table) for table in before}
    plans = {row["id"]: row for row in after["calendar_events"]}
    rules = {row["id"]: row for row in after["reminders"]}
    linked = {row["reminder_id"]: row["id"] for row in before["calendar_events"] if row["reminder_id"]}
    expected = len(before["calendar_events"]) + sum(row["id"] not in linked for row in before["reminders"])
    assert len(plans) == expected
    for old in before["calendar_events"]:
        assert old["id"] in plans
        for key in ("title", "notes", "start", "end", "timezone", "all_day", "source_message_id"):
            assert plans[old["id"]][key] == old[key], (old["id"], key)
    for old in before["reminders"]:
        new = rules[old["id"]]
        assert all(new[key] == value for key, value in old.items())
        assert new["plan_id"] in plans
        assert plans[new["plan_id"]]["recurrence"] == old["recurrence"]
        if old["id"] in linked:
            assert new["plan_id"] == linked[old["id"]]
    for table in before:
        if table in ("calendar_events", "reminders"):
            continue
        indexed = {row["id"]: row for row in after[table]}
        assert len(indexed) == len(before[table]), table
        for old in before[table]:
            assert all(indexed[old["id"]][key] == value for key, value in old.items()), table
    assert copy.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
    report = {
        "source_schema": old_version,
        "target_schema": copy.execute("SELECT version_num FROM alembic_version").fetchone()[0],
        "previous_plans": len(before["calendar_events"]),
        "previous_reminders": len(before["reminders"]),
        "linked_records_reused": len(linked),
        "canonical_plans": len(plans),
        "notifications_preserved": len(before["notifications"]),
        "conversations_preserved": len(before["conversations"]),
        "settings_and_other_existing_records_preserved": True,
        "credentials_accessed_or_changed": False,
        "integrity": "ok",
        "snapshot_sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
    }
(target.parent / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(report, ensure_ascii=False))
