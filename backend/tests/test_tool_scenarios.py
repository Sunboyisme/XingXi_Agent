"""Simulated workflows through every built-in tool, with real local effects."""
import io
import json

import pytest
from PIL import Image
from sqlalchemy import select

from app import artifacts, db, tools
from .test_features013 import import_example, authorize


@pytest.mark.asyncio
async def test_all_builtin_tools_in_user_workflows(configured, isolate, monkeypatch, tmp_path):
    isolate["search"] = "synthetic-key"
    skill = import_example(configured)
    authorize(configured, skill)
    source = tmp_path / "预算.txt"
    source.write_text("活动预算：100元；3个节点。", encoding="utf-8")
    request = (f"读取文件夹 {tmp_path} 的预算，查询广州天气和资料并计算，生成报告、表格和配图；"
               "记住我喜欢简短回答。我是零基础，请创建Python学习路线，目标是理解变量；"
               "创建待办并修改完成；在2030-11-01创建、修改并删除活动计划，测试技能生成笔记。")
    with db.Session() as session:
        project = db.Project(name="模拟活动筹备")
        session.add(project); session.flush()
        conversation = db.Conversation(title="模拟组合工具用户任务", project_id=project.id)
        session.add(conversation); session.flush()
        message = db.Message(conversation_id=conversation.id, role="user", content=request)
        session.add(message); session.flush()
        run = db.Run(kind="chat", conversation_id=conversation.id, source_message_id=message.id)
        session.add(run); session.commit()
        run_id, conversation_id = run.id, conversation.id

    async def weather(**kwargs):
        return {"location": "广州", "temperature": 25, "source": "https://example.com/weather"}
    async def search(query):
        return {"results": [{"title": "模拟公开资料", "url": "https://example.com/report", "content": "预算100元"}]}
    async def read(url):
        return {"url": url, "text": "模拟原始资料：预算100元，完成3个节点。"}
    async def image(run_id, prompt, name):
        output = io.BytesIO()
        Image.new("RGB", (32, 32), "orange").save(output, format="PNG")
        saved = artifacts.save_file(run_id, name + ".png", output.getvalue(), image=True)
        return {"artifacts": [saved]}
    monkeypatch.setattr(tools.weather, "get_weather", weather)
    monkeypatch.setattr(tools.search, "search_web", search)
    monkeypatch.setattr(tools.search, "read_webpage", read)
    monkeypatch.setattr(tools.image_generation, "ready", lambda: True)
    monkeypatch.setattr(tools.image_generation, "generate", image)
    registry = {tool.name: tool for tool in tools.build_tools(run_id, conversation_id)}
    called = set()

    async def call(tool_name, **args):
        result = json.loads(await registry[tool_name].ainvoke(args))
        if not isinstance(result, dict):
            result = {"value": result}
        assert not result.get("error"), (tool_name, result)
        assert not result.get("needs_details"), (tool_name, result)
        called.add(tool_name)
        return result

    # Research, calculation, memory and learning.
    await call("get_weather", city="广州")
    await call("web_search", query="活动预算")
    await call("read_url", url="https://example.com/report")
    assert (await call("calculate", expression="100/4"))["result"] == "25"
    await call("date_time", value="2030-11-01", add_days=1)
    await call("convert_units", value="5", from_unit="km", to_unit="m")
    saved = await call("remember", content="用户喜欢简短回答", category="preference", explicit_request=True, evidence="记住我喜欢简短回答")
    assert saved["state"] == "confirmed"
    await call("search_memories", query="简短回答")
    await call("search_conversation_history", query="预算", role="user")
    await call("search_project_history", query="预算", role="user")
    await call("create_learning_goal", title="Python", objective="理解变量", foundation="零基础", explicit_request=True)
    assert (await call("learning_goals"))["value"]

    # Local data -> real files -> read-back. External services are fixtures.
    await call("scan_local_folder", path=str(tmp_path))
    await call("read_local_file", path=str(source))
    text = await call("create_text_file", name="活动记录.md", format="md", content="# 活动：预算100元")
    await call("list_files")
    await call("read_file", file_id=text["artifacts"][0]["id"])
    matches = await call("search_file", file_id=text["artifacts"][0]["id"], query="预算")
    assert matches["matches"]
    await call("create_document", name="活动报告.docx", format="docx", title="活动报告", blocks=[{"kind": "paragraph", "text": "预算100元，3个节点。"}])
    await call("create_spreadsheet", name="预算.xlsx", sheets=[{"name": "预算", "rows": [["项目", "金额"], ["活动", 100]]}])
    await call("generate_image", prompt="橙色活动插画", name="活动配图")
    await call("load_skill", skill_id=skill["id"])
    await call("read_skill_file", skill_id=skill["id"], path="references/format.md")
    assert (await call("run_skill_script", skill_id=skill["id"], path="scripts/make_note.py", arguments=[]))["exit_code"] == 0

    # Todo lifecycle and calendar actions use the real guarded entry points.
    await call("list_todos")
    todo = await call("create_todo", title="完成三个节点", notes="保留备注")
    await call("update_todo", todo_id=todo["id"], changes={"title": "完成四个节点"})
    await call("action_todo", todo_id=todo["id"], action="complete")
    day = {"start": "2030-11-01", "end": "2030-11-02"}
    await call("list_plans", **day)
    plans = [{"title": name, "start": f"2030-11-01T{hour}:00:00+08:00", "end": f"2030-11-01T{hour}:30:00+08:00"} for name, hour in [("活动准备", "09"), ("活动整理", "10")]]
    created = await call("create_plans", plans=plans, explicit_request=True)
    ids = [item["id"] for item in created["value"]]
    await call("list_plans", **day)
    await call("update_plan", plan_id=ids[0], plan={**plans[0], "title": "更新活动准备"}, target_date="2030-11-01")
    await call("list_plans", **day)
    await call("action_plan", plan_id=ids[0], action="complete", target_date="2030-11-01")
    await call("list_plans", **day)
    await call("delete_plan", plan_id=ids[0], target_date="2030-11-01")
    await call("list_plans", **day)
    await call("delete_plans", target_date="2030-11-01", targets=[{"plan_id": ids[1]}])
    assert called == set(tools.TOOL_INFO), set(tools.TOOL_INFO) - called
    with db.Session() as session:
        audited = {event.data["tool_id"] for event in session.scalars(select(db.RunEvent).where(db.RunEvent.run_id == run_id, db.RunEvent.kind == "tool")) if event.data["status"] == "completed"}
    assert called <= audited
