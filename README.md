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

## 命令与诊断

命令面板保留六个主要入口：

- `WeaveNet: Add Relay Connection`
- `WeaveNet: Manage Relay Connections`
- `WeaveNet: Refresh Models`
- `WeaveNet: Test Relay Connection`
- `WeaveNet: Open Settings`
- `WeaveNet: Show Debug Log`

编辑、复制、删除、密钥管理、元数据刷新和视觉模型选择集中在管理菜单；旧命令 ID 暂时保留兼容，常用命令面板不再逐一展示。

连接测试只由用户主动触发。测试读取 `/models`，并为实际配置的每种 API 选择一个模型，执行最小流式与非流式请求；不测试未配置的 API。最小请求可能产生少量费用。测试会展示脱敏 Host、端点、HTTP 状态、响应类型和请求 ID；结果是该代表模型的证据，不保证连接中的所有模型和能力都已验证。声明 max_completion_tokens 的 Chat 模型会用对应字段测试；声明不允许输出上限的模型不会执行无界生成测试。

某条连接刷新失败时，仅恢复该连接最后一次成功目录并显示降级状态；其他连接继续可用。每条连接保存一份 `directory`，v3 快照最多保留 2000 个 API 模型条目；固定模型、能力覆盖、过滤和可选公开元数据在在线刷新与离线恢复时按同一规则组装，不再额外持久化最终模型列表。目录快照绑定连接配置与凭据，修改 API、模型规则、地址或密钥后不会复用旧身份的快照。取消、超时、截断流和无效工具参数会明确报告，聊天 POST 不会盲目重试。

开启 `debug` 后记录脱敏请求摘要、usage、首输出时延、请求 ID 等。API Key、提示词正文与工具参数正文不写入日志。`cacheRead` 等字段缺失只表示上游没有返回用量，不代表未命中缓存。

运行时界面文案跟随 VS Code 的显示语言：当前内置简体中文（`l10n/bundle.l10n.zh-cn.json`），未翻译的条目自动回退英文。新增语言只需在 `l10n/` 下添加 `bundle.l10n.<locale>.json`；`npm test` 会校验翻译键与代码中的引用一一对应、占位符一致，且没有空值或遗留条目。

## 可选功能

### 在线模型元数据

`modelMetadataEnabled` 默认开启，使用 OpenRouter 公开目录补充 Relay 缺失的图片、工具、推理能力和参考价格。关闭后既不刷新公开目录，也不使用已缓存的公开元数据，只读取 Relay 和模型声明。`metadataRefreshHours` 控制缓存刷新间隔；管理菜单可手动刷新。

用户配置与 Relay 元数据优先；无法确认的能力保持关闭。参考价格不是 Relay 实际扣费，应以 Relay 的用量日志为准。公开目录也不能证明某条具体 Relay 路由接受相同功能，必要时用模型覆盖关闭能力。

### 纯文本模型的视觉代理

`visionProxyEnabled` 默认关闭。通过管理菜单选择已安装的原生视觉模型，或在设置说明中点击“选择视觉代理模型”，将 `visionProxyModel` 配置为精确 `vendor/id`。纯文本模型会先让该模型描述图片，再把描述交给目标 Relay；原生视觉模型直接接收图片。

图片、视觉指令和当前消息的有界布局（可能包含用户文本、工具结果）会交给视觉模型提供者，可能独立计费。代理不自动选模、不回退、不允许递归使用仅靠代理获得视觉能力的模型。

每个请求最多 8 张图片，单张 10 MiB、总计 20 MiB；描述只进入有界的短期进程内缓存，不持久化。目标请求成功后才提交缓存；历史描述过期后不会自动再次外发原图片。`visionProxyPrompt` 可以覆盖默认描述指令。

现有图片请求的兼容规则与工具图片提升处理继续保留；它们不属于本次协议配置精简。详见隐私说明。

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
npm run lint
npm run typecheck
npm run compile
npm run test:coverage
npm run test:integration
npm run package:list
```

合并到 main 只运行 CI，CI 会在声明的最低宿主 VS Code 1.116.0 与最新稳定版上分别运行扩展宿主冒烟测试。发布前同步更新扩展与锁文件版本、CHANGELOG，等待检查通过后推送带说明的语义版本标签；Marketplace 发布流水线会校验标签、`package.json` 与 CHANGELOG 版本一致后运行检查并打包，重复版本会明确失败而不是静默跳过。0.8.0 已就绪但尚未发布。
