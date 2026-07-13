# WeaveNet for Copilot

把你自己的 sub2api 中转站模型接入 GitHub Copilot Chat 的模型选择器，同时保持 Claude 走 Claude 原生协议、其他模型走 OpenAI 协议。

## 项目结构

```text
src/
  extension.ts       VS Code 激活与命令注册
  constants.ts       扩展常量与 SecretStorage key
  auth/              OpenAI、ChatGPT、Claude API Key 管理
  config/            VS Code 配置读取与校验
  copilot/           Copilot provider 与请求转换
  relay/             中转站 HTTP/SSE 客户端、模型与协议类型
  metadata/          OpenRouter 在线模型能力与参考价格
```

## 使用方式

1. 安装本地 VSIX 扩展。
2. 默认中转站地址是 `https://sub2api.huangonce.com/v1`。如果换了部署地址，再修改 `weavenet-copilot.baseUrl`。
3. 在 sub2api 里创建三个用户密钥：
   - OpenAI 密钥：绑定 `aixroute openai` 分组，只包含非 `gpt-*`、非 `claude-*` 模型。
   - ChatGPT 密钥：绑定 GPT 专用分组，只包含 `gpt-*` 模型。
   - Claude 密钥：绑定 `aixroute claude` 分组。
4. 在 VS Code 命令面板运行 `WeaveNet: Set OpenAI API Key`，填入 OpenAI 分组密钥。
5. 运行 `WeaveNet: Set ChatGPT API Key`，填入 GPT 分组密钥。
6. 运行 `WeaveNet: Set Claude API Key`，填入 Claude 分组密钥。
7. 运行 `WeaveNet: Refresh Models`，然后在 Copilot Chat 模型选择器里选择 `WeaveNet ...` 模型。
8. 需要立即更新 OpenRouter 能力目录时，运行 `WeaveNet: Refresh Model Metadata`。

## 命令

- `WeaveNet: Set OpenAI API Key`：设置非 GPT、非 Claude 模型使用的 OpenAI 分组密钥。
- `WeaveNet: Set ChatGPT API Key`：设置 `gpt-*` 模型使用的 GPT 专用分组密钥。
- `WeaveNet: Set Claude API Key`：设置 Claude 原生 `/messages` 协议使用的分组密钥。
- `WeaveNet: Clear OpenAI API Key`：删除已保存的 OpenAI 分组密钥。
- `WeaveNet: Clear ChatGPT API Key`：删除已保存的 GPT 专用分组密钥。
- `WeaveNet: Clear Claude API Key`：删除已保存的 Claude 分组密钥。
- `WeaveNet: Refresh Models`：重新从三个分组拉取模型列表。
- `WeaveNet: Refresh Model Metadata`：立即刷新 OpenRouter 的公开模型能力和参考价格目录。
- `WeaveNet: Open Settings`：打开 WeaveNet 设置页。
- `WeaveNet: Show Debug Log`：打开 `WeaveNet` 输出通道，用于查看脱敏请求摘要和缓存用量字段。

## 协议路由

插件会用三个密钥分别拉取模型列表，并在本地合并展示：

- `gpt-*` 模型：走 `POST /chat/completions`，使用 ChatGPT 分组密钥。
- 其他非 `claude-*` 模型：走 `POST /chat/completions`，使用 OpenAI 分组密钥。
- `claude-*` 模型：走 Anthropic-compatible `POST /messages`，使用 Claude 分组密钥。

这样可以避免 Claude 模型被错误地转成 OpenAI 协议，减少缓存或原生能力失效的问题。

## 模型能力与参考价格

模型的图片输入、工具调用、推理、上下文窗口与公开参考价格按 `sub2api → OpenRouter` 的顺序读取。sub2api 明确返回的字段优先，只有缺失字段才由 OpenRouter 补充；插件不再使用 LiteLLM、内置模型快照或名称猜测。无法确认的图片、工具与推理能力保持关闭，缺失的 token 上限使用插件配置默认值。模型选择器会显示输入、输出和缓存读取的每百万 token 参考价，以及对应的成本档位。

参考价格不是 sub2api 实际扣费价格。实际扣费受你的分组、账号倍率和上游渠道影响，应以 sub2api 的用量日志为准。

支持推理的模型会在聊天输入框旁显示“思考工作量”，可选择 Low、Medium、High、Extra High 或 Max。OpenAI 协议会发送 `reasoning_effort`；Claude 协议会换算为原生 `thinking.budget_tokens`。有上下文窗口元数据的模型也会显示“上下文大小”。

