# WeaveNet for Copilot

把你的 OpenAI 兼容 AI Relay 模型接入 GitHub Copilot Chat 的模型选择器，同时保持 Claude 走 Claude 原生协议、其他模型走 OpenAI 协议。

## 项目结构

```text
src/
  extension.ts       VS Code 激活与命令注册
  constants.ts       扩展常量与 SecretStorage key
  auth/              Relay API Key 管理
  config/            VS Code 配置读取与校验
  copilot/           Copilot provider 与请求转换
  relay/             中转站 HTTP/SSE 客户端、模型与协议类型
  metadata/          OpenRouter 在线模型能力与参考价格
```

## 使用方式

1. 安装本地 VSIX 扩展。
2. 在你的 Relay 中创建一把可访问所需模型的 API Key。
3. 首次启动时，扩展会显示一次非阻塞提示；点击 **Add Relay Connection**，输入连接名称、Relay Base URL 和 API Key。也可在命令面板运行 `WeaveNet: Add Relay Connection`。
4. 运行 `WeaveNet: Refresh Models`，然后在 Copilot Chat 模型选择器里选择 `WeaveNet ...` 模型。
5. 需要立即更新 OpenRouter 能力目录时，运行 `WeaveNet: Refresh Model Metadata`。

### Relay 连接管理

可用配置档在工作、中转站或模型集之间快速切换，而不必反复改写设置：

1. 在命令面板运行 `WeaveNet: Add Relay Connection`，依次填写名称、Relay API 地址和 API Key。
2. 使用 `WeaveNet: Manage Relay Connections` 新增、编辑、复制、测试、删除连接或设置默认连接。状态栏会显示当前连接和模型刷新状态。

每个连接可选地设置 `requestHeaders`、`includeModels`、`excludeModels` 和固定 `models`。每个连接只有一把 Relay API Key，密钥不会写入 `settings.json`，而是按连接隔离存储在 VS Code SecretStorage。复制连接不会复制其 API Key。`requestHeaders` 的值仍属于普通 VS Code 设置，不受 SecretStorage 保护，不得用于保存 API Key、令牌或其他敏感信息。

## 命令

- `WeaveNet: Add Relay Connection`：新建 Relay 连接，收集地址和 API Key 后自动设为默认连接。
- `WeaveNet: Manage Relay Connections`：打开连接管理菜单。
- `WeaveNet: Edit Relay Connection`：编辑连接名称、地址、额外请求头、模型过滤规则和固定模型。改名时会迁移该连接的 API Key。
- `WeaveNet: Copy Relay Connection`：复制不含 API Key 的连接配置。
- `WeaveNet: Test Relay Connection`：通过 `/models` 测试地址、认证和模型发现；发现 `claude-*` 模型时也会以最小请求验证 Claude `/messages`。结果安全展示脱敏端点、HTTP 状态、响应类型与请求 ID，并解释鉴权、端点、限流、上游和网络错误。
- `WeaveNet: Set Default Relay Connection`：选择 Copilot 使用的连接。
- `WeaveNet: Delete Relay Connection`：永久删除连接配置及其 API Key。
- `WeaveNet: Clear All Relay Connections`：永久删除全部连接配置、其 API Key，以及旧版本遗留的 Relay 密钥。
- `WeaveNet: Set Relay API Key`：设置当前连接的唯一 API Key。
- `WeaveNet: Clear Relay API Key`：删除当前连接的 API Key。
- `WeaveNet: Refresh Models`：使用当前 Relay API Key 刷新模型列表。
- `WeaveNet: Refresh Model Metadata`：立即刷新 OpenRouter 的公开模型能力和参考价格目录。
- `WeaveNet: Open Settings`：打开 WeaveNet 设置页。
- `WeaveNet: Show Debug Log`：打开 `WeaveNet` 输出通道，用于查看脱敏请求摘要和缓存用量字段。

## 协议路由

插件使用当前 Relay 的同一把 API Key 获取模型，并按模型协议发送请求：

- OpenAI 兼容模型：走 `POST /chat/completions`，使用 `Authorization: Bearer` 认证。
- Claude 模型：走 Anthropic-compatible `POST /messages`，使用 `x-api-key` 认证。

