"""Bound cumulative generation work, including routing, repairs and summaries."""

import json
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from .task_context import ModelBudgetExceeded


@dataclass
class Budget:
    requests: int = 0
    input_tokens: int = 0
    max_requests: int = 24
    max_input_tokens: int = 160000

    def reserve(self, messages, options):
        from .context import tokens
        from .loop_compaction import message_cost

        incoming = sum(message_cost(message) for message in messages)
        incoming += tokens(json.dumps(options.get("tools", []), ensure_ascii=False))
        if self.requests >= self.max_requests or self.input_tokens + incoming > self.max_input_tokens:
            raise ModelBudgetExceeded("本轮模型调用已达到用量保护上限，已停止继续请求；已有操作和成果保留。请缩小剩余事项范围后继续。")
        self.requests += 1
        self.input_tokens += incoming


current: ContextVar[Budget | None] = ContextVar("model_budget", default=None)


@contextmanager
def scope():
    token = current.set(Budget())
    try:
        yield
    finally:
        current.reset(token)


def calendar_limits():
    budget = current.get()
    if budget:
        budget.max_requests = min(budget.max_requests, 10)
        budget.max_input_tokens = min(budget.max_input_tokens, 60000)


def reserve(messages, options):
    budget = current.get()
    if budget:
        budget.reserve(messages, options)
