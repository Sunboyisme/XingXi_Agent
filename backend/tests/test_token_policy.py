"""Cost/continuation regressions. No live provider requests are needed."""

from copy import deepcopy

import pytest
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage
from sqlalchemy import select

from app import (
    agent_prompts,
    context,
    db,
    model_profiles,
    prompt_cache,
    provider,
    request_policy,
    usage_cost,
)
from .test_chat_context import seed


@pytest.mark.parametrize(
    "text,expected",
    [
        ("解释一下 RAG 是什么", False),
        ("帮我查询明天天气", False),
        ("搜索资料，告诉我有哪些选择", False),
        ("生成一份Word文档", False),
        ("生成Word和PDF各一份", True),
        ("先收集资料再制作分析报告", True),
        ("把整个项目分阶段执行并保存任务进度", True),
    ],
)
def test_ordinary_requests_do_not_need_a_separate_model_router(text, expected):
    assert request_policy.needs_task_router(text) is expected


def test_free_text_answers_and_existing_task_amendments_still_get_routed():
    assert request_policy.needs_task_router(
        "电商行业，零基础", has_tasks=True, awaiting_input=True
    )
    assert request_policy.needs_task_router("修改上次的报告", has_tasks=True)
    assert not request_policy.needs_task_router("解释一下 RAG", has_tasks=True)


def test_manual_reasoning_is_kept_for_answers_but_not_auxiliary_routing():
    config = {
        "thinking_control": "thinking",
        "thinking_enabled": True,
        "thinking_explicit": True,
        "reasoning_effort": "high",
        "reasoning_efforts": ["low", "high"],
    }
    assert request_policy.thinking_config(config) == config
    routed = request_policy.thinking_config(config, purpose="task_routing")
    assert routed["thinking_enabled"] is False and routed["reasoning_effort"] is None
    assert config["thinking_enabled"] is True


def test_automatic_reasoning_and_mandatory_thinking_use_task_complexity():
    config = {
        "thinking_control": "thinking",
        "thinking_explicit": False,
        "thinking_enabled": False,
        "reasoning_efforts": ["low", "medium", "high"],
    }
    assert not request_policy.thinking_config(config)["thinking_enabled"]
    task = request_policy.thinking_config(config, purpose="task_execution")
    assert task["thinking_enabled"] and task["reasoning_effort"] == "medium"
    forced = request_policy.thinking_config(
        {**config, "thinking_control": "always"}, purpose="context_compaction"
    )
    assert forced["thinking_enabled"] and forced["reasoning_effort"] == "low"
    manual_off = {**config, "thinking_enabled": False, "thinking_explicit": True}
    assert not request_policy.thinking_config(manual_off, purpose="task_execution")[
        "thinking_enabled"
    ]


def test_auto_choice_survives_snapshot_reconstruction():
    selection = model_profiles.saved_selection(
        {
            "provider_id": "custom",
            "model_name": "example",
            "thinking_explicit": False,
            "thinking_enabled": True,
            "reasoning_effort": "medium",
        }
    )
    assert selection.thinking_enabled is None and selection.reasoning_effort is None


def test_working_budget_is_independent_of_capacity_and_can_fit_large_active_input():
    config = {"context_tokens": 500_000}
    assert context.working_limits(config)[2] == 32_768
    assert (
        context.working_limits(
            {**config, "working_tokens": context.TASK_WORKING_TOKENS}
        )[2]
        == 65_536
    )
    assert context.working_limits(config, required=90_000)[2] == 90_000
    assert context.working_limits({"context_tokens": 4096}, required=90_000)[2] == 3072
    assert context.limits(config)[0] == 500_000


@pytest.mark.asyncio
async def test_large_capacity_still_summarizes_old_history_without_deleting_originals(
    configured, monkeypatch
):
    run_id, conversation_id, config = seed(180)
    config["context_tokens"] = 500_000
    purposes = []

    class Summarizer:
        async def ainvoke(self, messages):
            return AIMessage(
                content="用户约定仍有效，待办未完成；需要细节时检索原始消息。"
            )

    def summary_model(config, *, usage_purpose=None):
        purposes.append(usage_purpose)
        return Summarizer()

    monkeypatch.setattr(provider, "model", summary_model)
    summary, kept = await context.prepare(run_id, conversation_id, config)
    assert summary and len(kept) == context.RECENT_MESSAGES
    assert purposes == ["context_compaction"]
    with db.Session() as session:
        assert (
            len(
                list(
                    session.scalars(
                        select(db.Message).where(
                            db.Message.conversation_id == conversation_id
                        )
                    )
                )
            )
            == 180
        )


def test_official_cache_hints_preserve_the_prompt_and_reasoning_payload():
    prompt = "固定规则与目录" + agent_prompts.CAPABILITY_MARKER + "已加载规则"
    prompt += (
        agent_prompts.RUNTIME_MARKER
        + "实际背景"
        + agent_prompts.CLOCK_MARKER
        + "当前时间"
    )
    llm = provider.CompatibleChatModel(
        model="gpt-5.6",
        api_key="synthetic-key",
        base_url="https://api.openai.com/v1",
        use_responses_api=False,
        extra_body={"custom_option": True},
    )
    payload = llm._get_request_payload(
        [
            SystemMessage(content=prompt),
            HumanMessage(content="问题"),
            AIMessage(
                content="工具调用前正文",
                additional_kwargs={"reasoning_content": "接口所需思考"},
            ),
        ]
    )
    blocks = payload["messages"][0]["content"]
    assert "".join(block["text"] for block in blocks) == prompt
    assert blocks[0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
    assert "prompt_cache_breakpoint" not in blocks[-1]
    assert payload["messages"][-1]["reasoning_content"] == "接口所需思考"
    assert payload["extra_body"]["custom_option"] is True
    assert payload["extra_body"]["prompt_cache_key"].startswith("xiaoxi-")


def test_cache_keys_are_stable_and_compatible_endpoints_receive_no_extra_fields():
    raw = {"model": "gpt-5.4", "messages": [{"role": "system", "content": "固定指令"}]}
    original = deepcopy(raw)
    first = prompt_cache.prepare(raw, "https://api.openai.com/v1", scope="task_routing")
    second = prompt_cache.prepare(
        deepcopy(raw), "https://api.openai.com/v1", scope="task_routing"
    )
    assert (
        first["extra_body"]["prompt_cache_key"]
        == second["extra_body"]["prompt_cache_key"]
    )
    assert first["messages"] == raw["messages"]
    assert prompt_cache.prepare(raw, "https://example.com/v1") == original
    assert raw == original


def test_new_cache_write_usage_can_be_accounted_for():
    value = usage_cost.usage_values(
        {
            "usage": {
                "prompt_tokens": 1000,
                "completion_tokens": 50,
                "prompt_tokens_details": {
                    "cached_tokens": 600,
                    "cache_write_tokens": 300,
                },
            }
        },
        "tokens",
    )
    assert value["input_tokens"] == 1000 and value["output_tokens"] == 50
    assert value["cached_tokens"] == 600 and value["cache_write_tokens"] == 300
