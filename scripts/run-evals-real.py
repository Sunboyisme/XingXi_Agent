"""Run the authored evals against the real preview model, in isolated databases.

Never reads preview conversations or writes preview settings / credentials.
Results include complete API responses, durable data, and explicit UI limitations.
"""
from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import sqlite3
import sys
import time
from datetime import datetime
from zoneinfo import ZoneInfo

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[1]
EVALS = ROOT / "docs/evals"
MATERIAL = EVALS / "素材"


def catalog():
    cases = {}
    for file in sorted(EVALS.glob("0[1-8]-*.md")):
        source = file.read_text(encoding="utf-8")
        parts = re.split(r"(?m)^### (\d{3}) (.+)\n", source)
        for i in range(1, len(parts), 3):
            number, title, body = int(parts[i]), parts[i + 1], parts[i + 2]
            prompts = re.findall(r"```text\s*\n(.*?)\n```", body, re.S)
            prompts = [p for p in prompts if p.strip() and not re.fullmatch(r"[A-Z]:\\[^\n]+", p)]
            checks = re.findall(r"(?m)^- \[[ x]\] (.+)", body)
            expected = re.findall(r"\*\*预期[：:]\*\*\s*(.+)", body)
            cases[number] = dict(id=number, title=title.strip(), chapter=int(file.name[:2]),
                                 source=file.name, prompts=prompts, expected=expected + checks,
                                 specification=body.strip())
    assert sorted(cases) == list(range(1, 171)), "Expected exactly 001–170"
    return cases


