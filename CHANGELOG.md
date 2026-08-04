# Change Log

## 0.6.4 - 2026-08-04

- 改进聊天错误提示：常见 HTTP 状态码现在显示简短、可操作的中英文说明，例如 503 显示“模型服务暂时过载或不可用，请稍后重试”，不再把上游响应正文、request ID 和 Extension Host 调用栈直接暴露在聊天界面。
- 流式响应中断、速率或额度限制、上下文窗口超限、仅支持 WebSocket 的 Responses 端点及长对话网关失败均提供针对性提示；完整的安全结构化信息仍保留在扩展诊断日志中供排查。

## 0.6.3 - 2026-08-02

- `openai.reasoningSummary` 默认开启：Responses 请求自动带 `reasoning.summary: "auto"`，无需配置；网关不支持该字段时可在固定模型上显式声明 `false` 关闭。

## 0.6.2 - 2026-08-02

- `weavenet-copilot.openaiApiStrategy` 默认值由 `auto` 改为 `chat`。Responses 与 Chat Completions 的规范化前缀不同，自动探测把已有连接切到 Responses 会造成 Prompt 缓存整体冷启动、首字时延上升；改为默认 Chat Completions 后不再自动切换协议，需要 Responses 时显式选择 `responses` 或 `auto`。
- 修复固定模型与自动发现模型合并时抹掉能力元数据的缺陷。此前合并按整体展开，固定模型未声明的字段会以 `undefined` 覆盖发现结果——只想补一条 `openai` 能力的固定模型会连带丢掉 `toolCalling`、`maxInputTokens`、`name` 等元数据，进而导致工具调用被整体禁用。现在固定模型只覆盖它真正声明过的字段，`openai` 能力对象亦按字段合并；元数据来源标注只对被覆盖的字段更新。
- 新增 `openai.reasoningSummary` 能力（仅 Responses 协议，默认关闭）：启用后请求带 `reasoning.summary: "auto"`，模型在最终答案前流式输出可读的思考摘要，缩短长推理场景的可见空窗期。不支持该字段的网关可能返回 400，关闭即可；调试日志新增 `reasoningSummary=` 字段。

## 0.6.1 - 2026-08-01

- 新增应用级 `weavenet-copilot.openaiApiStrategy` 设置（`auto` / `chat` / `responses`）。协议决策采用安全否决优先级：全局或固定模型任一处显式 `chat` 都强制 Chat Completions；没有 `chat` 时显式 `responses` 强制 Responses；均未指定时才执行现有能力探测。强制策略和模型级声明会跳过无意义的 Responses 探测，设置变化会自动失效旧目录快照并刷新模型。

## 0.6.0 - 2026-08-01

- 拆分 `extension.ts` 以消除 UI 与事务逻辑的混杂（架构风险 #7）：命令控制器（`src/commands/connectionCommands.ts`）、连接变更服务（`src/config/connectionMutations.ts`）与状态栏 presenter（`src/ui/statusBarPresenter.ts`）各自独立成模块，`extension.ts` 只保留激活编排。命令 ID、配置读写、globalState 提示语义与状态栏行为均保持不变，无用户可见变化。
- 澄清模型路由字段的语义（架构风险 #4）：`route` 收窄为目录分组 key（`RouteKey`，`chatgpt` 为历史遗留别名），新增 `catalogSource` 区分模型来自 Relay 自动发现（`discovery`）还是用户固定配置（`configured`）；`protocol` 明确为 wire protocol（Claude Messages / OpenAI 兼容）；`openaiApi` 明确为 OpenAI 协议族内部 variant，`undefined` 等价 `chat`，统一经 `resolveOpenAIApiVariant` 解析。`claude-` 前缀识别收敛为单一 `isClaudeModelId` helper。去重与快照恢复按目录分组隔离，旧快照自动回填 `catalogSource`。行为不变，无用户可见变化。
- 拆分 `provider.ts`（架构风险 #3）：连接池与状态机（`src/copilot/connectionRuntimeManager.ts`，含 profile 同步、代际/修订号守卫的刷新、快照恢复与密钥失效）、模型目录加载与快照持久化（`src/copilot/modelCatalogService.ts`）、picker 模型绑定（`src/copilot/modelBindingRegistry.ts`）、连接诊断探测（`src/copilot/connectionTestService.ts`）各自独立成模块，`provider.ts` 只保留 Provider API 与编排。公共导出与 re-exports 保持不变，行为不变，无用户可见变化。

