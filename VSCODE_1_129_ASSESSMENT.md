# VS Code 1.129 兼容性与功能机会评估

> 记录日期：2026-07-16  
> 对应扩展版本：WeaveNet for Copilot 0.3.3  
> 状态：已完成静默模型发现等代码改进，尚未在 VS Code 1.129 Agent Host / Agents 窗口中完成专项验证。

## 结论摘要

VS Code 1.129 未发现会破坏 WeaveNet 当前语言模型 Provider 集成的稳定 API 变更。扩展当前使用的 `LanguageModelChatProvider`、模型信息、流式响应、工具调用、图片输入、模型选项和 token 计数等接口仍然有效。

当前 `package.json` 中的 `engines.vscode: ^1.116.0` 已允许扩展安装到 VS Code 1.129。除非未来实际使用仅在更高版本提供的稳定 API，否则不应仅为跟随最新版本而提高最低 VS Code 版本。

1.129 对 WeaveNet 最有价值的变化，是扩展提供的 BYOK 模型可以被 Copilot Agent Host 的 agent harness 使用。该能力仍受功能开关、组织策略、Agents 窗口扩展激活方式以及模型工具调用能力声明等条件影响，因此目前只能视为可用机会，不能宣称已经完成兼容验证。

## 当前集成基础

WeaveNet 0.3.3 已具备以下基础能力：

- 通过 `contributes.languageModelChatProviders` 声明 `weavenet` Provider。
- 通过 `vscode.lm.registerLanguageModelChatProvider` 注册模型 Provider。
- 从 Relay 发现模型并向 VS Code 提供模型列表。
- 支持 OpenAI-compatible Chat Completions 与 Anthropic-compatible Messages。
- 支持流式输出、工具调用、图片输入、推理选项、上下文窗口、取消请求和 token 估算。
- 根据模型及 Relay 元数据声明 `toolCalling` 和 `imageInput` 能力。
- 使用 VS Code SecretStorage 保存连接密钥。
- 对模型目录使用显式失效、并发合并、连接隔离和已完成目录缓存，避免模型变更事件形成重复刷新反馈循环。

## VS Code 1.129 的直接影响

### 1. 未发现稳定 API 破坏性变化

本次检查未发现与当前 Provider 集成有关的破坏性变更，也不需要立即修改扩展清单、注册方式或 Relay 协议实现。

当前使用的稳定 `LanguageModelChatInformation` 核心字段仍包括：

- `id`
- `name`
- `family`
- `version`
- `detail`
- `tooltip`
- `maxInputTokens`
- `maxOutputTokens`
- `capabilities.toolCalling`
- `capabilities.imageInput`

### 2. 不需要提高最低 VS Code 版本

保留 `engines.vscode: ^1.116.0` 可以继续覆盖已有用户，同时允许在 1.129 上安装。只有在后续代码确实依赖 1.129 或其他更高版本的稳定 API 时，才应调整该声明并同步升级 `@types/vscode`。

### 3. Proposed Custom Editor Priority 与本扩展无关

1.129 提到的自定义编辑器优先级 Proposed API 不影响 WeaveNet，因为扩展没有提供 Custom Editor，也没有启用 Proposed API。

## 可利用的新能力

### Agent Host 中使用 BYOK 模型

VS Code 1.129 的 Agent Host 可以让 BYOK 或扩展提供的语言模型使用 Copilot agent harness。理论上，WeaveNet 模型可在满足条件时用于 agent 会话。

前置条件与限制：

- 用户或组织必须启用 Agent Host，例如允许 `chat.agentHost.enabled`。
- 组织策略可能禁止或限制该功能。
- 模型必须准确声明工具调用能力，才会出现在适用的 agent 模式中。
- Agents 窗口仍处于 Preview，扩展运行与激活行为可能继续变化。
- 扩展可能需要通过 `extensions.supportAgentsWindow` 明确允许在 Agents 窗口中运行；该行为尚未进行实机验证。
- Agent Host 的会话管理工具和 `!` 命令属于 VS Code 产品能力，不需要也不应由 WeaveNet 重复实现。

### Inline Chat 与 Utility Model

扩展提供的模型还可以被用户选择用于：

- `inlineChat.defaultModel`
- `chat.utilityModel`
- `chat.utilitySmallModel`

Utility Model 可参与标题、摘要、设置搜索、Git 审查、提交消息、重命名建议、分支名、提示词分类和意图检测等辅助任务。是否适合用于这些任务，应结合模型成本、延迟、上下文能力和工具支持进行测试。

## BYOK 能力边界

WeaveNet 的语言模型 Provider 不会自动替代所有 GitHub Copilot 服务能力。当前不应宣称支持以下能力：

- GitHub 服务提供的语义代码搜索。
- Embedding 生成与向量索引。
- 编辑器内联代码补全或 ghost text。

