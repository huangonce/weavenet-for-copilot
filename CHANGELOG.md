# Change Log

## 0.3.1 - 2026-07-16

- Made connection creation and renaming recover safely across configuration and SecretStorage failures, while serializing connection mutations.
- Fixed secret-deletion rollback races and expanded the one-time legacy reset to clean global, workspace, and workspace-folder legacy Base URL values.
- Isolated model-refresh snapshots by active connection to prevent stale models from another Relay appearing after a connection switch.
- Validated Relay base URLs and constructed endpoints canonically; protected Relay authentication and protocol headers from profile overrides.
- Restricted model-refresh diagnostics to debug-gated, structured error summaries without raw upstream messages.

## 0.3.0 - 2026-07-15

- Replaced the built-in Default Relay with named Relay connections, including add, edit, copy, test, delete, clear-all, and set-default workflows with isolated SecretStorage API keys.
- Added visible connection status and structured connection diagnostics for safe endpoints, HTTP status, response type, request IDs, and Claude `/messages` compatibility.
- Replaced ambiguous legacy Relay migration with a one-time reset of the pre-profile Base URL and legacy API keys. Existing profile connections and profile-scoped keys are never removed by this upgrade step.
- Moved the extension icon to `resources`, tightened the VSIX contents, and added package-content inspection to Marketplace publishing.

## 0.2.1 - 2026-07-15

- Increased the default relay response-header timeout from 60 to 120 seconds for slower reasoning and long-context requests.
- Hardened Claude tool-result chains, streaming tool arguments, extended-thinking sampling constraints, and OpenAI incremental tool calls.
- Extended model-discovery timeout and cancellation through body reads, added response/catalog limits, and strengthened metadata cache validation.
- Added structured relay error mapping, isolated Copilot Chat activation failures, and required compilation and tests before Marketplace publishing.

## 0.2.0 - 2026-07-15

- Added independent route refresh, fixed/private model definitions, unique picker IDs, and explicit upstream routing.
- Added response/stream timeouts, one safe retry for model discovery GETs, and processing-aware stream fallback without blind chat retries.
- Improved OpenAI and Claude SSE/JSON compatibility, reasoning, usage, incremental tools, MIME validation, and strict tool argument parsing.
- Added Anthropic cache breakpoints with configurable `5m`/`1h` TTL, sampling controls, sanitized tool schemas, safer relay error mapping, and broader token estimation.
- Added Vitest coverage for protocol parsing, cache controls, schema sanitization, and model routing.

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
