import asyncio
import json
import time

import pytest
from sqlalchemy import select

from app import db, learning_workflows as workflows, provider, schemas

API = "/api/v1"


def finished(client, run):
    for _ in range(200):
        value = client.get(API + "/runs/" + run["id"]).json()
        if value["status"] not in {"queued", "running"}:
            assert value["status"] == "completed", value
            return value
        time.sleep(.01)
    pytest.fail("Workflow did not finish")


@pytest.fixture
def model(monkeypatch):
    calls = []

    async def ask(schema, instructions, text, *args, **kwargs):
        calls.append(schema.__name__)
        if schema is workflows.IntakeResult:
            data = json.loads(text.split("\n已生效")[0])
            complete = len([x for x in data["messages"] if x["role"] == "user"]) > 1
            return schema(title="HTML", objective="理解页面结构", foundation="零基础" if complete else "", question="你目前有什么基础？")
        if schema is schemas.CoursePlan:
            return schema(overview="路线", nodes=[schemas.CourseNode(key=str(i), module="基础", title=f"知识点{i}",
                objective="理解结构", exercise_type="question", criteria="内部路线标准") for i in range(3)])
        if schema is workflows.ReviewQuestion:
            if kwargs.get("on_partial"):
                kwargs["on_partial"]({"exercise": "1. main 的作用是什么？", "criteria": "内部复习标准"})
            return schema(exercise="1. main 的作用是什么？", criteria="内部复习标准")
        if schema is schemas.Feedback:
            return schema(passed=True, explanation="理解正确", strengths=["明确主内容"], gaps=[], next_step="可返回课程", evidence="用户说明main包含主内容")
        raise AssertionError(schema)

    monkeypatch.setattr(provider, "ask_json", ask)
    return calls


def seed_goal():
    with db.Session() as session:
        goal = db.Goal(title="HTML", objective="理解结构", foundation="零基础")
        session.add(goal); session.flush()
        nodes = [db.KnowledgeNode(goal_id=goal.id, ordinal=i, module="基础", title=f"章节{i}", objective="理解main的主内容作用",
                    criteria="内部章节标准", status="passed" if i == 0 else "needs_practice") for i in range(2)]
        session.add_all(nodes); session.flush()
        goal.current_node_id = nodes[0].id
        lessons = [db.Lesson(node_id=node.id, content="main包含主内容", exercise="说明main", criteria="内部原题标准", graph_thread_id=db.uid()) for node in nodes]
        session.add_all(lessons); session.commit()
        return goal.id, [node.id for node in nodes], [lesson.id for lesson in lessons]


def test_interview_persists_drafts_and_confirms_only_one_goal(client, model):
    row = client.post(API + "/learning/intakes").json()
    assert client.post(API + "/learning/intakes").json()["id"] == row["id"]
    path = API + f"/learning/intakes/{row['id']}"
    saved = client.put(path + "/draft", json={"answer": "想学HTML", "revision": 0})
    assert saved.status_code == 200
    assert client.put(path + "/draft", json={"answer": "覆盖", "revision": 0}).status_code == 409
    finished(client, client.post(path + "/messages", json={"message_id": "one", "content": "想学HTML，理解结构"}).json())
    assert client.get(path).json()["status"] == "draft"
    assert client.get(API + "/learning/goals").json() == []
    finished(client, client.post(path + "/messages", json={"message_id": "two", "content": "我是零基础"}).json())
    ready = client.get(path).json()
    assert ready["status"] == "ready"
    finished(client, client.post(path + "/confirm", json=ready["summary"]).json())
    again = client.post(path + "/confirm", json=ready["summary"]).json()
    assert again["status"] == "completed"
    assert len(client.get(API + "/learning/goals").json()) == 1
    assert model.count("CoursePlan") == 1


