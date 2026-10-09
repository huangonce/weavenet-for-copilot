# WeaveNet 最新文档对照代码审查

核查日期：2026-10-06。审查对象为工作区 0.7.11 基线上的未发布精简改动。GitHub 当日 latest 稳定标签为 VS Code 1.140.0；同时核对项目最低支持版本 1.116.0 的声明。

## 结论

连接默认 API 与模型级覆盖、取消后台付费探测、保留安全传输与连接身份的方向，与最新官方契约一致。本轮发现并修正了宿主类型、预算、原生请求头、工具模式和迁移一致性问题。随后已完成下述三项 P1 与一项 P2 的协议闭环修复，并增加跨轮次和边界回归。真实模型服务行为仍受 Relay 实现与宿主历史保存能力影响，不将模拟测试等同于所有服务的兼容认证。

## 官方依据

| 来源 | 本次核对内容 |
| --- | --- |
| [VS Code Provider 指南](https://code.visualstudio.com/api/extension-guides/ai/language-model-chat-provider) | 注册 vendor、managementCommand、三种 Provider 方法及 silent 语义 |
| [VS Code 1.140.0 稳定声明](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.d.ts) 与 [1.116.0 声明](https://github.com/microsoft/vscode/blob/1.116.0/src/vscode-dts/vscode.d.ts) | Provider、模型信息、toolMode、modelOptions、响应 Part 的稳定合同 |
| [VS Code thinking 提案声明](https://github.com/microsoft/vscode/blob/1.140.0/src/vscode-dts/vscode.proposed.languageModelThinkingPart.d.ts) | value 可以是 string 或 string[]，thinking 仍属可选宿主能力 |
| [官方 BYOK / Custom Endpoint 文档](https://code.visualstudio.com/docs/agent-customization/language-models#_custom-endpoint-configuration-reference) | API 默认值与覆盖；contextWindow 是输入加输出总量；输出预留 |
| [OpenRouter Models OpenAPI](https://openrouter.ai/docs/api/api-reference/models/list-all-models-and-their-properties.md) | context_length、共享上下文、max_completion_tokens、公开元数据 |
| [Anthropic 官方 SDK](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/_client.py) | 全部原生请求的 anthropic-version 默认头 |
| [Anthropic ModelInfo](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/model_info.py) 与 [能力结构](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/model_capabilities.py) | display_name、独立输入/输出上限、supported 与 thinking.types |
| [OpenAI 官方生成参数类型](https://github.com/openai/openai-python/blob/main/src/openai/types/chat/completion_create_params.py) | max_tokens 已废弃且不适用于 o-series；max_completion_tokens 和 required 工具模式 |

OpenAI guide/reference 站点本次返回 403，相关要求使用成功读取的官方 OpenAPI 生成 SDK 注释。Anthropic 部分单页存在跨域重定向问题，另读取了其[官方指南全文汇总](https://platform.claude.com/llms-full.txt)、官方 SDK 和 cookbook；没有将失败页面当作已读取正文。

## 已修正

1. **总窗口误作输入预算。** [模型预算](src/relay/models.ts)与[OpenRouter 补充](src/metadata/openrouterFallback.ts)现在区分 contextWindow、maxInputTokens 与 maxOutputTokens；已知总窗口时预留输出空间。明确输入上限不再被误减一次，旧 OpenRouter 快照也按原有总窗口语义处理。公开缓存升到 v4。
2. **宿主 thinking 数组被拒绝。** [请求快照](src/copilot/canonicalRequest.ts)接受 string[]、安全快照并拼接，保留代理拒绝和整体文本上限；不放松 JSON 与元数据边界。
3. **原生目录头与元数据。** [Relay 客户端](src/relay/client.ts)在 x-api-key 请求中发送 anthropic-version，包括 /models；解析原生显示名、输入/输出上限与结构化视觉能力。明确仅支持 adaptive 的目录会选择 adaptive，而不会启用手动预算。
4. **Required 工具模式。** [Provider](src/copilot/provider.ts)对没有工具或不支持工具的请求明确报错；[Claude 请求](src/copilot/claudeResponse.ts)在强制工具轮次中优先满足工具要求，关闭与强制 tool_choice 不兼容的手动 extended thinking。
5. **同 ID 多协议不一致。** [主动诊断](src/copilot/connectionTestService.ts)验证所有明确配置的 API，而非用最后一个同 ID 声明覆盖所有候选；[迁移](src/migration/profilePool.ts)按原协议保存同 ID 的 native 与 Responses 目录变体。
6. **异步迁移覆盖用户修改与作用域。** 迁移提交前核对配置快照与当前凭据，若在读取目录期间发生修改则停止写入。旧协议策略只读取 globalValue，避免设置项撤下后合并读取工作区值而改变全局路由。旧目录保留、配置失败回滚和 UUID 密钥隔离继续生效。
7. **测试令牌字段与费用边界。** Chat 主动诊断遵循明确的 max_completion_tokens 配置；禁用输出上限的模型不会发起无界付费测试，只记录无法执行有界生成验证。
8. **原生管理入口。** [扩展清单](package.json)增加 managementCommand，连接管理可由 VS Code 的模型管理界面进入。

## 既存问题与后续修复记录

### 已修复 P1：Claude 签名思考与遮蔽块回放

修复前，[流解析](src/relay/claude.ts)只传递 thinking 文本，不保留 signature_delta 或 redacted_thinking；[历史转换](src/copilot/convert.ts)忽略 thinking。Messages 协议启用 extended thinking 且执行工具续接时，下一轮会缺少必须原样回传的原块。范围不包括关闭 thinking 的普通聊天。

依据：[官方 ThinkingBlockParam](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/thinking_block_param.py)、[RedactedThinkingBlockParam](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/redacted_thinking_block_param.py)、[官方工具续接示例](https://github.com/anthropics/claude-cookbooks/blob/main/extended_thinking/extended_thinking_with_tool_use.ipynb)。签名与块内容需要原样、原顺序回传；示例展示缺失时的 400。

需要按 content block index 保存完整文字、签名与遮蔽数据，经命名空间元数据和 canonical snapshot 回放，并覆盖两轮工具、取消和截断场景。

### 已修复 P1：DeepSeek Chat 缺完整 reasoning_content

修复前，[Chat 转换](src/copilot/convert.ts)跳过 thinking；当前 reasoning 回放能力只用于 Responses。DeepSeek thinking 请求携带 tools 时，历史全部 assistant 轮次需要完整 reasoning_content，包括未实际调用工具的轮次；缺失会 400。无 tools 对话不要求回传，不泛化其他 OpenAI 兼容服务。

依据：[当前 DeepSeek 官方指南](https://api-docs.deepseek.com/guides/thinking_mode/#tool-calls)。需要明确的模型能力、Chat 字段支持、纯文本 assistant 历史与工具轮次回放测试。

### 已修复 P1：新版 Claude adaptive 模式未实现

修复前，[思考配置](src/copilot/helpers.ts)仅表达 enabled + budget_tokens，[请求构造](src/copilot/claudeResponse.ts)没有 adaptive / output_config 分派。用户为 Claude 4.7 或以后型号显式开启 thinking 时，可能首轮就发送不支持的旧模式。此次后续修复已通过显式能力和原生目录模式完成 adaptive 请求与 effort。

依据：[官方全文指南的 Model capabilities](https://platform.claude.com/llms-full.txt)说明 adaptive 是 Claude 4.7 及以后唯一思考模式；[官方 adaptive 类型](https://github.com/anthropics/anthropic-sdk-python/blob/main/src/anthropic/types/thinking_config_adaptive_param.py)。应以明确模式能力构造 adaptive 与 effort，保留旧模型预算模式。

### 已修复 P2：Responses 原始 phase 未保留

修复前，[Responses 响应解析](src/relay/openaiResponses.ts)没有保存 message phase；[历史转换](src/copilot/convert.ts)依据工具位置推断，纯文本消息可能把上游 commentary 改成 final_answer。

依据：[官方 EasyInputMessageParam](https://github.com/openai/openai-python/blob/main/src/openai/types/responses/easy_input_message_param.py)要求 gpt-5.3-codex 及以后跟进请求保留原 phase；丢失可能降低表现。这里确认语义丢失，不声称必然 400。需要保存原 message 边界与 phase，再原样回放。

## 四项修复实现

[Claude block collector](src/relay/claudeReplay.ts)按块索引累积原文、signature_delta、遮蔽数据与工具参数；[Responses collector](src/relay/responsesReplay.ts)保留原 message/phase/output index，合并 reasoning delta 与缺字段的终态。取消或未完成响应不提交待执行工具。

[统一状态](src/relay/replayState.ts)经[宿主保存](src/copilot/protocolState.ts)、[严格快照](src/copilot/canonicalRequest.ts)与[身份/正文/工具核对](src/copilot/replayConversion.ts)回放。旧加密 carrier 不再作为生产回放捷径。Crypto 数据不跨模型/凭据发送，不使用未知 phase 的启发式猜测。

Chat 的 `openai.replayReasoningContent` 与模型 `claude.thinkingMode` 使用示例见 [README](README.md)。签名、思考和 phase 都取自 API 实际返回，不能修复旧版本已经丢失的历史。

四项闭环回归见 [protocolReplay tests](test/copilot/protocolReplay.test.ts)。其中包含真实解析器的跨轮次请求、签名分片、redacted、无工具旧轮次的推理回传、消息边界、终态缺字段、无绑定 cipher、隐藏正文失配与取消/截断。

四项修复最终验证：28 个测试文件、496 项测试全部通过；语句覆盖率 86.29%、分支 79.07%、行 90.59%，达到项目门槛。typecheck、lint、compile、package:list 与 diff --check 通过。VS Code 1.139.1 隔离宿主完成实际 native Part 的签名/遮蔽数据和 phase 快照回放验证；比较发送 JSON 以避免 null prototype 对象的原型差异干扰。未调用真实付费模型 API，下方保留先前审查基线。

## 验证与边界

- 增加共享上下文预算、老快照兼容、thinking 数组与资源边界、同名多协议迁移与诊断、配置/密钥变更中止迁移、现代令牌字段和 Required 工具模式测试。
- 真实宿主测试扩展到原生 managementCommand、显式 API 清单、预算计算，以及宿主提供 thinking 类型时的数组解析。
- 先前文档审查基线：27 个测试文件、474 项测试通过；语句覆盖率 85.95%、分支 78.88%、行 89.89%，达到项目门槛；typecheck、lint、compile、package:list 和 diff --check 通过。
- VS Code 1.139.1 的隔离真实宿主验证通过，包括激活、管理入口、预算及可选原生 thinking 数组。1.140.0 与 1.116.0 本次完成的是官方声明核对；未宣称已运行这两个版本的全部宿主/Agent 测试。单元测试不代替真实付费 Relay 协议验证。
- 输入 token 计数仍为估算；正确声明预算不等于精确 tokenizer。思考块及模型配置扩展字段不全部属于稳定公开 API，应继续进行宿主版本回归。
- 本轮不调用用户真实密钥或付费模型，不宣称 Agents 窗口、多窗口、组织策略和全部网关已获兼容认证。

## 后续八组文档一致性修复

已补齐签名历史的真实请求前缀指纹，续接前对 system、tools 和历史输入校验；仅排除协议外层缓存断点，不排除业务 JSON。已收紧 Claude effort、采样/强制工具能力与 OpenAI 采样能力/档位；未确认能力采用安全默认。已将上下文耗尽视为截断，修正工具图片与 manual 回放思考计量，支持同源有界 /models 分页，标准化图片 schema 并保留选定参数；摘要只对明确支持的推理模型发送。

新增回归见 [remainingCompliance tests](test/copilot/remainingCompliance.test.ts) 和 [pagination tests](test/relay/modelPagination.test.ts)。能力配置、旧网关兼容和历史升级限制见 [README](README.md)。此前四项协议状态修复继续保留；本轮不调用真实付费模型。

八组修正最终验证：30 个测试文件、520 项测试全部通过；语句覆盖率 86.54%、分支 79.84%、行 90.79%，达到项目门槛。typecheck、lint、compile、package:list 与 diff --check 通过。VS Code 1.139.1 隔离宿主的激活、管理入口、预算及协议状态快照回放通过；独立只读审查的三轮签名工具循环和缓存断点迁移也通过。未作真实付费服务或所有 Agent 窗口的兼容认证。

## 内部 API 与目录精简

运行时模型统一使用 `apiType`，删除旧 `ModelProtocol`、`RouteKey`、`OpenAIApiVariant` 及变体解析 helper。每条连接保留一份成功发现的 `directory`；[v3 快照](src/copilot/modelSnapshotStore.ts)只保存目录，不再重复保存路由列表和最终模型列表。[共享目录组装](src/copilot/modelRegistry.ts)同时用于在线刷新和离线恢复，由当前配置重建固定模型、API 覆盖、能力、过滤及可选公开元数据。

旧持久化表示只由[快照升级边界](src/migration/catalogUpgrade.ts)转换，[配置迁移](src/migration/profilePool.ts)保留原凭据 HMAC 合同、UUID、回滚与并发配置/密钥检查。只能恢复身份匹配的 v2，未绑定身份的 v1 继续拒绝。升级持久化与删除继续串行，失败保留已验证的原记录；网络目录中的任意旧字段也不会进入规范运行时。

只读审查发现并修正了两项离线恢复回归：旧 `contextWindows` 等字段必须按发布版的排序、去重和验证规则重建身份；旧目录仅保存一个同 ID API 时，恢复需补齐其他明确声明的 API 并继承共同能力和预算。另修正能力覆盖合并后可能保留列表外默认 effort 的问题。回归见[目录测试](test/copilot/modelRegistry.test.ts)、[旧配置迁移测试](test/migration/explicitProtocols.test.ts)与[快照存储测试](test/copilot/modelSnapshotStore.test.ts)；[隔离宿主测试](test/integration/suite.cjs)新增实际 API 变体组装、v3 存储及升级/删除顺序检查。

本轮最终验证：30 个测试文件、535 项测试全部通过；语句覆盖率 86.63%、分支 80.26%、函数 87.60%、行 90.87%，达到项目门槛。typecheck、lint、compile、package:list 与 diff --check 通过。当前安装的 VS Code 1.141.0 隔离宿主运行成功，覆盖激活、管理入口、预算、API 变体与快照升级/删除；宿主提供 thinking Part 时还验证协议 metadata 回放。宿主自身输出内置 Copilot proposal 与 Agent channel 警告，测试退出码为 0；这不等同于所有 Agents 窗口和网关获兼容认证。最低 1.116.0 仍仅完成声明核对，未完成该版本的真实宿主验证。本轮没有调用真实付费模型，改动仍为本地 Unreleased，版本未提升。
