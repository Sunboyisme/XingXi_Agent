"""Local protocol fixture, never used by the application in normal operation."""

import json
import re
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def reply(body):
    messages = body["messages"]
    system = str(messages[0].get("content", ""))
    user = str(
        next((m["content"] for m in reversed(messages) if m["role"] == "user"), "")
    )
    if "office-contract" in user:
        used = [call["function"]["name"] for message in messages for call in message.get("tool_calls", [])]
        tool_results = [json.loads(message["content"]) for message in messages if message.get("role")=="tool"]
        if "list_files" not in used:
            name,args = "list_files",{}
        elif "read_file" not in used:
            files = next(result["files"] for result in tool_results if "files" in result)
            name,args = "read_file",{"file_id":next(f["id"] for f in files if f["kind"]=="upload")}
        elif "create_document" not in used:
            name,args = "create_document",{"name":"办公报告.docx","format":"docx","title":"项目报告","blocks":[{"kind":"paragraph","text":"预算100元，完成3项任务。"},{"kind":"table","rows":[["预算","完成任务"],["100元","3项"]]}]}
        elif "create_spreadsheet" not in used:
            name,args = "create_spreadsheet",{"name":"项目明细.xlsx","sheets":[{"name":"明细","rows":[["项目","金额"],["甲",40],["乙",60],["合计",{"formula":"SUM(B2:B3)"}]]}]}
        else:
            return {"content":"资料已读取，Word报告和Excel明细表已生成，请查看下方文件卡片。"}
        return {"content":None,"tool_calls":[{"id":"call_office_"+name,"type":"function","function":{"name":name,"arguments":json.dumps(args,ensure_ascii=False)}}]}
    if '"title": "CoursePlan"' in system:
        match = re.search(r"主题：([^\n]+)", user)
        topic = match.group(1) if match else "测试主题"
        nodes = [
            {
                "key": str(i),
                "module": "基础与实践",
                "title": f"{topic} · {name}",
                "objective": f"掌握{name}并能举例",
                "prerequisites": [str(i - 1)] if i else [],
                "exercise_type": "question",
                "criteria": "解释关键概念并给出具体例子",
            }
            for i, name in enumerate(["认识基础", "应用方法", "独立实践"])
        ]
        return {
            "content": json.dumps(
                {"overview": "测试课程：从基础到实践。", "nodes": nodes},
                ensure_ascii=False,
            )
        }
    if '"title": "LessonContent"' in system:
        return {
            "content": json.dumps(
                {
                    "content": "## 先理解，再动手\n这是隔离测试用的教学内容。概念用于描述事物，例子用于检验理解。",
                    "exercise": "用自己的话解释概念，并给一个具体例子。",
                    "hints": ["先描述用途，再举例。"],
                    "criteria": "概念解释清晰，例子具体。",
                },
                ensure_ascii=False,
            )
        }
    if '"title": "Feedback"' in system:
        passed = "不会" not in user.split("用户提交：")[-1]
        return {
            "content": json.dumps(
                {
                    "passed": passed,
                    "explanation": "测试反馈：已依据提交的文字检查。",
                    "strengths": ["提交了具体回答"] if passed else [],
                    "gaps": [] if passed else ["缺少具体例子"],
                    "next_step": "继续下一知识点" if passed else "补充例子后再练习",
                    "evidence": "仅检查本次文字或图片输入，未运行代码。",
                },
                ensure_ascii=False,
            )
        }
    last = messages[-1]
    if (
        user.strip() in {"确认", "确认创建", "好的，创建吧", "可以，创建吧"}
        and any(
            "本地013日序" in str(message.get("content", ""))
            for message in messages
            if message.get("role") == "user"
        )
        and not any(
            call.get("function", {}).get("name") == "create_plans"
            for message in messages
            for call in message.get("tool_calls", [])
        )
    ):
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": "call_plan_confirmed",
                    "type": "function",
                    "function": {
                        "name": "create_plans",
                        "arguments": json.dumps(
                            {
                                "plans": [
                                    {
                                        "title": "本地模拟：读书",
                                        "start": "2026-10-20T09:00:00+08:00",
                                        "end": "2026-10-20T10:00:00+08:00",
                                        "reminder_enabled": True,
                                    }
                                ],
                                "explicit_request": True,
                                "confirm": True,
                            },
                            ensure_ascii=False,
                        ),
                    },
                }
            ],
        }
    if (
        user.strip() in {"确认", "确认创建", "好的，创建吧", "可以，创建吧"}
        and any(
            "我想学" in str(message.get("content", ""))
            for message in messages
            if message.get("role") == "user"
        )
        and not any(
            call.get("function", {}).get("name") == "create_learning_goal"
            for message in messages
            for call in message.get("tool_calls", [])
        )
    ):
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": "call_course_confirmed",
                    "type": "function",
                    "function": {
                        "name": "create_learning_goal",
                        "arguments": json.dumps(
                            {
                                "title": "学习做饭",
                                "objective": "能独立做晚餐",
                                "foundation": "",
                                "explicit_request": True,
                                "confirm": True,
                            },
                            ensure_ascii=False,
                        ),
                    },
                }
            ],
        }
    if "组合MCP" in user:
        remote = next((x["function"]["name"] for x in body.get("tools", []) if x["function"]["name"].startswith("mcp_")), None)
        if last["role"] != "tool":
            name, args = "calculate", {"expression": "2+3"}
        elif remote and not any(call.get("function", {}).get("name", "").startswith("mcp_") for message in messages for call in message.get("tool_calls", [])):
            name, args = remote, {"text": "mixed tool result 5"}
        else:
            return {"content": "组合工具已执行。"}
        return {"content": None, "tool_calls": [{"id": "call_" + name, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
    if "本地013日序" in user or "本地013技能" in user or "本地013图片来源" in user:
        used = [call["function"]["name"] for message in messages for call in message.get("tool_calls", [])]
        if "本地013日序" in user:
            if "list_plans" not in used:
                name, args = "list_plans", {"start": "2026-10-20", "end": "2026-10-21"}
            elif "create_plans" not in used:
                name, args = "create_plans", {"plans": [{"title": "本地模拟：读书", "start": "2026-10-20T09:00:00+08:00", "end": "2026-10-20T10:00:00+08:00", "reminder_enabled": True}], "explicit_request": True}
            else:
                return {"content": "本地模拟：日程工具已执行，请到日序查看实际保存的安排。"}
        elif "本地013技能" in user:
            match = re.search(r'"id": "([a-f0-9-]{36})", "name": "text-notes"', system)
            if not match:
                return {"content": "本地模拟：请先启用 text-notes 技能。"}
            key = match.group(1)
            if "load_skill" not in used:
                name, args = "load_skill", {"skill_id": key}
            elif "read_skill_file" not in used:
                name, args = "read_skill_file", {"skill_id": key, "path": "references/format.md"}
            elif "run_skill_script" not in used:
                name, args = "run_skill_script", {"skill_id": key, "path": "scripts/make_note.py", "arguments": ["本地模拟笔记", "这是本地模拟的技能产物。"]}
            else:
                return {"content": "本地模拟：请查看脚本实际返回的文件与执行记录。"}
        else:
            remote = next((tool["function"]["name"] for tool in body.get("tools", []) if "0.1.3 图片与来源验收" in tool["function"].get("description", "")), None)
            if not remote:
                return {"content": "本地模拟：请启用验收 MCP 工具。"}
            if remote in used:
                return {"content": "本地模拟：这次返回了图片和网页来源，展示在回答下方。"}
            name, args = remote, {}
        return {"content": None, "tool_calls": [{"id": "call_013_" + name, "type": "function", "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}]}
    if last["role"] == "tool":
        try:
            result = json.loads(last.get("content", "{}"))
        except json.JSONDecodeError:
            result = {}
        if isinstance(result, dict) and result.get("skipped"):
            return {"content": "好的，我们继续。"}
        if isinstance(result, dict) and result.get("state") == "candidate":
            return {"content": "这条信息需要你确认是否记住。"}
        if isinstance(result, dict) and result.get("status") == "needs_confirmation":
            if result.get("plans"):
                return {
                    "content": (
                        "我先确认一下：要把这条计划按上面的日期和时间写入日历吗？"
                    )
                }
            return {
                "content": (
                    f"我可以按「{result.get('title', '')}」建立学习路线，"
                    f"目标：{result.get('objective') or '暂不限定'}。"
                    "要我现在创建吗？"
                )
            }
        return {"content": "工具已经执行，结果已保存。"}
    if "检查记忆背景" in user:
        return {
            "content": json.dumps(
                {
                    "preference_available": "我喜欢简短的回答" in system,
                    "private_available": "我有糖尿病" in system,
                },
                ensure_ascii=False,
            )
        }
    calls = []
    if "天气" in user:
        calls.append(("get_weather", {"city": "广州", "days": 3, "country_code": "CN"}))
    if "计算" in user:
        calls.append(("calculate", {"expression": "(199 + 89) * 0.85"}))
    if "换算" in user:
        calls.append(
            ("convert_units", {"value": "5", "from_unit": "mile", "to_unit": "km"})
        )
    if "日期" in user:
        calls.append(("date_time", {"value": "2026-10-15", "add_days": 30}))
    if calls:
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": f"call_{index}",
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": json.dumps(arguments, ensure_ascii=False),
                    },
                }
                for index, (name, arguments) in enumerate(calls)
            ],
        }
    if "喜欢简短的回答" in user or "我有糖尿病" in user or "今天想吃清淡" in user:
        content = (
            "我有糖尿病"
            if "我有糖尿病" in user
            else "今天想吃清淡"
            if "今天想吃清淡" in user
            else "我喜欢简短的回答"
        )
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": "call_memory_policy",
                    "type": "function",
                    "function": {
                        "name": "remember",
                        "arguments": json.dumps(
                            {
                                "content": content,
                                "category": "fact"
                                if "糖尿病" in content
                                else "preference",
                                "evidence": content,
                                # Deliberately normal: backend must independently guard private / temporary data.
                                "risk": "normal",
                            },
                            ensure_ascii=False,
                        ),
                    },
                }
            ],
        }
    if "记住" in user:
        return {
            "content": "我先保存这条记忆。",
            "tool_calls": [
                {
                    "id": "call_memory",
                    "type": "function",
                    "function": {
                        "name": "remember",
                        "arguments": json.dumps(
                            {
                                "content": "我喜欢先看例子再学习理论",
                                "category": "preference",
                                "explicit_request": True,
                            },
                            ensure_ascii=False,
                        ),
                    },
                }
            ],
        }
    if "我想学" in user:
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": "call_course",
                    "type": "function",
                    "function": {
                        "name": "create_learning_goal",
                        "arguments": json.dumps(
                            {
                                "title": "学习做饭",
                                "objective": "能独立做晚餐",
                                "foundation": "",
                                "explicit_request": True,
                            },
                            ensure_ascii=False,
                        ),
                    },
                }
            ],
        }
    if "查资料" in user:
        return {
            "content": None,
            "tool_calls": [
                {
                    "id": "call_search",
                    "type": "function",
                    "function": {
                        "name": "web_search",
                        "arguments": '{"query":"前端官方资料"}',
                    },
                }
            ],
        }
    return {"content": "连接成功。这里是本地协议测试服务，没有调用真实模型。"}