def test_failed_course_retry_reuses_created_goal(client, model, monkeypatch):
    row = client.post(API + "/learning/intakes").json()
    path = API + f"/learning/intakes/{row['id']}/confirm"
    original = provider.ask_json
    async def fail(*args, **kwargs):
        raise ValueError("synthetic failure")
    monkeypatch.setattr(provider, "ask_json", fail)
    run = client.post(path, json={"title": "HTML", "objective": "结构", "foundation": "零基础"}).json()
    for _ in range(100):
        if client.get(API + "/runs/" + run["id"]).json()["status"] == "failed": break
        time.sleep(.01)
    monkeypatch.setattr(provider, "ask_json", original)
    finished(client, client.post(path, json={"title": "其他", "objective": "其他", "foundation": "零基础"}).json())
    goals = client.get(API + "/learning/goals").json()
    assert len(goals) == 1 and goals[0]["title"] == "HTML"


def test_review_prefers_gap_keeps_original_and_updates_mastery_with_evidence(client, model):
    goal, nodes, lessons = seed_goal()
    original = client.get(API + f"/learning/nodes/{nodes[1]}/lesson").json()
    run = client.post(API + "/learning/reviews", json={"goal_id": goal}).json()
    finished(client, run)
    review_id = run["result"]["review_id"]
    path = API + f"/learning/reviews/{review_id}"
    review = client.get(path).json()
    assert review["node_id"] == nodes[1]
    assert "尚未作答" in review["source"]["basis"]
    assert "内部" not in json.dumps(review, ensure_ascii=False)
    assert "内部" not in client.get(API + f"/runs/{run['id']}/events").text
    saved = client.put(path + "/draft", json={"revision": 0, "answer": "main包含主内容", "attachment_ids": []}).json()
    assert saved["draft"]["answer"] == "main包含主内容"
    assert client.put(path + "/draft", json={"revision": 0, "answer": "旧草稿"}).status_code == 409
    result = client.post(path + "/submit", json={"submission_id": "answer1", "answer": "main包含主内容"}).json()
    finished(client, result)
    assert client.post(path + "/submit", json={"submission_id": "answer1", "answer": "main包含主内容"}).status_code == 200
    reviewed = client.get(path).json()
    assert len(reviewed["turns"]) == 1 and reviewed["draft"] == {}
    assert client.get(API + f"/learning/nodes/{nodes[1]}/lesson").json() == original
    assert next(x for x in client.get(API + f"/learning/goals/{goal}").json()["nodes"] if x["id"] == nodes[1])["status"] == "passed"
    assert client.get(API + f"/learning/reviews?goal_id={goal}&session_id={reviewed['session_id']}").json()[0]["turns"]


def test_end_all_stops_learning_only_and_retains_drafts(client, monkeypatch):
    goal, nodes, _ = seed_goal()
    saved = client.post(API + f"/learning/goals/{goal}/sessions", json={"node_id": nodes[0]}).json()
    with db.Session() as session:
        row = session.get(db.LearningSession, saved["id"])
        row.drafts = {nodes[0]: {"answer": "未提交", "attachment_ids": []}}
        other = db.Goal(title="另一个", objective="目标", foundation="入门")
        session.add(other); session.flush()
        session.add(db.LearningSession(goal_id=other.id, status="paused"))
        session.commit()
    async def waiting(*args, **kwargs):
        await asyncio.sleep(60)
    monkeypatch.setattr(provider, "ask_json", waiting)
    run = client.post(API + "/learning/reviews", json={"goal_id": goal}).json()
    assert client.post(API + "/learning/sessions/end-all").status_code == 200
    assert client.get(API + "/runs/" + run["id"]).json()["status"] == "cancelled"
    with db.Session() as session:
        assert all(row.status == "ended" for row in session.scalars(select(db.LearningSession)))
        assert session.get(db.LearningSession, saved["id"]).drafts[nodes[0]]["answer"] == "未提交"
    assert client.post(API + "/learning/sessions/end-all").json()["ended_ids"] == []


