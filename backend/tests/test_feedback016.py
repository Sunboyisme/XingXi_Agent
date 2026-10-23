"""Regression source for the follow-up. Run only on the user's explicit request."""

import asyncio
import io
import json
from datetime import date

import pytest
from fastapi import HTTPException
from PIL import Image
from sqlalchemy import select

from app import complex_tasks, config, conversation_cleanup, db, feature_tools, features, main, office, plans, projects, provider, retrieval, schemas
from .test_v016 import query_proof, request_context, timed


def image_bytes():
    output = io.BytesIO()
    Image.new("RGB", (40, 40), "white").save(output, "JPEG")
    return output.getvalue()


def source_image(project_id=None):
    with db.Session() as session:
        conversation = db.Conversation(title="图片来源", project_id=project_id)
        picture = db.Attachment(name="课程.jpg", media_type="image/jpeg", width=40, height=40)
        session.add_all([conversation, picture])
        session.flush()
        message = db.Message(conversation_id=conversation.id, role="user", content="计算课程时长", attachment_ids=[picture.id])
        session.add(message)
        session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id, source_message_id=message.id,
                     model_config={"vision_enabled": True, "model_name": "selected-model"})
        session.add(run)
        session.commit()
        (config.ATTACHMENTS_DIR / f"{picture.id}.jpg").write_bytes(image_bytes())
        return conversation.id, picture.id, run.id


def test_prose_and_format_aliases_never_block_existing_markdown():
    plan = complex_tasks.Plan(goal="输出两份文件", expected_outputs=["markdown", "word", "text"], steps=[
        {"title": "分析", "instruction": "分析", "formats": ["text"]},
        {"title": "交付", "instruction": "保存文件", "formats": ["markdown", "docx"]},
    ])
    assert plan.expected_outputs == ["md", "docx"]
    assert plan.steps[0].formats == []
    assert plan.steps[1].formats == ["md", "docx"]
    with pytest.raises(ValueError):
        complex_tasks.normalize_formats(["unknown-file"])


def test_uploaded_image_uses_selected_vision_model_and_reports_uncertainty(monkeypatch):
    conversation_id, picture_id, run_id = source_image()
    async def describe(schema, instructions, text, **options):
        assert options["model_config"]["model_name"] == "selected-model"
        assert options["image_data"][0] == image_bytes()
        return office.ImageReading(content="课程08：22:22", uncertainties=["课程09被遮挡"])
    monkeypatch.setattr(provider, "ask_json", describe)
    value = asyncio.run(office.read_file(picture_id, conversation_id, run_id=run_id))
    assert value["kind"] == "image" and "22:22" in value["parts"][0]["text"]
    assert value["uncertainties"] == ["课程09被遮挡"]
    with db.Session() as session:
        assert session.get(db.OfficeFile, picture_id) is None


def test_image_read_failure_is_actionable_without_invoking_a_model(monkeypatch):
    conversation_id, picture_id, run_id = source_image()
    with db.Session() as session:
        session.get(db.Run, run_id).model_config = {"vision_enabled": False}
        session.commit()
    async def unexpected(*args, **kwargs):
        raise AssertionError("unsupported model must not be called")
    monkeypatch.setattr(provider, "ask_json", unexpected)
    with pytest.raises(ValueError, match="未启用图片输入"):
        asyncio.run(office.read_file(picture_id, conversation_id, run_id=run_id))


def test_shared_material_survives_chat_delete_without_cross_project_access():
    first = projects.create_project(schemas.ProjectWrite(name="甲"))
    second = projects.create_project(schemas.ProjectWrite(name="乙"))
    conversation_id, picture_id, _ = source_image(first.id)
    value = asyncio.run(projects.add_material(first.id, schemas.ProjectMaterialCreate(file_id=picture_id, conversation_id=conversation_id)))
    with db.Session() as session:
        sibling = db.Conversation(project_id=first.id)
        outsider = db.Conversation(project_id=second.id)
        session.add_all([sibling, outsider])
        session.commit()
        sibling_id, outsider_id = sibling.id, outsider.id
        conversation_cleanup.remove(session, session.get(db.Conversation, conversation_id))
    path, _ = office.authorized(value["file_id"], sibling_id)
    assert path.is_file() and value["file_id"] != picture_id
    with pytest.raises(ValueError, match="不属于"):
        office.authorized(value["file_id"], outsider_id)


