# OpenAI Responses API 增量演进计划

## 目标

在不改变现有 Relay 默认行为的前提下，将 OpenAI Responses API 作为新的显式协议加入。现有 OpenAI-compatible 模型继续使用 `POST /chat/completions`；不得因一次聊天 POST 失败而自动切换协议或重试。

## 协议选择

后续为固定模型和可验证的模型目录能力增加独立协议值，例如：

- `openai-chat`：现有 `POST /chat/completions`，默认且向后兼容。
- `openai-responses`：新增 `POST /responses`，仅在连接或模型显式声明时启用。
- `anthropic-messages`：现有 `POST /messages`。

Picker ID、连接 UUID、配置 revision 与来源绑定规则保持不变。协议是模型绑定的一部分，选中模型后不得跨协议重路由。

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
- `store`、previous response ID 和服务层级等字段必须由显式能力控制。
- 日志只记录协议、状态、事件类型、usage、请求 ID 和时延；不记录 Prompt、图片或工具参数正文。
- 现有 `route: "openai"` 固定模型保持 Chat Completions 语义，避免配置迁移破坏。

## 完成条件

- 原有 Chat Completions 测试和真实 Relay 测试全部保持通过。
- Responses 流式、非流式、工具调用、拒绝、截断、usage、取消和不完整流均有测试。
- 协议选择只依赖显式配置或可信模型目录字段。
- 升级用户无需修改现有连接即可继续使用。