def test_rubrics_are_not_in_legacy_lesson_goal_feedback_or_events(client):
    goal, nodes, lessons = seed_goal()
    with db.Session() as session:
        session.get(db.Lesson, lessons[0]).feedback = {"explanation": "反馈", "active_criteria": "内部评分秘密", "nested": {"next_criteria": "内部评分秘密"}}
        run = db.Run(kind="assessment", goal_id=goal, status="completed", result={"feedback": {"active_criteria": "内部评分秘密"}})
        session.add(run); session.flush()
        session.add(db.RunEvent(run_id=run.id, kind="learning_content", data={"fields": {"criteria": "内部评分秘密", "content": "讲解"}}))
        session.commit(); run_id = run.id
    for path in [f"/learning/goals/{goal}", f"/learning/nodes/{nodes[0]}/lesson", f"/runs/{run_id}", f"/runs/{run_id}/events"]:
        response = client.get(API + path)
        assert response.status_code == 200 and "内部" not in response.text


def test_usage_totals_include_all_history_without_double_count_or_cache(client):
    with db.Session() as session:
        covered = db.Run(kind="chat", status="completed", usage={"total_tokens": 900})
        session.add(covered); session.flush()
        for i in range(105): session.add(db.Run(kind="chat", status="completed", usage={"total_tokens": 10}))
        for tokens in [30, 40, None]: session.add(db.UsageCall(run_id=covered.id, provider_id="p", provider_label="p", model_name="m", purpose="learning", kind="tokens", status="completed", total_tokens=tokens, cached_tokens=15))
        session.commit()
    report = client.get(API + "/usage?limit=1").json()
    assert report["total_tokens"] == 1120
    assert report["unknown_token_calls"] == 1 and len(report["calls"]) == 1
    assert report["historical_count"] == 105 and len(report["historical"]) == 100


def test_markdown_preview_preserves_blank_lines_and_original_file(client):
    raw = "# 标题\n\n一段文字\n\n- 第一项\n- 第二项\n\n```js\nconst x = 1;\n```\n".encode()
    response = client.post(API + "/files", files={"file": ("说明.md", raw, "text/markdown")})
    assert response.status_code == 200
    key = response.json()["id"]
    for _ in range(100):
        preview = client.get(API + f"/files/{key}/preview")
        if preview.status_code == 200: break
        time.sleep(.02)
    assert preview.json()["kind"] == "markdown" and preview.json()["content"].encode() == raw
    assert client.get(API + f"/files/{key}/content").content == raw


def test_complete_without_submission_is_idempotent(client):
    goal, nodes, _ = seed_goal()
    with db.Session() as session:
        session.get(db.KnowledgeNode, nodes[1]).status = "in_progress"; session.commit()
    first = client.post(API + f"/learning/nodes/{nodes[1]}/complete").json()
    second = client.post(API + f"/learning/nodes/{nodes[1]}/complete").json()
    assert first == second and first["status"] == "needs_practice"


def test_intake_summary_saves_unfinished_form_without_creating_goal(client, model):
    row = client.post(API + "/learning/intakes").json()
    path = API + f"/learning/intakes/{row['id']}"
    summary = {"title": "HTML", "objective": "结构", "foundation": "入门", "weekly_minutes": "尚未决定"}
    assert client.put(path + "/summary", json={"summary": summary}).status_code == 200
    assert client.get(path).json()["summary"] == summary
    assert client.get(API + "/learning/goals").json() == []
    assert client.put(path + "/summary", json={"summary": {"unknown": "非法字段"}}).status_code == 422


def test_review_history_survives_new_session_and_017_upgrade(client, model, tmp_path):
    goal, nodes, _ = seed_goal()
    run = client.post(API + "/learning/reviews", json={"goal_id": goal}).json()
    finished(client, run)
    review_id = run["result"]["review_id"]
    path = API + f"/learning/reviews/{review_id}"
    first_session = client.get(path).json()["session_id"]
    finished(client, client.post(path + "/submit", json={"submission_id": "old", "answer": "main包含主内容"}).json())
    assert client.post(API + f"/learning/sessions/{first_session}/end").status_code == 200
    finished(client, client.post(API + "/learning/reviews", json={"goal_id": goal}).json())
    second_session = client.get(path).json()["session_id"]
    assert first_session != second_session
    old = client.get(API + f"/learning/reviews?goal_id={goal}&session_id={first_session}").json()
    assert len(old) == 1 and len(old[0]["turns"]) == 1
    assert client.get(API + f"/learning/reviews?goal_id={goal}&session_id={second_session}").json()[0]["turns"] == []
