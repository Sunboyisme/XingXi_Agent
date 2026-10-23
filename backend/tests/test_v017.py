"""0.1.7 regression sources; execute only when the user requests tests."""

import json

import pytest
from sqlalchemy import func, select

from app import db, projects, tools


API = "/api/v1"


@pytest.mark.parametrize("foundation", ["", "  ", "基础未知"])
def test_new_learning_goal_missing_foundation_does_not_save(client, foundation):
    response = client.post(API + "/learning/goals", json={
        "title": "AI/Agent开发", "objective": "准备面试", "foundation": foundation,
    })
    assert response.status_code == 422
    assert client.get(API + "/learning/goals").json() == []


def test_explicit_beginner_choice_fills_only_missing_details(client):
    response = client.post(API + "/learning/goals", json={
        "title": "AI/Agent开发", "objective": "准备面试", "use_beginner_defaults": True,
    })
    assert response.status_code == 200
    goal = response.json()
    assert goal["objective"] == "准备面试"
    assert "零基础" in goal["foundation"]
    assert goal["nodes"] == []


@pytest.mark.asyncio
async def test_explicit_request_cannot_bypass_learning_intake():
    with db.Session() as session:
        chat = db.Conversation()
        session.add(chat)
        session.flush()
        message = db.Message(conversation_id=chat.id, role="user", content="帮我创建AI/Agent面试学习路线")
        session.add(message)
        session.flush()
        run = db.Run(kind="chat", conversation_id=chat.id, source_message_id=message.id)
        session.add(run)
        session.commit()
        chat_id, run_id = chat.id, run.id
    tool = next(item for item in tools.builtin_tools(run_id, chat_id) if item.name == "create_learning_goal")
    result = json.loads(await tool.ainvoke({"title": "AI/Agent面试", "objective": "准备开发岗位面试", "explicit_request": True}))
    assert result["status"] == "needs_details"
    assert result["missing"] == ["目前基础与相关背景"]
    with db.Session() as session:
        assert session.scalar(select(func.count()).select_from(db.Goal)) == 0
        assert session.scalar(select(func.count()).select_from(db.Run).where(db.Run.kind == "course")) == 0


def test_conversation_can_be_pinned_at_creation_and_activity_includes_unfiled(client):
    chat = client.post(API + "/conversations", json={"pinned": True}).json()
    assert chat["pinned_at"]
    assert chat["project_id"] is None
    with db.Session() as session:
        session.add_all([
            db.Run(kind="chat", conversation_id=chat["id"], status="running"),
            db.Run(kind="chat", conversation_id=chat["id"], status="queued"),
            db.Run(kind="chat", conversation_id=chat["id"], status="completed"),
            db.Run(kind="chat", conversation_id=chat["id"], status="running", profile_id="another-profile"),
        ])
        session.commit()
    assert projects.conversation_activity() == {chat["id"]: 2}
    assert client.get(API + "/conversations/activity").json() == {chat["id"]: 2}