def test_project_retrieval_only_includes_own_memories_and_global_preferences():
    first = projects.create_project(schemas.ProjectWrite(name="甲"))
    second = projects.create_project(schemas.ProjectWrite(name="乙"))
    with db.Session() as session:
        for project, category, text in [(None, "fact", "课程时长全局事实"), (None, "preference", "课程时长个人偏好"),
                                         (first.id, "fact", "课程时长甲项目"), (second.id, "fact", "课程时长乙项目")]:
            session.add(db.Memory(project_id=project, category=category, content=text, source="用户", state="confirmed"))
        session.commit()
    result, trace = asyncio.run(retrieval.retrieve_detailed("课程时长", project_id=first.id))
    assert {item["content"] for item in result} == {"课程时长甲项目", "课程时长个人偏好"}
    assert all("乙项目" not in item["content"] for item in trace["candidates"])


def test_bulk_removal_validates_every_target_before_any_write():
    rows = plans.create_events([timed(25), timed(26)])
    run_id, conversation_id = request_context("将25号的计划都去掉")
    query_proof(run_id, plans.list_events("2026-10-25", "2026-10-27"))
    remove = next(tool for tool in feature_tools.build(run_id, conversation_id) if tool.name == "delete_plans")
    result = json.loads(remove.invoke({"target_date": "2026-10-25", "targets": [{"plan_id": row["id"]} for row in rows]}))
    assert result["error"] and result["not_executed"]
    assert len(plans.list_events("2026-10-25", "2026-10-27")) == 2


def test_bulk_removal_cancels_only_the_selected_repeat_instance():
    rows = plans.create_events([timed(25), timed(25, recurrence="daily")])
    run_id, conversation_id = request_context("将25号的计划都去掉")
    values = plans.list_events("2026-10-25", "2026-10-26")
    query_proof(run_id, values)
    remove = next(tool for tool in feature_tools.build(run_id, conversation_id) if tool.name == "delete_plans")
    result = json.loads(remove.invoke({"target_date": "2026-10-25", "targets": [
        {"plan_id": row["id"], "occurrence_start": row["occurrence_start"]} for row in values]}))
    assert result["removed"] == 2
    assert {item["operation"] for item in result["operations"]} == {"delete", "cancel_occurrence"}
    assert plans.list_events("2026-10-26", "2026-10-27")[0]["id"] == rows[1]["id"]


def test_day_order_uses_actual_instance_keys_and_can_reset():
    row = plans.create_events([timed(25)])[0]
    key = row["id"] + ":" + row["occurrence_start"]
    features.save_day_order(features.DayOrderWrite(day="2026-10-25", timezone="Asia/Shanghai", keys=[key]))
    assert features.day_orders(date(2026, 10, 25), date(2026, 10, 26), "Asia/Shanghai")["2026-10-25"] == [key]
    with pytest.raises(HTTPException):
        features.save_day_order(features.DayOrderWrite(day="2026-10-26", timezone="Asia/Shanghai", keys=[key]))
    features.save_day_order(features.DayOrderWrite(day="2026-10-25", timezone="Asia/Shanghai", keys=[]))
    assert features.day_orders(date(2026, 10, 25), date(2026, 10, 26), "Asia/Shanghai") == {}


def test_retry_is_bound_to_the_failed_question_and_latest_user_message():
    conversation_id, _, run_id = source_image()
    with db.Session() as session:
        run = session.get(db.Run, run_id)
        run.status = "failed"
        session.commit()
        assert main.retry_action(session, run) == "retry"
        session.add(db.Message(conversation_id=conversation_id, role="user", content="新的问题"))
        session.commit()
        assert main.retry_action(session, run) == "none"


def test_deleting_project_preserves_chat_and_removes_project_memory():
    project = projects.create_project(schemas.ProjectWrite(name="保留聊天"))
    conversation_id, _, _ = source_image(project.id)
    with db.Session() as session:
        session.get(db.Run, session.scalar(select(db.Run.id).where(db.Run.conversation_id == conversation_id))).status = "completed"
        session.add(db.Memory(project_id=project.id, content="项目专属", source="用户"))
        session.commit()
    projects.delete_project(project.id)
    with db.Session() as session:
        assert session.get(db.Conversation, conversation_id).project_id is None
        assert session.scalar(select(db.Memory.id).where(db.Memory.project_id == project.id)) is None
