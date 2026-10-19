# 语言模型 Provider 契约与 configuration 迁移评估

> 记录日期：2026-10-09
> 对应扩展版本：WeaveNet for Copilot 0.8.0
> 对照宿主：已声明最低版本 VS Code 1.116.0 与本机最新稳定版 1.141.0
> 结论：**暂不迁移** `managementCommand` → `configuration`；先做一次 spike 回答第四节的问题。触发条件见第五节。

## 结论摘要

1. 稳定 API 从 1.116.0 到 1.141.0 **没有任何变化**：本机 `vscode.d.ts` 中 32 个 `LanguageModel*` 声明与 `lm` 命名空间的成员、签名逐行一致（去掉注释后比对）。
2. 宿主实际读取的字段多于稳定 d.ts。`isUserSelectable`、`statusIcon`、`configurationSchema`、`isBYOK` 等**没有 proposed 门槛**，本扩展已经在用，稳定版上确实生效。
3. `capabilities.apiType`、`adaptiveThinking`、`editTools` 会让宿主**抛错**（`L(extension, proposal)` 的实现就是 `throw`）。这是硬红线，已用测试锁定。
4. `managementCommand` 在 1.116.0 与 1.141.0 中都标记为 `deprecated: true`（不是 1.141 新增），但**仍然可用**；`configuration`、`when`、`deprecation.link` 在两个版本都已存在。因此迁移不需要提高最低宿主版本，但也意味着一旦声明 `configuration`，管理页齿轮入口会立刻切换行为。

## 一、契约对照（1.116.0 → 1.141.0）

### 1. 稳定 API 无变化

方法：把 `node_modules/@types/vscode/index.d.ts`（1.116.0）与已安装宿主的
`resources/app/out/vscode-dts/vscode.d.ts`（1.141.0）按声明切块、去注释、归一化空白后逐块比对。

- 32 个 `LanguageModel*` 声明：无新增、无删除、无成员变化。
- `lm` 命名空间：`selectChatModels`、`registerLanguageModelChatProvider`、`registerTool`、`invokeTool`、`tools`、`onDidChangeChatModels` 等完全一致。
- 官方 release notes（1.137–1.141）也确认没有 provider API 变更。

### 2. 运行时暴露面（真实扩展宿主探针）

在未声明任何 `enabledApiProposals` 的探针扩展里读取 `vscode` 模块：

| 宿主 | `LanguageModelThinkingPart` | `LanguageModelDataPart` | `lm` 成员数 | 备注 |
| --- | --- | --- | --- | --- |
| 1.141.0 | function | function | 23 | 多出 `LanguageModelChatApiType` |
| 1.116.0 | function | function | 23 | 无 `LanguageModelChatApiType` |

结论：proposed API 的**实现**在稳定宿主里也存在，只有 **d.ts** 被 proposal 门槛挡住。因此"运行时探测 + 优雅降级"是正确策略，本扩展的 thinking 承载与协议回放不需要改动。

### 3. 宿主读取、但没有 proposed 门槛的字段

从宿主编译产物（`extensionHostProcess.js` 的 `$provideLanguageModelChatInfo`、`workbench.desktop.main.js` 的模型元数据构造）可读到：

- 直接透传：`isUserSelectable`、`statusIcon`、`configurationSchema`、`isBYOK`、`warningText`、`infoText`、`promo`、`targetChatSessionType`。
- 能力映射：`capabilities.imageInput → vision`、`capabilities.toolCalling → { toolCalling, agentMode }`。
- `configurationSchema` 会被 `getModelConfigurationActions()` 转成模型右键/管理页里的枚举动作（1.116 与 1.141 都有该路径）。

### 4. 需要 proposed API 的字段（会让宿主抛错）

`extensionHostProcess.js` 中：

```js
function He(extension, proposal) { return extension.enabledApiProposals?.includes(proposal) ?? false; }
function L(extension, proposal) { if (!He(extension, proposal)) throw new Error(`Extension '...' CANNOT use API proposal: ${proposal}...`); }
// 模型信息映射：
a.capabilities.editTools && L(o.extension, "chatProvider");
(a.capabilities.apiType !== void 0 || a.capabilities.adaptiveThinking !== void 0) && L(o.extension, "languageModelCapabilities");
```

- 因此返回 `capabilities.editTools` / `apiType` / `adaptiveThinking` 会让**模型枚举整体抛错**。
- `requiresAuthorization`、`isDefault` 只在 `He(extension, "chatProvider")` 为真时被使用，否则**静默忽略**（不抛错，但也没有效果）。
- 已发布扩展不应声明 `enabledApiProposals`（官方 proposed API 文档：只应在 Insiders 使用，且不应出现在已发布扩展里）。
- 现状：本扩展只返回 `toolCalling` / `imageInput`，并由 `test/relay/models.test.ts` 与 `test/manifest.test.ts` 锁定。

## 二、contributes.languageModelChatProviders 的现状

### 1. 两个宿主都支持 configuration / when，且 managementCommand 已弃用

1.116.0 与 1.141.0 的扩展点 schema 均为：

```js
{ type: "object", required: ["vendor", "displayName"], properties: {
  vendor, displayName,
  configuration: { type: "object", anyOf: [<json-schema>, { properties: { properties: { ... secret: { type: "boolean" } } } }] },
  managementCommand: { type: "string", deprecated: true, deprecationMessage: <...> },
  deprecation: { type: "object", properties: { link: { type: "string" } } },
  when: { type: "string" } } }
```