同一把密钥只因目标协议不同而采用对应的请求头；这样可避免 Claude 模型被错误地转成 OpenAI 协议，减少缓存或原生能力失效的问题。

## 模型能力与参考价格

模型的图片输入、工具调用、推理和上下文窗口优先读取 sub2api 返回的能力字段，缺失字段由 OpenRouter 补充；公开参考价格来自 OpenRouter。插件不再使用 LiteLLM、内置模型快照或名称猜测。无法确认的图片、工具与推理能力保持关闭，缺失的 token 上限使用插件配置默认值。模型选择器会显示输入、输出和缓存读取的每百万 token 参考价，以及对应的成本档位。

参考价格不是 sub2api 实际扣费价格。实际扣费受你的分组、账号倍率和上游渠道影响，应以 sub2api 的用量日志为准。

支持推理的模型会在聊天输入框旁显示“思考工作量”，可选择 Low、Medium、High、Extra High 或 Max。OpenAI 协议会发送 `reasoning_effort`；Claude 协议会换算为原生 `thinking.budget_tokens`。有上下文窗口元数据的模型也会显示“上下文大小”。

## 常用设置

- `weavenet-copilot.activeProfile`：当前使用的 Relay 连接名称；仅全局保存，且仅在没有任何连接时为空。
- `weavenet-copilot.profiles`：全局保存的 Relay 连接列表。每项至少包含 `name`、`baseUrl`，还可单独设置 `requestHeaders`、模型白名单/黑名单与固定模型；schema 不允许在此写入 API Key 或其他未声明字段。`requestHeaders` 是普通配置，不应包含任何秘密。
- `weavenet-copilot.anthropicVersion`：Claude `/messages` 请求使用的 `anthropic-version`。
- `weavenet-copilot.openaiPromptCaching`：是否为 `gpt-*` 模型发送稳定的 `prompt_cache_key`，默认开启。
- `weavenet-copilot.openaiPromptCacheKey`：可选的 OpenAI 缓存 key。留空时按当前工作区生成稳定值；同一工作区内应保持不变。
- `weavenet-copilot.claudePromptCaching`：Claude 缓存模式，默认 `automatic`。插件会为 system、最后一个工具定义和最近两条用户消息设置显式缓存断点，适合持续增长的多轮 Copilot 对话。设为 `disabled` 可关闭缓存。
- `weavenet-copilot.debug`：开启后将请求摘要和 Claude 缓存用量写入 VS Code 的 `WeaveNet` 输出通道，不记录 API Key 或 prompt 正文。通过 `WeaveNet: Show Debug Log` 打开。
  - `cacheRead` / `cacheWrite` 为数字时是上游实际返回的 token 用量；显示 `n/a` 表示上游的流式响应未返回该字段，不能据此判断是否命中。
