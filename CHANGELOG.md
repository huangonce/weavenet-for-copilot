# Change Log

## 0.7.13 - 2026-08-08

- 修复 `0.7.12` 首次启用的可复用发布工作流无法通过 GitHub Actions 静态校验的问题：可选 `OVSX_PAT` 现在先映射为 job 环境变量，再由 Open VSX 步骤判断是否配置，不再在 `if` 表达式中直接引用受限制的 `secrets` 上下文。`0.7.12` 未进入 Marketplace；本版本包含其全部功能与修复。

## 0.7.12 - 2026-08-08

- 新增 DeepSeek Chat 专用协议适配：直连 `api.deepseek.com` 自动识别，自定义网关可声明 `openai.dialect: "deepseek"`；请求使用 DeepSeek 原生 `thinking` 开关，并将流式思考以有界隐藏元数据带回下一轮的 `reasoning_content`，改善工具调用后的多轮 Agent 稳定性。标题、分类、设置解析等 Copilot 辅助请求会自动关闭思考，避免无意义延迟和消耗。
- 新增默认关闭的 DeepSeek 工具列表稳定化：可先执行 Copilot 的 `activate_*` 辅助工具，再把稳定后的工具集合发送给上游；合成控制消息不会污染模型历史，最多尝试三轮并在无法收敛时明确失败。
- 向 Copilot 返回 OpenAI Chat、OpenAI Responses 和 Claude 的标准 `usage` 数据，并按模型使用真实上游输入量动态校准后续 Token 估算；最小诊断模式始终记录 Token 用量。
- 将诊断拆分为 `minimal`、`metadata`、`verbose`：默认只记录 Token，元数据模式保持脱敏，verbose 才写入可能含提示词、代码和图片的敏感请求 dump；dump 单文件最多 2 MiB、最多 20 个且总计最多 20 MiB，并提供专用命令打开其目录。
- 引入 Release Please、可复用发布工作流、GitHub Release VSIX 附件、可选 Open VSX 发布和手动救援发布；CI 与发布加入高危依赖审计，发布工具链的已知 npm 漏洞已清零。

## 0.7.11 - 2026-08-08

- 修复长回复可能让 VS Code Remote Extension Host 内存持续增长并最终退出的问题：OpenAI Chat Completions、OpenAI Responses 与 Claude Messages 现在通过共享的有界缓冲器批量发布流式文本和思考片段，避免每个 token 都产生一次跨进程进度调用。在一次实测回复中约 7,500 次调用会被压缩为少量有界批次，从而避免宿主达到约 4 GiB 后触发 V8 OOM、日志页面退出和模型重新加载。
- 流式批处理保持文本、思考、元数据与工具调用的原始顺序，并继续及时响应取消；定时发布异常会在当前请求中安全报告，取消后的缓冲内容不会晚到写入。

## 0.7.10 - 2026-08-08

- 修复 Relay 只返回终止标记时聊天静默结束的问题：OpenAI Chat Completions、OpenAI Responses 与 Claude Messages 现在都会把“零文本、零思考、零工具调用”的完成流识别为错误，并提示用户重试；聊天 POST 不会自动重发，避免重复计费或重复执行工具。
- 加固 OpenAI 流式协议处理：SSE 现在按标准事件边界聚合并支持多行 `data` 字段；`length`、`content_filter`、无效或矛盾的 `finish_reason` 会显示明确错误；工具调用仅在终止语义完整且全部参数均为有效 JSON 对象后原子发布，截断流不会泄漏半成品调用。
- 加固 Relay 传输安全：远程连接必须使用 HTTPS，HTTP 仅允许 `localhost`、`127.0.0.0/8` 与 `::1` 回环地址。升级后仍使用远程 HTTP 的连接需要先配置 TLS，否则会被安全拒绝；本机开发 Relay 不受影响。

## 0.7.9 - 2026-08-07

- 加固模型目录快照与 Responses 能力探测缓存：持久化结果现在绑定到连接配置和 API Key 对应的隐私保护身份，修改地址、请求头、模型规则、协议策略或密钥后不会再恢复或复用旧连接的结果；等价请求头会按真实发送语义规范化，避免仅因大小写或顺序变化而无效刷新。
- 修复大型模型目录的离线恢复边界：写入时对路由快照和最终模型列表一致限制为 2,000 项，并串行化更新、删除与清空操作，避免异步晚到写入覆盖新快照或使删除失效。
- 修复启动时已恢复模型未及时发布以及刷新取消后状态悬空的问题：Relay 暂时不可用或刷新被取消时，已验证的快照会立即出现在模型选择器中，并明确进入降级状态而不是一直显示刷新中。
- 将源码与测试的 TypeScript 检查纳入 CI 和 Marketplace 发布门禁，并修正全部测试类型错误，降低仅在真实扩展宿主中出现回归的风险。
- 升级说明：0.7.9 会丢弃无法验证连接身份的旧版目录与探测缓存，首次启动会重新加载；现有连接配置和保存在 SecretStorage 中的 API Key 不受影响。

## 0.7.8 - 2026-08-07

- 修复 Agent 截图等工具结果中的图片无法通过 Relay 协议发送的问题：图片不再嵌入仅支持文本的工具输出字段，而是在完整的并行工具结果批次之后作为普通用户附件发送；OpenAI Chat Completions、OpenAI Responses 与 Claude Messages 均保持合法的工具调用链和一致顺序。
- 加固工具调用历史规范化：普通用户文本、顶层图片和视觉代理描述都会等待匹配的工具结果；截断历史中的未回答调用会被安全清理，孤立、过期或重复工具结果会明确拒绝。跨多条用户消息延迟的内容继续保留原消息边界、名称和多模态顺序，只有图片的工具结果会添加安全说明且不会把 base64 写入文本。

