"""Current-question and intake regression sources; no execution during delivery."""

from datetime import date
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app import learning_public, learning_state


def current():
    return {"id": "lesson:new", "exercise": "1. 打印支出", "criteria": "输出支出", "requirements": "提交一行代码"}


def feedback(**changes):
    return {"response_type": "feedback", "passed": True, "explanation": "已完成", "gaps": [],
            "assessed_exercise_id": "lesson:new", "current_answer_quotes": ["print('支出')"],
            "criterion_checks": [{"criterion": "输出支出", "satisfied": True, "answer_quote": "print('支出')"}],
            **changes}


def test_old_answer_cannot_be_used_as_current_answer_evidence():
    result = learning_state.bind_feedback(feedback(), current(),
        {"submission_id": "s", "answer": "我运行了print('hello')", "attachment_ids": []}, "lesson", allow_followup=False)
    assert not result["passed"]


def test_matching_current_answer_and_question_are_required():
    submission = {"submission_id": "s", "answer": "print('支出')", "attachment_ids": []}
    assert learning_state.bind_feedback(feedback(), current(), submission, "lesson", allow_followup=False)["passed"]
    assert not learning_state.bind_feedback(feedback(assessed_exercise_id="lesson:old"), current(), submission, "lesson", allow_followup=False)["passed"]


def test_discussion_preserves_question_and_does_not_add_another():
    result = learning_state.bind_feedback(feedback(response_type="discussion", next_exercise="另一个问题", next_criteria="新标准"),
        current(), {"submission_id": "s", "answer": "为什么从0开始？"}, "lesson", allow_followup=True)
    assert not result["passed"] and result["next_exercise"] == ""
    assert result["active_exercise_id"] == "lesson:new"
    assert result["active_exercise"] == "1. 打印支出"
    assert "criterion_checks" not in learning_public.public(result)


def test_stale_question_submission_is_rejected_without_model():
    lesson = SimpleNamespace(id="lesson", exercise="旧题", criteria="旧标准", feedback={"active_exercise_id": "lesson:new", "active_exercise": "新题"})
    with pytest.raises(HTTPException) as error:
        learning_state.require_current(lesson, "lesson:old")
    assert error.value.status_code == 409


def test_intake_preserves_weekly_units_and_later_deadline():
    messages = [{"role": "user", "content": "每周4小时，希望12月底前上线。"},
                {"role": "user", "content": "改为希望1月底前上线。"}]
    result = learning_state.intake_schedule(messages, {}, date(2026, 10, 27))
    assert result["weekly_minutes"] == "240" and result["target_date"] == "2027-01-31"


def test_code_first_presentation_and_escaped_paths():
    text = "先解释。第二句。第三句。第四句。\n```python\nprint('hello')\n```"
    result = learning_state.lesson_presentation(text, ["学Python希望先代码，再最多三句话解释"])
    assert result.startswith("```python") and "第四句" not in result
    assert learning_state.clean_text(r"路径C:\new\notes") == r"路径C:\new\notes"