如需提供 WeaveNet 驱动的内联代码补全，需要另行实现并维护 `InlineCompletionItemProvider`，这不属于本次 1.129 兼容评估范围。

## 已识别的兼容风险

### 1. Agents 窗口扩展激活

需要验证 WeaveNet 是否会在 Agents 窗口中自动激活、Provider 是否成功注册，以及是否需要增加 `extensions.supportAgentsWindow` 配置。

### 2. 多窗口模型发现

Agent Host 会引入更多窗口和会话场景，需要检查：

- 主窗口与 Agents 窗口是否会重复触发模型发现。
- 同一连接是否出现重复模型项。
- SecretStorage、配置变更和模型刷新事件是否在不同窗口间保持一致。
- 已修复的模型刷新事件反馈循环是否会在新宿主中重新出现。

### 3. Silent 模型发现

稳定 API 的 `PrepareLanguageModelChatModelOptions.silent` 表示静默解析模型时不应弹出交互式 UI。当前 `provideLanguageModelChatInformation()` 已显式处理该参数：后台静默发现不显示成功通知，用户主动刷新仍可显示结果。

该行为已有单元回归测试，但仍需在 Agent Host 和 Agents 窗口的真实多窗口枚举场景中验证。

### 4. 工具调用能力声明

Agent 模式依赖 `capabilities.toolCalling`。如果 Relay 或补充元数据错误地把不支持工具调用的模型标记为支持，模型可能进入 agent 模式但在执行工具时失败；如果错误地标记为不支持，则模型可能不会出现在 agent 模式。

后续验证应覆盖真实工具调用，而不只检查模型是否出现在选择器中。

### 5. 非稳定模型选择器元数据

WeaveNet 当前还会向模型信息附加以下字段：

- `isBYOK`
- `isUserSelectable`
- `statusIcon`
- `inputCost`
- `outputCost`
- `cacheCost`
- `cacheWriteCost`
- `pricing`
- `priceCategory`
- `configurationSchema`

这些字段不属于当前稳定 `LanguageModelChatInformation` 类型。它们可能被 VS Code 当前产品界面识别，但不应被视为长期稳定合同。后续升级 VS Code 时需要回归测试，并在官方稳定 API 提供对应能力后优先迁移。

## 后续验证与改进路线

以下为完成静默发现代码改进后仍待开展的真实环境验证与长期工作；本文档本身不包含功能实现。

### P0：真实环境兼容验证

- 在 VS Code 1.129 中安装发布版或测试 VSIX。
- 启用 Agent Host，并确认 WeaveNet 模型能否出现在 agent 模型选择器中。
- 运行包含工具调用、流式响应、取消和长上下文的真实 agent 会话。
- 验证 Agents 窗口中的扩展激活、SecretStorage、配置与日志行为。
- 检查主窗口和 Agents 窗口之间是否存在重复模型或重复 `/models` 请求。

### P1：静默发现与自动化测试

- 在 Agent Host 中验证 `options.silent` 的真实调用行为。
- 验证后台发现、启动发现和用户主动刷新的通知隔离。
- 为 Agent Host 多次枚举和跨窗口事件反馈增加集成回归测试。
- 在 Extension Host 测试中增加 VS Code 1.129，或建立最低支持版本与当前稳定版本的测试矩阵。
- 为工具调用能力声明增加端到端验证。

### P2：长期 API 对齐

- 跟踪 Agents 窗口从 Preview 转为稳定后的扩展激活要求。
- 跟踪 BYOK、模型配置与价格展示相关的稳定 API。
- 审查并减少对非稳定模型选择器字段的依赖。
- 仅在采用新稳定 API 时升级 `@types/vscode` 和 `engines.vscode`。
- 评估是否需要在用户文档中增加 Agent Host、Inline Chat 和 Utility Model 使用说明。

## 当前决策

截至 2026-07-16，维持以下决策：

- 仅修改稳定 API 范围内的运行时代码，不引入 1.129 专属 API。
- 不启用 Proposed API。
- 不提高最低 VS Code 版本。
- 不立即升级 `@types/vscode`。
- 不宣称已经完成 Agent Host 或 Agents 窗口兼容认证。
- 保留现有 Provider 集成，并将 Agent Host 兼容性作为后续专项验证工作。

## 参考资料

- [Visual Studio Code 1.129 Release Notes](https://code.visualstudio.com/updates/v1_129)
- [Language Models in Visual Studio Code](https://code.visualstudio.com/docs/agent-customization/language-models)
- [Agents Window](https://code.visualstudio.com/docs/agents/agents-window)
- [VS Code API: LanguageModelChatInformation](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatInformation)
- [VS Code API: LanguageModelChatProvider](https://code.visualstudio.com/api/references/vscode-api#LanguageModelChatProvider)
