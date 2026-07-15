# WeaveNet 通用 Relay 产品改进清单

> 目标：将 WeaveNet 从服务于特定 sub2api 部署的扩展，逐步发展为可连接不同 OpenAI 兼容与 Anthropic 兼容 AI Gateway 的 Copilot 扩展。

## P0：首次体验与连接管理

### 1. 以普通连接替代内置 Default Relay

- 不再以产品预设绑定特定 Relay 地址。
- 首次启动显示 **Add Relay Connection**，依次输入连接名称、Base URL 与 API Key。
- 第一个创建的连接自动成为默认连接。

### 2. 补齐连接管理操作

新增命令或界面操作：

- 编辑连接：名称、Base URL、附加请求头、模型规则。
- 删除连接：明确询问是否一并删除 SecretStorage 中的 API Key。
- 复制连接：便于创建不同模型过滤或路由规则的变体。
- 测试连接：检查地址、鉴权、模型端点与协议支持。
- 设为默认连接：不再用空 `activeProfile` 表示默认连接。

### 3. 提供可见的连接状态

在状态栏、模型选择器或连接管理界面展示：

- 当前连接名称与 Base URL 主机名。
- 最后连接结果与检测时间。
- 已发现模型数量。
- 切换、测试和编辑连接的快速入口。

## P0：错误诊断与可恢复性

### 4. 输出结构化连接测试结果

测试连接时应区分并解释：

- URL 格式错误、DNS、TLS 或网络错误。
- `401` / `403`：API Key 无效或权限不足。
- `404`：端点路径不兼容。
- `429`：服务限流。
- `5xx`：Relay 或其上游失败。
- `/models` 可用但 Claude `/messages` 不兼容。

结果中可安全展示脱敏后的请求地址、HTTP 状态、响应类型与 `X-Request-Id`。

### 5. 探测并保存 Relay 能力

连接测试应验证并记录以下能力，模型选择器仅展示实际可用能力：

- OpenAI Chat Completions。
- Anthropic Messages。
- 工具调用。
- 图片输入。
- 流式响应。
- 推理参数。
- 提示词缓存。

## P1：兼容性与配置模型

### 6. 支持多种认证方式

保留“一把 API Key”作为默认体验，并支持连接级认证策略：

- Bearer Token。
- `x-api-key`。
- 自定义请求头。
- 无认证（本地 Relay）。
- 后续扩展 OAuth、环境变量或外部命令获取令牌。

所有敏感凭据仍只保存在 VS Code SecretStorage。

### 7. 允许连接级协议和路径覆盖

为不同服务提供可配置或自动探测的端点：

- Models path，例如 `/models`。
- OpenAI Chat path，例如 `/chat/completions`。
- Anthropic Messages path，例如 `/messages`。
- 协议开关或自动探测。
- API 版本 Header。

### 8. 提供模型别名与路由规则

避免仅通过模型 ID 名称猜测协议。支持配置：

- 模型 ID 到协议的映射。
- 显示名称。
- 禁用模型。
- 固定模型。
- 优先模型。
- 模型分组。

这有助于兼容 OpenRouter、LiteLLM、OneAPI、New API、企业网关和私有代理。

## P1：隐私、安全与企业可用性

### 9. 明确第三方服务数据告知

首次创建连接时显示一次简要确认：

- 对话、代码、工具结果和图片会发送至用户配置的 Relay。
- Relay 可能继续转发至其他模型提供商。
- 用户应确认服务的数据保留与隐私政策。

### 10. 加强敏感数据保护

- 永不记录自定义认证 Header 的值。
- 支持导出安全诊断报告，自动移除密钥、Prompt 和工具参数。
- 删除连接时可选择一并清除密钥。
- 错误消息不得回显完整 URL query 参数。

### 11. 明确团队与工作区配置边界

推荐的分层：

- 可提交到仓库：连接名称、地址、模型规则、非敏感 Header 名称。
- 不可提交：API Key、认证 Header 值。
- 支持共享连接模板；每位开发者单独填写自己的密钥。

## P2：产品包装与可维护性

### 12. 去除特定服务绑定

将 Marketplace 和 README 的核心定位调整为：

> Connect GitHub Copilot Chat to OpenAI-compatible and Anthropic-compatible AI gateways.

sub2api 应作为已验证的兼容服务或示例出现，而不是默认产品假设。

### 13. 支持连接模板导入与导出

导出的连接模板不得包含密钥。例如：

```json
{
  "name": "Company Gateway",
  "baseUrl": "https://ai.example.com/v1",
  "protocols": ["openai", "anthropic"]
}
```

导入模板后，要求用户单独填入 API Key。

### 14. 按用户任务重组文档

将文档按以下场景拆分或重构：

- 5 分钟快速开始。
- 创建、编辑、删除连接。
- 兼容的 Relay 类型。
- 协议与模型路由。
- 故障排查。
- 隐私与安全。
- 企业与团队配置。

## 建议实施顺序

1. 用普通连接取代产品预设的 Default Relay。
2. 实现测试、编辑、删除连接。
3. 实现连接级协议能力探测和可操作的故障提示。
4. 扩展认证方式及端点路径覆盖。
5. 继续完善模型路由、团队共享和产品文档。
