"""Stable question identity, grounded grading, and literal intake schedule fields."""

import calendar
import hashlib
import re
from datetime import date


def current_exercise(lesson):
    feedback = lesson.feedback or {}
    exercise = feedback.get("active_exercise") or feedback.get("next_exercise") or lesson.exercise
    criteria = feedback.get("active_criteria") or feedback.get("next_criteria") or lesson.criteria
    legacy_key = hashlib.sha256(exercise.encode()).hexdigest()[:12]
    return {"id": feedback.get("active_exercise_id") or f"{lesson.id}:{legacy_key}",
            "exercise": exercise, "criteria": criteria,
            "requirements": feedback.get("active_requirements") or ""}


def require_current(lesson, exercise_id):
    from fastapi import HTTPException
    current = current_exercise(lesson)
    if exercise_id and exercise_id != current["id"]:
        raise HTTPException(409, "当前练习已更新，请刷新题目后再提交；输入仍保留。")
    return current


def clean_text(text):
    # Normalize accidental escaped line breaks, without decoding code/paths.
    return text.replace("\\n", "\n") if "\\n" in text and "```" not in text and not re.search(r"[A-Za-z]:\\", text) else text


def bind_feedback(result, current, submission, lesson_id, *, allow_followup):
    result = dict(result)
    discussion = result.get("response_type") == "discussion"
    claimed_pass = bool(result.get("passed"))
    checks = result.get("criterion_checks") or []
    quotes = result.get("current_answer_quotes") or []

    def grounded(quote):
        return bool(quote and (quote in submission.get("answer", "") or
                    (quote.startswith("image:") and quote[6:] in submission.get("attachment_ids", []))))

    proven = bool(result.get("assessed_exercise_id") == current["id"] and checks and quotes
                  and all(grounded(quote) for quote in quotes)
                  and all(check.get("satisfied") and grounded(check.get("answer_quote", "")) for check in checks))
    result["passed"] = claimed_pass and proven and not discussion
    result["assessed_exercise_id"] = current["id"]
    if claimed_pass and not result["passed"] and not discussion:
        result["explanation"] = "当前作答还缺少与这道题对应的可核实依据，暂不能判为通过；请以当前题目为准。"
        result["gaps"] = [*result.get("gaps", []), "当前题的完成证据尚未核实"]
    if discussion or not allow_followup:
        result["next_exercise"] = result["next_criteria"] = result["next_requirements"] = ""
    if discussion:
        result["gaps"] = []
    next_exercise = result.get("next_exercise", "")
    if next_exercise:
        result["active_exercise_id"] = f"{lesson_id}:{submission['submission_id']}"
        result["active_exercise"] = next_exercise
        result["active_criteria"] = result["next_criteria"]
        result["active_requirements"] = result.get("next_requirements") or "按新题编号提交一段回答或代码，只完成当前题。"
    else:
        result.update(active_exercise_id=current["id"], active_exercise=current["exercise"],
                      active_criteria=current["criteria"], active_requirements=current["requirements"])
    for key in ("explanation", "reference_answer", "next_exercise", "next_step", "active_exercise", "next_requirements", "active_requirements"):
        if isinstance(result.get(key), str):
            result[key] = clean_text(result[key])
    return result


def lesson_presentation(text, preferences):
    if not any(re.search(r"先.{0,8}代码|代码.{0,8}最前", item) for item in preferences):
        return text
    block = re.search(r"```[^\n]*\n[\s\S]*?```", text)
    if not block:
        return text
    explanation = (text[:block.start()] + text[block.end():]).strip()
    if any(re.search(r"(?:最多|不超过)\s*(?:3|三)\s*句", item) for item in preferences):
        sentences = re.findall(r"[^。！？!?]+[。！？!?]?", explanation)
        explanation = "".join(sentences[:3]).strip()
    return block.group() + ("\n\n" + explanation if explanation else "")


def intake_schedule(messages, previous, today=None):
    """Later explicit user dates override earlier ones; units stay in minutes."""
    today = today or date.today()
    values = {key: str(previous.get(key) or "") for key in ("outcome", "weekly_minutes", "target_date")}
    for message in messages:
        if message.get("role") != "user":
            continue
        text = message.get("content", "")
        weekly = re.search(r"(?:每周|一周)\s*(\d+(?:\.\d+)?)\s*(小时|分钟)", text)
        if weekly:
            minutes = round(float(weekly[1]) * (60 if weekly[2] == "小时" else 1))
            if 1 <= minutes <= 10080:
                values["weekly_minutes"] = str(minutes)
        full = re.search(r"(20\d{2})[-年/.](\d{1,2})[-月/.](\d{1,2})(?:日|号)?", text)
        month_end = re.search(r"(?:(20\d{2})年)?(\d{1,2})\s*月底", text)
        try:
            if full:
                values["target_date"] = date(*map(int, full.groups())).isoformat()
            elif month_end:
                month = int(month_end[2])
                year = int(month_end[1]) if month_end[1] else today.year
                target = date(year, month, calendar.monthrange(year, month)[1])
                if not month_end[1] and target < today:
                    target = date(year + 1, month, calendar.monthrange(year + 1, month)[1])
                values["target_date"] = target.isoformat()
        except ValueError:
            continue
    return values