并且两个版本的扩展点都带 `activationEventsGenerator: onLanguageModelChatProvider:<vendor>`，`when` 由 `getVendors()` 用 context key 求值。

### 2. 提供 configuration 会改变管理页齿轮入口

`renderVendorElement`（两个版本同构）：

```js
if (vendor.configuration) { /* 由 schema 生成的配置动作；1.116 为 Configure/Delete，1.141 为设置对话框动作 */ }
else if (vendor.managementCommand) { /* 齿轮直接执行该命令 */ }
```

`renderModelElement` 另有一处：`!vendor.isDefault && !vendor.managementCommand && (actions.length || metadata.configurationSchema)` 才追加 "Configure Model"（宿主 JSON 配置编辑器）入口。也就是说：

- 保持 `managementCommand`：齿轮打开本扩展的连接管理命令（多连接、按连接密钥、诊断、连通性测试），代价是宿主不显示 "Configure Model" 的 JSON 入口（该入口本来也表达不了我们的连接模型）。
- 声明 `configuration`：齿轮改为 schema 动作，`managementCommand` 在该界面不再出现（命令面板仍可用）。

## 三、迁移选项

### 选项 A：保持现状（推荐）

- 零风险，两个宿主都支持，弃用只是标记。
- 保留现有连接管理 UX：`weavenet-copilot.profiles` 为唯一事实来源，密钥按连接 UUID 存在 SecretStorage，诊断/状态栏/测试连接都建立在这套模型上。
- 代价：`deprecationMessage` 会在清单校验/未来版本中持续存在；如果微软将来移除该字段，需要迁移。

### 选项 B：configuration 只承载 provider 级设置

- 用 `configuration` 暴露扁平、无密钥的旋钮（如 `modelNamePrefix`、`maxInputTokens`/`maxOutputTokens`、`visionProxyEnabled`、默认 `reasoningEffort`），连接仍由本扩展管理。
- 问题：`configuration` 存在时齿轮不再执行 `managementCommand`，等于**丢掉管理页里的连接入口**；同时这些旋钮已经存在于 `weavenet-copilot.*` 设置中，会形成第二份配置来源和漂移风险。
- 除非同时提供一个替代入口，否则不建议。

### 选项 C：group = 连接，完全交给宿主

- 宿主支持每个 vendor 多个 provider group（`getLanguageModelsProviderGroups()`），schema 允许嵌套对象与 `secret: true`，理论上一个 group 可以表达"一个连接 + 密钥"。
- 宿主在调用 provider 时会传入 `{ silent, configuration }`（1.141 的 `$provideLanguageModelChatInfo` 已确认），provider 有机会读取配置值。
- 但需要迁移 `profiles` 与按 UUID 的密钥、重做诊断/状态栏/迁移与回滚，风险与工作量都大。

## 四、开放问题（spike 需要回答）

用隔离 profile 的探针扩展（contributes `configuration`，含一个 `secret: true` 属性）回答：

1. `provideLanguageModelChatInformation` 的 `options.configuration` 到底是什么：单个 group 的 settings、全部 group 的合并，还是模型级配置？
2. provider 是否按 group 分别调用（决定我们能否把一个 group 当作一条连接）？
3. `secret: true` 的值如何到达 provider（`options.configuration` 内联，还是需要 provider 侧另读）？
4. 在 Language Models 编辑器里增删 group 时，provider 收到哪些事件（是否触发 `onDidChangeLanguageModelChatInformation`）？
5. 嵌套对象（如 `models: [...]`、`requestHeaders: {}`）在该编辑器里的编辑体验是否可用。

方法：`--extensions-dir`/`--user-data-dir` 指向隔离目录，探针扩展记录每次调用的完整 `options`，再用命令面板创建两个 group 观察差异。全程不触碰用户正式配置。

## 五、建议与触发条件

- 现在：**选项 A**。把 `managementCommand` 视为受支持但已弃用的入口，保持命令 ID 稳定。
- 触发重新评估的条件（任一满足）：
  1. VS Code 宣布移除 `managementCommand`（release notes 或 schema 去掉该字段）；
  2. 用户反馈希望在 Language Models 编辑器里直接管理连接；
  3. 需要宿主托管的密钥存储（企业策略下 SecretStorage 受限等）。
- 触发后先做第四节 spike，再决定选项 B 或 C；不要在缺少这些答案时直接声明 `configuration`。

## 六、文档口径提醒

官方 "Language model chat provider" 指南目前仍教 `managementCommand`，且只列 3 种 response part；`configuration`、`configurationSchema`、thinking 承载都没有出现在指南里。判断依据应以 API reference、contribution points 与宿主实现为准。

## 参考资料

- 本机 `vscode.d.ts`（1.141.0）与 `@types/vscode` 1.116.0 的逐声明比对（本轮分析的 `.tmp/diff-api.cjs`、`.tmp/diff-bodies.cjs`）。
- 真实宿主探针：`.tmp/probe-suite.cjs` + `.tmp/run-probe.cjs`（1.141.0 与 1.116.0 各一次）。
- 宿主实现：`resources/app/out/vs/workbench/api/node/extensionHostProcess.js`、`resources/app/out/vs/workbench/workbench.desktop.main.js`（1.141.0 与 1.116.0 归档版）。
- <https://code.visualstudio.com/api/references/vscode-api>
- <https://code.visualstudio.com/api/references/contribution-points>
- <https://code.visualstudio.com/api/advanced-topics/using-proposed-api>
- <https://code.visualstudio.com/docs/agent-customization/language-models>
