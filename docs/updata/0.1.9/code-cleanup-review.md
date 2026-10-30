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