class Handler(BaseHTTPRequestHandler):
    stream_delay = 0
    def log_message(self, *_):
        pass

    def do_POST(self):
        if self.path == "/v1/embeddings":
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            inputs = body["input"]
            if isinstance(inputs, str):
                inputs = [inputs]
            vectors = []
            for text in inputs:
                if any(term in text for term in ["精炼", "简短", "言简意赅"]):
                    vectors.append([1.0, 0.0, 0.0])
                elif any(term in text for term in ["Python", "编程"]):
                    vectors.append([0.0, 1.0, 0.0])
                else:
                    vectors.append([0.0, 0.0, 1.0])
            result = {"object": "list", "model": body["model"], "data": [
                {"object": "embedding", "index": i, "embedding": vector} for i, vector in enumerate(vectors)],
                "usage": {"prompt_tokens": 1, "total_tokens": 1}}
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result).encode())
            return
        if self.path != "/v1/chat/completions":
            self.send_error(404)
            return
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        message = reply(body)
        self.send_response(200)
        if not body.get("stream"):
            result = {
                "id": "mock-response",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": "mock-test",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", **message},
                        "finish_reason": "tool_calls"
                        if message.get("tool_calls")
                        else "stop",
                    }
                ],
                "usage": {
                    "prompt_tokens": 10,
                    "completion_tokens": 20,
                    "total_tokens": 30,
                },
            }
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(result, ensure_ascii=False).encode())
            return
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        def chunk(delta, reason=None, usage=None):
            if self.stream_delay:
                time.sleep(self.stream_delay)
            result = {
                "id": "mock-stream",
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": "mock-test",
                "choices": [{"index": 0, "delta": delta, "finish_reason": reason}],
            }
            if usage:
                result["usage"] = usage
            self.wfile.write(
                ("data: " + json.dumps(result, ensure_ascii=False) + "\n\n").encode()
            )
            self.wfile.flush()

        try:
            chunk({"role": "assistant"})
            if "reasoning_content" in message:
                chunk({"reasoning_content": message["reasoning_content"]})
            for part in re.findall(r".{1,5}", message.get("content") or "", flags=re.S):
                chunk({"content": part})
            if message.get("tool_calls"):
                chunk(
                    {
                        "tool_calls": [
                            {"index": i, **call}
                            for i, call in enumerate(message["tool_calls"])
                        ]
                    }
                )
            chunk(
                {},
                "tool_calls" if message.get("tool_calls") else "stop",
                {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
            )
            self.wfile.write(b"data: [DONE]\n\n")
        except (BrokenPipeError, ConnectionResetError):
            pass


if __name__ == "__main__":
    print("Synthetic provider at http://127.0.0.1:8877/v1", flush=True)
    ThreadingHTTPServer(("127.0.0.1", 8877), Handler).serve_forever()