## 0.5.9 - 2026-08-01

- 持久化 Responses 能力探测结论：探测 verdict 写入 `globalState`，扩展重启后不会立刻对所有模型重新发起付费 `POST /responses` 探测；TTL（与 `metadataRefreshHours` 对齐）与手动刷新清理语义不变。连接删除、配置修订或密钥变更时同步清除对应持久化条目。
- 持久化每个连接最近一次成功的模型目录：Relay 在扩展重启后不可用时，模型选择器仍能恢复上次成功加载的模型列表（按路由分组保留），连接状态显示为降级而非无模型可用。配置修订或 API 密钥移除时同步清除对应快照，避免展示过期模型。

## 0.5.8 - 2026-08-01

- 修复切换到 Responses API 后提示词缓存命中率骤降的问题：Responses 请求此前未发送 `prompt_cache_key`，上游失去缓存亲和路由，多轮请求被分散到不同实例导致前缀缓存大量失效。现在 Responses 请求与 Chat Completions 一致：`openaiPromptCaching` 开启且模型支持时发送相同的 `prompt_cache_key`（含图像的请求仍省略该提示字段）。

## 0.5.7 - 2026-08-01

- 新增 `openai.encryptedReasoning` 能力（Responses 协议，默认关闭）：启用后请求带 `include: ["reasoning.encrypted_content"]`，扩展把服务端返回的 reasoning item（真实 `id` + 加密载荷）原样寄存在会话历史的思考块上，下一轮按原位逐字回传。这是无状态占位回放的规范替代方案——推理内容由服务端加密、客户端无法构造，而回传加密件不需要服务端存储：请求仍为 `store: false`，且从不发送 `previous_response_id`。若宿主未能带回加密载荷，则退化为不发送任何 reasoning item（绝不发送缺少加密载荷的 reasoning item）。
- 流式与全量响应解析现在完整捕获 reasoning 输出项（`id`、summary、`encrypted_content`），并通过新回调对外提供，供上述回放与诊断使用。
- 修复重放历史输出顺序被打乱的问题：`convertResponsesInput` 不再按“文本→推理→工具调用”三段式合并，而是按原始交错顺序产出 input item，`phase` 标注按分段所处位置正确标记（最后一次工具调用之前的文本为 `commentary`，其后为 `final_answer`）。
- 默认行为不变：未声明 `encryptedReasoning` 的请求不带 `include` 字段；`replayReasoningContent` 的占位推理仍紧邻其后的工具调用组发送，每组连续工具调用只发一次。

## 0.5.6 - 2026-08-01

- 修复 Responses 能力探测缓存跨连接串扰的问题：缓存键改为“连接 UUID + 模型 ID”，两个连接即使共用同一 Relay 地址也不会互相继承探测结论；连接配置修订或删除时同步清除对应缓存。
- 修复探测结果误缓存的问题：只有明确的 HTTP 拒绝（400/404/426）才缓存为“不支持”，超时、限流、5xx 与网络故障等临时失败不再缓存，下次刷新会自动重试。
- 修复推理模型探测误判的问题：`max_output_tokens: 1` 下思考可能耗尽全部 token 预算，返回零可见内容但 HTTP 200 的合法信封。探测成功标准改为“HTTP 200 + 合法响应体”，不再因空输出而误判为失败。
- 模型刷新改为接受取消令牌：选择器打开期间的刷新可随选择器关闭而取消，取消不再被记录为连接错误。
- 手动执行 `Refresh Models` 会先清除对应连接的能力探测缓存，再重新探测全部模型，结果立即可见。
- 修复固定模型 `openaiApi` 显式声明被发现结果覆盖的问题：显式配置优先于自动探测，未声明时才沿用探测结论。
- 探测前按模型 ID 去重，目录重复列出同一模型时只发送一次付费 POST。
- 修复 `scripts/probe-responses.mjs` 中 `WEAVENET_MODELS` 白名单过滤结果未生效的问题。
- 新增固定模型 `openaiApi` 配置字段：`responses`（Responses API）或 `chat`（Chat Completions，默认），显式声明优先于自动探测。

