"""Account for every model round, including tool results and reasoning."""
import json

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage
from openai import BadRequestError

from . import context, provider, task_context
from .db import Session, TaskStep
from .runs import emit


def message_cost(message):
    content = message.content
    if isinstance(content, list):
        cost = sum(1024 if isinstance(part, dict) and part.get("type") in {"image_url", "image"}
                   else context.tokens(json.dumps(part, ensure_ascii=False)) for part in content)
    else:
        cost = context.tokens(str(content))
    return cost + context.tokens(json.dumps(getattr(message, "tool_calls", []), ensure_ascii=False)) + context.tokens(context.reasoning_text(message)) + 8


class ContextBudget(AgentMiddleware):
    def __init__(self, run_id, config, tool_tokens):
        self.run_id, self.config, self.tool_tokens = run_id, config, tool_tokens
        self.first = True

    async def awrap_model_call(self, request, handler):
        total, reserve, hard = context.limits(self.config)
        overhead = self.tool_tokens + (message_cost(request.system_message) if request.system_message else 0)
        messages = list(request.messages)
        used = overhead + sum(map(message_cost, messages))
        # Drop only complete old conversation turns. Never split the active
        # human request or a tool-call/result group, or alter durable history.
        last_user = max((i for i, message in enumerate(messages) if message.type == "human"), default=0)
        removed = 0
        while used > hard and removed < last_user:
            used -= message_cost(messages[removed])
            removed += 1
        if removed:
            messages = messages[removed:]
            while messages and messages[0].type != "human":
                used -= message_cost(messages.pop(0))
            emit(self.run_id, "context", {"status": "degraded", "text": "本轮历史已按上下文额度缩减，原始消息仍保留。"})
        emit(self.run_id, "context", {"status": "usage", "used_tokens": used,
             "limit_tokens": total, "reserved_tokens": reserve, "estimated": True,
             "provider_id": self.config.get("provider_id"), "model_name": self.config.get("model_name")})
        if used > hard:
            raise provider.ConfigurationError("当前步骤的提示、工具结果与消息超过上下文额度。已有操作结果保留；请在连接与设置中增大该模型的上下文大小后继续，或将当前步骤拆小。")
        overrides = {"messages": messages}
        execution = task_context.current.get()
        if self.first and execution:
            with Session() as db:
                step = db.get(TaskStep, execution.step_id)
                names = {tool.name for tool in request.tools if hasattr(tool, "name")}
                required = [name for name in step.tools if name in names] if step else []
                if step and step.output.get("validation_missing") and required:
                    # A prose-only attempt failed validation. Require an actual
                    # tool call on the repair's first round; guards still apply.
                    overrides["tool_choice"] = required[0] if len(required) == 1 else "required"
        self.first = False
        try:
            return await handler(request.override(**overrides))
        except BadRequestError as error:
            # Some reasoning endpoints only accept automatic tool selection.
            # Retry only an explicit tool_choice rejection, before any tool ran.
            if "tool_choice" not in overrides or not any(word in str(error).lower() for word in ("tool_choice", "tool choice")):
                raise
            guidance = "\n当前步骤必须取得实际工具结果；上次只有文字未通过核对。请先调用当前步骤要求的工具，不能用文字声明代替。"
            return await handler(request.override(messages=messages, tool_choice="auto",
                system_message=SystemMessage(content=(request.system_message.content if request.system_message else "") + guidance)))
