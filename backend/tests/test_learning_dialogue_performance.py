"""Regression sources for learning dialogue and project activity; not run by default."""

import json
from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from app import db, learning, main, projects, provider, runs, schemas


def reviewed_lesson():
    with db.Session() as session:
        goal = db.Goal(title="技能学习", objective="完成一个小练习", foundation="初学者")
        session.add(goal)
        session.flush()
        node = db.KnowledgeNode(goal_id=goal.id, ordinal=0, title="基础", module="入门", objective="理解", status="passed")
        session.add(node)
        session.flush()
        lesson = db.Lesson(node_id=node.id, content="教学", exercise="写一个方案", criteria="方案可行",
                           graph_thread_id=db.uid(), state="reviewed")
        session.add(lesson)
        session.flush()
        session.add(db.Attempt(lesson_id=lesson.id, submission_id="earlier", answer="我每周可以投入五小时",
                    feedback={"response_type": "discussion", "explanation": "先选一件小事开始"}))
        session.commit()
        return lesson.id, node.id


@pytest.mark.asyncio
async def test_reviewed_lesson_accepts_followup_with_history_without_reteaching(monkeypatch):
    lesson_id, node_id = reviewed_lesson()
    launched = []

    async def reply(schema, instructions, text, *args, **kwargs):
        context = json.JSONDecoder().raw_decode(text)[0]
        assert context["previous_turns"][0]["answer"] == "我每周可以投入五小时"
        assert context["previous_turns"][0]["feedback"]["explanation"] == "先选一件小事开始"
        assert context["current_answer"] == "我不会做，第一步怎么开始？"
        return schemas.Feedback(response_type="discussion", passed=True, explanation="先选一个你能观察的小场景。",
                                strengths=[], gaps=[], next_step="这个场景是什么？", evidence="本知识点的文字对话")

    monkeypatch.setattr(provider, "ask_json", reply)
    monkeypatch.setattr(provider, "user_content", lambda *args, **kwargs: "validated")
    monkeypatch.setattr(runs, "launch", lambda run_id, operation: launched.append(operation))
    # No graph is supplied: a follow-up must not restart the lesson graph.
    request = SimpleNamespace(app=SimpleNamespace(state=SimpleNamespace(tutor=None)))
    with db.Session() as session:
        await main.submit(lesson_id, schemas.Submission(submission_id="followup", answer="我不会做，第一步怎么开始？"), request, session)
    await launched[0]()
    with db.Session() as session:
        assert len(learning.node_turns(session, node_id)) == 2
        assert session.get(db.KnowledgeNode, node_id).status == "passed"
        assert session.get(db.Lesson, lesson_id).feedback["passed"] is False
        assert len(list(session.scalars(select(db.Lesson)))) == 1
    with db.Session() as session:
        with pytest.raises(HTTPException) as error:
            await main.submit(lesson_id, schemas.Submission(submission_id="followup", answer="repeat"), request, session)
        assert error.value.status_code == 409


def test_project_activity_counts_running_project_tasks_only():
    with db.Session() as session:
        project = db.Project(name="项目")
        session.add(project)
        session.flush()
        inside, ordinary = db.Conversation(project_id=project.id), db.Conversation()
        session.add_all([inside, ordinary])
        session.flush()
        session.add_all([db.Run(kind="chat", conversation_id=inside.id, status="running"),
                         db.Run(kind="chat", conversation_id=inside.id, status="completed"),
                         db.Run(kind="chat", conversation_id=ordinary.id, status="running")])
        session.commit()
        project_id = project.id
    assert projects.project_activity() == {project_id: 1}
