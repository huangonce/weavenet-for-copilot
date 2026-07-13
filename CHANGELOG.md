# Change Log

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
