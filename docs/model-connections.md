# 模型连接

设置页以连接列表管理配置。每套连接有独立名称、服务商类型、接口地址、凭据引用和模型列表，同一服务商可配置多套。添加和编辑在弹窗中完成；图片与思考参数收进模型的“能力设置”。主页面仅保留一个默认模型选择器，以“连接名称 · 模型名称”区分来源。

阿里云百炼、DeepSeek、Kimi、智谱和硅基流动提供接口与模型示例，自定义接口保留自由输入。预设仅用于新建连接，不会生成已连接状态；状态中的“已配置”表示密钥和模型字段存在，连通性需用户点击“保存并测试模型”验证。

凭据按连接 ID 保存在系统凭据管理中。旧版 `model` 凭据和单模型设置保留为原有连接；新连接使用 `model:<connection-id>`，SQLite 与读取 API 均不返回密钥。删除连接同时移除对应凭据，删除默认连接会回退到剩余连接。

聊天可选择任意已配置连接中的模型，每次发送时保存接口、模型、图片能力和思考开关的快照。重试沿用原快照；后续修改默认模型不会改变正在运行的请求。学习等其他入口使用全局默认模型。默认关闭可切换模型的思考；始终思考的模型显示不可关闭状态，未知模型不会擅自发送扩展参数，可在能力设置中指定接口协议。

`CompatibleChatModel` 保留服务商返回的 `reasoning_content`，并在流式工具调用后原样回传；同模型下一轮所需的上下文保存在消息的内部字段中，不暴露在聊天消息 API。聊天工具菜单只展示 MCP 工具开关，内置工具继续自动参与 Agent 调用。

接口与参数依据官方文档核对（2026-10-17）：

