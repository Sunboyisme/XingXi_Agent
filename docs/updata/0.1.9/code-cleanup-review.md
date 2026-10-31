# XiaoXi 全库静态审查与代码清理

日期：2026-10-30。状态：已完成静态审查与确认项清理，尚待用户功能验证。

## 审查范围与方式

- 前端：180 个 TypeScript／TSX 源文件，包括组件用例；从 `src/main.tsx` 追踪静态导入、类型引用、再导出和字面量动态导入，覆盖 144 个可达模块，核对 259 个本地值导出。没有发现可确认删除的孤立生产模块或无引用值导出。
- 后端与 Python 脚本：159 个文件，包括应用、迁移、测试和工具脚本；结合 AST 引用分析、Ruff、Vulture 候选及注册位置复核。
- 桌面端：通过 Cargo Clippy 检查所有 Rust 目标，包括测试目标的编译；没有执行测试程序。另行核对 Tauri 命令注册、平台条件编译和安装版迁移入口。
- 配置与 JavaScript：45 个配置／脚本／浏览器用例文件的未使用声明和不可达语句检查；其中 16 个 `.mjs` 文件通过 Node 语法检查。三个 PowerShell 脚本通过原生解析器检查，没有运行打包或验收脚本。
- 样式：核对旧周历和旧每日详情弹窗的类名与当前 JSX；只删除已确认不再生成的类名规则，保留动态状态及仍被当前组件继承的样式。

## 已清理项目

| 类别 | 文件 | 修改 |
| --- | --- | --- |
| 未调用函数 | `scripts/build-eval-report.py` | 删除从未引用的 `short()` 摘要助手。 |
| 未引用导入 | `backend/tests/test_context_feedback.py`、`test_eval_files.py`、`test_project_workspace.py` | 删除 `wait_run`、`db`、`io`、`config` 四处导入。 |
| 未引用导入 | `tests/browser/app.spec.ts` | 删除 `readFileSync` 和 `resolve` 两处导入。 |
| 无效内部参数 | `backend/app/tools.py` | 移除私有 `utility_result()` 未使用的 `name` 参数及三处固定名称实参，公开工具签名保持不变。 |
| 回调占位参数 | `backend/app/complex_tasks.py`、`context_archive.py` | 两处内部读取回调改用 `**_arguments` 明确表示忽略转发参数，继续接受守卫按关键字调用。 |
| 冗余判断 | `backend/app/model_profiles.py` | 去掉已被 `"qwen" in leaf` 覆盖的模型名称枚举分支，合并等价嵌套条件。 |
| 冗余判断 | `backend/app/schemas.py` | 合并练习反馈校验的嵌套条件，保持短路顺序和错误内容。 |
| 冗余中间变量 | `backend/app/office.py` | 图片读取结果直接返回，不再先赋给 `reading`。 |
| 冗余 Rust 写法 | `src-tauri/src/desktop.rs`、`voice.rs` | 删除两处重复借用及无析构作用的 `drop(state)`，合并截图隐藏窗口时的嵌套条件；互斥锁守卫的释放保留。 |
| 过宽的静态检查屏蔽 | `src-tauri/src/main.rs` | 迁移助手的 `dead_code` 屏蔽仅对调试构建生效，并注明安装版入口。 |
| 无界面引用的 CSS | `src/styles/plans.css`、`version-013.css` | 删除旧 `plan-week-view`、`plan-weekday`、`plan-week-allday`、`plan-week-allday-label`、`week-allday-event`、`plan-week-column`、`plan-week-scroll`、`plan-week-times`、`plan-agenda-dialog` 九组类名相关规则。当前仍使用的 `plan-week-grid` 和 `week-event` 基础样式保留。 |

## 已核对并保留的项目

- FastAPI 路由、Pydantic 校验器、SQLAlchemy 事件、模型中间件和 Tauri 命令通过注册或框架约定调用，不因缺少显式函数调用而删除。
- `migrate_legacy_data()` 在安装版条件编译分支中实际使用；删除会影响旧数据迁移，因此保留。
- Pydantic 校验器的 `cls`、FastAPI 异常处理器的 `request/error`、`ContextBudget.tool_tokens`、`queue_message.db`、公开工具的 `explicit_request` 以及评估回调的 `events` 保留。其中存在框架必需参数和既有调用约定，删除或改名会改变接口。
- `office_worker.py` 的 `print()` 是子进程 JSON 通信协议；生成、评估和验收脚本的 `print()`／`console.log()` 是命令行结果输出。它们不是遗留调试语句，不删除。应用前端、Rust 和后端未发现遗留的 `console.log/debug/trace`、`debugger`、`dbg!`、`println!` 或 `breakpoint()`。
- 前端依赖仍有实际 import、类型或构建工具用途，未修改依赖清单与锁文件。辅助依赖扫描曾将明确存在的 import 报为未使用，未采信该结果执行删除。
- 未删除历史数据库迁移、历史验收脚本、生成 API 类型、带保留说明的兼容代码、个人数据或截图。

