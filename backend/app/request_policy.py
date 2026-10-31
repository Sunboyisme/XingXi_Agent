"""Local routing and reasoning policies, without another classifier call."""

import re


def needs_task_router(text, *, has_tasks=False, awaiting_input=False):
    """Keep persistent work and ambiguous task follow-ups on the task router."""
    if awaiting_input:
        return True
    if has_tasks and re.search(
        r"继续|接着|重做|重新|上[个次一]|刚才|之前|原来|这个任务|当前任务|"
        r"修改|调整|补充|取消|停止|暂停|放弃|进度|成果",
        text,
    ):
        return True
    if re.search(
        r"分阶段|分步骤|多阶段|拆[分解].{0,8}任务|任务.{0,8}(?:进度|拆[分解])|"
        r"持续(?:推进|执行|跟进)|后台(?:执行|任务)|断点|可恢复|"
        r"完成.{0,12}(?:整个|全部|整套|项目)|全流程|端到端",
        text,
    ):
        return True
    formats = re.findall(
        r"(?<![a-z0-9])(?:word|docx|pdf|excel|xlsx|csv|markdown|md|txt|json|pptx?)(?![a-z0-9])",
        text,
        re.I,
    )
    aliases = {"word": "docx", "excel": "xlsx", "markdown": "md", "ppt": "pptx"}
    formats = {aliases.get(value.casefold(), value.casefold()) for value in formats}
    if "文档" in text and not formats.intersection({"docx", "pdf", "txt", "md"}):
        formats.add("docx")
    if "表格" in text and not formats.intersection({"xlsx", "csv"}):
        formats.add("xlsx")
    if "图片" in text:
        formats.add("image")
    if re.search(r"生成|制作|导出|保存|交付|输出|做成|写成|撰写", text):
        if len(formats) > 1:
            return True
        if re.search(r"多份|[两三四五六七八九十\d]+份|各一份|分别|一整套|批量", text):
            return True
        if re.search(
            r"先.{1,300}(?:再|然后|最后)|(?:调研|研究|收集|分析).{0,80}(?:报告|方案|项目)",
            text,
            re.S,
        ):
            return True
    return len(text) > 2000 and bool(re.search(r"帮我|完成|执行|制作|生成|整理", text))


def thinking_config(config, *, purpose="chat", text=""):
    """Manual answer choices win; auxiliary work has its own reasoning policy."""
    value = dict(config)
    mode = value.get("thinking_control", "none")
    levels = value.get("reasoning_efforts", [])
    auxiliary = purpose in {"task_routing", "context_compaction", "task_review"}
    if not auxiliary and value.get("thinking_explicit", True):
        return value
    deliberate = purpose in {"task_planning", "task_execution"} or bool(
        re.search(
            r"深入(?:分析|思考)|仔细(?:分析|推理)|复杂(?:推理|分析)|证明|推导|"
            r"权衡|多方案|规划|架构设计|系统设计|根因|因果分析",
            text,
        )
    )
    enabled = mode == "always" or (not auxiliary and deliberate and mode != "none")
    value["thinking_enabled"] = enabled
    if not enabled:
        value["reasoning_effort"] = None
    elif levels:
        order = ("minimal", "low", "medium", "high", "xhigh", "max", "ultra")
        supported = [level for level in order if level in levels]
        if deliberate and not auxiliary and "medium" in supported:
            value["reasoning_effort"] = "medium"
        elif deliberate and not auxiliary and "high" in supported:
            value["reasoning_effort"] = "high"
        else:
            value["reasoning_effort"] = supported[0] if supported else None
    return value