- `weavenet-copilot.includeModels` / `excludeModels`：旧版顶层兼容设置。仅当当前配置档省略同名字段时作为模型 ID 正则白名单/黑名单回退；新配置应写入 `profiles` 中。
- `weavenet-copilot.maxInputTokens`：向 Copilot 声明的输入 token 硬上限，默认 `128000`。即使模型元数据声明了更大的上下文，也不会超过这个值；OAuth 上游的实际窗口较小时应相应调低。
- `weavenet-copilot.supportsToolCalling`：是否向 Copilot 声明工具调用能力。
- `weavenet-copilot.supportsImageInput`：是否为所有模型向 Copilot 声明图片输入能力，默认关闭。
- `weavenet-copilot.imageInputModels`：可选的模型 ID 正则表达式；命中后强制向 Copilot 声明图片输入能力。正常情况下无需配置，插件会优先根据 sub2api 和 OpenRouter 的模型元数据自动识别。
- `weavenet-copilot.disabledImageInputModels`：即使公开元数据声称支持图片，也强制关闭对应模型的图片输入能力。默认为空；只有确认某个具体路由不支持图片时，才建议在这里添加模型 ID 正则表达式。
- OpenAI 图片请求会自动采用与 VS Code 内置 Custom Endpoint 相同的兼容形态，不发送 `prompt_cache_key`、`context_window`、`reasoning_effort` 或 `max_tokens` 等可选扩展字段；纯文本请求仍保留对应设置。
- `weavenet-copilot.metadataRefreshHours`：OpenRouter 模型能力目录的后台刷新间隔，默认 6 小时。
- `weavenet-copilot.models`：旧版顶层兼容的固定模型列表；仅当当前配置档省略 `models` 时作为回退。新配置应写入 `profiles` 中。
- 自动发现通过当前连接的 `/models` 目录一次性刷新；返回的 `claude-*` 模型使用 Claude 原生路由，其余模型使用 OpenAI 路由。固定模型会与发现结果合并。发现失败时会保留上一次成功的发现快照；如果没有快照但配置了固定模型，则以降级状态仅展示固定模型。
- `weavenet-copilot.requestTimeoutSeconds`：等待响应头的秒数。模型发现 GET 最多安全重试一次，聊天 POST 不做网络盲重试。
- `weavenet-copilot.streamIdleTimeoutSeconds`：流式响应数据块之间允许的空闲秒数。
- `weavenet-copilot.temperature` / `weavenet-copilot.topP`：可选采样参数，同时转发到 OpenAI 兼容和 Claude 请求。
- `weavenet-copilot.claudePromptCachingTTL`：Claude 缓存断点 TTL，支持 `5m` 和 `1h`。自动模式会覆盖 system、tools 和最近两条用户消息。

协议兼容层同时支持标准 SSE、无空格 `data:`、CRLF、完整 JSON 响应、reasoning、usage 和增量工具调用。只有在没有任何上游处理证据时，流式请求才允许安全降级为非流式请求。

当上游明确返回上下文窗口超限时，插件会提示新开会话或减少附件。Cloudflare、Nginx 等网关返回 HTML 错误页时，插件只显示简短的 HTTP 错误和排查提示，不会把整页 HTML 注入聊天窗口。调试模式会额外记录请求体字节数，但不会记录请求正文。

API Key 会存储在 VS Code SecretStorage 中。

请使用 `Delete Relay Connection` 或 `Clear All Relay Connections` 删除连接；这两个命令会同时清除对应 API Key。直接手动编辑设置删除 Profile 不会回收 SecretStorage 中已有的 API Key。

从旧版单一 Relay 配置首次升级到连接配置档版本时，扩展会执行一次性清理：删除旧版顶层 Base URL 与旧版 API Key，并要求重新创建 Relay 连接。完成标记保存在 VS Code 全局状态中，后续升级不会重复执行，也不会删除新版连接配置或连接专属 API Key。

## 隐私与安全

- API Key 只保存在 VS Code SecretStorage 中，不会写入工作区文件或调试日志。
- 自定义 `requestHeaders` 值由 VS Code 配置系统保存，不受 SecretStorage 保护；不得在其中放置 API Key、令牌或其他敏感信息。
- 对话、代码、图片和工具调用内容会发送到你配置的 sub2api 中转站及其上游模型服务。
- 插件不会收集遥测数据。开启调试日志时只记录脱敏请求摘要，不记录 API Key 或提示词正文。
- 使用公开或第三方中转站前，请确认其隐私政策、日志保留和数据处理方式符合你的要求。

完整说明见 [PRIVACY.md](PRIVACY.md)，问题反馈见 [SUPPORT.md](SUPPORT.md)。

## 发布流程

合并到 `main` 只运行持续集成，不会发布。发布前必须更新 `package.json` 和 `package-lock.json` 的版本号，并同步维护 `CHANGELOG.md`；Marketplace 不允许重复发布同一版本。

```bash
npm version patch --no-git-tag-version
git commit -am "Release x.y.z"
git tag vx.y.z
git push origin main vx.y.z
```

推送形如 `v0.3.3` 的语义化版本标签后，GitHub Actions 会校验标签与 `package.json` 版本一致，再执行 lint、编译、覆盖率门槛、真实 VS Code 扩展宿主冒烟测试、打包和 Marketplace 发布。流水线使用仓库的 `VSCE_PAT` Actions Secret；重复版本会安全跳过，不会覆盖已发布版本。