## 开发检查与边界

- TypeScript 编译通过，包括显式禁止不可达语句和未使用标签的检查；Vite 生产构建通过，保留既有分块体积提示。
- Ruff 的未使用导入／局部变量、重复定义、无效引用、冗余自赋值和注释死代码检查通过；全部 Python 文件通过 AST 语法解析。候选扫描未再发现未引用的无装饰器顶层定义或完全相同的多语句顶层函数体。
- 修改的六个后端模块已静态对照原版本：公开函数、已装饰函数参数和数据模型字段签名没有变化。此项是源码结构核对，不等于接口行为验收。
- Cargo Clippy 编译通过，未使用代码相关检查无告警。保留 `drop_files::collect` 参数较多的一条风格提示；该函数参与文件读取限制和递归，不属于死代码，本轮不为消除风格提示改写它。
- 未运行单元测试、浏览器／原生窗口功能验收、模拟数据、真实模型、计时／声音或微信收件检查。静态分析也不能证明所有动态路径；本轮只清理证据充分的项目，不声称全库绝对不存在无用代码。
- 独立测试版复用 `.local-data/preview-runtime` 的既有真实连接、数据与凭据，更新后保持打开。日历布局、桌面截图／语音以及工具和文件读取行为由用户继续确认；尚未构建安装包。

## 2026-10-31 追加审查

本节记录后续复核，不覆盖上方 10 月 30 日的历史结论与验证状态。

### 本轮确认并清理

| 类别 | 文件 | 引用证据与处理 |
| --- | --- | --- |
| 单次调用包装与无效内部参数 | `src/components/DesktopQuickAsk.tsx` | `refreshSettings(report)` 只有 `shown()` 中的一个调用，且实参固定为 `false`，错误提示分支无法启用。将请求移回该位置，删除包装和参数，继续在后台刷新失败时沿用已缓存设置。等待后的前置守卫已保证组件挂载，移除后续同一同步条件中的重复检查。 |
| 无效内部参数与冗余请求属性 | `src/components/LearningPage.tsx` | `ensureSession()` 的两个调用只传节点 ID，从未传 `minutes`。删除第二个私有参数和 `target_minutes: undefined` 属性；JSON 原本不发送该属性，后端会话 API 和其他入口的时长设置不变。 |
| 被覆盖的条件 | `backend/app/model_profiles.py` | `leaf.endswith("-thinking")` 为真时，后面的 `"thinking" in leaf` 必然为真，删除前者，不改变短路条件的结果。 |
| 旧型号分支 | `backend/app/quick_setup.py` | `model` 只能来自当前预设的 `names`；硅基流动生图集合仅含 `Tongyi-MAI/Z-Image-Turbo`，百炼先取 `auto`。删除无法命中的 `Qwen/Qwen-Image` 专用尺寸分支，保留两家现用默认尺寸。 |
| 无界面引用的样式 | `src/styles/feedback-016.css`、`src/styles/version-014.css` | 删除旧 `plan-week-column`、`plan-agenda-dialog` 和 `plan-week-repeats` 三组共八条规则。全局引用与 JSX 动态类名复核均未发现生成端；当前 `plan-agenda-list` 和 `plan-week-grid` 保留。 |

### 复核覆盖与保留项

