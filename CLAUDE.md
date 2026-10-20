# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 交付约定（优先级最高）

- 每轮修改后先完成必要检查，主动打开可运行的桌面测试版，并保持打开供用户检查。
- 等待用户明确表示本轮测试通过后，才可构建本轮安装包。此前版本的打包授权不适用于新的修改。
- 用户尚未验收时，不运行 NSIS、`release:windows` 或其他安装包构建流程。
- 测试版使用独立应用标识，能与安装版同时运行；不得覆盖个人安装目录、数据库或凭据。
- 本地模拟检查、原生窗口检查、真实模型或微信收件验收分别报告，不互相替代。

这些规则在 `AGENTS.md` 中同样存在，修改时保持两处一致。

## 项目概览

XiaoXi（原名 Bai Agent / 小汐）是 Windows 本地优先的个人助手：对话 + 工具调用、按知识框架教学、记忆、提醒、微信渠道。前端 React 19 + Vite + Tailwind 4，桌面壳 Tauri 2；后端 Python 3.12 / FastAPI + LangChain + LangGraph，SQLite + Alembic。桌面程序自动启动本机 Python 后端，数据只存本机。

注意：README 中的绝对路径 `261005-Bai-Agent` 是迁移前的旧路径，实际工作区就是当前仓库目录。

## 常用命令

在 PowerShell 中执行；包管理器为 pnpm 11，Python 环境用 uv 管理。

```powershell
# 依赖（新机器）
pnpm install --frozen-lockfile
uv sync --project backend --frozen

# 开发版：启动器会后台启动桌面窗口，桌面程序自己拉起 Python 后端
# 双击 启动XiaoXi.cmd，或：
pnpm desktop:dev

# 测试版（独立标识、数据目录和端口，可与安装版/开发版同时运行）
# 双击 启动测试版.cmd，或：
.\scripts\start-preview.ps1

# 后端测试（自动使用临时数据目录，不动个人数据库）
.\backend\.venv\Scripts\python.exe -m pytest backend/tests -q
# 单个测试
.\backend\.venv\Scripts\python.exe -m pytest backend/tests/test_memory.py -q
.\backend\.venv\Scripts\python.exe -m pytest backend/tests/test_memory.py::test_name -q

# 前端单元测试（vitest + jsdom）
pnpm test
pnpm exec vitest run src/components/ChatPage.test.tsx

# 类型生成、类型检查与构建
pnpm api:types
pnpm build

# Rust 检查（不打包）
cargo check --manifest-path src-tauri/Cargo.toml

# 浏览器端到端（先看下方“浏览器测试”，单文件示例）
pnpm exec playwright test tests/browser/app.spec.ts

# 安装包（仅在用户明确验收本轮修改后执行）
pnpm release:windows
```

`package.json` 与 `src-tauri/tauri.conf.json` 的 version 必须一致，否则 `release:windows` 直接报错。

### 浏览器测试

浏览器测试使用本地模拟模型，必须使用隔离数据目录，**不要对正常个人空间运行**。先退出桌面应用，开三个终端并设置相同的 `BAI_DATA_DIR`：

```powershell
$env:BAI_DATA_DIR = '<仓库>\.local-data\review'
$env:BAI_MODEL_API_KEY = 'synthetic-key'
uv run --project backend uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8766 --no-access-log   # 终端一
pnpm dev                                                                                                       # 终端二
uv run --project backend python backend/tests/mock_provider.py                                                 # 终端三
```

然后 `pnpm exec playwright test`（使用本机 Chrome，`playwright.config.ts` 固定单 worker）。Windows 原生验证使用 `tests/native.verify.mjs`，需要开发进程开启 CDP 9227，且浏览器测试已保存课程。

## 架构

### 前端

