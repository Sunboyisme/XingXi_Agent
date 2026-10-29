"""Load schemas and capability rules on demand without changing tool permissions."""

import json
import re

from langchain.agents.middleware import AgentMiddleware
from langchain_core.messages import ToolMessage
from langchain_core.tools import StructuredTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import BaseModel, Field

from . import agent_prompts, context


GROUPS = (
    ("天气", {"get_weather"}),
    ("计算、日期、单位", {"calculate", "date_time", "convert_units"}),
    ("搜索与网页", {"web_search", "read_url"}),
    ("日历与提醒", {"list_plans", "create_plans", "update_plan", "delete_plan", "delete_plans", "action_plan"}),
    ("独立待办", {"list_todos", "create_todo", "update_todo", "action_todo"}),
    ("记忆与聊天历史", {"remember", "search_memories", "search_conversation_history", "search_project_history"}),
    ("文件读取", {"list_files", "read_file", "search_file", "read_local_file", "scan_local_folder"}),
    ("生成文件与图片", {"create_document", "create_spreadsheet", "create_text_file", "generate_image"}),
    ("学习路线", {"learning_goals", "create_learning_goal"}),
    ("技能", {"load_skill", "read_skill_file", "run_skill_script"}),
    ("任务与原文", {"read_context_record", "read_task_result"}),
)

# Load prerequisites together, so the model can perform the required read before
# a write without another discovery round. No prerequisite executes here.
DEPENDENCIES = {
    "list_plans": {"date_time"},
    "create_plans": {"list_plans", "date_time"},
    "update_plan": {"list_plans", "date_time"},
    "delete_plan": {"list_plans", "date_time"},
    "delete_plans": {"list_plans", "date_time"},
    "action_plan": {"list_plans", "date_time"},
    "create_todo": {"list_todos"},
    "update_todo": {"list_todos"},
    "action_todo": {"list_todos"},
    "remember": {"search_memories"},
    "read_file": {"list_files", "search_file"},
    "search_file": {"list_files", "read_file"},
    "read_local_file": {"scan_local_folder"},
    "create_learning_goal": {"learning_goals"},
    "read_skill_file": {"load_skill"},
    "run_skill_script": {"load_skill", "read_skill_file"},
}


class DiscoveryQuery(BaseModel):
    query: str = Field(default="", max_length=1000, description="工具用途、名称或服务名；留空分页浏览目录")
    names: list[str] = Field(default_factory=list, max_length=32, description="精确工具名称，来自目录或发现结果")
    offset: int = Field(default=0, ge=0, description="继续使用上次返回的next_offset")
    limit: int = Field(default=6, ge=1, le=8)


def schema_tokens(tools):
    """Use the actual exposed schemas for both initial and per-round budgets."""
    if not tools:
        return 0
    schemas = [convert_to_openai_tool(tool) for tool in tools]
    return context.tokens(json.dumps(schemas, ensure_ascii=False))


