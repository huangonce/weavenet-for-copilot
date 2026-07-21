# Change Log

## 0.4.1 - 2026-07-21

- Added opt-in OpenAI request capabilities for modern token limits, Relay-specific context windows, prompt caching, store controls, strict and parallel tools, developer messages, client request IDs, and model-specific reasoning efforts.
- Preserved legacy OpenAI-compatible Relay payloads by default while avoiding simultaneous `temperature` and `top_p` sampling controls.
- Added refusal, finish-reason, detailed usage, request ID, rate-limit, and processing-time diagnostics without logging prompt or tool-argument content.
- Hardened strict function schemas with safe fallback and documented a non-disruptive future migration path for the Responses API.

## 0.4.0 - 2026-07-20

- Enabled all Relay connections simultaneously and aggregated their independently refreshed model catalogs with a concurrency limit of three connections.
- Bound every picker model to its source connection, immutable effective configuration, and stable UUID so requests cannot be rerouted by later connection selection or rename operations.
- Migrated profile identities and SecretStorage keys from names to UUIDs with verified, retry-safe upgrade behavior and connection-local diagnostic invalidation.
- Replaced default-connection UX with aggregate status and refresh summaries; deleting a connection now always deletes its API key.

## 0.3.4 - 2026-07-20

- Added explicit structured Relay diagnostics for model discovery and OpenAI/Anthropic streaming and non-streaming protocol support.
- Persisted safe diagnostic summaries by connection fingerprint while invalidating them when credentials change.
- Improved status presentation and connection management with staged editing, optional API-key retention, and orphaned-key reuse.
- Hardened bounded Relay response processing, cancellation handling, response metadata, and diagnostic cache cleanup.

## 0.3.3 - 2026-07-16

- Fixed repeated model catalog reloads by reusing resolved catalogs until connection, credential, or metadata changes explicitly invalidate them.
- Refactored the Copilot provider into focused model discovery, OpenAI, Claude, connection, helper, and request diagnostics modules.
- Strengthened Relay response and streaming reliability while preserving safe cancellation, error mapping, and request diagnostics.
- Added ESLint checks, coverage-enabled CI, package inspection, tag/version validation, and a VS Code Extension Host smoke test.

## 0.3.2 - 2026-07-16

- Refused Relay redirects for authenticated requests and reliably released JSON, OpenAI SSE, and Claude SSE stream readers across completion and failure paths.
- Rejected malformed model catalogs, unsafe connection names, and orphaned destination API keys during connection copy or rename operations.
- Expanded regression coverage for UTF-8 stream boundaries, model catalog validation, SecretStorage lifecycle safety, and connection workflows.

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