## 0.5.5 - 2026-08-01

- 改进 HTTP 426 的错误提示：部分 Relay 分组以 WebSocket 提供 `/responses`，而本扩展使用 HTTP 流式请求。此时不再原样透传网关的 `WebSocket upgrade required`，而是说明成因并给出处置方式（改用以 HTTP 暴露 Responses 的分组，或将该模型路由到 Chat Completions）。
- 免费的 `GET /responses` 端点探测收到 426 时保持 `unknown`，交由每个模型各自的 POST 探测判定。该 GET 不携带 `model`，按模型分组路由的网关只会以默认分组作答，其结论不能推广到同一 Relay 下的其他模型。

## 0.5.4 - 2026-08-01

- 修复严格 Relay 拒绝 Responses 工具调用历史的问题：默认不再回传合成的 `reasoning` item。规范中的 `reasoning` item 必须携带上游返回的 `id`，重放历史无法提供；部分网关据此将 `reasoning.content` 限制为空数组，返回 `array_above_max_length` 的 HTTP 400。DeepSeek 等要求回传思考内容的 Relay 可通过模型能力 `openai.replayReasoningContent` 显式开启。
- 新增可选的 `openai.assistantPhase` 能力：为重放的 assistant 消息标注 `phase`（工具调用前的文本记为 `commentary`，最终回答记为 `final_answer`）。官方文档指出 Codex 系模型丢失该字段会把前导说明误判为最终答案；因旧网关可能拒绝未知字段，默认关闭。
- 更正 0.5.3 说明中的错误表述：Responses 规范的 input item **接受** `role: "system"`（`EasyInputMessage` 与 `Message` 均允许 `system`/`developer`）。改用顶层 `instructions` 是等效且更通用的写法，并非修复规范违规。

## 0.5.3 - 2026-08-01

- 修复 Responses 请求中 assistant 消息 content 分片类型错误的问题：assistant 文本改为规范的 `output_text`（之前误用 `input_text`），避免严格校验的 Relay 对含 assistant 历史消息的请求返回 `Invalid value: 'input_text'. Supported values are: 'output_text' and 'refusal'` 的 HTTP 400。
- 系统指令改为通过顶层 `instructions` 字段发送（Responses 规范的 input item 不接受 `role: 'system'`，严格 Relay 会拒绝），同时保持对宽松 Relay 的兼容。
- 修正 `reasoning` item 的 `summary` 类型为规范的 `summary_text` 分片数组。

## 0.5.2 - 2026-08-01

- 修复思考模型拒绝 Responses 工具调用历史的问题：在每组 `function_call` 前回传非空 `reasoning` item（优先复用 VS Code 的思考内容），避免 DeepSeek 等 Relay 返回 `reasoning_text ... must be passed back` 的 HTTP 400。

## 0.5.1 - 2026-08-01

- 修复 Responses 请求中 assistant `function_call` 被错误嵌套进消息 `content` 数组的问题；改为顶层 input item（与 `function_call_output` 同级），避免严格校验的 Relay（如 DeepSeek）对含工具调用历史的请求返回 HTTP 400。

## 0.5.0 - 2026-08-01