class ToolDiscovery(AgentMiddleware):
    def __init__(self, tools, *, required=()):
        self.available = {tool.name: tool for tool in sorted(tools, key=lambda tool: tool.name)}
        self.loaded = []
        self.advertised = set()
        self._load({"read_context_record", *required})
        # Async discovery runs in the same event loop as the middleware; tool
        # execution can remain parallel without a worker mutating this state.
        self.discovery_tool = StructuredTool.from_function(
            coroutine=self.discover,
            name="discover_tools",
            description="按名称、用途或服务发现并加载本轮可用工具；留空分页浏览。只加载定义，不执行操作。未命中可换词或浏览，不能据此断言没有能力。",
            args_schema=DiscoveryQuery,
        )

    def _load(self, names):
        pending = set(names)
        added = []
        while pending:
            name = min(pending)
            pending.remove(name)
            if name not in self.available or name in self.loaded:
                continue
            self.loaded.append(name)
            added.append(name)
            pending.update(DEPENDENCIES.get(name, set()))
        return added

    def exposed_tools(self):
        # Append newly discovered definitions; never reshuffle a loaded prefix
        # inside this run or unload a tool the model may still need.
        return [self.discovery_tool, *(self.available[name] for name in self.loaded)]

    @property
    def registered_tools(self):
        return [self.discovery_tool, *self.available.values()]

    def catalog_context(self):
        """Builtin labels and service counts stay small; MCP details are searchable."""
        builtin = {name for name, tool in self.available.items()
                   if (tool.metadata or {}).get("source") != "mcp"}
        lines = []
        assigned = set()
        for label, names in GROUPS:
            selected = sorted(names & builtin)
            if selected:
                lines.append(label + "：" + "、".join(selected))
                assigned.update(selected)
        if remaining := sorted(builtin - assigned):
            lines.append("其他内置：" + "、".join(remaining))
        servers = {}
        for tool in self.available.values():
            metadata = tool.metadata or {}
            if metadata.get("source") == "mcp":
                label = metadata.get("source_label") or "MCP"
                servers[label] = servers.get(label, 0) + 1
        lines.extend(f"MCP服务 {label}：{count}个工具，可按服务名或用途发现"
                     for label, count in sorted(servers.items()))
        return "工具能力目录（仅含已启用且可用的工具；详细参数按需加载）：\n" + "\n".join(lines)

    def _entry(self, name):
        tool = self.available[name]
        metadata = tool.metadata or {}
        return {"name": name, "label": metadata.get("catalog_name", name),
                "service": metadata.get("source_label", "内置"),
                "description": (metadata.get("catalog_description") or tool.description)[:240]}

    def _score(self, name, query):
        entry = self._entry(name)
        # Search the full description locally; shortening a discovery receipt
        # must not hide a remote capability from search.
        metadata = self.available[name].metadata or {}
        text = " ".join([name, entry["label"], entry["service"],
                         self.available[name].description,
                         metadata.get("catalog_description", "")]).casefold()
        if name.casefold() == query or entry["label"].casefold() == query:
            return 10000
        if query in text:
            return 1000
        words = re.findall(r"[a-z0-9_]+|[\u4e00-\u9fff]", query)
        return sum(len(word) for word in words if word in text)

    async def discover(self, query="", names=None, offset=0, limit=6):
        query = query.strip().casefold()
        requested = list(dict.fromkeys(names or []))
        missing = []
        if requested:
            candidates = []
            for name in requested:
                if name in self.available:
                    candidates.append(name)
                else:
                    missing.append(name)
            matched = bool(candidates)
            if not matched:
                candidates = list(self.available)
        elif query:
            ranked = [(self._score(name, query), name) for name in self.available]
            candidates = [name for score, name in sorted(ranked, key=lambda item: (-item[0], item[1])) if score]
            matched = bool(candidates)
            if not matched:
                candidates = list(self.available)
        else:
            candidates, matched = list(self.available), False
        selected = candidates[offset:offset + limit]
        added = self._load(selected) if matched else []
        end = offset + len(selected)
        result = {"items": [self._entry(name) for name in selected],
                  "loaded": selected if matched else [], "also_loaded": [name for name in added if name not in selected],
                  "total": len(candidates), "next_offset": end if end < len(candidates) else None,
                  "not_found": missing}
        if matched and selected:
            result["message"] = "工具已加载；下一轮按完整定义及对应规则调用，发现本身未执行任何业务操作。"
        else:
            result["message"] = "以下为可用工具目录；可用names精确加载、换用途搜索或按next_offset继续浏览；未命中不代表不可用。"
        return json.dumps(result, ensure_ascii=False, separators=(",", ":"))

    async def awrap_model_call(self, request, handler):
        tools = self.exposed_tools()
        self.advertised = {tool.name for tool in tools}
        system_message = request.system_message
        if system_message and isinstance(system_message.content, str):
            system_message = system_message.model_copy(update={
                "content": agent_prompts.with_capabilities(system_message.content, set(self.loaded)),
            })
        return await handler(request.override(tools=tools, system_message=system_message))

    async def awrap_tool_call(self, request, handler):
        name = request.tool_call["name"]
        if name not in self.advertised:
            # Even a guessed tool name or discover+execute parallel batch must
            # see the schema and capability rules before the operation can run.
            known = name in self.available
            if known:
                self._load({name})
            return ToolMessage(
                content=json.dumps({"error": "本次工具尚未向模型加载，未执行。"
                                    + ("下一轮先核对已加载的完整定义与规则，再修正调用。" if known else "请使用discover_tools查找真实可用工具。"),
                                    "not_executed": True, "retryable": True}, ensure_ascii=False),
                tool_call_id=request.tool_call["id"], name=name, status="error",
            )
        return await handler(request)
