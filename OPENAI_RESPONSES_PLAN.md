# OpenAI Responses API 增量演进计划

## 目标

在不改变现有 Relay 默认行为的前提下，将 OpenAI Responses API 作为新的显式协议加入。现有 OpenAI-compatible 模型继续使用 `POST /chat/completions`；不得因一次聊天 POST 失败而自动切换协议或重试。

## 协议选择

后续为固定模型和可验证的模型目录能力增加独立协议值，例如：

- `openai-chat`：现有 `POST /chat/completions`，默认且向后兼容。
- `openai-responses`：新增 `POST /responses`，仅在连接或模型显式声明时启用。
- `anthropic-messages`：现有 `POST /messages`。

Picker ID、连接 UUID、配置 revision 与来源绑定规则保持不变。协议是模型绑定的一部分，选中模型后不得跨协议重路由。

### 已确认的配置方案

下一版本优先提供模型级显式配置，不默认对整个连接启用 Responses。例如：

```json
{
	"id": "gpt-5.2",
	"route": "openai",
	"protocol": "openai-responses",
	"toolCalling": true,
	"thinking": true
}
```

兼容规则：

- 现有 `route: "openai"` 或 `route: "chatgpt"` 未声明 `protocol` 时，继续使用 `openai-chat`。
- 现有 `route: "claude"` 未声明 `protocol` 时，继续使用 `anthropic-messages`。
- 只有显式声明 `protocol: "openai-responses"` 的模型才请求 `/responses`。
- 同一连接可以同时配置 Chat Completions、Responses 和 Claude Messages 模型。
- 初版不提供自动连接级默认值，避免把不支持 Responses 的模型一起切换。

运行时在请求开始前只分派一次：

- `openai-chat` → Chat Completions provider。
- `openai-responses` → Responses provider。
- `anthropic-messages` → Claude Messages provider。

分派后协议不可改变。任一 POST 失败都直接返回对应错误，不改发其他协议、模型或连接。

## 实施阶段

1. 增加独立的 Responses 请求、事件和 usage 类型，不与 `ChatRequest` 共用可变联合类型。
2. 实现 `POST /responses` 客户端；保持有界正文、SSE 单事件上限、响应头超时、流空闲超时、取消和拒绝重定向。
3. 映射 `input`、`instructions`、function tools、reasoning items、output items、refusal 和 usage。
4. 单独解析 Responses SSE 事件，只有官方完成事件才视为正常终止。
5. 增加用户显式触发的最小协议探测；后台模型发现不执行付费 POST。
6. 为 Chat Completions 与 Responses 分别维护能力字段和契约测试。
7. 真实 Relay 验证后再在文档中宣布支持，不改变既有连接默认值。

## 安全与兼容约束

- 聊天 POST 不做网络级自动重试。
- Chat Completions 失败后不自动改发 Responses，反之亦然。
- 不跨连接故障转移，不复制工具执行。
- Responses 初版不自动从流式降级到非流式，不自动替换请求字段后重发。
- `store`、previous response ID 和服务层级等字段必须由显式能力控制。
- Responses 初版采用无状态请求，不依赖 `previous_response_id`，默认不启用服务端存储。
- 日志只记录协议、状态、事件类型、usage、请求 ID 和时延；不记录 Prompt、图片或工具参数正文。
- 现有 `route: "openai"` 固定模型保持 Chat Completions 语义，避免配置迁移破坏。

连接测试可增加由用户显式触发的 `/responses` 流式和非流式最小探测。后台模型发现不得执行付费 POST，探测结果只作为配置依据，不能触发运行时协议切换。

## 完成条件

- 原有 Chat Completions 测试和真实 Relay 测试全部保持通过。
- Responses 流式、非流式、工具调用、拒绝、截断、usage、取消和不完整流均有测试。
- 协议选择只依赖显式配置或可信模型目录字段。
- `/responses` 失败后不存在 `/chat/completions` 重发，反向也不存在；测试必须验证每次逻辑请求只访问一个协议端点。
- 升级用户无需修改现有连接即可继续使用。
