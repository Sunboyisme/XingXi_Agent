# XiaoXi · 0.1.5

从 0.1.0 开始的历史发布、修改、反馈及验收记录统一见 [更新记录汇总](docs/updata/change.md)；之后每轮修改同步保存到该文件，各版本原始记录继续保留。

0.1.5 修正计划开始与结束时间联动，并修复聊天输入框无法直接粘贴图片的问题。0.1.4 支持上传办公资料、显示解析状态、按需读取与生成 Word、PDF、Excel、TXT、MD、CSV、JSON 结果文件，并提供预览、下载和另存为；同时改进提醒卡、重复计划、对话定位与学习回答区。详见 [0.1.5 更新记录](docs/updata/0.1.5/changes.md)、[0.1.4 发布说明](docs/releases/0.1.4.md)与[文件功能](docs/files.md)。

0.1.3 新增「日序」月历/周历和 Skill 技能包，支持聊天安排计划、联动提醒、按技能授权运行脚本，以及 MCP 图片与网页来源持久化展示。详见 [0.1.3 发布说明](docs/releases/0.1.3.md)、[技能使用](docs/skills.md)和[日序](docs/calendar.md)。Windows x64 安装包已于 2026-10-19 在用户验收并授权后构建。

应用已从 Bai Agent 更名为「XiaoXi」。使用 `启动测试版.cmd` 打开独立测试版。应用标识、数据目录和密钥存储保持兼容，已有 0.1.0 安装包保留。

个人助手，在同一个对话框中查询天气、联网搜索、阅读网页、计算、处理日期与单位换算、保存记忆和安排提醒。Agent 自行选择已封装的工具，必要时连续调用。提供 **Windows x64 安装版** 和桌面开发环境。同时支持按知识框架逐步学习，内容由你配置的模型生成。

项目位置：`C:\QinBai\Personal_Works\Project\261005-XiaoXi_Agent`。开发路线见 [PLAN.md](PLAN.md)，技术说明见 [docs/architecture.md](docs/architecture.md)，界面规范见 [docs/interface.md](docs/interface.md)。

## 安装版

安装包位于 `releases/0.1.4/XiaoXi_0.1.4_x64-setup.exe`，同目录 `SHA256SUMS.txt` 可校验文件。安装版包含前端、Python 后端及 MCP 依赖，无需安装 Python、Node.js 或 Rust。第三方 stdio MCP 服务及技能脚本自身需要的运行环境需另行准备。缺少 WebView2 时安装器会联网下载运行环境。图标采用用户选定的 A 版「奶油方糖」。

安装数据默认保存在 `%LOCALAPPDATA%\XiaoXi_Agent`，不写入安装目录；旧版 `com.qinbai.baiagent` 目录会在升级首次启动时自动迁移。开发版个人数据、API 密钥和测试记录不放入安装包。开发版与安装版默认使用不同的数据目录；使用前先退出另一个XiaoXi，避免占用同一个本机服务端口。安装版首次使用需要配置自己的模型连接。

版本交付、验证范围与构建说明见 [0.1.2 发布记录](docs/releases/0.1.2.md)。

## 开发启动

本机依赖已经安装。双击项目根目录的 **`启动测试版.cmd`**。启动器在后台运行开发服务，第一次编译或依赖变化后需要等待；再次启动会打开已有窗口。

也可以在 PowerShell 中运行：

```powershell
Set-Location -LiteralPath 'C:\QinBai\Personal_Works\Project\261005-XiaoXi_Agent'
pnpm desktop:dev
```

桌面程序自动启动 Python 后端。正常启动桌面时不需要再手动执行 `backend:dev`。关闭主窗口后留在托盘运行；双击托盘图标打开窗口，通过托盘菜单或「关于这个空间 → 退出XiaoXi」彻底退出。

启动器使用 Windows 自带的 PowerShell 5.1，无需另装 PowerShell 7。开发环境依赖 Node.js/pnpm、Python 3.12/uv、Rust 和 Windows WebView2/MSVC 构建环境。新机器先准备这些环境，再运行：