- 新增 OpenAI Responses API 协议层：通过 `/responses` 端点发起无状态请求（`store: false`、无 `previous_response_id`），包含 SSE 流式事件解析、用量映射与独立的协议错误处理。
- 模型刷新时自动探测 Relay 的 Responses API 支持：先以免费 GET 探测端点可用性，再对受支持端点发送 `max_output_tokens: 1` 的最小化请求验证模型兼容性，并缓存探测结果；不支持的模型回退到 Chat Completions。
- 将支持 Responses API 的模型路由到 `/responses` 流式请求，保留推理、严格工具调用与无状态约束。
- 统一终止状态传播：连接测试与持久化诊断接受 `completed`/`incomplete`，探测如实记录截断（`max_output_tokens: 1` 下常见），不再硬编码为已完成。
- 连接测试新增免费的 `/responses` 端点可用性探测，且不会单独降低整体健康度；纯单协议 Relay 不再因跳过另一协议而显示 degraded。
- 保留 Responses 请求历史中的 assistant `function_call`，使 `call_id` 与 `function_call_output` 配对，避免严格 Relay 拒绝多轮工具调用历史。
- 设置或清除 API Key 时捕获 SecretStorage 故障并给出提示，不再产生未处理的拒绝。
- 强化分层边界，落实全库深度审查发现的修复。

## 0.4.2 - 2026-07-21

- 新增 OpenAI 请求传输生命周期诊断，可在收到 HTTP 响应前安全关联客户端请求 ID、请求体字节数、请求次数和流式模式。
- 明确记录请求是否收到响应、AbortSignal 状态、VS Code 取消或响应超时来源，以及底层网络错误名称和错误码。
- 诊断继续排除请求正文、Prompt、工具参数、URL、认证头和 API Key；聊天 POST 仍不进行网络自动重试。
- 扩展请求、取消、超时和上传阶段网络失败的回归测试覆盖。

## 0.4.1 - 2026-07-21

- 新增可显式启用的 OpenAI 请求能力，包括现代令牌上限、Relay 专用上下文窗口、提示缓存、存储控制、严格及并行工具、developer 消息、客户端请求 ID，以及模型专属的推理强度。
- 默认保留旧版 OpenAI-compatible Relay 请求负载，同时避免一并发送 `temperature` 和 `top_p` 采样参数。
- 新增拒绝信息、结束原因、详细用量、请求 ID、限流和处理耗时诊断，且不记录 Prompt 或工具参数正文。
- 强化严格函数 schema 的安全回退，并记录未来无破坏性迁移到 Responses API 的方案。

## 0.4.0 - 2026-07-20

- 同时启用所有 Relay 连接，并以最多三个连接的并发限制独立刷新和聚合其模型目录。
- 将模型选择器中的每个模型绑定到来源连接、不可变的生效配置和稳定 UUID，避免后续连接选择或改名操作改变请求路由。
- 将配置档身份和 SecretStorage 密钥由名称迁移为 UUID，并提供经过验证、可安全重试的升级流程和连接级诊断失效机制。
- 使用聚合状态和刷新摘要取代默认连接交互；删除连接时始终同时删除其 API Key。

## 0.3.4 - 2026-07-20

- 新增结构化 Relay 诊断，明确检测模型发现以及 OpenAI/Anthropic 流式和非流式协议支持情况。
- 按连接指纹持久化安全的诊断摘要，并在凭据变更时使其失效。
- 改进状态展示与连接管理，支持分阶段编辑、选择性保留 API Key，以及复用孤立密钥。
- 强化有界 Relay 响应处理、取消处理、响应元数据和诊断缓存清理。

## 0.3.3 - 2026-07-16

- 复用已解析的模型目录，直到连接、凭据或元数据变更明确使其失效，从而修复模型目录重复加载问题。
- 将 Copilot provider 重构为职责清晰的模型发现、OpenAI、Claude、连接、辅助工具和请求诊断模块。
- 提升 Relay 响应和流式传输的可靠性，同时保留安全取消、错误映射和请求诊断能力。
- 新增 ESLint 检查、包含覆盖率的 CI、扩展包内容检查、标签与版本校验，以及 VS Code Extension Host 冒烟测试。

## 0.3.2 - 2026-07-16

- 拒绝已认证 Relay 请求的重定向，并在完成或失败路径中可靠释放 JSON、OpenAI SSE 和 Claude SSE 流读取器。
- 拒绝格式错误的模型目录、不安全的连接名称，以及复制或重命名连接时目标位置的孤立 API Key。
- 扩展 UTF-8 流边界、模型目录校验、SecretStorage 生命周期安全和连接工作流的回归测试覆盖。

## 0.3.1 - 2026-07-16

