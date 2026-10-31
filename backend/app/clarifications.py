"""Ask once, stop generation, and resume the exact request the user answered."""

from typing import Annotated

from fastapi import HTTPException
from langchain_core.tools import tool
from pydantic import Field, ValidationError
from sqlalchemy import select

from .clarification_models import ClarificationRead, QuestionInput
from .config import PROFILE_ID
from .db import MESSAGE_ORDER, ComplexTask, Message, Run, uid
from .task_context import TaskControl


class Requested(TaskControl):
    def __init__(self, request):
        self.request = request
        super().__init__(text(request))


def create(questions):
    return ClarificationRead(request_id=uid(), questions=[{
        "id": f"q{index + 1}", "question": question.question, "multiple": question.multiple,
        "options": [{"id": f"o{number + 1}", **option.model_dump()} for number, option in enumerate(question.options)],
    } for index, question in enumerate(questions)]).model_dump()


def text(request):
    lines = ["需要你补充以下信息，选择后我会继续："]
    for question in request["questions"]:
        lines.extend(["", question["question"]])
        lines.extend(f"{index + 1}. {option['label']}" + (f"：{option['description']}" if option.get("description") else "")
                     for index, option in enumerate(question["options"]))
        lines.append(f"{len(question['options']) + 1}. 其他，我来填写")
    return "\n".join(lines)


def question_tool():
    @tool
    async def ask_user_question(questions: Annotated[list[QuestionInput], Field(min_length=1, max_length=3)]) -> str:
        """缺少影响结果的关键信息时向用户提问，随后停止本轮生成，收到回答再继续。一次1–3题，每题2–5个清晰选项，可单选或多选；其他自由回答入口自动添加，不要把其他列入options。不能反复询问已有答案或让用户批准已明确授权的常规操作。"""
        raise Requested(create(questions))
    return ask_user_question


def read(message, *, latest_id):
    value = (message.provider_context or {}).get("clarification")
    if not isinstance(value, dict):
        return None
    try:
        result = ClarificationRead.model_validate(value).model_dump()
    except ValidationError:
        return None
    result["source_message_id"] = message.id
    if result["state"] == "pending" and latest_id != message.id:
        result["state"] = "superseded"
    return result


def resolve(db, conversation_id, response):
    source = db.get(Message, response.source_message_id)
    latest_id = db.scalar(select(Message.id).where(Message.conversation_id == conversation_id,
        Message.profile_id == PROFILE_ID).order_by(Message.created_at.desc(), MESSAGE_ORDER.desc()).limit(1))
    if not source or source.profile_id != PROFILE_ID or source.conversation_id != conversation_id or source.role != "assistant":
        raise HTTPException(404, "没有找到这组问题")
    request = read(source, latest_id=latest_id)
    if not request or request["state"] != "pending" or request["request_id"] != response.request_id:
        raise HTTPException(409, "这组问题已回答或对话已有更新，请根据最新消息继续")
    answers = {answer.question_id: answer for answer in response.answers}
    if len(answers) != len(response.answers) or set(answers) != {question["id"] for question in request["questions"]}:
        raise HTTPException(400, "请逐项回答本次问题，不能重复或遗漏")
    lines, selected, normalized = [], [], []
    for question in request["questions"]:
        answer = answers[question["id"]]
        options = {option["id"]: option for option in question["options"]}
        chosen = set(answer.option_ids)
        custom = answer.custom_text.strip()
        if (len(chosen) != len(answer.option_ids) or not chosen <= options.keys() | {"other"}
                or (not question["multiple"] and len(chosen) != 1)
                or ("other" in chosen) != bool(custom)):
            raise HTTPException(400, "请核对所选项；选择其他时填写自己的回答，单选问题只能选择一项")
        values = [option["label"] + (f"：{option['description']}" if option.get("description") else "")
                  for option in question["options"] if option["id"] in chosen]
        if custom:
            values.append(custom)
        content = question["question"] + "：" + "；".join(values)
        lines.append("- " + content)
        selected.append({"number": question["id"], "content": content})
        normalized.append({**answer.model_dump(), "custom_text": custom})
    source_run = db.get(Run, source.run_id) if source.run_id else None
    task = db.get(ComplexTask, source_run.task_id) if source_run and source_run.task_id else None
    if task and (task.conversation_id != conversation_id or task.profile_id != PROFILE_ID or task.status != "waiting_input"):
        raise HTTPException(409, "任务状态已更新，请根据最新任务继续")
    context = {"source_message_id": source.id, "request_id": request["request_id"],
               "selected": selected, "answers": normalized, "task_id": task.id if task else None}
    return source, request, "补充回答：\n" + "\n".join(lines), context


def accept(db, source, request, response, message):
    source.provider_context = {**(source.provider_context or {}), "clarification": {
        **request, "state": "answered", "answers": response["answers"], "answer_message_id": message.id,
    }}
    message.provider_context = {**(message.provider_context or {}), "clarification_response": response}
    if response.get("task_id"):
        task = db.get(ComplexTask, response["task_id"])
        task.pending_message_ids = list(dict.fromkeys([*task.pending_message_ids, message.id]))
        message.provider_context = {**message.provider_context,
            "task_route": {"task_id": task.id, "decision": "supplement"}}


def choice_context(db, message):
    response = (message.provider_context or {}).get("clarification_response")
    if not response:
        return None
    source = db.get(Message, response.get("source_message_id"))
    if not source or source.profile_id != PROFILE_ID or source.conversation_id != message.conversation_id:
        return None
    request = (source.provider_context or {}).get("clarification") or {}
    if request.get("request_id") != response.get("request_id") or request.get("answer_message_id") != message.id:
        return None
    from .followups import prior_context
    return {"source_message_id": source.id, "source_created_at": source.created_at,
            "selected": response["selected"], "context": prior_context(db, message)}