- `src/App.tsx` 持有页面路由（chat/learning/reminders/settings）、全局数据和 5 秒通知轮询；各功能页在 `src/components/`。
- `src/lib/api.ts`：Tauri 环境通过 IPC `backend_config` 取得后端 URL + bearer token，浏览器开发环境走 Vite 代理；`readEvents()` 解析 SSE。类型来自 `api.generated.ts`（OpenAPI 生成，不要手改）。
- 样式加载顺序在 `src/main.tsx`：`style.css` → `styles/cream.css` → `styles/workspace.css`。`styles/interface.css` 是旧外观，当前不加载。
- 界面视觉约定见 `docs/interface.md`（奶油杏主题、圆角、头像动效、中文文案规范）。

### Tauri 壳

`src-tauri/src/main.rs`：单实例、托盘、提醒窗口、窗口布局；按 `BAI_BACKEND_PORT`（默认 8766）选择端口，优先复用已认证的健康后端，否则启动子进程（开发版用 `backend/.venv/Scripts/python.exe`，发布版用资源目录里的 `bai-backend.exe`）；退出时只停止自己启动的后端。前端认证信息只通过 `backend_config` IPC 下发。

### 后端

- `app/main.py`：所有业务路由挂在 `/api/v1` 的 `APIRouter` 上，统一 bearer 认证（仅 `/api/v1/health` 例外）。lifespan 依次执行迁移、待导入恢复、语义索引 worker、MCP manager、LangGraph SQLite saver、APScheduler 提醒（3 秒 tick）、微信通道。
- `app/provider.py`：OpenAI 兼容 `ChatOpenAI` 封装；密钥走 `keyring`，可用 `BAI_<NAME>_API_KEY` 环境变量覆盖（测试用）。
- `app/agent.py` + `app/tools.py`：对话循环与统一工具目录（内置工具 + MCP），工具启用状态、执行前复查、RunEvent 记录。
- `app/runs.py`：任务生命周期、超时、取消；事件先写库再由 SSE 读取，界面断开不取消任务。
- `app/learning.py`：LangGraph `teach → await_submission → assess` 教学图，等待练习时 checkpoint 落盘。
- `app/memory.py` + `app/retrieval.py`：candidate/confirmed 记忆、关键词 + Embedding 余弦 + RRF 混合检索；规则见 `docs/memory.md`。
- `app/db.py` + `migrations/versions/`：SQLAlchemy 领域模型与不可变编号迁移；新增结构变更必须新增迁移文件，不改旧迁移。
- `app/data_transfer.py` 数据导入导出；`app/mcp_service.py` MCP 连接管理；`app/wechat.py` 微信渠道；`app/reminders.py` 提醒调度。

## 数据与配置

- 数据目录由 `BAI_DATA_DIR` 决定：开发版 `.local-data/dev`，测试版 `.local-data/preview-runtime`，安装版 `%LOCALAPPDATA%\XiaoXi_Agent`（旧版 `com.qinbai.baiagent` 首次启动自动迁移）。浏览器/隔离验证各用独立子目录。
- 每个数据目录下：`bai.sqlite`（业务数据 + 向量）、`checkpoints.sqlite`（学习图）、`attachments/`、`auth-token`（本机 bearer token）；安装版另有 `backend.log`。
- API 密钥和微信凭据存 Windows 凭据库，按数据目录隔离，不写入数据库或前端；测试通过 monkeypatch 的假 vault 隔离。
- 后端只监听 `127.0.0.1`，不要暴露到公网。

## 验证报告要求

汇报时区分：单元/构建检查、浏览器隔离验证、原生窗口检查、真实模型或微信收件验收。模拟检查不能替代真实模型质量验收（见 `docs/verification.md` 的记录格式）。

## 参考文档

`README.md`（使用与边界）、`PLAN.md`（路线图）、`docs/architecture.md`（架构与关键约定）、`docs/interface.md`（界面）、`docs/memory.md`、`docs/mcp.md`、`docs/wechat-integration.md`、`docs/data-storage.md`、`docs/evals/README.md`、`docs/verification.md`。