```powershell
pnpm install --frozen-lockfile
uv sync --project backend --frozen
pnpm desktop:dev
```

开发启动日志位于 `.local-data\dev\desktop.log`。开发可执行文件依赖本项目、Python 虚拟环境和前端开发服务；分发时使用上方安装包。

## 第一次使用

1. 打开「连接与设置」，填写服务商的 **OpenAI 兼容接口地址、模型名称、API 密钥**。接口地址一般包含 `/v1`，以服务商说明为准。模型需要支持 Chat Completions 和工具调用。点击「保存并测试模型」会发起一次真实模型请求。
2. 需要提交图片时，确认模型支持图片，再勾选图片输入。不要仅依据模型名称推测是否支持。
3. 天气、计算器、日期与时区、单位换算已内置，无需额外工具密钥。需要联网搜索和读取网页时，另外填写 **Tavily API 密钥**。模型密钥与搜索密钥是两个不同配置；未配置搜索不影响其他内置工具。
4. 在对话中说「我想系统学习前端，从零开始，目标是做一个个人网站」，或打开「学习 → 新的学习目标」，填写主题、目标和基础。

学习会保存模块、前置关系、知识点和练习标准。选择一个知识点后，获得讲解、示例与练习；用文字、代码片段或图片提交，模型给出有依据的反馈。练习未通过可以补讲并重练；跳过会标记「尚未验证」。学习进度与练习等待状态在重启后恢复。通过练习后，可以主动安排次日复习提醒。

记忆默认自动保存明确、稳定的普通偏好，并提供撤销；敏感信息和推测内容等待确认，临时信息留在当前对话。可在记忆页切换「自动记忆 / 每次确认」，查看来源、编辑或删除。明确说「请记住……」已有授权，直接保存；历史对话单独保留。规则见 [记忆保存与确认](docs/memory.md)。

计划支持全天、定时、每天／每周／每月重复及多个提醒。完成本次与结束整个系列分开操作；关闭提醒保留计划，通知「知道了」只标已读，「稍后提醒」只推迟本次通知。界面默认使用**北京时间**。电脑开机且XiaoXi在托盘运行时，提醒可以通过独立窗口显示，同时尝试发送 Windows 通知。应用退出、电脑关机或休眠时不能按时弹出；恢复运行后补充一次逾期提示，重复事项跳到下一次时间，不逐条补发历史遗漏。

## 对话中的工具

直接发送「广州未来三天会下雨吗」「帮我算 `(199 + 89) * 0.85`」「30 天后是星期几」「5 英里是多少公里」「明天早上九点提醒我读书」等请求即可。工具菜单用于查看内置能力、填入示例和检查搜索配置，不需要先选择工具才能提问。一次请求可以组合多个工具。

