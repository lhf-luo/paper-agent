# Pi 原生模型配置

网页 Agent 和 `paper-agent agent` 默认使用项目独立目录 `.paper-agent/pi/`，不读取或修改用户的 `~/.pi/agent/`。

- `auth.json`：Pi 原生凭据。网页提供商列表直接来自 Pi 内置目录；选择提供商后，按 Pi 提示输入 API Key，或账户 ID、AWS profile 等配置。保存沿用应用的配置确认流程。
- `models.json`：Pi 原生自定义提供商和模型覆盖。网页不再提供任意提供商、接口地址或模型参数输入框。
- `models-store.json`：Pi 管理的模型目录缓存，包括价格、上下文窗口、推理等级、图片限制等。它不是凭据文件，不应将 API Key 写入此文件。
- `settings.json`：所选提供商和对话模型；网页选择的模型在重启后继续有效。

原生模型直接由 Pi 解析和执行，不再注册一个价格为零、能力由应用猜测的替代模型。网页的“刷新模型目录”调用 Pi 刷新功能，网络失败会保留已保存的缓存。编辑配置文件后重新读取设置或发送下一轮消息即可生效；运行中的回答保持原运行时。

## 中转站

编辑 `.paper-agent/pi/models.json`，例如：

```json
{
  "providers": {
    "my-relay": {
      "baseUrl": "https://relay.example/v1",
      "api": "openai-completions",
      "apiKey": "$MY_RELAY_API_KEY",
      "models": [
        {
          "id": "my-model",
          "name": "My model",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 128000,
          "maxTokens": 16384
        }
      ]
    }
  }
}
```

设置该环境变量后启动应用。也可使用 Pi 原生 `auth.json` 中该提供商的 `api_key` 凭据。已有内置提供商可以按 Pi 文档在此文件中覆盖地址、模型和兼容参数。文件中的中转模型会出现在对话模型选择器中，提供商配置下拉框仍只列出内置提供商。

## OAuth 与迁移

需要浏览器登录的提供商请运行 `paper-agent agent`，使用 Pi 的 `/login`，然后回到网页读取设置。网页直接提供 API Key 及其原生多字段凭据流程，不另行实现 OAuth。

首次启用时导入旧 `.paper-agent/config/` 中的模型、凭据和当前选择。官方且匹配的内置模型使用 Pi 自带元数据；中转配置转成原生模型文件。已有 Pi 文件优先，旧配置原文件保留；`legacy-import.json` 标记导入已完成，后续修改或删除不会被旧配置重新覆盖。

`paper-agent models add` 是旧应用配置命令，不用于维护新的 Pi Agent 目录；新配置请通过网页、Pi `/login` 或编辑原生文件完成。PDF 翻译等独立模块的旧模型配置仍保留。
