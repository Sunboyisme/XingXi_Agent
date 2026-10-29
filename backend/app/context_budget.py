"""Account for every model round, including tool results and reasoning."""
from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import SystemMessage
from openai import BadRequestError

from . import agent_prompts, context, provider, task_context
from .db import Session, TaskStep
from .loop_compaction import LoopCompactor, message_cost
from .runs import emit
from .tool_discovery import schema_tokens


class ContextBudget(AgentMiddleware):
    def __init__(self, run_id, config, tool_tokens=0):
        # Accept the old initial estimate for callers using the previous
        # signature; every real request is now measured from its exposed tools.
        self.run_id, self.config = run_id, config
        self.first = True
        self.compactor = LoopCompactor(run_id, config)

    async def awrap_model_call(self, request, handler):
        total, reserve, hard = context.limits(self.config)
        # Discovery can add schemas between model rounds. Count the exposed
        # request, not the complete registry or a stale initial estimate.
        tool_tokens = schema_tokens(request.tools)
        system_message, runtime = request.system_message, ""
        if (system_message and isinstance(system_message.content, str)
                and any(message.type == "human" for message in request.messages)):
            fixed, runtime = agent_prompts.split_runtime(system_message.content)
            system_message = system_message.model_copy(update={"content": fixed})
        overhead = (tool_tokens + (message_cost(system_message) if system_message else 0)
                    + context.tokens(runtime))
        messages = await self.compactor.prepare(list(request.messages), overhead, hard)
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
             "tool_tokens": tool_tokens, "loaded_tools": len(request.tools),
             "provider_id": self.config.get("provider_id"), "model_name": self.config.get("model_name")})
        if used > hard:
            raise provider.ConfigurationError("自动摘要后，当前步骤必须保留的提示、工具信息与消息仍超过上下文额度。已有操作结果保留；请在连接与设置中调整当前模型的上下文大小，或缩小当前步骤范围。")
        # Add application data only to the active request's human message.
        # Earlier messages, durable history and multimodal parts stay intact.
        # The compactor sees the original user message, never this derived data.
        if runtime:
            messages = list(messages)
            index = max(i for i, message in enumerate(messages) if message.type == "human")
            source = messages[index]
            content = source.content + runtime if isinstance(source.content, str) else [
                *source.content, {"type": "text", "text": runtime},
            ]
            messages[index] = source.model_copy(update={"content": content})
        overrides = {"messages": messages, "system_message": system_message}
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
                system_message=SystemMessage(content=(system_message.content if system_message else "") + guidance)))