当前封装了 13 个工具。天气接入 [Open-Meteo](https://open-meteo.com/en/docs)，同名地点会要求确认；查询失败会返回错误，不使用模型知识伪造天气。回答下方可以展开最近一轮的工具结果，重新打开对话后仍可查看。

开发接入说明见 [docs/tools.md](docs/tools.md)。

## 数据与密钥

- 正常开发空间：`.local-data\dev`。SQLite 保存对话、课程、练习、记忆、提醒和执行记录；`checkpoints.sqlite` 保存 LangGraph 状态，图片保存在 `attachments`。
- 安装版空间：`%LOCALAPPDATA%\XiaoXi_Agent`。后端日志为该目录下的 `backend.log`；更新程序时数据保留在用户目录。旧版 `com.qinbai.baiagent` 的数据库、附件和技能会自动迁移，已保存的 API 密钥从原凭据项读取并复制到新位置；WebView 缓存留在旧目录。
- API 密钥通过 `keyring` 写入 Windows 凭据存储，不写进数据库、前端代码或 Git。接口地址不能内嵌用户名和密码。留空密钥表示保留已有配置，勾选清除才删除。
- 本机 API 仅监听 `127.0.0.1:8766`，前端开发服务使用 `127.0.0.1:5186`。不要把当前版本的服务直接暴露到公网。
- `.local-data\review` 是开发验证数据，连接本地模拟接口时会显示「隔离测试 · 模拟接口」。正常空间没有内置模拟回复，也不会自动调用任何外部模型。
- 备份前退出应用，再复制整个数据目录。密钥存储单独管理，复制数据库不会复制密钥。

## 当前边界

当前尚未实现云端账号、跨设备同步、iPhone 客户端、手机推送、关机后的持续提醒及 App Store 上架。下一阶段按 PLAN.md 接入云端，然后做 iPhone 客户端。

当前开发版增加了可选的微信文字聊天与提醒渠道：在「连接与设置 → 微信」扫码连接，主动发一条消息后可尝试聊天；提醒需要另外开启「到期提醒同时发送到微信」。需要电脑开机且XiaoXi运行。已完成隔离测试，真实扫码、平台兼容与手机收件尚待验收；原安装包不包含本次改动。操作、渠道限制和验收步骤见 [微信接入说明](docs/wechat-integration.md)。

文字与图片反馈属于模型分析，本版本不自动运行用户代码，也不现场验证操作结果。联网搜索返回链接和摘要，读取正文失败时工具明确报告失败。真实教学质量、来源选择和特定服务商兼容性需要接入你的模型后评估。

## 开发与验证

```powershell
# 后端自动测试：自动使用独立的临时目录，不打开个人数据库
.\backend\.venv\Scripts\python.exe -m pytest backend/tests -q
# SSE 解码与错误呈现测试
pnpm test
# 生成 API 类型、检查类型并构建前端
pnpm api:types
pnpm build
# Rust 检查，不打包
cargo check --manifest-path src-tauri/Cargo.toml
# 封装后端、构建 Windows x64 NSIS 安装包并复制交付文件
pnpm release:windows
```

浏览器端到端测试使用本地模拟模型。先退出桌面应用，再分别在三个终端启动下列服务，每个终端设置相同的 `BAI_DATA_DIR`：

```powershell
# 终端一：隔离的后端
$env:BAI_DATA_DIR = 'C:\QinBai\Personal_Works\Project\261005-XiaoXi_Agent\.local-data\review'
$env:BAI_MODEL_API_KEY = 'synthetic-key'
uv run --project backend uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8766 --no-access-log
# 终端二：前端（也设置上面的 BAI_DATA_DIR）
pnpm dev
# 终端三：本地协议测试服务
uv run --project backend python backend/tests/mock_provider.py
```

然后运行 `pnpm exec playwright test`，使用本机 Chrome。测试会在隔离空间创建测试对话和课程，不产生真实模型费用。**不要对正常个人空间运行这些浏览器测试。** Windows 原生验证另用 `tests/native.verify.mjs`，需要桌面开发进程开启 CDP 9227，并已有浏览器测试保存的前端课程。

已验证的结果与未验证事项见 [docs/verification.md](docs/verification.md)。

### 记忆检索与独立测试版

双击 `启动测试版.cmd` 打开独立的桌面测试版。测试版使用 `.local-data/preview-runtime` 保存自己的数据库和凭据，可在设置中添加真实聊天模型，并通过「语义记忆检索」卡片单独配置 Embedding 地址、模型和密钥。模拟验收数据保存在其他目录，不作为测试版的默认模型连接；不会自动导入安装版或原开发版的个人配置。

连接页面用卡片展示状态，点击配置或管理后再编辑。聊天回答下方的「检索依据」查看当次运行保存的记忆候选、分数和选入结果；「设置 → 记忆 → 检索调试」可输入问题试查当前记忆。手动试查不调用聊天模型，启用语义检索时会调用 Embedding 服务。

人工功能评测（170 条对话任务、测试素材与记录模板）见 [XiaoXi 功能评测集](docs/evals/README.md)。评测用例的预期不等于真实模型已通过；请在独立测试版中执行。