- 串行化连接变更，并确保创建和重命名连接时能够从配置或 SecretStorage 故障中安全恢复。
- 修复密钥删除回滚竞态，并扩展一次性旧配置重置，以清理全局、工作区和工作区文件夹中的旧版 Base URL。
- 按活动连接隔离模型刷新快照，防止切换连接后显示其他 Relay 的过期模型。
- 校验 Relay Base URL 并规范构造端点，防止配置档覆盖 Relay 认证头和协议头。
- 将模型刷新诊断限制为仅在调试模式下输出的结构化错误摘要，不包含原始上游消息。

## 0.3.0 - 2026-07-15

- 使用具名 Relay 连接取代内置的 Default Relay，支持新增、编辑、复制、测试、删除、全部清除和设置默认连接，并通过 SecretStorage 隔离存储 API Key。
- 新增可见的连接状态和结构化连接诊断，安全展示端点、HTTP 状态、响应类型、请求 ID，以及 Claude `/messages` 兼容性。
- 使用一次性重置配置档机制之前的 Base URL 和旧版 API Key，取代含义不明确的旧 Relay 迁移；升级过程不会删除已有配置档连接及其专属密钥。
- 将扩展图标移至 `resources`，收紧 VSIX 内容，并在 Marketplace 发布流程中加入扩展包内容检查。

## 0.2.1 - 2026-07-15

- 将 Relay 响应头默认超时时间从 60 秒提高到 120 秒，以适应较慢的推理和长上下文请求。
- 强化 Claude 工具结果链、流式工具参数、扩展思考采样约束，以及 OpenAI 增量工具调用。
- 将模型发现的超时和取消控制覆盖到响应正文读取，增加响应与模型目录大小限制，并强化元数据缓存校验。
- 新增结构化 Relay 错误映射，隔离 Copilot Chat 激活故障，并要求在 Marketplace 发布前完成编译和测试。

## 0.2.0 - 2026-07-15

- 新增独立路由刷新、固定或私有模型定义、唯一模型选择器 ID，以及显式上游路由。
- 新增响应和流式超时、模型发现 GET 的一次安全重试，以及可感知处理状态且不盲目重试聊天请求的流式降级。
- 改进 OpenAI 和 Claude 的 SSE/JSON 兼容性、推理、用量、增量工具、MIME 校验和严格工具参数解析。
- 新增支持配置 `5m`/`1h` TTL 的 Anthropic 缓存断点、采样控制、工具 schema 清理、更安全的 Relay 错误映射，以及更全面的 token 估算。
- 新增 Vitest 测试，覆盖协议解析、缓存控制、schema 清理和模型路由。

## 0.1.4

- 默认 API 地址改为香港前置 `https://hk-sub2api.huangonce.com/v1`。
- 激活时自动迁移显式配置的旧默认地址；其他自定义地址和 API Key 保持不变。

## 0.1.3

- 修复 VS Code 在流式请求进行中取消 token 时客户端静默返回，进而被 Chat 显示为无响应的问题；现在按 VS Code 的取消语义结束，并写入 WeaveNet 调试输出。

## 0.1.2

- 将 OpenAI 与 Claude 流中的 SSE 错误、异常断流和无内容响应转为明确异常，并写入 WeaveNet 调试输出，避免 Copilot 只显示 `Sorry, no response was returned.`。

## 0.1.1

- 将 `maxInputTokens` 改为模型元数据之上的硬上限，避免 OAuth 上游实际上下文较小时让 Copilot 持续堆积超量输入。
- 识别 JSON/SSE 中的上下文超限错误，并清理 Cloudflare 等网关返回的 HTML 错误页。
- 调试日志增加脱敏的请求体字节数。

## 0.1.0

- 首次公开发布。
- 将 sub2api 模型接入 GitHub Copilot Chat 模型选择器。
- 分离 OpenAI、ChatGPT 和 Claude API Key，并按模型协议路由请求。
- 支持 Claude 原生协议、自动提示缓存、OpenAI 提示缓存和调试日志。
- 支持工具调用、图片输入、推理强度和公开模型价格元数据。
- 提供中文和英文的命令及设置文本。
