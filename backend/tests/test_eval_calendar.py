"""Source-only calendar regressions for evaluation remediation."""

import pytest
from fastapi import HTTPException

from app import calendar_policy, db, feature_tools, plan_targets, plans

from .test_eval_execution import request_run


def timed(title, start="2050-11-01T15:00:00+08:00", end="2050-11-01T16:00:00+08:00", **kwargs):
    return plans.PlanWrite(title=title, start=start, end=end, **kwargs)


def test_reworded_item_in_same_source_does_not_duplicate():
    _, run_id = request_run("每两周的周日下午3点整理一次家庭账单。")
    with db.Session() as session:
        source = session.get(db.Run, run_id).source_message_id
    first = plans.create_events([timed("家庭账单整理", recurrence="weekly", repeat_interval=2)], source)
    second = plans.create_events([timed("整理家庭账单", end="2050-11-01T15:30:00+08:00", recurrence="weekly", repeat_interval=2)], source)
    assert first[0]["id"] == second[0]["id"]
    assert first[0]["end"] == second[0]["end"]


def test_conflict_leaves_independent_item_saved():
    plans.create_events([timed("与小林会议")])
    conversation_id, run_id = request_run("帮我安排牙医和晚餐。")
    with db.Session() as session:
        source = session.get(db.Run, run_id).source_message_id
    result = feature_tools._save_plans([
        timed("牙医", start="2050-11-01T15:30:00+08:00", end="2050-11-01T16:30:00+08:00"),
        timed("晚餐", start="2050-11-01T18:00:00+08:00", end="2050-11-01T19:00:00+08:00"),
    ], run_id, conversation_id, source, "帮我安排牙医和晚餐。")
    assert result["status"] == "needs_confirmation"
    assert [item["title"] for item in result["value"]] == ["晚餐"]
    assert result["conflicts"][0]["title"] == "与小林会议"


def test_advance_reminder_is_checked_against_source():
    assert calendar_policy.reminder_offsets("提前一天提醒") == [-1440]
    conversation_id, run_id = request_run("帮我安排复盘会，提前一天提醒。")
    with db.Session() as session:
        source = session.get(db.Run, run_id).source_message_id
    with pytest.raises(ValueError, match="reminder_offsets"):
        feature_tools._save_plans([timed("复盘会", reminder_enabled=True, reminder_offsets=[-30])],
            run_id, conversation_id, source, "帮我安排复盘会，提前一天提醒。")
    assert plans.list_events("2050-11-01", "2050-11-02") == []


def test_series_selection_does_not_require_a_guessed_occurrence():
    conversation_id, run_id = request_run("确认结束整个跑步系列，保留之前完成记录。")
    created = plans.create_events([timed("跑步", recurrence="weekly")])[0]
    queried = plans.list_events("2050-11-01", "2050-11-09")
    with db.Session() as session:
        session.add(db.RunEvent(run_id=run_id, kind="tool", data={"tool_id": "list_plans", "status": "completed", "result": queried}))
        session.commit()
    selected = plan_targets.validate_series(run_id, conversation_id, created["id"])
    assert selected["id"] == created["id"]
    with db.Session() as session:
        session.get(db.CalendarEvent, created["id"]).title = "修改后的跑步"
        session.commit()
    with pytest.raises(HTTPException) as error:
        plan_targets.validate_series(run_id, conversation_id, created["id"])
    assert error.value.status_code == 409


def test_discussion_is_not_creation_authorization():
    assert not calendar_policy.creation_authorized("先给方案，别写进日历。")
    assert calendar_policy.creation_authorized("下周六记得去给爸妈买体检套餐。")
