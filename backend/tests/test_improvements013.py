from app import config, db, skills

from .test_app import API


def test_all_day_reminder_time_persists_and_reschedules_existing_reminder(client):
    value = {
        "title": "全天提醒",
        "start": "2026-10-20",
        "end": "2026-10-21",
        "all_day": True,
        "reminder_enabled": True,
        "reminder_time": "18:45",
    }
    response = client.post(API + "/calendar/events", json=value)
    assert response.status_code == 200, response.text
    event = response.json()
    reminder = next(
        r
        for r in client.get(API + "/reminders").json()
        if r["id"] == event["reminder_id"]
    )
    assert "10:45:00" in reminder["due_at"]
    value["reminder_time"] = "07:15"
    changed = client.put(f"{API}/calendar/events/{event['id']}", json=value).json()
    assert changed["reminder_id"] == event["reminder_id"]
    assert changed["reminder_time"] == "07:15"
    reminder = next(
        r
        for r in client.get(API + "/reminders").json()
        if r["id"] == event["reminder_id"]
    )
    assert "23:15:00" in reminder["due_at"] and reminder["due_at"].startswith(
        "2026-10-19"
    )
    for invalid in ("24:00", "8:00", "12:61", "", "09:00:00"):
        assert (
            client.post(
                API + "/calendar/events", json={**value, "reminder_time": invalid}
            ).status_code
            == 422
        )


def test_builtin_skill_installs_once_without_overwriting_or_authorizing(
    tmp_path, monkeypatch
):
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)
    skills.ensure_builtin()
    with db.Session() as session:
        row = session.query(db.Skill).filter_by(name="meeting-actions").one()
        key = row.id
        assert row.enabled and not row.scripts_allowed
        assert row.files == ["SKILL.md"]
        assert skills.SkillRead.model_validate(row).builtin
        assert session.query(db.Skill).filter_by(name="document-brief").one().enabled
        row.enabled = False
        session.commit()
    skills.ensure_builtin()
    with db.Session() as session:
        row = session.get(db.Skill, key)
        assert not row.enabled and not row.scripts_allowed
        session.delete(row)
        session.commit()
    skills.ensure_builtin()
    with db.Session() as session:
        assert session.query(db.Skill).filter_by(name="meeting-actions").count() == 0


def test_timed_plan_reminder_can_precede_start_and_survives_updates(client):
    value = {
        "title": "提前提醒的会议",
        "start": "2026-10-21T09:00:00+08:00",
        "end": "2026-10-21T10:00:00+08:00",
        "reminder_enabled": True,
        "reminder_at": "2026-10-20T20:30:00+08:00",
    }
    response = client.post(API + "/calendar/events", json=value)
    assert response.status_code == 200, response.text
    event = response.json()
    assert event["reminder_at"] == "2026-10-20T12:30:00.000000+00:00"
    reminder_id = event["reminder_id"]

    def reminder():
        return next(
            r for r in client.get(API + "/reminders").json() if r["id"] == reminder_id
        )

    assert reminder()["due_at"] == event["reminder_at"]
    value["reminder_at"] = "2026-10-21T08:15:00+08:00"
    changed = client.put(f"{API}/calendar/events/{event['id']}", json=value).json()
    assert changed["reminder_id"] == reminder_id and "00:15:00" in reminder()["due_at"]
    assert (
        next(
            e
            for e in client.get(API + "/calendar/events").json()
            if e["id"] == event["id"]
        )["reminder_at"]
        == changed["reminder_at"]
    )
    naive = client.post(
        API + "/calendar/events",
        json={
            **value,
            "title": "无偏移提醒",
            "reminder_at": "2026-10-21T08:00:00",
        },
    )
    assert naive.status_code == 200
    assert naive.json()["reminder_at"] == "2026-10-21T00:00:00.000000+00:00"
    value["reminder_at"] = None
    client.put(f"{API}/calendar/events/{event['id']}", json=value)
    assert "01:00:00" in reminder()["due_at"]
    value["status"] = "completed"
    client.put(f"{API}/calendar/events/{event['id']}", json=value)
    assert reminder()["status"] == "cancelled"