- [百炼深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking)：`enable_thinking`，预设中国内地兼容接口；其他地域需自行调整地址与对应密钥。
- [DeepSeek 思考模式](https://api-docs.deepseek.com/guides/thinking_mode/)：`thinking.type` 和工具轮次的 `reasoning_content`。
- [Kimi 思考模型](https://platform.kimi.com/docs/guide/use-thinking-models)：K2.6 可切换，K3 / K2.7 Code 始终思考。
- [智谱思考模式](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)：`thinking.type`，GLM-5.3 系列始终思考。
- [硅基流动 Chat Completions](https://api-docs.siliconflow.cn/docs/api/chat-completions-post)：Qwen3 的 `enable_thinking`；[兼容地址](https://docs.siliconflow.cn/docs/userguide/quickstart)。

本轮使用本地协议服务验证请求参数、流式工具调用、独立凭据、持久化、迁移和界面交互；没有使用用户真实密钥调用这些服务商。安装包需等待本轮桌面测试验收后构建。

验证结果：139 项后端测试、26 项前端测试、17 项浏览器交互检查通过；TypeScript 与 Vite 构建通过。原生测试窗口视口为 1266 × 710，配置弹窗和保存按钮均在可见区域内；700 × 480 的窄矮窗口检查也通过。Vite 仍有单个 JS chunk 超过 500 kB 的构建提示，本轮未做无关拆包。

## 2026-10-31：快速配置与共享密钥

模型连接页新增两个快速入口：硅基流动用于首次配置，阿里云百炼用于已有阿里云账户（北京地域）。用户粘贴一份 API Key，系统读取 `/models`，从维护的推荐列表选择对话模型，并补齐空的语义检索、生图、语音输入和朗读配置。已有默认模型和能力设置保留；部分配置、已停用但保留型号的能力也不覆盖。联网搜索仍单独配置。

模型列表不是调用权限或余额的证明。百炼的兼容模型列表可能不包含原生生图等服务，这些服务和语音能力会填写官方预设；完成页显示保存结果，实际调用由用户确认。推荐模型不在对话列表中时不保存新连接，提供手动配置路径。快速配置不发起生图、合成或其他生成探测。

能力设置中的“密钥来源”可选择同一接口来源的已有模型连接，也可使用独立密钥。JSON 只保存 `credential_connection_id`，每次调用按连接 ID 从系统凭据管理读取密钥，换密钥无需逐项重填。协议、域名和端口必须与来源连接相同，标准默认端口按同一来源处理。仍有能力引用的连接不能直接删除或更换接口域名，应先调整能力密钥来源。原有独立凭据不迁移、不清除。

硅基流动生图使用 `image_size` 和 `images` 响应结构；百炼千问生图沿用原生协议并由服务商选择默认尺寸。语音朗读同时处理普通播放和设置内试听的凭据引用；记忆与知识库共用 Embedding 凭据解析。

预设依据：[硅基流动快速开始](https://docs.siliconflow.cn/docs/userguide/quickstart)、[Agent 配置示例](https://docs.siliconflow.cn/docs/usercases/use-siliconcloud-in-yan)、[语音合成](https://docs.siliconflow.cn/docs/userguide/capabilities/text-to-speech)，以及[百炼接口地址](https://help.aliyun.com/zh/model-studio/base-url)、[视觉理解模型](https://help.aliyun.com/zh/model-studio/vision-model)、[Embedding 兼容接口](https://help.aliyun.com/zh/model-studio/embedding-interfaces-compatible-with-openai)。

本轮完成接口类型生成、编译和语法／差异检查，没有执行本轮自动化或真实模型验收；不沿用上文历史版本的通过结论。实际效果仍待用户在固定数据目录的独立测试版中确认。

### 同日后续调整：指定型号与空配置修正

按用户指定，硅基流动文本预设改为 `deepseek-ai/DeepSeek-V4.1-Flash` 与 `zai-org/GLM-5.3-Flash`，快速配置会同时添加账户列表返回的两个型号，优先将 DeepSeek 设为全局默认，缺失的指定型号单独显示待配置。手动连接仍可添加更多型号，每个连接上限五十个。向量改用 `BAAI/bge-m3`，图片改用 `Tongyi-MAI/Z-Image-Turbo`；语音预设和百炼入口保持原有型号。

本次修正替代上文按“有保存内容”保留部分配置的规则：能力必须有接口、型号和可解析凭据才算已配置，完整但停用的配置仍保留；空表单、孤立密钥和未配齐的能力在再次快速配置时补齐。不会清除原有独立凭据。此前误显示已保留的空配置需重新执行快速配置应用新预设，不在启动时修改用户配置。

硅基流动 DeepSeek 采用 `enable_thinking` 控制开关，仅在思考开启时发送已配置的强度；避免使用该接口未列出的 `reasoning_effort=none`。依据：[硅基流动 Chat Completions 参数](https://docs.siliconflow.cn/docs/api/chat-completions-post)、[思考模型说明](https://docs.siliconflow.cn/docs/userguide/capabilities/reasoning)和 [GLM-5.3-Flash 官方部署说明](https://github.com/vllm-project/recipes/blob/main/models/zai-org/GLM-5.3-Flash.yaml)。本轮仍只有编译与静态检查，实际调用待用户验证。

## 2026-10-31：工作上下文、自动思考与提示缓存

模型窗口继续约束请求的物理容量；日常单轮输入默认使用 32,768 token 的工作预算，复杂任务步骤默认 65,536 token。历史在工作预算内提前整理为摘要和近期消息，原文保留并可检索。当前消息或必要工具资料较大时，工作预算可扩展至模型允许的输入额度。上下文提示分别显示本轮额度和模型窗口，生成空间仍单独保留。

聊天思考菜单默认提供“自动（按任务）”：普通请求关闭可切换思考，复杂任务规划／执行或明确深入推理请求使用支持的适度强度。选择关闭或具体强度后，正式回答沿用手动选择；可随时切回自动。强制思考模型保持开启，有明确强度列表时，小任务采用最低支持强度。分类、摘要和交付核对独立采用节省策略，避免继承正式回答的高强度；旧运行快照保留原选择。

普通请求直接进入智能体工具循环，多阶段或多成果任务以及旧任务补充继续使用任务规划。需要模型分类时，仅发送当前消息一次、最近四条背景摘录和短任务目录；实际执行仍读取原始要求。用量页面分别标注任务分类、任务规划和交付核对，便于查看额外调用的消耗。

提示按固定规则、稳定目录、已加载规则、运行资料、时间的顺序组织，目录及 JSON 排序保持确定。官方 OpenAI 接口使用稳定缓存键，GPT-5.6 及之后已支持的模型另设显式前缀边界；其他兼容接口保留普通请求参数，由服务商自身处理缓存。缓存命中及写入用量以真实响应为准，不承诺固定节省比例，也不缓存业务操作结果。

缓存参数依据：[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Chat Completions 参数](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。本轮仅完成编译及静态检查，实际缓存命中、思考行为和费用仍待用户验证。