- 前端扫描覆盖 187 个 TypeScript／TSX 文件，入口追踪到 151 个模块，核对 357 个导出（含类型及再导出）和 268 个本地值导出；未发现孤立生产模块、无引用值／类型导出或仅被测试引用的值导出。`WeekPlacement` 虽没有外部具名导入，仍是 `fitWeekPlans()` 使用的返回类型，不删除。
- Python AST 扫描覆盖后端和脚本 161 个文件；额外按模块解析导入别名与属性调用，避免同名函数掩盖无引用定义。本轮未发现可确认删除的无装饰器顶层定义或完全相同的多语句顶层函数体。
- 45 个配置、工具和浏览器用例文件的未使用声明／不可达语句静态检查没有发现新增问题，其中 16 个 `.mjs` 文件通过 Node 语法检查。
- 继续保留 FastAPI 路由、Pydantic 校验器、SQLAlchemy 事件和 LangChain／HTTPX 扩展方法等动态注册入口；`cls`、框架回调参数、公开工具参数和持久化字段不因静态候选提示删除。历史迁移、验收脚本、兼容代码和生成类型保留。
- CSS 的 `handle-${h}`、`corner-${corner}`、`is-${tone}`、`is-${doc.status}` 都有实际生成端，不能按完整类名字面量缺失删除；对应截图操作、通知色彩及文件状态规则均保留。
- 应用源码未发现遗留的 `console.log/debug/trace`、`debugger`、`breakpoint()`、`dbg!` 或 `println!`；`office_worker.py` 的 `print()` 属于 JSON 进程协议，生成与评估脚本输出属于命令行结果，继续保留。相近但回退语义不同的错误格式化函数也未强行合并。

### 开发检查与交付状态

- TypeScript 严格编译（含未使用声明、参数、不可达语句及无用标签）、Vite 生产构建、Ruff、Python AST 语法解析、JavaScript 语法检查和差异检查完成。两个修改后端模块的公开函数、装饰器与数据模型签名与本轮基线相同；没有修改公开 API 或依赖清单。
- Cargo Clippy 全目标静态编译完成，没有无用代码相关告警；原有 `drop_files::collect` 参数数量风格提示保留。本轮没有修改 Rust 源码，也没有执行测试目标。
- 按 react-best-practices 复核两个组件的异步读取、挂载检查与状态更新；学习请求仍先保存草稿，桌面刷新仍在等待后检查当前挂载与可见状态。
- 独立测试版启动器成功退出，已确认预览路径下的应用进程和主窗口句柄存在，保持打开；继续使用独立标识及固定 `.local-data/preview-runtime` 的既有数据与真实连接。这只是启动状态确认，实际桌面对话、学习会话、模型配置与日历表现待用户验证。
- 未执行单元测试、自动化、模拟、原生窗口交互、真实模型或微信收件验收；未构建安装包，未主动推送。本轮代码与记录整理为本地提交，提交不代表验收通过。

## 2026-10-31 · 图文功能后的冗余复查

- 本轮范围：198 个前端 TypeScript／TSX 文件，入口可达模块 162 个，核对导出 388 个；未发现孤立生产模块。唯一未被外部直接引用的 `WeekPlacement` 仍用于 `fitWeekPlans()` 的返回类型，保留。Python 应用、迁移、测试及脚本共 172 个文件完成 AST 解析与顶层函数体重复扫描，没有完全相同的多语句顶层函数候选。
- 确认删除：小窗口失效的划词返回参数／分支／图标；旧正文 textarea 样式；关闭 15 个扩展的 StarterKit 包装及 19 个无用依赖包。改用相同版本、相同默认配置的实际扩展，保留图片节点、换行、光标、末尾段落和撤销重做。
- 确认简化：共享凭据解除函数返回值直接用于提醒，取消重复依赖查询；常用文本素材及导出过程改为集合推导，导入校验的编号字典改为集合；原生图片复制移交已有 RGBA 数据，取消整份像素缓冲区克隆。
- 保留依据：CSS 剩余字面量缺失候选均有动态生成端或属于 ProseMirror；标注文字输入的 `.common-image-text-entry` 仍在使用，恢复并保留。两个截图边界计算函数对最小文字尺寸的约定不同，本轮未强行合并；异步读取状态、同步锁、挂载守卫及 StrictMode 延迟释放均有独立用途。未删除框架动态注册入口、迁移、兼容接口、用户素材或验收脚本。
- 开发检查：TypeScript 严格编译（含不可达语句和无用标签）、Vite 构建、Rust Clippy 编译、修改 Rust 文件格式检查、Python F／E9／PLW0127／ERA001、Git 差异检查完成。三个修改 Python 模块的函数签名和装饰器与 HEAD 一致；完整 Ruff 逐文件基线对照为素材模块 0 项、数据导入导出模块 7 项、主模块 66 项，均未新增，未将框架约定及风格提示当作死代码删除。Clippy 继续保留 `drop_files::collect` 参数较多的原有提示。
- 交付边界：独立测试版重新编译启动、主窗口恢复并保持打开，沿用固定 `.local-data/preview-runtime` 的已有数据、凭据及真实连接；未执行任何功能验收或构建安装包。本轮两份更新记录同步保存并整理本地提交，用户验证状态仍为待确认。
