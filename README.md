# WeaveNet for Copilot

为 GitHub Copilot Chat 管理具名 Relay 连接，明确选择 Chat Completions、Responses 或 Anthropic Messages API，并提供连接隔离、目录恢复与脱敏诊断。

标准网关也可直接使用 VS Code 内置的 [Custom Endpoint](https://code.visualstudio.com/docs/agent-customization/language-models#_add-a-custom-endpoint-model)。WeaveNet 适合需要集中管理多条 Relay、明确模型协议覆盖、检查连接或使用可选视觉代理的场景。

## 快速开始

1. 安装扩展，运行 `WeaveNet: Add Relay Connection`。
2. 输入连接名称、Relay Base URL，选择 Relay 实际提供的 API，再输入 API Key。
3. 运行 `WeaveNet: Refresh Models`，然后在 Copilot 模型选择器中选择模型。
4. 使用 `WeaveNet: Manage Relay Connections` 编辑、复制、测试、删除连接或管理密钥。

连接的 API 类型有三种：

| `apiType` | 请求端点 | 认证 |
| --- | --- | --- |
| `chat-completions` | `POST /chat/completions` | `Authorization: Bearer` |
| `responses` | `POST /responses` | `Authorization: Bearer` |
| `messages` | `POST /messages` | `x-api-key` |

Base URL 是 API 根路径，例如 `https://relay.example.com/v1`。远程 Relay 必须使用 HTTPS；只有 localhost 与 IP 回环地址允许 HTTP。地址不能包含用户名、密码、query 或 fragment。

**刷新模型只读取 `/models`，不发起付费推理或协议探测。**带 has_more/last_id 的目录会通过同端点 after_id 继续读取；拒绝重复游标，最多 100 页、10000 模型和累计 10 MiB，不跟随第三方 next_url。新发现的模型继承连接 API；插件不会按模型名字猜测协议。混合协议 Relay 必须给对应模型配置 `apiType` 覆盖。

## 连接与模型配置

连接保存在用户级 `weavenet-copilot.profiles` 中。UUID 由扩展创建；编辑连接保留 UUID，复制连接生成新 UUID且不复制密钥。所有连接同时启用，每个模型只向其来源连接发送请求。

下面展示一个 Chat 默认连接以及两个模型覆盖。请使用“添加连接”生成自己的 UUID：

```json
{
  "weavenet-copilot.profiles": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "name": "Work Relay",
      "baseUrl": "https://relay.example.com/v1",
      "apiType": "chat-completions",
      "models": [
        {
          "id": "company-claude",
          "apiType": "messages",
          "toolCalling": true,
          "imageInput": true,
          "thinking": true
        },
        {
          "id": "company-gpt",
          "apiType": "responses",
          "toolCalling": true,
          "maxInputTokens": 100000,
          "maxOutputTokens": 16000,
          "openai": { "reasoningSummary": false }
        }
      ]
    }
  ]
}
```

`models` 只要求模型 `id`；`apiType` 留空时继承连接。既能定义目录中不存在的固定模型，也能覆盖发现模型的名称、API 或能力。覆盖只修改明确填写的字段，因此不必重复整个能力对象。同一 ID 的不同 API 声明保留为独立模型；相同 ID 与 API 的重复声明合并，后写的明确字段优先。收窄 `reasoningEfforts` 时会重新校验继承的默认 effort，避免发送新列表不允许的值。

- `toolCalling`：工具调用支持。
- `imageInput`：原生图片输入支持。明确的 `false` 可关闭来自公开目录的视觉声明。
- `thinking`：推理支持；模型选择器可以显示思考工作量。
- `contextWindow`：已知的输入加输出总窗口；插件会从中预留输出空间。它是静态预算元数据，不创建上下文档位控件。
- `maxInputTokens` / `maxOutputTokens`：向宿主声明的输入、输出上限；请按上游实际限制填写并预留输出空间。
- `openai`：已验证的 OpenAI 请求能力，例如 `tokenLimitField`、`strictTools`、`parallelToolCalls`、`developerRole`、`clientRequestId`、`reasoningEfforts`、`defaultReasoningEffort`。

`openai.encryptedReasoning` 可在 Responses 请求中启用加密推理状态回放；`replayReasoningContent` 在 Chat 中回传每轮 `reasoning_content`，在 Responses 中回放上游原始 reasoning 内容。仅在对应 Relay 要求时启用。Responses 会保留上游返回的原始 `phase`，不会根据工具位置猜测；`assistantPhase: false` 可显式关闭发送阶段字段。Claude 的 Required 工具模式需有明确强制工具能力；manual 强制轮次关闭冲突的思考，adaptive 允许时保留思考。已有 manual 签名思考链中关闭思考会明确报错，避免发送不一致的续接。没有可用工具时也会明确报错。Responses 始终使用无状态 `store: false`，不发送 `previous_response_id`。`reasoningSummary` 默认省略，只有模型声明 thinking 且明确 reasoningSummary: true 才发送。

连接也支持 `includeModels`、`excludeModels` 正则过滤与非敏感的 `requestHeaders`。认证和协议保留头由扩展管理；额外请求头不能用于保存密钥。

输入 token 全局硬上限为 `maxInputTokens`，默认 128000；输出默认值为 `maxOutputTokens`，默认 16384。之前的“上下文大小”档位已移除：它在不同 API 上不能一致生效。需要限制上下文时使用明确的输入、输出上限。若 Relay 或 OpenRouter 提供总窗口，向宿主声明的输入加输出不会超过该窗口。

## 模型参数能力与安全默认

模型的工具能力不等于允许强制工具选择。Claude 的 `claude.forcedToolChoice` 控制 Required/any：明确不支持或未知时，在请求前报错；不要把不支持的 Required 悄悄改成 Auto。声明允许强制工具选择的 adaptive 模型可同时发送 adaptive 和 any；manual 强制轮次关闭与其冲突的手动思考。

Claude 的 `claude.sampling` 控制非思考请求是否继承全局采样。未确认支持时省略；原生目录明确支持 manual 的旧模型可采用旧模式能力。即使允许采样，也只发送 temperature 或 top_p 中的一种。新 Claude 模型不支持采样或强制工具时，应明确设 false。

```json
{
  "id": "company-claude",
  "apiType": "messages",
  "thinking": true,
  "toolCalling": true,
  "claude": {
    "thinkingMode": "adaptive",
    "reasoningEfforts": ["low", "medium", "high", "xhigh", "max"],
    "sampling": false,
    "forcedToolChoice": false
  }
}
```

Claude 的 effort 仅允许 low、medium、high、xhigh、max；none/minimal 不会作为 Claude output_config.effort 发送。模型还可进一步缩小允许列表。

OpenAI 的 `openai.sampling: true` 明确允许采样，false 明确关闭；`samplingEfforts` 可限制只有指定思考档位才允许发送。未声明支持且思考能力未知或为 true 的模型默认不发送采样；明确非推理模型可按标准字段继承全局设置。Chat 与 Responses 共用该规则。

标准图片默认遵循 OpenAI schema，仅有 url/detail，不附加私有 media_type；图片不会自动删除已支持的输出上限、思考工作量和缓存键。确有此需求的旧 Relay 可显式选择 `openai.imageCompatibility: "legacy-relay"`，恢复旧的字段与提示省略策略；此模式会省略部分限制和参数，应按该网关文档使用。

```json
{
  "id": "gateway-model",
  "apiType": "responses",
  "thinking": true,
  "openai": {
    "samplingEfforts": ["none"],
    "reasoningSummary": true,
    "imageCompatibility": "standard"
  }
}
```

采样、强制工具与摘要是独立能力，不会通过模型 ID 名字猜测；模型 `claude`/`openai` 字段是已验证能力声明。既有 UUID、密钥与协议保持不变。新增安全默认可能省略旧版发送的可选字段：需要这些字段时，请明确配置对应能力，而非回到全局盲目发送。

提示词缓存同样使用明确能力。开启 `openaiPromptCaching` 后，模型声明 `openai.promptCacheKey: true` 才自动生成工作区稳定键；填写 `openaiPromptCacheKey` 也表示明确要求发送该键。模型显式 `promptCacheKey: false` 始终优先禁用，不再根据 `gpt-` 名称推断。Claude 模型声明 `claude.automaticCaching: true` 时发送顶层 `cache_control`，同时停止添加块级断点；未声明该能力的 Relay 继续使用现有显式断点。`claudePromptCaching: "disabled"` 关闭两种方式，TTL 仍由 `claudePromptCachingTTL` 选择 `5m` 或 `1h`。

## 命令与诊断

命令面板保留六个主要入口：

- `WeaveNet: Add Relay Connection`
- `WeaveNet: Manage Relay Connections`
- `WeaveNet: Refresh Models`
- `WeaveNet: Test Relay Connection`
- `WeaveNet: Open Settings`
- `WeaveNet: Show Debug Log`

编辑、复制、删除、密钥管理、元数据刷新、视觉模型选择和输入 Token 对比集中在管理菜单。新增连接统一使用 `weavenet-copilot.addConnection`；旧的 `createProfile`、`switchProfile`、`setDefaultConnection` 命令已移除，自定义快捷键或脚本请改用添加连接或管理连接入口。

连接测试只由用户主动触发。测试读取 `/models`，并为实际配置的每种 API 选择一个模型，执行最小流式与非流式请求；不测试未配置的 API。最小请求可能产生少量费用。测试会展示脱敏 Host、端点、HTTP 状态、响应类型和请求 ID；结果是该代表模型的证据，不保证连接中的所有模型和能力都已验证。声明 max_completion_tokens 的 Chat 模型会用对应字段测试；声明不允许输出上限的模型不会执行无界生成测试。

“对比输入 Token 数量”（`weavenet-copilot.compareInputTokens`）仅列出 `apiType: "responses"` 且声明 `openai.tokenCounting: true` 的模型。选择模型并输入样本文本后，扩展对同一条用户消息显示本地估算与 Relay `/responses/input_tokens` 的计数。只发送手动输入的文本，不读取编辑器或会话历史，不生成回复、不自动重试，也不改变现有估算器。日常聊天和宿主 `countTokens` 继续本地计算，不增加网络请求。

某条连接刷新失败时，仅恢复该连接最后一次成功目录并显示降级状态；其他连接继续可用。每条连接保存一份 `directory`，v3 快照最多保留 2000 个 API 模型条目；固定模型、能力覆盖、过滤和可选公开元数据在在线刷新与离线恢复时按同一规则组装，不再额外持久化最终模型列表。目录快照绑定连接配置与凭据，修改 API、模型规则、地址或密钥后不会复用旧身份的快照。取消、超时、截断流和无效工具参数会明确报告，聊天 POST 不会盲目重试。

开启 `debug` 后记录脱敏请求摘要、usage、首输出时延、请求 ID 等。每个请求在完成、取消或失败时只结算一次用量摘要，累计计数覆盖前值，不重复相加；缺失字段保留已知值或显示 `n/a`。`cacheRead`、`cacheWrite` 与 Claude 的 5m/1h 写入分开记录；只有未缓存输入、缓存读取和缓存写入都已知时才计算 Claude 输入总量。API Key、提示词正文与工具参数正文不写入日志。字段缺失只表示上游没有返回用量，不代表未命中缓存。

三个协议共用传输诊断；Claude 原生 `request-id` 与 OpenAI 的 `x-request-id` 都会保留。请求体只在传输层序列化，调试摘要复用其字节数。Responses 同一个工具的参数完成与输出项完成事件只计一次工具，不重复解析或累计预算。

运行时界面文案跟随 VS Code 的显示语言：当前内置简体中文（`l10n/bundle.l10n.zh-cn.json`），未翻译的条目自动回退英文。新增语言只需在 `l10n/` 下添加 `bundle.l10n.<locale>.json`；`npm test` 会校验翻译键与代码中的引用一一对应、占位符一致，且没有空值或遗留条目。

## 可选功能

### 在线模型元数据

`modelMetadataEnabled` 默认开启，使用 OpenRouter 公开目录补充 Relay 缺失的图片、工具、推理能力和参考价格。关闭后既不刷新公开目录，也不使用已缓存的公开元数据，只读取 Relay 和模型声明。`metadataRefreshHours` 控制缓存刷新间隔；管理菜单可手动刷新。

用户配置与 Relay 元数据优先；无法确认的能力保持关闭。参考价格不是 Relay 实际扣费，应以 Relay 的用量日志为准。公开目录也不能证明某条具体 Relay 路由接受相同功能，必要时用模型覆盖关闭能力。

元数据服务返回损坏的响应结构时保留已有缓存；合法的 `data: []` 仍表示空目录。缺失、空值、非法类型和溢出的价格保持未知，只有明确的零价才显示为零。

### 纯文本模型的视觉代理

`visionProxyEnabled` 默认关闭。通过管理菜单选择已安装的原生视觉模型，或在设置说明中点击“选择视觉代理模型”，将 `visionProxyModel` 配置为精确 `vendor/id`。纯文本模型会先让该模型描述图片，再把描述交给目标 Relay；原生视觉模型直接接收图片。

图片、视觉指令和当前消息的有界布局（可能包含用户文本、工具结果）会交给视觉模型提供者，可能独立计费。代理不自动选模、不回退、不允许递归使用仅靠代理获得视觉能力的模型。

每个请求最多 8 张图片，单张 10 MiB、总计 20 MiB；描述只进入有界的短期进程内缓存，不持久化。目标请求成功后才提交缓存；历史描述过期后不会自动再次外发原图片。`visionProxyPrompt` 可以覆盖默认描述指令。

现有图片请求的兼容规则与工具图片提升处理继续保留；它们不属于本次协议配置精简。详见隐私说明。

### Agent 模式与工具调用能力

Copilot 的 Agent 模式只会提供声明了工具调用的模型。WeaveNet 按 Relay `/models` 返回的 `capabilities.tool_calling`（以及可选的在线元数据）上报该能力；某个模型在 Agent 模式里看不到时，先确认 Relay 为该模型返回了工具调用能力，再检查是否被已废弃的全局开关 `weavenet-copilot.supportsToolCalling` 关闭。图片能力同理按 `capabilities.vision` 与视觉代理上报。

在“Chat: Manage Language Models”里可以用 `@provider:weavenet`、`@capability:tools`、`@capability:vision` 过滤查看本扩展上报的模型与能力；Agents / Agent Host 会话使用 BYOK 模型由 VS Code 的 `chat.agentHost.byokModels.enabled` 控制，工具类小请求可设置 `chat.utilityModel` / `chat.utilitySmallModel`（或 `chat.byokUtilityModelDefault`）。

## 从旧版升级

- 保留连接 UUID、名称、地址、密钥与模型能力覆盖。
- 将旧 `route` / `openaiApi` 转为模型 `apiType`，并遵循旧全局 `chat` 否决规则。
- 将全局 `responses` 转为连接默认 API；`auto` 不再继续探测。优先从当前凭据和旧配置对应的已验证目录快照提取协议覆盖，并保留完整离线目录。缺少快照但有密钥时，迁移会只读一次 /models，固化旧 Claude 路由；不会继续执行 Responses 付费探测。目录读取失败时不提交迁移。
- 混合协议连接请检查迁移提示。无密钥而无法读取目录的旧连接，以及以后新增的 Claude 模型，需要自己填写 `apiType: "messages"`，以后新增模型也不再按名字自动路由。
- 旧 `activeProfile` 和 `openaiApiStrategy` 成功迁移后清除；失败会回滚普通设置，密钥不会因本次迁移删除。
- 旧 `route`、`protocol`、`openaiApi` 的解释只在迁移边界发生；运行时统一使用 `apiType`。凭据和配置匹配的 v2 快照转为单目录 v3，无法验证身份的 v1 不恢复。原 v2 记录在目录保留成功前不会删除；迁移保留的旧记录由之后的成功目录刷新清理。
- `contextWindows` 和 `openai.contextWindow` 不再产生上下文控件或私有请求参数。
- 旧全局工具开关和视觉正则暂时保留为废弃兼容项；新配置使用模型级能力。

协议改变后建议新开会话，避免旧协议的工具或推理历史被带到另一种 API。使用管理菜单删除连接会同时删除其 API Key。手动从设置中删除连接不会回收 SecretStorage 中的密钥；激活时的迁移会清理遗留的按名称旧条目，运行时也只读取按连接 UUID 保存的密钥，因此残留的旧密钥不会被同名的其他连接沿用，需要重新填写密钥。

## 推理与协议历史

Claude 的完整签名思考块和 `redacted_thinking`、Chat 的推理正文、Responses 的原始消息边界与阶段会通过有界宿主 metadata 保存，在下一轮回传。状态绑定连接配置、凭据、模型和 API，不能拿到其他模型或密钥下继续使用；工具与可见正文修改或裁剪后会拒绝失配的旧状态。宿主若不提供承载状态所需的 thinking part，扩展会给出一次性提示并禁用原样回放，而不是让请求整体失败。

DeepSeek thinking 的 Chat 请求携带工具时需要所有历史轮次的完整 `reasoning_content`，包括未实际调用工具的轮次。配置示例：

```json
{
  "id": "deepseek-model",
  "apiType": "chat-completions",
  "thinking": true,
  "toolCalling": true,
  "openai": { "replayReasoningContent": true }
}
```

新版 Claude 的 adaptive 示例：

```json
{
  "id": "company-claude",
  "apiType": "messages",
  "thinking": true,
  "toolCalling": true,
  "claude": {
    "thinkingMode": "adaptive",
    "reasoningEfforts": ["low", "medium", "high", "max"],
    "defaultReasoningEffort": "high"
  }
}
```

原生目录明确声明 adaptive 支持和 effort 等级时自动采用该信息；能力不完整的 Relay 需要显式配置。manual 继续使用旧式 budget_tokens；adaptive 发送 thinking.type 和 output_config.effort，不发送手动预算。仅填写模型实际允许的 effort，例如不支持 max 的型号应从列表删除。

签名状态同时保存实际 system、工具定义和此前消息的前缀指纹（不计 API cache_control 断点）；前缀变化或旧状态缺指纹时，在 POST 前拒绝并提示新开会话。指纹不会把工具业务参数或 schema 中的同名 cache_control 删除。

状态最多 4 MiB、512 个协议 item，继续受 canonical JSON 的节点、深度与累计大小限制。工具批次只在完整响应和状态校验成功后发布；取消、缺终止事件、无效签名、正文冲突或截断不会发布未完成的工具。Claude 的 model_context_window_exceeded 与 max_tokens 一样视为截断；不发布待执行工具或继续使用受截断的思考状态。Responses 的合法 incomplete 可保留已知消息阶段及部分文本，但不保存未完成的加密推理或工具调用。

旧版本没有保存完整签名、推理或原始 phase 的历史无法补造；升级后建议新开需要原生推理工具链的会话。详细官方依据及已修复记录见 [文档对照审查](CODE_REVIEW_2026-10-06.md)。

工具结果的图片与直接图片使用相同的图片计量；不会将 Base64 当工具文本。Claude manual 工具续接也保守计入已回放思考，避免漏算；仍是估算，并非模型精确 tokenizer，旧模型自动剥离的历史思考可能使估算偏高。

## 隐私与开发

密钥只保存在 VS Code SecretStorage。配置中的自定义请求头仍是普通设置，不受密钥存储保护；连接诊断的持久化标识只用经过规范化的请求头名称、不包含其取值，避免弱随机凭据被离线比对。对话、代码、工具调用及图片会发往所配置的 Relay 和其上游；扩展不收集遥测。完整说明见 [PRIVACY.md](PRIVACY.md)，问题反馈见 [SUPPORT.md](SUPPORT.md)。

```bash
npm ci
npm run check
npm run test:integration
npm run package:list
```

合并到 main 只运行 CI，CI 会在声明的最低宿主 VS Code 1.116.0 与最新稳定版上分别运行扩展宿主冒烟测试。发布前同步更新扩展与锁文件版本、CHANGELOG，等待检查通过后推送带说明的语义版本标签；Marketplace 发布流水线会校验标签、`package.json` 与 CHANGELOG 版本一致后运行检查并打包，重复版本会明确失败而不是静默跳过。

`npm run check` 执行 lint、源码和测试类型检查、带覆盖率的测试。CI 质量任务通过后只编译、打包一次，两个宿主任务下载并安装同一 VSIX，不再分别编译源码。发布同样检查、打包、安装测试并发布同一个文件。手动发布已经验证的包使用 `npm run publish:marketplace -- <文件路径.vsix>`，不会再次从源码构建。

`npm run test:integration` 同时加载独立测试扩展，通过已注册模型的 `selectChatModels` / `sendRequest` / `countTokens` 验证宿主 RPC，覆盖三协议文本、工具 Schema、思考工作量和协议状态跨轮回放，并检查缓存控制、手动 Token 对比、取消及错误不会重发生成请求。测试只连接本地模拟 Relay，期间关闭在线元数据并在结束时恢复设置；使用隔离的宿主用户目录与扩展安装目录。可通过 `VSCODE_VERSION` 选择版本，或通过 `VSCODE_EXECUTABLE_PATH` 使用已经准备好的测试宿主而跳过下载。对已打包产物执行 `VSCODE_TEST_VSIX=/绝对路径/extension.vsix node test/integration/run.cjs`，可跳过源码编译并测试真实安装文件。2026-10-19 的已安装 VSIX 回归已通过 Linux VS Code 1.116.0 和 1.142.0；真实上游服务和 Windows/macOS 界面不在该自动化测试范围内。

`npm run benchmark` 编译后执行不联网的 CPU 基准，覆盖目录匹配、工具参数、文本计数与多轮 Claude 前缀校验；也可用 `node --expose-gc scripts/benchmark.cjs <out目录>` 测量已保存的构建。夹具生成和输出校验不计入耗时，预热 2 次，取 5 或 7 轮中位数。2026-10-19 在 Node 24.20.0 / Linux x64 / Ryzen 5 5600X 上，使用相同脚本比较目录与工具参数优化前后的结果：

| 场景 | 优化前 | 优化后 |
| --- | ---: | ---: |
| 500 模型 × 1000 元数据，完整/裸 ID 混合 | 11.61 ms | 0.36 ms |
| 2000 模型 × 10000 元数据，裸 ID | 610.54 ms | 3.30 ms |
| 约 1 MiB ASCII 工具参数，每片 128 UTF-16 单元 | 3348.95 ms | 11.22 ms |
| 约 1 MiB 中文工具参数，每片 128 UTF-16 单元 | 1186.21 ms | 3.78 ms |

这些是本地处理耗时，不含 Relay 网络或模型生成；不代表整次聊天同倍加速。目录索引仅存活于当前补全批次，工具计量状态仅存活于当前请求，不缓存凭据，也不降低输入和资源限制。基准不设耗时通过门槛。

### 维护与协议边界

以下边界于 2026-10-19 对照官方文档核实，并由测试守护：

- `src/relay/http.ts` 共用一套有界 SSE reader，按 [WHATWG event stream 格式](https://html.spec.whatwg.org/dev/server-sent-events.html#the-event-stream-format) 处理 UTF-8、CRLF/CR/LF、空行派发与多行 data；EOF 不派发缺少最终空行的事件。三种协议共享解码、超时、取消和 reader 释放。
- [OpenAI Responses](https://developers.openai.com/api/docs/guides/streaming-responses) 的语义事件与 [Claude Messages](https://platform.claude.com/docs/en/build-with-claude/streaming) 的 content block/message_stop 流程分别保留在协议适配器；工具发布仍须经过对应协议的完整性验证。
- Chat 与 Responses 共用 function tool 定义转换，但保留各自嵌套/平铺格式。按 [OpenAI strict mode 文档](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)，Responses 省略 strict 会尝试规范化 schema；因此未启用严格模式或 schema 不能安全严格化时明确发送 strict: false，以保留可选参数语义。兼容的显式严格配置发送 true；Chat 非严格模式继续省略该字段。
- 严格转换遵循 [OpenAI 支持的 Schema 子集](https://developers.openai.com/api/docs/guides/structured-outputs#some-type-specific-keywords-are-not-yet-supported)。`allOf` 等不支持或无法安全转换的组合不强行封闭或展开对象，而是沿用现有非严格模式并保留约束；业务键和字面量不按 Schema 关键字判定。
- Schema 清理仅遍历真正的子 Schema；按照 [JSON Schema 对象规范](https://json-schema.org/understanding-json-schema/reference/object)，保留 `properties`、`$defs` 等映射中的业务名称及 `enum`、`const`、`default`、`examples` 字面量，不把名为 `errorMessage` 或 `$schema` 的业务数据误删。
- 按 [OpenAI Token 计数](https://developers.openai.com/api/docs/guides/token-counting) 提供主动样本诊断；按 [Claude 缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 为明确支持的路由选择顶层自动缓存，避免与显式断点叠加。流式用量依据官方累计语义汇总，缺省不记为零。
- `src/copilot/responseLifecycle.ts` 统一流式输出和诊断的完成、取消、异常收尾；请求构造、推理回放和工具原子发布保留在各适配器。[VS Code Provider 文档](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) 定义 progress 输出及 silent 不提示用户的约定；缓存优先枚举、只等待缺目录连接和共享并发上限 3 是扩展自身的性能策略。
- 一次模型枚举按连接准备展示上下文；公开元数据变更仅重新组装已验证目录，不改连接健康状态，也不重复请求 Relay。请求专用配置在下次请求时读取，展示、能力和视觉配置分别更新对应状态。新增、编辑的写事务只等待持久化与必要回滚，网络刷新在事务外完成。
- 聊天与 Token 诊断复用连接一致性校验：异步密钥读取或视觉准备期间配置/凭据变更时终止过期请求，不自动重发。目录恢复复用在线刷新的版本守卫，晚到结果不能覆盖已完成的新目录。外部视觉目录复核使用可取消等待，取消当前聊天不终止其他请求共享的复核。
- Claude 前缀验证在一次请求内只遍历消息一次，使用 [Node Hash.copy](https://nodejs.org/api/crypto.html#hashcopyoptions) 取得各历史前缀的摘要。已有指纹的 JSON 字节格式、缓存标记剥离范围及业务字段语义不变；不增加跨请求提示词缓存或旧格式分支。
- `src/json.ts` 仅复用已规范化数据的稳定键排序，保留原 localeCompare、数组顺序和 undefined 行为，以兼容现有目录 HMAC 与旧版迁移。它不替代 canonical 请求校验；历史配置规范化、Claude 前缀指纹、诊断脱敏身份和视觉缓存身份仍按各自语义处理。
- 未完成 Chat 工具调用最多累计 4 MiB UTF-8 数据、512 个调用；索引只需是非负安全整数，可以不连续。这些是扩展的本地资源上限，不是官方 API 限额。空的成功流直接报告错误，不再次生成；只有明确的“不支持流式”错误允许一次非流式降级。

新增、编辑和刷新不增加确认步骤；删除连接及密钥保留一次确认。输入校验、跨连接身份校验、工具批次完整性、取消/超时和持久化回滚仍负责各自实际边界。兼容处理限于已有配置迁移、明确选择的旧网关格式和已知宿主能力差异，不根据模糊失败猜测协议或追加生成请求。

运行时宿主选项只使用当前公开的 `modelOptions`，不再读取 `modelConfiguration` / `configuration` 别名；旧默认连接入口、重复函数包装和无调用的辅助函数已移除。最早期全局连接格式不再在启动时自动重置或删除，其值不参与当前连接读取；清空连接命令仍保留遗留密钥清理。已有连接/密钥/目录的升级迁移与旧会话读取仍用于保留用户数据；全局能力设置和显式 `legacy-relay` 仍有实际行为，不能视为无调用代码。

本项目保留针对多 Relay 的直接 API 适配。这是基于现有兼容性与资源约束的工程选择。官方 [OpenAI TypeScript SDK](https://developers.openai.com/api/reference/typescript) 和 [Anthropic TypeScript SDK](https://platform.claude.com/docs/en/cli-sdks-libraries/sdks/typescript) 均提供流式和取消能力，也默认重试部分失败请求；将来采用 SDK 时需显式配置重试、超时和日志，并继续保留本项目的字节边界与错误脱敏。不能通过 [Anthropic 的 OpenAI 兼容层](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk) 统一三种协议，因为该兼容层不支持 Claude prompt caching 和原生 thinking 输出。
