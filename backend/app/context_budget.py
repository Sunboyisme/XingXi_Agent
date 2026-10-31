"""Account for every model round, including tool results and reasoning."""
from langchain.agents.middleware import AgentMiddleware

from . import context, provider
from .loop_compaction import LoopCompactor, message_cost
from .runs import emit
from .tool_discovery import schema_tokens


class ContextBudget(AgentMiddleware):
    def __init__(self, run_id, config, tool_tokens=0):
        # Accept the old initial estimate for callers using the previous
        # signature; every real request is now measured from its exposed tools.
        self.run_id, self.config = run_id, config
        self.compactor = LoopCompactor(run_id, config)

    async def awrap_model_call(self, request, handler):
        # Discovery can add schemas between model rounds. Count the exposed
        # request, not the complete registry or a stale initial estimate.
        tool_tokens = schema_tokens(request.tools)
        system_message = request.system_message
        # Keep application context in the system role. Appending it to a human
        # message changes the user's utterance and breaks follow-up semantics.
        overhead = tool_tokens + (message_cost(system_message) if system_message else 0)
        last_user = max((i for i, message in enumerate(request.messages) if message.type == "human"), default=0)
        active_input = message_cost(request.messages[last_user]) if request.messages else 0
        total, reserve, hard = context.working_limits(self.config, required=overhead + active_input + context.SUMMARY_TOKENS)
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
        if used > hard:
            # Necessary active tool results can use physical capacity, without
            # bringing discarded old conversation turns back into the request.
            total, reserve, hard = context.working_limits(self.config, required=used)
        emit(self.run_id, "context", {"status": "usage", "used_tokens": used,
             "limit_tokens": total, "reserved_tokens": reserve, "estimated": True,
             "capacity_tokens": context.limits(self.config)[0],
             "tool_tokens": tool_tokens, "loaded_tools": len(request.tools),
             "provider_id": self.config.get("provider_id"), "model_name": self.config.get("model_name")})
        if used > hard:
            raise provider.ConfigurationError("自动摘要后，当前步骤必须保留的提示、工具信息与消息仍超过上下文额度。已有操作结果保留；请在连接与设置中调整当前模型的上下文大小，或缩小当前步骤范围。")
        # Missing outputs are reconciled by the task planner. Forcing a write
        # here can duplicate an existing plan, and some providers reject it.
        return await handler(request.override(messages=messages, system_message=system_message))