## 常用设置

- `weavenet-copilot.baseUrl`：sub2api API 地址，默认 `https://sub2api.huangonce.com/v1`。
- `weavenet-copilot.anthropicVersion`：Claude `/messages` 请求使用的 `anthropic-version`。
- `weavenet-copilot.openaiPromptCaching`：是否为 `gpt-*` 模型发送稳定的 `prompt_cache_key`，默认开启。
- `weavenet-copilot.openaiPromptCacheKey`：可选的 OpenAI 缓存 key。留空时按当前工作区生成稳定值；同一工作区内应保持不变。
- `weavenet-copilot.claudePromptCaching`：Claude 缓存模式，默认 `automatic`。插件会在整个 `/messages` 请求的顶层发送唯一的 `cache_control: { "type": "ephemeral" }`，让 Anthropic 自动把缓存点推进到最后一个可缓存块，适合持续增长的多轮 Copilot 对话。设为 `disabled` 可关闭缓存。
- `weavenet-copilot.debug`：开启后将请求摘要和 Claude 缓存用量写入 VS Code 的 `WeaveNet` 输出通道，不记录 API Key 或 prompt 正文。通过 `WeaveNet: Show Debug Log` 打开。
  - `cacheRead` / `cacheWrite` 为数字时是上游实际返回的 token 用量；显示 `n/a` 表示上游的流式响应未返回该字段，不能据此判断是否命中。
- `weavenet-copilot.includeModels`：模型 ID 正则白名单。
- `weavenet-copilot.excludeModels`：模型 ID 正则黑名单。
- `weavenet-copilot.maxInputTokens`：向 Copilot 声明的输入 token 硬上限，默认 `128000`。即使模型元数据声明了更大的上下文，也不会超过这个值；OAuth 上游的实际窗口较小时应相应调低。
- `weavenet-copilot.supportsToolCalling`：是否向 Copilot 声明工具调用能力。
- `weavenet-copilot.supportsImageInput`：是否为所有模型向 Copilot 声明图片输入能力，默认关闭。
- `weavenet-copilot.imageInputModels`：可选的模型 ID 正则表达式；命中后强制向 Copilot 声明图片输入能力。正常情况下无需配置，插件会优先根据 sub2api 和 OpenRouter 的模型元数据自动识别。
- `weavenet-copilot.disabledImageInputModels`：即使公开元数据声称支持图片，也强制关闭对应模型的图片输入能力。默认为空；只有确认某个具体路由不支持图片时，才建议在这里添加模型 ID 正则表达式。
- OpenAI 图片请求会自动采用与 VS Code 内置 Custom Endpoint 相同的兼容形态，不发送 `prompt_cache_key`、`context_window`、`reasoning_effort` 或 `max_tokens` 等可选扩展字段；纯文本请求仍保留对应设置。
- `weavenet-copilot.metadataRefreshHours`：OpenRouter 模型能力目录的后台刷新间隔，默认 6 小时。

当上游明确返回上下文窗口超限时，插件会提示新开会话或减少附件。Cloudflare、Nginx 等网关返回 HTML 错误页时，插件只显示简短的 HTTP 错误和排查提示，不会把整页 HTML 注入聊天窗口。调试模式会额外记录请求体字节数，但不会记录请求正文。

API Key 会存储在 VS Code SecretStorage 中。

## 隐私与安全

- API Key 只保存在 VS Code SecretStorage 中，不会写入工作区文件或调试日志。
- 对话、代码、图片和工具调用内容会发送到你配置的 sub2api 中转站及其上游模型服务。
- 插件不会收集遥测数据。开启调试日志时只记录脱敏请求摘要，不记录 API Key 或提示词正文。
- 使用公开或第三方中转站前，请确认其隐私政策、日志保留和数据处理方式符合你的要求。

完整说明见 [PRIVACY.md](PRIVACY.md)，问题反馈见 [SUPPORT.md](SUPPORT.md)。

## 发布流程

合并到 `main` 后，GitHub Actions 会自动编译、打包并发布到 Visual Studio Marketplace。发布前必须在 PR 中更新 `package.json` 和 `package-lock.json` 的版本号，并同步维护 `CHANGELOG.md`；Marketplace 不允许重复发布同一版本。

```bash
npm version patch --no-git-tag-version
```

流水线使用仓库的 `VSCE_PAT` Actions Secret。重复版本会安全跳过，不会覆盖已发布版本。
