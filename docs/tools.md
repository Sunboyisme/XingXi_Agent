# 对话工具箱

开发版已增加统一工具开关、MCP 服务管理和来源记录，操作见 [MCP 与统一工具管理](mcp.md)。目录包含全部内置与已发现的 MCP 工具，Agent 每轮仅获得已启用且可用的工具；执行前再次检查开关。未配置搜索时，搜索工具仍在目录中，但不会提供给模型。

用户输入自然语言 → FastAPI 创建 Run → LangChain Agent 选择工具及参数 → Python 执行工具 → 工具结果返回模型 → SSE 显示回答及调用记录。工具由 Agent 根据自然语言调用。聊天区 MCP 菜单仅显示外部工具及其开关；设置页继续管理完整目录。模型需支持工具调用。

`backend/app/tools.py` 的 `build_tools(run_id, conversation_id)` 返回可直接交给 `create_agent` 的工具列表；`TOOL_INFO` 保存菜单描述。`GET /api/v1/tools` 返回当前工具配置状态，复用原有本机认证。`GET /api/v1/runs/{run_id}/tools` 返回已持久化的调用结果，供重新进入对话时恢复最近一轮记录。

| 工具                                                   | 用途                                   | 外部配置               |
| ------------------------------------------------------ | -------------------------------------- | ---------------------- |
| `get_weather`                                          | 城市当前天气、未来 1–7 天预报          | 无需密钥，需要网络     |
| `web_search`、`read_url`                               | 联网检索、提取公开网页正文             | Tavily 密钥            |
| `calculate`                                            | 十进制算式、括号、幂、整除、余数       | 无                     |
| `date_time`                                            | 当前时间、日期偏移、时区换算、日期间隔 | 无                     |
| `convert_units`                                        | 长度、重量、体积、温度、速度、时长换算 | 无                     |
| `search_memories`、`remember`                          | 查询与保存记忆                         | 无                     |
| `create_plans`、`list_plans`、`update_plan`、`action_plan` | 日历安排、重复及提醒 | 无 |
| `list_todos`、`create_todo`、`update_todo`、`action_todo` | 独立待办与跟进提醒 | 无 |
| `list_files`、`search_file`、`read_file` | 授权资料的目录、全文定位与分段读取 | 无 |
| `learning_goals`、`create_learning_goal`               | 查询学习进度、生成并保存学习路线       | 课程生成使用已配置模型 |

天气适配在 `backend/app/weather.py`：先查询城市坐标，再查询预报；返回具体地点、当地时间、单位、获取时间及来源 URL。同名地点返回候选列表，Agent 应先询问用户，再传入候选的 `location_id`。未找到城市、数据不完整、网络错误均明确报告。当前天气来自气象模型，不能当成气象站实测；公开服务按个人使用方式接入。

接口规范：[Open-Meteo 地理编码](https://open-meteo.com/en/docs/geocoding-api)、[Open-Meteo 预报](https://open-meteo.com/en/docs)、[Tavily Search](https://docs.tavily.com/documentation/api-reference/endpoint/search)。

本地计算在 `backend/app/utilities.py`：算式解析 AST，只允许数字和算术运算，不调用 `eval`；限制输入长度、节点数、幂与结果范围，使用 28 位 Decimal 精度。日期输入为 ISO 8601，默认北京时间；无 UTC 偏移的时间按指定时区解释，跨夏令时的模糊时间要求明确偏移。日期间隔返回实际经过秒数及对应 24 小时天数。单位换算拒绝跨类别、不支持的单位、非有限数和低于绝对零度的温度。

工具结果写入 RunEvent 并通过 SSE 呈现。外部服务失败返回结构化错误，工具记录区显示「调用失败」。日历在用户明确委托且信息齐全时实际执行；仅讨论不写入，模糊项集中追问并先处理独立明确项。普通稳定偏好按记忆设置生效，私密/推测信息未授权时待确认；auto下明确纠正已生效记录支持直接更新和撤销。

扩展时添加有明确参数说明的 `@tool` 函数，在 `build_tools` 和 `TOOL_INFO` 中注册，；聊天菜单无需为内置工具添加入口。后端测试检查注册工具与菜单一致、实际 LangChain 工具循环、错误结果与记录持久化；天气和搜索使用 MockTransport 或本地模拟模型，未验证真实服务商的回答质量。


## 0.1.8 评测整改接口（2026-10-28，待用户验证）

- `search_file(file_id, query, offset=0, limit=8)`只检索当前对话/项目授权文档的已解析正文，返回`matches`、`part`、`source`、`read_start`、`searched_parts`与`next_offset`；命中需继续读取原文，未命中不代表原文无答案。`read_file`返回`coverage`与文档片段总数，完整范围仍受解析警告限制。
- `create_text_file`支持`content`或仅CSV的结构化`rows`，两者互斥；CSV统一转义、校验列数并保留公式注入防护。Excel生成返回`calculations`，公式值与文件缓存一致；可识别销售额/目标的完成率列额外校验比例。
- `create_plans`兼容原参数，增加可选逐项`reminder_evidence`，仅接受当前用户或本轮实际读取文件的逐字依据；存在冲突时返回实际已保存的`value`和待确认项。重复系列查询有`series_revision`，整个系列按编号及版本核对，普通事项仍执行本地日期校验。
- 成功普通回答的`retry_action=retry`表示只读重组，不能新增写入、文件、脚本或付费生成；已有文件卡直接复用。产物返回`current`、`revision`以标记同名修订，原文件保留。
- 学习提交可带`exercise_id`，旧客户端省略时绑定服务端当前题；过期标识返回409。公开作答要求与内部评分标准分开，逐项判分与本次作答证据不进入公开接口。

代码与提示调整不等于验收通过，逐项状态见[74项整改记录](evals/results/2026-10-27/整改记录.md)。