## 0.7.7 - 2026-08-06

- 编辑连接的向导不再包含“额外请求头 JSON”输入步骤：该步骤紧跟在地址之后，容易让人误以为是 API Key 输入框，而且直接手写 JSON 并不方便。现在编辑连接时只依次询问名称、地址、模型过滤规则和固定模型路由；连接已有的额外请求头保持不变，需要修改时可直接编辑 `settings.json` 中该连接的 `requestHeaders`。

## 0.7.6 - 2026-08-06

- 彻底清除聊天错误气泡中的扩展宿主内部信息：此前错误的 `stack` 会随 RPC 序列化跨进程传递，VS Code 的 `LanguageModelError.tryDeserialize` 又会重建出充满内部帧（如 `at i.tryDeserialize (...extensionHostProcess.js...)`）的新实例，聊天界面因此显示大量无关调用栈。现在错误在离开扩展前统一清洗：剥离 `stack` 并把名称改为 `Error`，使反序列化走干净路径；用户只会看到简短的错误说明（如 `[503] 模型服务暂时过载或不可用。请稍后重试。`），消息、错误码和 `instanceof` 语义不受影响，取消操作（CancellationError）原样透传。

## 0.7.5 - 2026-08-05

- 视觉代理现在可以选择 WeaveNet 自己加载的、具备原生图片输入的模型（例如 `weavenet/gpt-4o`）：命令 `WeaveNet: Pick Vision Proxy Model` 的列表不再排除 WeaveNet 模型，而是通过运行时同款安全检查只展示真正支持图片的候选；运行时查找也使用同一检查，因此“用自己加载的 GPT 给无视觉的 DeepSeek 描述图片”可以直接配置实现。仅靠视觉代理声明图片能力的模型仍不能作为代理，以避免递归。

## 0.7.4 - 2026-08-05

- 修复 canonical 快照拒绝空文本片段导致请求失败并报 “Message 4 part 1 text must be a non-empty string of at most 4194304 UTF-8 bytes.”。空或纯空白的 `LanguageModelTextPart` 是 VS Code API 合法的（例如仅包含工具调用的助手轮次、返回空字符串的工具结果），现已接受；Claude Messages 转换器会跳过空文本块，避免上游拒绝。思考片段的空 `id` 也不再被当作错误。

## 0.7.3 - 2026-08-05

- 修复 0.7.0 引入、0.7.1 未完全解决的严重回归：canonical 请求快照要求消息、内容片段、工具定义和响应选项的字段必须是「自有数据属性」，而 VS Code 宿主还原出的对象把这些字段实现为原型上的 getter，导致所有聊天请求都失败并报 “Message 1.content must be a direct data property and cannot be sent safely.”。现在宿主提供的容器改为「每个属性只读取一次并立即快照」，允许访问器但杜绝重复读取带来的 TOCTOU 差异；Proxy 仍在触发任何陷阱前被拒绝，嵌套的工具输入 schema、结构化图片等不受信任数据继续保持严格的纯对象与 own-descriptor 校验。

## 0.7.2 - 2026-08-05

- 新增命令 `WeaveNet: Pick Vision Proxy Model`：从已安装的 VS Code 语言模型中选择视觉代理目标，自动写入 `weavenet-copilot.visionProxyModel`（`vendor/id`），不再需要手动输入模型 ID。列表会排除 WeaveNet 自身的模型，避免误选导致递归。设置项说明新增可点击的命令链接。

## 0.7.1 - 2026-08-05

- 修复 0.7.0 引入的严重回归：canonical 请求快照会拒绝 VS Code 宿主自身构造的消息与响应选项容器（原型不是 `Object.prototype`/`null`），导致所有聊天请求都失败并报 “Message 1 has an unsupported prototype and cannot be sent safely.”。现在顶层的消息与响应选项容器只校验非 Proxy 且逐属性经 own-descriptor 安全读取，不再要求精确的原型身份；嵌套的工具输入、结构化图片和思考元数据等不受信任数据仍保持原有的严格纯对象校验。

## 0.7.0 - 2026-08-05

- 新增默认关闭的纯文本模型视觉代理：用户精确配置已安装的原生视觉模型后，扩展会将当前图片、视觉指令和有界消息布局交给该模型生成描述，再把经过长度前缀 JSON 安全 framing 的描述发送给目标 WeaveNet 模型。原生视觉模型仍直接接收图片；代理不自动选模、不 fallback，也不允许递归使用仅靠代理获得图片能力的模型。
- 视觉代理增加完整的隐私、计费、provenance、缓存和资源边界：最多 8 张当前图片、单张 10 MiB、合计 20 MiB，描述只进入 64 条/512 KiB/30 分钟的进程内缓存且目标请求成功后才提交；视觉流最多 4,096 个 chunk，90 秒无响应或 120 秒总耗时即取消并失败。
- 加固聊天请求捕获与协议转换：在首个异步边界前生成拒绝 Proxy/accessor 的不可变 canonical 快照，严格限制消息、part、JSON 和文本规模；OpenAI、Responses 与 Claude 转换只接受该快照，并对非法 role/part、非图片 DataPart 和不支持的图片 MIME 类型 fail closed。

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