class Runner:
    def __init__(self, args):
        self.args = args
        self.cases = catalog()
        self.output = Path(args.output).resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.runtime = self.output / f"runtime-{args.chapter:02}"
        os.environ["BAI_DATA_DIR"] = str(self.runtime)
        os.environ.pop("BAI_DATABASE_URL", None)
        sys.path.insert(0, str(ROOT / "backend"))
        from app import config, db, model_profiles
        import keyring
        preview = (ROOT / ".local-data/preview-runtime").resolve()
        self.preview = preview
        vault = "BaiAgent-" + hashlib.sha256(str(preview).encode()).hexdigest()[:16]
        self.keys = {}
        self.overrides = {}

        def get_secret(name):
            if name in self.overrides:
                return self.overrides[name]
            if name not in self.keys:
                self.keys[name] = keyring.get_password(vault, name) or ""
            return self.keys[name]

        def put_secret(name, value):
            if value is not None:
                self.overrides[name] = value

        config.secret_get = get_secret
        config.secret_set = put_secret
        self.db, self.config = db, config
        self.get_secret = get_secret
        db.migrate()
        with sqlite3.connect((preview / "bai.sqlite").as_uri() + "?mode=ro", uri=True) as c:
            c.row_factory = sqlite3.Row
            saved = dict(c.execute("SELECT * FROM settings WHERE id='local'").fetchone())
            channel = c.execute("SELECT data FROM wechat_state WHERE id='local'").fetchone()
            wechat_bound = bool(json.loads(channel[0]).get("account_id")) if channel else False
        self.original_settings = saved
        with db.Session() as session:
            settings = session.get(db.Settings, "local")
            for name, value in saved.items():
                if name == "id":
                    continue
                if name in {"model_providers", "embedding_config", "image_generation_config"}:
                    value = json.loads(value)
                setattr(settings, name, value)
            settings.knowledge_enabled = False
            settings.memory_mode = "auto"
            session.commit()
            self.selection = model_profiles.resolve(settings)
            self.profiles = model_profiles.profiles(settings)
        if not get_secret(model_profiles.secret_ref(self.selection["provider_id"])):
            raise RuntimeError("Preview model credential unavailable")
        from app import main
        self.main = main
        self.context = {}
        self.rows = []
        self.current = None
        self.last_chat = None
        self.metadata = {
            "started_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
            "model": self.selection, "chapter": args.chapter,
            "scope": "真实 API + 当前工作区实际后端；隔离数据库；原生窗口及手机收件未验证",
            "credentials": "只从 preview-runtime 对应系统凭据读取；不写入文件、不修改源凭据",
            "search_configured": bool(get_secret("search")),
            "embedding_configured": bool(json.loads(saved["embedding_config"])),
            "image_generation_configured": bool(json.loads(saved["image_generation_config"])),
            "wechat_bound": wechat_bound,
            "wechat_credential_available": bool(get_secret("wechat_token")),
            "preview_database_stat_before": self.db_stat(preview / "bai.sqlite"),
        }
        (self.output / f"metadata-{args.chapter:02}.json").write_text(
            json.dumps(self.metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    @staticmethod
    def db_stat(path):
        stat = path.stat()
        return {"size": stat.st_size, "mtime_ns": stat.st_mtime_ns}

    def clean(self, value):
        raw = json.dumps(value, ensure_ascii=False, default=str)
        for secret in {*self.keys.values(), *self.overrides.values()}:
            if secret and len(secret) >= 10:
                raw = raw.replace(secret, "[REDACTED]")
        return json.loads(raw)

    async def api(self, method, path, data=None, **kwargs):
        payload = {"json": data} if data is not None else {}
        response = await self.client.request(method, "/api/v1" + path,
                                             **payload, **kwargs)
        try:
            value = response.json()
        except ValueError:
            value = {"body": response.text[:3000]}
        if response.status_code >= 400:
            raise RuntimeError(f"HTTP {response.status_code} {path}: {json.dumps(value, ensure_ascii=False)}")
        return value

    async def new_chat(self, project=None):
        value = await self.api("POST", "/conversations", {"title": "新对话", "project_id": project})
        self.last_chat = value["id"]
        return value["id"]

    async def upload(self, filename):
        path = MATERIAL / filename
        route = "/attachments" if path.suffix.lower() in {".png", ".jpg", ".jpeg"} else "/files"
        value = await self.api("POST", route, files={"file": (path.name, path.read_bytes())})
        if route == "/files":
            for _ in range(200):
                if value.get("file_status") not in {"queued", "parsing"}:
                    break
                await asyncio.sleep(.2)
                value = await self.api("GET", f"/files/{value['id']}")
        return value

    def snapshot(self):
        tables = ["memories", "calendar_events", "plan_segments", "plan_occurrences", "todos",
                  "notifications", "goals", "knowledge_nodes", "office_files", "artifacts",
                  "complex_tasks", "projects", "knowledge_documents", "learning_sessions"]
        result = {}
        with sqlite3.connect(self.runtime / "bai.sqlite") as c:
            c.row_factory = sqlite3.Row
            for table in tables:
                result[table] = [dict(r) for r in c.execute("SELECT * FROM " + table)]
        return result

    def events(self, run_id):
        with self.db.Session() as session:
            from sqlalchemy import select
            return [{"kind": e.kind, "data": e.data} for e in session.scalars(
                select(self.db.RunEvent).where(self.db.RunEvent.run_id == run_id).order_by(self.db.RunEvent.id))]

    async def wait_run(self, run, limit=360, hook=None):
        start = time.monotonic()
        hook_done = False
        while run["status"] in {"queued", "running", "waiting"}:
            if hook and not hook_done:
                hook_done = bool(await hook(run, self.events(run["id"])))
            if time.monotonic() - start > limit:
                await self.api("POST", f"/runs/{run['id']}/cancel")
                run = await self.api("GET", f"/runs/{run['id']}")
                run["eval_timeout"] = limit
                break
            await asyncio.sleep(.3)
            run = await self.api("GET", f"/runs/{run['id']}")
        events = self.events(run["id"])
        messages = await self.api("GET", f"/conversations/{run['conversation_id']}/messages") if run.get("conversation_id") else []
        output = "\n\n".join(m["content"] for m in messages if m.get("run_id") == run["id"] and m["role"] == "assistant")
        if not output:
            output = str(run.get("result", {}).get("text") or run.get("result", {}).get("content") or "")
        if not output and run.get("result"):
            output = json.dumps(run["result"], ensure_ascii=False)
        if run.get("error"):
            output += "\n[执行错误] " + str(run["error"])
        receipt = {"run": run, "output": output, "events": events,
                   "presentation": await self.api("GET", f"/runs/{run['id']}/presentation"),
                   "elapsed_seconds": round(time.monotonic() - start, 2)}
        if self.current is not None:
            self.current["turns"].append(receipt)
        print(f"{self.args.chapter:02} case {self.current['id'] if self.current else 'setup'} run {run['status']} {round(time.monotonic()-start,1)}s", flush=True)
        return receipt

    async def say(self, text, chat=None, files=(), selection=None, hook=None):
        chat = chat or await self.new_chat()
        attached = [await self.upload(name) for name in files]
        data = {"content": text, "attachment_ids": [a["id"] for a in attached]}
        if selection:
            data["model_selection"] = selection
        if self.current is not None:
            self.current["sent"].append({"chat_id": chat, "content": text, "files": list(files)})
        run = await self.api("POST", f"/conversations/{chat}/messages", data)
        return await self.wait_run(run, hook=hook)

    async def prompts(self, n, chat=None, files=(), indices=None):
        chat = chat or await self.new_chat()
        source = self.cases[n]["prompts"]
        for index in (range(len(source)) if indices is None else indices):
            await self.say(source[index], chat, files=files if index == (0 if indices is None else indices[0]) else ())
        self.context[n] = chat
        return chat

    def note(self, text, status=None):
        self.current["notes"].append(text)
        if status:
            self.current["execution_status"] = status

    async def begin(self, n):
        self.current = {**self.cases[n], "sent": [], "turns": [], "observations": [], "notes": [],
                        "execution_status": "executed", "started_at": datetime.now(ZoneInfo("Asia/Shanghai")).isoformat(),
                        "before": self.snapshot()}

    def finish(self):
        self.current["after"] = self.snapshot()
        self.current["finished_at"] = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        result = self.clean(self.current)
        (self.output / f"case-{result['id']:03}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        self.rows.append(result)
        print(f"CASE_DONE {result['id']:03} turns={len(result['turns'])} state={result['execution_status']}", flush=True)
        self.current = None

    async def tool(self, name, enabled):
        return await self.api("PATCH", f"/tools/{name}", {"enabled": enabled})

    async def run_case(self, n):
        await getattr(self, f"chapter{self.args.chapter}")(n)

    async def retry(self, chat):
        run = await self.api("POST", f"/conversations/{chat}/retry", {})
        return await self.wait_run(run)

    def observe(self, label, value):
        self.current["observations"].append({"label": label, "value": value})

    async def chapter1(self, n):
        await self.prompts(n)
        if 18 <= n <= 22 and not self.metadata["search_configured"]:
            self.note("测试版未配置 Tavily；已发送原题检查模型实际回复，但原题联网能力前置不满足。", "not_applicable")

    async def chapter2(self, n):
        if n == 24:
            await self.prompts(n)
        elif n in {26, 35}:
            previous = 25 if n == 26 else 34
            with self.db.Session() as session:
                from sqlalchemy import select
                run_ids = list(session.scalars(select(self.db.Run.id).where(self.db.Run.conversation_id == self.context[previous])))
                changes = list(session.scalars(select(self.db.MemoryChange).where(self.db.MemoryChange.run_id.in_(run_ids))))
                ids = [c.id for c in changes]
            if not ids:
                raise RuntimeError("前例没有生成可撤销的记忆变更")
            self.observe("撤销 API", await self.api("POST", f"/memory-changes/{ids[-1]}/undo"))
            self.observe("撤销后记忆", await self.api("GET", "/memories"))
            if n == 26:
                try:
                    await self.retry(self.context[25])
                except RuntimeError as error:
                    self.observe("重试接口", str(error))
            self.note("通过同一撤销接口执行；8 秒提示条与鼠标悬停未做原生窗口验证。", "partial_execution")
        elif n == 27:
            await self.prompts(n)
            memories = await self.api("GET", "/memories")
            candidates = [m for m in memories if m["state"] == "candidate"]
            self.observe("忽略前候选", candidates)
            # Check a new chat before discarding the candidate.
            await self.say("我之前提过什么健康情况吗？")
            for m in candidates:
                await self.api("DELETE", f"/memories/{m['id']}")
            self.observe("忽略后记忆", await self.api("GET", "/memories"))
        elif n == 28:
            await self.prompts(n)
            await self.say("我感冒了，医生开了阿莫西林，有什么要注意的？")
        elif n == 31:
            await self.api("PATCH", "/settings/memory", {"memory_mode": "confirm"})
            chat = await self.prompts(n)
            candidates = [m for m in await self.api("GET", "/memories") if m["state"] == "candidate"]
            self.observe("确认前候选", candidates)
            for m in candidates:
                await self.api("POST", f"/memories/{m['id']}/confirm", {"revision": m["revision"]})
            await self.say("请用两句话介绍 Python。", chat)
            await self.api("PATCH", "/settings/memory", {"memory_mode": "auto"})
        elif n == 34:
            # The cross-chat probe follows undo in 035 so that the latest change is still identifiable.
            await self.prompts(n)
            await self.say("我住哪？附近周末可以去哪玩？")
        elif n == 36:
            memories = await self.api("GET", "/memories")
            target = next((m for m in memories if "周报" in m["content"]), None)
            if not target:
                raise RuntimeError("023 周报记忆不存在")
            await self.api("PUT", f"/memories/{target['id']}", {"content": "用户写周报使用本周完成、遇到的问题、下周计划三段式，每段不超过两条。", "category": "preference", "revision": target["revision"]})
            await self.prompts(n)
        elif n == 37:
            memories = await self.api("GET", "/memories")
            targets = [m for m in memories if "燕麦拿铁" in m["content"]]
            if not targets:
                await self.say("请记住我只喝燕麦拿铁")
                targets = [m for m in await self.api("GET", "/memories") if "燕麦拿铁" in m["content"]]
            for m in targets:
                await self.api("DELETE", f"/memories/{m['id']}")
            await self.prompts(n)
        elif n == 38:
            chat = await self.new_chat()
            await self.prompts(n, chat, indices=[0, 1])
            await self.prompts(n, indices=[2])
            await self.prompts(n, indices=[3])
        elif n == 39:
            await self.prompts(n, indices=[0])
            await self.prompts(n, indices=[1])
            if not self.metadata["embedding_configured"]:
                self.note("未配置 Embedding；已执行原题并保留关键词检索实际结果，语义检索用例不适用。", "not_applicable")
        elif n == 40:
            await self.prompts(n)
            self.note("按评测约定使用未启用 Embedding 的关键词检索模式。")
        elif n == 42:
            before = self.usage_count()
            self.observe("检索调试结果", await self.api("POST", "/memories/retrieval/preview", {"query": "周末去哪玩"}))
            self.observe("聊天调用数量变化", self.usage_count() - before)
            self.note("实际检索接口已执行；设置页视觉展示未做原生窗口验证。", "partial_execution")
        elif n == 44:
            await self.prompts(n, self.context[43])
        elif n == 46:
            chat = await self.new_chat()
            receipt = await self.say(self.cases[6]["prompts"][0], chat)
            self.observe("重新读取消息", await self.api("GET", f"/conversations/{chat}/messages"))
            self.observe("重新读取工具", await self.api("GET", f"/runs/{receipt['run']['id']}/tools"))
            self.observe("重新读取检索", await self.api("GET", f"/runs/{receipt['run']['id']}/retrieval"))
            self.note("已重开数据库连接读取持久化记录；未验证桌面切换对话后的展开显示。", "partial_execution")
        else:
            await self.prompts(n)

    def usage_count(self):
        with sqlite3.connect(self.runtime / "bai.sqlite") as c:
            return c.execute("SELECT count(*) FROM usage_calls").fetchone()[0]

    async def chapter3(self, n):
        if n == 58:
            await self.prompts(n)
        elif n in {60, 61}:
            await self.prompts(n, self.context[59])
            if n == 60:
                try:
                    await self.retry(self.context[59])
                except RuntimeError as error:
                    self.observe("重试接口", str(error))
        elif n == 65:
            # 2026-10-27 is Tuesday; the written case explicitly permits using the occurrence date.
            await self.say("这周三的跑步已经跑完了。")
            self.note("执行日是周二，按原用例允许的日期替换，使用本周三跑步。")
        elif n == 67:
            await self.prompts(n, self.context[66])
        elif n == 68:
            chat = await self.prompts(n)
            await self.say("确认结束整个跑步系列，保留之前完成记录。", chat)
        elif n == 70:
            await self.say("下周六下午两点安排一小时整理书柜。")
            self.current["before"] = self.snapshot()
            await self.prompts(n)
        elif n == 71:
            await self.say("下周一上午十点到十一点安排产品会议，下周二下午三点到四点安排设计会议。")
            self.current["before"] = self.snapshot()
            await self.prompts(n)
        elif n == 74:
            await self.prompts(n, self.context[72])
        else:
            await self.prompts(n)
        if n in {49, 50, 51, 53, 73}:
            self.note("核对真实持久化计划／待办／提醒数据；原生弹窗、系统通知、日期格展示及到点导航待桌面验证。", "partial_execution")
        if n in {51, 52, 53, 54, 63, 64, 66, 67, 68, 69, 70}:
            self.observe("展开后的实际计划", await self.api("GET", "/plans", params={"start": "2026-10-26", "end": "2027-04-01"}))

    async def chapter4(self, n):
        mapping = {
            75: ["方案A-青禾数字化方案.docx"], 76: ["方案A-青禾数字化方案.docx", "方案B-纸舟数字化方案.docx"],
            77: ["销售明细-2026Q3.xlsx"], 78: ["员工手册节选.pdf"], 79: ["扫描件-无文字层.pdf"],
            81: ["门店配置.json"], 83: ["长文-城市更新研究.md"], 84: ["会议纪要-1024.md"],
            85: ["销售明细-2026Q3.xlsx"], 87: ["会员名单.csv"], 88: ["门店配置.json"], 93: ["小票.png"]}
        if n in {80, 82}:
            name = "旧版合同.doc" if n == 80 else "门店配置-损坏.json"
            try:
                self.observe("实际上传解析结果", await self.upload(name))
            except RuntimeError as error:
                self.observe("实际上传拒绝", str(error))
            self.note("已执行真实附件上传与解析；输入框失败附件拦截未做桌面验证。", "partial_execution")
        elif n == 91:
            await self.prompts(n, self.context[90])
        elif n == 92:
            before = {str(p): p.stat().st_mtime_ns for p in (MATERIAL / "本地资料").rglob("*") if p.is_file()}
            await self.prompts(n, self.context[90], indices=[0])
            await self.prompts(n, indices=[1])
            self.observe("源文件修改时间未改变", all(Path(p).stat().st_mtime_ns == stamp for p, stamp in before.items()))
        elif n == 94:
            await self.say(self.cases[n]["prompts"][0], files=["小票.png"])
            self.note("使用原始图片执行了实际视觉问答；系统截图及 Ctrl+V 粘贴链路未验证。", "partial_execution")
        elif n == 95:
            model = self.selection
            try:
                await self.say("图里写了什么？", files=["小票.png"], selection={"provider_id": model["provider_id"], "model_name": "deepseek-v4-pro", "thinking_enabled": False})
            except RuntimeError as error:
                if "当前模型未启用图片输入" not in str(error):
                    raise
                self.observe("后端拒绝未启用视觉的模型", str(error))
                self.note("发送时被服务端明确拦截，没有发起视觉模型调用。")
        elif n in {96, 98}:
            await self.prompts(n)
            if not self.metadata["image_generation_configured"]:
                self.note("测试版未配置图片生成连接；已发送原题保留实际回复，无法测试真实图片生成或不存在的图片模型。", "not_applicable")
        else:
            await self.prompts(n, files=mapping.get(n, ()))
        if n in {84, 85, 86, 87, 88}:
            self.note("生成物将核对真实文件及内容；Windows 下载、另存为和前端预览交互未验证。", "partial_execution")

    async def make_project(self, name, workspace=""):
        return await self.api("POST", "/projects", {"name": name, "workspace_path": workspace})

    async def import_knowledge(self):
        import httpx
        paths = list((MATERIAL / "知识库").glob("*.md"))
        response = await self.client.post("/api/v1/knowledge/import",
            files=[("files", (p.name, p.read_bytes(), "text/markdown")) for p in paths],
            data={"paths": json.dumps([p.name for p in paths], ensure_ascii=False)})
        response.raise_for_status()
        await self.api("PUT", "/knowledge/config", {"enabled": True})
        for _ in range(200):
            docs = await self.api("GET", "/knowledge/documents")
            if all(d.get("status") not in {"queued", "parsing", "indexing"} for d in docs):
                self.observe("知识库导入状态", docs)
                break
            await asyncio.sleep(.2)

    async def task_start(self, hook=None):
        return await self.say(self.cases[100]["prompts"][0], files=["方案A-青禾数字化方案.docx", "方案B-纸舟数字化方案.docx"], hook=hook)

    async def pause_after_file(self, run, events):
        with self.db.Session() as session:
            from sqlalchemy import select
            found = session.scalar(select(self.db.Artifact.id).where(self.db.Artifact.run_id == run["id"]))
        if found:
            self.observe("首份文件生成后停止", await self.api("POST", f"/runs/{run['id']}/cancel"))
            return True
        return False

    async def chapter5(self, n):
        if n == 100:
            await self.task_start()
            self.context[100] = self.last_chat
        elif n == 101:
            async def amend(run, events):
                if any(e["kind"] == "tool" for e in events):
                    self.observe("执行中补充要求接口", await self.api("POST", f"/conversations/{run['conversation_id']}/messages", {"content": self.cases[101]["prompts"][0]}))
                    self.current["sent"].append({"chat_id": run["conversation_id"], "content": self.cases[101]["prompts"][0], "files": []})
                    return True
                return False
            await self.task_start(hook=amend)
        elif n == 102:
            await self.task_start(hook=self.pause_after_file)
            chat = self.last_chat
            await self.prompts(n, chat)
            self.note("首份真实文件生成后通过停止接口暂停并继续；输入框按钮呈现未验证。", "partial_execution")
        elif n == 103:
            await self.task_start(hook=self.pause_after_file)
            chat = self.last_chat
            from app import complex_tasks
            before = self.usage_count()
            complex_tasks.recover()
            await asyncio.sleep(1)
            self.observe("恢复扫描新增模型调用数", self.usage_count() - before)
            self.observe("恢复扫描后任务", await self.api("GET", f"/conversations/{chat}/tasks"))
            await self.say("继续", chat)
            self.note("执行了启动时同一任务恢复函数并检查调用数；未实际退出和重启桌面进程。", "partial_execution")
        elif n == 104:
            await self.prompts(n, self.context[100])
        elif n == 105:
            await self.task_start(hook=self.pause_after_file)
            await self.prompts(n, self.last_chat)
        elif n in {106, 107}:
            if n == 107 and not self.metadata["search_configured"]:
                await self.tool("read_url", False)
                self.observe("关闭后真实工具配置", await self.api("GET", "/tools"))
                await self.tool("read_url", True)
                self.note("测试版未配置 Tavily，106 的真实搜索任务无法成立，不能验证执行中关闭网页读取。已检查工具开关 API 并恢复。", "not_applicable")
                return
            if n == 107:
                await self.tool("read_url", False)
                await self.say(self.cases[106]["prompts"][0])
                await self.tool("read_url", True)
            else:
                await self.prompts(n)
            if not self.metadata["search_configured"]:
                self.note("未配置 Tavily，无法按原题进行真实搜索和读取；保留实际模型回复。", "not_applicable")
        elif n == 108:
            await self.prompts(n, files=["长文-城市更新研究.md"])
        elif n == 109:
            project = await self.make_project("禾木双十一")
            self.context["hemu"] = project["id"]
            chat = await self.new_chat(project["id"])
            for filename in ["营销方案-v2.md", "客户反馈-禾木咖啡.txt"]:
                path = MATERIAL / filename
                uploaded = await self.api("POST", f"/projects/{project['id']}/materials/upload", files={"file": (filename, path.read_bytes())})
                self.observe("项目资料直接上传", uploaded)
            for _ in range(200):
                materials = await self.api("GET", f"/projects/{project['id']}/materials")
                if not any("queued" in json.dumps(m) or "parsing" in json.dumps(m) for m in materials):
                    break
                await asyncio.sleep(.2)
            self.observe("项目资料解析后状态", materials)
            await self.prompts(n, chat)
        elif n == 110:
            await self.say("请记住：我养了一只橘猫，叫福袋，三岁。")
            a = await self.new_chat(self.context["hemu"])
            await self.prompts(n, a, indices=[0])
            project = await self.make_project("纸舟官网")
            self.context["zhizhou"] = project["id"]
            b = await self.new_chat(project["id"])
            await self.prompts(n, b, indices=[1])
        elif n == 111:
            chat = await self.new_chat(self.context["hemu"])
            await self.say("我们定一下，第一版初稿 10 月 30 日交，终稿 11 月 5 日交。", chat)
            chat = await self.new_chat(self.context["hemu"])
            await self.prompts(n, chat)
            await self.say(self.cases[n]["prompts"][0])
        elif n == 112:
            project_id = self.context["zhizhou"]
            await self.api("PUT", f"/projects/{project_id}", {"name": "纸舟官网", "workspace_path": str(MATERIAL / "本地资料")})
            await self.prompts(n, await self.new_chat(project_id), indices=[0])
            await self.prompts(n, await self.new_chat(self.context["hemu"]), indices=[1])
            await self.prompts(n, indices=[1])
            await self.api("PUT", f"/projects/{project_id}", {"name": "纸舟官网", "workspace_path": ""})
            await self.prompts(n, await self.new_chat(project_id), indices=[1])
        elif n == 113:
            chat = await self.new_chat()
            await self.say("帮我写一条禾木双十一文案，突出全网最低价。", chat)
            self.observe("移动聊天到项目", await self.api("PATCH", f"/conversations/{chat}", {"project_id": self.context["hemu"]}))
            await self.prompts(n, chat)
        elif n == 114:
            await self.import_knowledge()
            self.current["before"] = self.snapshot()
            await self.prompts(n)
        elif n in {115, 116, 117}:
            await self.prompts(n)
        elif n == 118:
            await self.api("PUT", "/knowledge/config", {"enabled": False})
            await self.prompts(n)
            await self.api("PUT", "/knowledge/config", {"enabled": True})
        elif n == 119:
            self.observe("知识库问答后的长期记忆", await self.api("GET", "/memories"))
            docs = await self.api("GET", "/knowledge/documents")
            for doc in docs:
                if "产品FAQ" in json.dumps(doc, ensure_ascii=False):
                    await self.api("DELETE", f"/knowledge/documents/{doc['id']}")
            await self.say(self.cases[116]["prompts"][0])
            self.observe("知识库原始文件仍存在", (MATERIAL / "知识库/产品FAQ-智能水杯.md").exists())
        elif n == 120:
            await self.learning_setup("公司制度入门", "掌握公司差旅制度", "刚入职，对公司制度不了解")
            session, lesson = await self.start_lesson()
            await self.submit_lesson(lesson, self.cases[n]["prompts"][0], session["id"])
        else:
            await self.prompts(n)
        if 114 <= n <= 120 and not self.metadata["embedding_configured"]:
            self.note("按原评测集允许的关键词检索模式执行；未启用语义向量检索。")

    async def learning_setup(self, title="Python 数据分析", objective="用 pandas 分析自己的记账表", foundation="零基础"):
        goal = await self.api("POST", "/learning/goals", {"title": title, "objective": objective, "foundation": foundation, "weekly_minutes": 180})
        await self.wait_run(await self.api("POST", f"/learning/goals/{goal['id']}/plan"))
        goal = await self.api("GET", f"/learning/goals/{goal['id']}")
        self.context["goal"] = goal
        return goal

    async def start_lesson(self, node_index=0):
        goal = self.context.get("goal")
        if not goal or not goal.get("nodes"):
            goal = await self.learning_setup()
        nodes = goal["nodes"]
        # Modules have no lesson; use leaf nodes.
        leaves = [x for x in nodes if x.get("kind", "knowledge") != "module" and not any(n.get("parent_id") == x["id"] for n in nodes)]
        node = leaves[min(node_index, len(leaves) - 1)]
        session = await self.api("POST", f"/learning/goals/{goal['id']}/sessions", {"node_id": node["id"]})
        existing = await self.api("GET", f"/learning/nodes/{node['id']}/lesson")
        if not existing or existing["state"] != "awaiting_submission":
            await self.wait_run(await self.api("POST", f"/learning/nodes/{node['id']}/lesson", {"session_id": session["id"]}))
        lesson = await self.api("GET", f"/learning/nodes/{node['id']}/lesson")
        self.context.update(session=session, lesson=lesson, node=node)
        self.observe("实际教学内容", lesson)
        return session, lesson

    async def submit_lesson(self, lesson, answer, session_id=None, images=()):
        from uuid import uuid4
        self.current["sent"].append({"content": answer, "learning_lesson_id": lesson["id"], "files": list(images)})
        attached = [await self.upload(name) for name in images]
        run = await self.api("POST", f"/learning/lessons/{lesson['id']}/submit", {
            "submission_id": str(uuid4()), "answer": answer, "session_id": session_id,
            "attachment_ids": [a["id"] for a in attached]})
        result = await self.wait_run(run)
        self.observe("批改后教学内容", await self.api("GET", f"/learning/lessons/{lesson['id']}"))
        return result

    async def chapter6(self, n):
        from uuid import uuid4
        if n == 121:
            await self.prompts(n)
            goals = await self.api("GET", "/learning/goals")
            if goals:
                self.context["goal"] = await self.api("GET", f"/learning/goals/{goals[0]['id']}")
        elif n == 122:
            prompts = self.cases[n]["prompts"]
            intake = await self.api("POST", "/learning/intakes", {"content": prompts[0], "message_id": str(uuid4()), "creation_id": str(uuid4())})
            self.current["sent"].append({"content": prompts[0], "entry": "learning_intake"})
            await self.wait_run(await self.api("GET", f"/runs/{intake['active_run_id']}"))
            for text in prompts[1:]:
                self.current["sent"].append({"content": text, "entry": "learning_intake"})
                await self.wait_run(await self.api("POST", f"/learning/intakes/{intake['id']}/messages", {"content": text, "message_id": str(uuid4())}))
            intake = await self.api("GET", f"/learning/intakes/{intake['id']}")
            self.observe("访谈模型输出", intake)
            summary = {**intake["summary"], "target_date": "2027-01-31"}
            await self.api("PUT", f"/learning/intakes/{intake['id']}/summary", {"summary": summary})
            form = {**summary, "weekly_minutes": 240}
            await self.wait_run(await self.api("POST", f"/learning/intakes/{intake['id']}/confirm", form))
            self.observe("重复确认返回", await self.api("POST", f"/learning/intakes/{intake['id']}/confirm", form))
            self.note("访谈、修改摘要、确认及重复请求执行真实接口；页面离开后草稿呈现未验证。", "partial_execution")
        elif n in {123, 124, 125}:
            await self.prompts(n)
            if n == 124:
                self.observe("可选学习目标", await self.api("GET", "/learning/continuations"))
        elif n == 126:
            await self.say("请记住：我学 Python 时希望先给一段能直接运行的小代码，再用最多三句话解释。")
            await self.start_lesson()
        elif n == 127:
            # Derive an answer from the public exercise, without inspecting hidden grading criteria.
            from app import provider, usage_cost
            lesson = self.context["lesson"]
            with usage_cost.scope(purpose="chat"):
                answer = await provider.model().ainvoke("请作为认真做题的学生，只给出下面 Python 练习的正确答案，不加客套话。\n" + lesson["exercise"])
            self.observe("作答来源", "同一真实 API 根据公开练习独立作答；未读取隐藏评分标准")
            await self.submit_lesson(lesson, str(answer.content), self.context["session"]["id"])
        elif n == 128:
            session, lesson = await self.start_lesson(1)
            await self.submit_lesson(lesson, "Python 的列表索引从 1 开始，第一个元素用 items[1]，所有字符串相加会自动得到整数，变量必须先声明类型。", session["id"])
        elif n == 129:
            lesson = await self.api("GET", f"/learning/lessons/{self.context['lesson']['id']}")
            await self.submit_lesson(lesson, "为什么 Python 的索引从 0 开始？", self.context["session"]["id"])
            public = await self.api("GET", f"/learning/lessons/{lesson['id']}")
            from app import provider, usage_cost
            with usage_cost.scope(purpose="chat"):
                answer = await provider.model().ainvoke("根据以下公开的新练习和反馈认真作答，只给答案，不追问。\n" + json.dumps(public, ensure_ascii=False))
            await self.submit_lesson(public, str(answer.content), self.context["session"]["id"])
        elif n == 130:
            # A screenshot must be a real submitted image; generate one from the student's code.
            from PIL import Image, ImageDraw, ImageFont
            image = Image.new("RGB", (1000, 260), "white")
            draw = ImageDraw.Draw(image)
            font = ImageFont.truetype("C:/Windows/Fonts/consola.ttf", 32)
            draw.multiline_text((24, 24), "items = ['apple', 'banana', 'pear']\nprint(items[0])\n# First item: apple", font=font, fill="black", spacing=14)
            image_path = self.output / "student-code.png"
            image.save(image_path)
            raw = await self.api("POST", "/attachments", files={"file": (image_path.name, image_path.read_bytes(), "image/png")})
            lesson = self.context["lesson"]
            run = await self.api("POST", f"/learning/lessons/{lesson['id']}/submit", {"submission_id": str(uuid4()), "answer": "我的代码作答在图片中，请根据代码批改。", "attachment_ids": [raw["id"]], "session_id": self.context["session"]["id"]})
            await self.wait_run(run)
        elif n == 131:
            goal = self.context["goal"]
            await self.wait_run(await self.api("POST", "/learning/reviews", {"goal_id": goal["id"], "session_id": self.context["session"]["id"]}))
            self.observe("独立复习记录", await self.api("GET", "/learning/reviews", params={"goal_id": goal["id"]}))
        elif n == 132:
            chat = await self.prompts(n)
            self.note("实际提醒数据已记录；到点原生弹窗及连续点击防重复未验证。", "partial_execution")
        elif n == 133:
            session = await self.api("GET", f"/learning/sessions/{self.context['session']['id']}")
            draft = {"node_id": self.context["node"]["id"], "lesson_id": self.context["lesson"]["id"], "answer": "items = [1, 2, 3]\nprint(items[", "revision": session["draft_revision"]}
            self.observe("保存草稿", await self.api("PUT", f"/learning/sessions/{session['id']}/draft", draft))
            before = self.usage_count()
            self.observe("重新读取学习会话", await self.api("GET", f"/learning/sessions/{session['id']}"))
            self.observe("恢复读取产生模型调用数", self.usage_count() - before)
            self.note("草稿持久化和恢复 API 已验证；托盘退出、重启及输入框视觉恢复未验证。", "partial_execution")
        elif n == 134:
            goal = self.context["goal"]
            session, lesson = await self.start_lesson(2)
            # Use a new teaching run, then stop it through the established end-session flow.
            await self.api("POST", f"/learning/sessions/{session['id']}/end")
            self.observe("结束后状态", await self.api("GET", f"/learning/sessions/{session['id']}"))
            self.note("结束学习的实际接口与会话保存已执行；生成中点击、关闭主窗口及最小化区别未做原生验证。", "partial_execution")

    async def chapter7(self, n):
        if 135 <= n <= 138:
            skills = await self.api("GET", "/skills")
            skill = next(x for x in skills if x["name"] == "text-notes")
            await self.api("PATCH", f"/skills/{skill['id']}", {"enabled": n != 137, "scripts_allowed": n == 136})
            await self.api("PUT", "/skill-runtimes", {"python": sys.executable})
            if n == 136:
                await self.say(self.cases[135]["prompts"][0])
            else:
                await self.prompts(n)
        elif n == 139:
            await self.tool("web_search", False)
            await self.tool("read_url", False)
            await self.prompts(n)
            await self.tool("web_search", True)
            await self.tool("read_url", True)
        elif n == 140:
            await self.tool("get_weather", False)
            await self.prompts(n)
            await self.tool("get_weather", True)
        elif n in {141, 142}:
            self.observe("实际 MCP 服务配置", await self.api("GET", "/mcp/servers"))
            await self.say(self.cases[141]["prompts"][0])
            self.note("测试版没有配置百炼 EnhancedSearch MCP；不能用内置搜索或模拟 MCP 替代。", "not_applicable")
        elif n == 143:
            server = await self.api("POST", "/mcp/servers", {"name": "评测-不存在程序", "transport": "stdio", "command": "C:\\no\\such.exe", "enabled": False})
            try:
                self.observe("真实 MCP 启动错误", await self.api("POST", f"/mcp/servers/{server['id']}/test"))
            except RuntimeError as error:
                self.observe("真实 MCP 启动错误", str(error))
            self.observe("失败后服务状态", await self.api("GET", "/mcp/servers"))
            await self.say("杭州明天天气如何？")
            await self.api("DELETE", f"/mcp/servers/{server['id']}")
        elif 144 <= n <= 148:
            self.observe("测试版微信绑定状态（只读）", {"bound": self.metadata["wechat_bound"], "credential_available": self.metadata["wechat_credential_available"]})
            self.note("无法由桌面 API 代替本人手机向微信发送消息及验证实际收件；没有发起微信投递，也没有解绑原测试版。", "not_applicable" if not self.metadata["wechat_bound"] else "blocked")
        elif n == 149:
            await self.api("POST", "/plans", {"title": "安全核对-保留计划", "start": "2026-11-10T10:00:00+08:00", "end": "2026-11-10T11:00:00+08:00"})
            await self.api("POST", "/memories", {"content": "评测安全核对：用户喜欢浅蓝色。", "category": "preference"})
            self.current["before"] = self.snapshot()
            await self.prompts(n, files=["供应商说明-含指令.md"])
        elif n == 150:
            await self.api("POST", "/todos", {"title": "安全核对-保留待办"})
            self.current["before"] = self.snapshot()
            await self.prompts(n)
        elif n == 152:
            async def stop(run, events):
                if sum(len(e["data"].get("text", "")) for e in events if e["kind"] == "delta") > 120:
                    self.observe("生成中停止", await self.api("POST", f"/runs/{run['id']}/cancel"))
                    return True
                return False
            await self.say("写一篇 1500 字的秋天散文", hook=stop)
            chat = self.last_chat
            await self.retry(chat)
            self.note("真实流式输出中途停止并重试；桌面按钮状态及停止后即时发送的视觉交互未验证。", "partial_execution")
        elif n == 153:
            selection = {k: self.selection[k] for k in ["provider_id", "model_name", "thinking_enabled"]}
            async def change_model(run, events):
                if any(e["kind"] == "delta" for e in events):
                    with self.db.Session() as session:
                        settings = session.get(self.db.Settings, "local")
                        profiles = json.loads(json.dumps(settings.model_providers))
                        for p in profiles:
                            if p["id"] == selection["provider_id"]:
                                p["default_model"] = "deepseek-v4-pro"
                        settings.model_providers = profiles
                        settings.model_name = "deepseek-v4-pro"
                        session.commit()
                    await self.api("POST", f"/runs/{run['id']}/cancel")
                    return True
                return False
            await self.say("请写一篇关于春夏秋冬的六百字短文。", selection=selection, hook=change_model)
            await self.retry(self.last_chat)
            with self.db.Session() as session:
                settings = session.get(self.db.Settings, "local")
                settings.model_providers = json.loads(self.original_settings["model_providers"])
                settings.model_name = self.original_settings["model_name"]
                session.commit()
            self.note("只有一套连接；补充验证同连接不同模型的快照，原题要求两套连接的完整场景不适用。", "not_applicable")
        elif n == 154:
            selection = {k: self.selection[k] for k in ["provider_id", "model_name", "thinking_enabled"]}
            for enabled in [True, False]:
                await self.say(self.cases[n]["prompts"][0], selection={**selection, "thinking_enabled": enabled})
            self.note("核对真实接口思考配置、思考事件与答案；前端思考展开显示未验证。", "partial_execution")
        elif n == 155:
            self.observe("实际费用记录", await self.api("GET", "/usage"))
            self.observe("实际模型价格", await self.api("GET", "/usage/prices"))
            self.note("实际调用与费用 API 已检查；日期筛选和上下文圆环的悬停、切换对话展示未验证。", "partial_execution")
        elif n == 156:
            import zipfile
            if not await self.api("GET", "/learning/goals"):
                await self.api("POST", "/learning/goals", {"title": "导出核对学习目标", "objective": "核对学习数据随导出保留", "foundation": "零基础"})
            if not await self.api("GET", "/knowledge/documents"):
                await self.import_knowledge()
            archive = await self.api("POST", "/settings/data/export")
            self.observe("实际导出结果", archive)
            with zipfile.ZipFile(archive["path"]) as z:
                self.observe("ZIP 文件清单", z.namelist())
                target = self.output / "export-inspect.sqlite"
                target.write_bytes(z.read("bai.sqlite"))
            with sqlite3.connect(target) as c:
                counts = {table: c.execute(f"SELECT count(*) FROM {table}").fetchone()[0] for table in ["settings", "mcp_servers", "wechat_state", "conversations", "memories", "calendar_events", "todos", "goals", "knowledge_documents", "knowledge_chunks", "artifacts"]}
                self.observe("导出数据库数据与凭据相关表数量", counts)
        else:
            await self.prompts(n)

    async def chapter8(self, n):
        if n == 157:
            await self.prompts(n, files=["营销方案-v2.md", "客户反馈-禾木咖啡.txt"])
        elif n == 158:
            await self.prompts(n, indices=[0, 1])
            await self.prompts(n, indices=[2])
            await self.prompts(n, indices=[3])
        elif n == 160:
            await self.prompts(n, files=["会议纪要-1024.md"])
        elif n == 161:
            await self.prompts(n, files=["销售明细-2026Q3.xlsx", "门店配置.json"])
        elif n == 163:
            await self.say(self.cases[121]["prompts"][0])
            self.current["before"] = self.snapshot()
            await self.prompts(n)
        elif n == 164:
            # Create real learning state via the tutoring flow, without injecting assessment records.
            await self.learning_setup()
            session, lesson = await self.start_lesson()
            await self.submit_lesson(lesson, "我认为所有列表从 1 开始，变量不用赋值也能直接打印。", session["id"])
            self.current["before"] = self.snapshot()
            await self.prompts(n)
        elif n == 165:
            await self.prompts(n, indices=[0])
            chat = await self.prompts(n, indices=[1, 2])
            await self.say("下次面试我要重点准备什么？")
        elif n == 168:
            await self.prompts(n)
            if not self.metadata["search_configured"]:
                self.note("测试版未配置 Tavily；原题必须使用官方联网来源，因此不适用。", "not_applicable")
        elif n == 169:
            self.observe("测试版微信绑定状态（只读）", {"bound": self.metadata["wechat_bound"], "credential_available": self.metadata["wechat_credential_available"]})
            self.note("需从本人手机微信发送并实际收件；未用普通桌面聊天冒充微信渠道。", "not_applicable" if not self.metadata["wechat_bound"] else "blocked")
        elif n == 170:
            from app import complex_tasks
            before = self.usage_count()
            complex_tasks.recover()
            self.observe("启动恢复函数新增模型调用数", self.usage_count() - before)
            await self.prompts(n)
            self.note("使用本组真实生成的计划、待办和记忆回答；没有实际跨天及重启桌面应用。", "partial_execution")
        else:
            await self.prompts(n)

    async def run(self):
        import httpx
        logging.getLogger("httpx").setLevel(logging.WARNING)
        async with self.main.app.router.lifespan_context(self.main.app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=self.main.app),
                                        base_url="http://127.0.0.1", timeout=60,
                                        headers={"Authorization": "Bearer " + self.config.AUTH_TOKEN}) as client:
                self.client = client
                for n, case in self.cases.items():
                    if case["chapter"] != self.args.chapter or n < self.args.start or n > self.args.end:
                        continue
                    if self.args.only and n not in {int(x) for x in self.args.only.split(",")}:
                        continue
                    if (self.output / f"case-{n:03}.json").exists() and not self.args.rerun:
                        continue
                    await self.begin(n)
                    try:
                        await self.run_case(n)
                    except Exception as error:
                        self.note(f"执行异常：{type(error).__name__}: {error}", "execution_error")
                        print(f"CASE_ERROR {n:03} {type(error).__name__}: {error}", flush=True)
                    self.finish()
        self.metadata["finished_at"] = datetime.now(ZoneInfo("Asia/Shanghai")).isoformat()
        (self.output / f"metadata-{self.args.chapter:02}.json").write_text(
            json.dumps(self.clean(self.metadata), ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--chapter", type=int, required=True, choices=range(1, 9))
    parser.add_argument("--output", default=str(ROOT / ".local-data/evals-20261027/run-1"))
    parser.add_argument("--start", type=int, default=1)
    parser.add_argument("--end", type=int, default=170)
    parser.add_argument("--rerun", action="store_true")
    parser.add_argument("--only", default="", help="Comma-separated case numbers for clean rechecks")
    args = parser.parse_args()
    asyncio.run(Runner(args).run())
