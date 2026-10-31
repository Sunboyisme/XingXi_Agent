"""Existing arrangements are read evidence, never a reason to create duplicates.

Regression sources only; execute when the user requests testing.
"""
import json

import pytest
from sqlalchemy import func, select

from app import complex_tasks, db, feature_tools, plans


def existing_plan(**changes):
    value = plans.PlanWrite(title="整理排期", start="2030-11-02", end="2030-11-03",
                            all_day=True, **changes)
    row = plans.create_events([value])[0]
    check = {"plan_id": row["id"], "expected": value.model_dump()}
    tool = next(tool for tool in feature_tools.build("", "") if tool.name == "check_existing_plans")
    return tool, row, check


def test_verified_existing_plan_does_not_write_and_receipt_expires_after_edit():
    tool, row, check = existing_plan()
    with db.Session() as session:
        before = session.scalar(select(func.count()).select_from(db.CalendarEvent))
    result = json.loads(tool.invoke({"checks": [check]}))
    assert result["status"] == "verified" and result["created"] == 0
    assert complex_tasks.calendar_result_current("check_existing_plans", result)
    with db.Session() as session:
        assert session.scalar(select(func.count()).select_from(db.CalendarEvent)) == before
        session.get(db.CalendarEvent, row["id"]).title = "用户随后修改的安排"
        session.commit()
    assert not complex_tasks.calendar_result_current("check_existing_plans", result)


@pytest.mark.parametrize("field,value", [
    ("title", "另一个事项"), ("start", "2030-11-01"),
    ("reminder_enabled", True), ("notes", "尚未保存的备注"),
])
def test_similar_or_changed_fields_cannot_claim_coverage(field, value):
    tool, _, check = existing_plan()
    check["expected"][field] = value
    result = json.loads(tool.invoke({"checks": [check]}))
    assert result["status"] == "mismatch" and field in result["different_fields"]
    assert not complex_tasks.calendar_result_current("check_existing_plans", result)


def test_duplicate_ids_and_deleted_plans_do_not_count_as_verified():
    tool, row, check = existing_plan()
    assert json.loads(tool.invoke({"checks": [check, check]})).get("error")
    with db.Session() as session:
        session.get(db.CalendarEvent, row["id"]).status = "deleted"
        session.commit()
    assert json.loads(tool.invoke({"checks": [check]})).get("error")


def test_recurring_occurrence_is_verified_at_its_own_date():
    tool, _, _ = existing_plan(recurrence="daily", repeat_count=3)
    occurrence = plans.list_events("2030-11-03", "2030-11-04")[0]
    check = {"plan_id": occurrence["id"], "occurrence_start": occurrence["occurrence_start"],
             "expected": {field: occurrence[field] for field in plans.PlanWrite.model_fields}}
    result = json.loads(tool.invoke({"checks": [check]}))
    assert result["status"] == "verified"
    assert complex_tasks.calendar_result_current("check_existing_plans", result)
