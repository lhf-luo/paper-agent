# Web Agent 使用指南

[文档索引](README.md) | [English](web-agent-guide.md)

Paper Agent 的 **Agent 对话** 页面是浏览器中的主要论文调研对话入口。它把专用的 `literature-corpus-manager` Skill 与论文搜索、PDF、Artifact、个人库、团队库和调研工作区工具组合在一起。

该 Skill 会自动加载。用户不需要输入斜杠命令，也不需要在每次请求中点名 Skill。

## 1. 打开 Agent 对话

启动已经安装的 Paper Agent：

```powershell
paper-agent
```

保持启动终端运行，然后在左侧导航中选择 **Agent 对话**。如果浏览器没有自动打开，可运行：

```powershell
paper-agent --no-open
```

复制终端打印的完整会话地址，包括其中的 `#token=...`。只有 loopback 裸地址时不包含本地会话凭据。

其他 Web 页面不需要模型；只有 Agent 对话和高级 Pi 终端需要模型。

## 2. 配置模型

在 **模型与凭据** 区域填写：

| 字段 | 填写内容 |
| --- | --- |
| Provider ID | Provider 或中转站在本地使用的稳定名称，例如 `research-relay` |
| Model ID | Endpoint 实际接受的模型标识 |
| Base URL | Provider 或中转站的 API 根地址 |
| API 类型 | Endpoint 实际实现的协议 |
| API key | 可选，只在当前服务进程内存中使用的密钥 |

API 类型必须与 Endpoint 实际协议一致：

| Endpoint 协议 | API 类型 |
| --- | --- |
| OpenAI 兼容 Chat Completions | `openai-completions` |
| OpenAI Responses | `openai-responses` |
| Anthropic Messages | `anthropic-messages` |
| Google Generative AI | `google-generative-ai` |

Base URL 必须使用 HTTPS。只有 `localhost`、`127.0.0.1` 或 `::1` 上的 loopback 服务可以使用普通 HTTP。

点击 **应用配置**。模型配置和凭据可用时，页面会显示 **可开始对话**。API key 留空表示继续使用当前凭据，不会替换它。

Endpoint 需要支持流式响应、tool/function calling、JSON Schema 参数和足够的上下文。能够连接模型并不代表工具调用一定可用。

## 3. 理解密钥生命周期

在 Agent 对话页面输入的 key：

- 只保存在当前 Paper Agent 服务进程内存；
- 提交成功后立即从密码框清空；
- 不会写入项目配置、Pi 文件、浏览器存储、对话记录、日志或错误响应；
- Paper Agent 重启后失效。

如果希望每次启动都从环境变量读取密钥，可在 **设置与诊断** 中配置 API key 环境变量名，在启动 Paper Agent 之前设置该变量，并从同一个终端启动服务。项目只保存环境变量名，不保存变量值。请把下面的示例名称替换为项目设置中保存的名称：

```powershell
$env:PAPER_AGENT_RELAY_API_KEY = "your-private-key"
paper-agent
```

```bash
export PAPER_AGENT_RELAY_API_KEY="your-private-key"
paper-agent
```

清除内存密钥，或者修改 Provider ID、Model ID、Base URL、API 类型，都会销毁已有 Agent 会话，避免旧运行时继续保留过期凭据。

## 4. 创建第一次对话

1. 在会话区域选择 `once` 或 `persistent`。
2. 点击 **新建会话**。
3. 选择常用任务模板，或者直接描述调研目标。
4. 把模板中的占位内容替换为研究主题、论文 ID 或本地 PDF 绝对路径。
5. 点击 **发送**，或按 `Ctrl+Enter` / `Cmd+Enter`。
6. 查看流式回答、工具卡片以及可能出现的人工确认卡片。

适合作为第一次请求的安全示例：

```text
搜集与内存安全系统编程有关的高相关论文。先查询已有个人知识库，再执行一次性多源搜索。展示检索式、纳入标准、provenance、重复项和 provider 失败。本次不要持久化记录或下载文件。
```

## 5. 选择对话模式、任务生命周期和知识范围

Paper Agent 有三个相关但彼此独立的控制项：

| 层次 | 选项 | 含义 |
| --- | --- | --- |
| Web 对话上下文 | `once` / `persistent` | `once` 每轮后销毁 Pi 模型上下文；`persistent` 为后续追问保留上下文 |
| 调研任务生命周期 | `once` / `persistent` | `once` 保持一次性搜集；`persistent` 会准备可复用的个人库写入，但仍需人工确认 |
| 知识范围 | `personal` / `team` | `personal` 是私人未审核内容；`team` 是已批准共享知识或明确的提议流程 |

**新建会话** 旁边的选择器只控制 Web 对话上下文，页面当前默认选择 `persistent`；它本身不会授权任何 corpus 写入。对于没有明确说明的调研任务，`literature-corpus-manager` Skill 默认采用 `once + personal`。

任务生命周期和范围重要时，应在请求中明确说明。持续对话也可以只进行一次性搜集：

```text
保留这段对话用于后续追问，但文献搜集使用 once + personal。先查已有知识，不要持久化记录，也不要向团队知识库提交提议。
```

需要建立可复用个人库时，应明确提出，并预期在实际写入前出现确认卡片：

```text
这次文献搜集使用 persistent + personal。保存前先展示准确的论文记录和写入计划，并等待我的确认。
```

## 6. 论文调研 Skill 如何工作

对于论文调研请求，自动加载的 `literature-corpus-manager` Skill 会指导 Agent：

1. 识别研究问题和期望交付物；
2. 选择或确认 `once`/`persistent` 与 `personal`/`team`；
3. 先查询已有个人或团队知识，避免重复搜集；
4. 使用缩写、同义词、作者/标题形式和邻近术语扩展查询；
5. 进行有界的多 Provider 搜索，并保留部分 Provider 失败；
6. 检查 provenance、去重结果和疑似重复项；
7. 在持久化、下载、Artifact 获取或团队提议前等待明确确认；
8. 报告证据边界，以及仍需人工精读或实验验证的部分。

搜索元数据只能用于发现来源，不能独立证明技术 claim。涉及实质性结论时，应要求 Agent 打开一手 PDF 或官方 Artifact，并给出物理页码、原文、图表、URL、hash 或 commit。

## 7. 常见使用场景

### 搜集某个主题的论文

```text
围绕“请替换为研究主题”搜集高相关论文。先查询已有知识，展示查询变体和纳入标准，再执行 once + personal 搜索；不要自动持久化或下载。
```

### 分析本地 PDF

```text
分析本地 PDF：D:\papers\paper.pdf。先核实文件身份和页数，再说明研究问题、方法、主要证据、局限和可复现性边界。引用物理 PDF 页码，不要自动获取 Artifact。
```

### 查询个人知识库

```text
查询 default 个人论文库中与“请替换为主题”有关的记录。说明每条结果的命中依据，并区分来源元数据、私人笔记和仍未解决的证据缺口；不要执行写入。
```

### 比较多篇论文

```text
比较以下论文的研究问题、假设、方法、数据集、baseline、关键结果、局限和可复现性：请粘贴论文 ID、标题或 PDF 路径。使用一手证据，并指出目前无法核实的 claim。
```

### 检查官方 Artifact

```text
检查这篇论文的官方 Artifact 候选：D:\papers\paper.pdf。展示来源证据、最终 URL、预期类型、许可证和版本边界。先发现候选，未经确认不要下载或 clone。
```

### 使用团队知识库

```text
查询团队知识库中与“请替换为主题”有关的已批准内容。如果需要提交选中的个人记录，先展示实际提交内容，移除私人笔记和筛选意见，并等待明确确认。
```

页面左侧的常用任务模板会把同类提示词填入输入框；发送前可以继续修改。

## 8. 工具卡片与人工确认

工具卡片会展示 Paper Agent 操作名称、状态、输入和输出。只读搜索、PDF 分析和 Artifact 发现可以直接运行；实质性操作会在对话中生成 `confirm`、`select` 或 `input` 卡片。

点击 **明确同意** 前，应检查操作目标、风险、详细计划和 manifest fingerprint。如果操作范围超过预期，选择 **拒绝 / 取消**。拒绝、超时、停止生成、删除会话或关闭服务都不会被视为同意。

需要确认的操作包括下载、持久化 corpus 写入、PDF 或 Artifact 获取、个人库整理、derived memory 写入、导出、团队提议与审核、token 变更、备份和配置写入。

## 9. 管理对话

- **停止生成** 会中止当前模型回合，不会同意尚未处理的操作。
- 点击其他会话即可切换对话。
- 不再需要某段内存对话及模型上下文时，可以删除会话。
- `persistent` 只在当前 Paper Agent 服务进程运行期间保留上下文。
- 重启服务会删除全部 Web Agent 会话。

不同研究问题建议使用不同会话，避免模型上下文和待确认操作混在一起。

## 10. 常见问题

- **提示需要模型配置或密钥：** 应用完整 Endpoint 配置并提交内存 key，或设置项目配置指定的环境变量后重新启动 Paper Agent。
- **重启后密钥消失：** 这是网页 key 的预期行为；重新输入，或改用环境变量方案。
- **HTTP Base URL 被拒绝：** 除 loopback 测试服务外必须使用 HTTPS。
- **模型能回答但不能调用工具：** 确认模型和中转站支持 tool/function calling 与 JSON Schema 参数。
- **找不到本地 PDF：** 提供 Paper Agent 服务进程可访问的绝对路径。
- **团队知识库不可用：** 配置团队服务，或使用 `paper-agent --team demo` 进行本地单人体验。
- **页面显示正在重连：** 保持启动终端运行；如果本地会话 token 丢失，请重新打开命令打印的完整会话 URL。

## 11. Web Agent 与 Pi 终端的区别

Agent 对话是普通用户使用的浏览器入口，采用进程内存凭据和内存会话。`paper-agent agent` 会启动面向高级用户的原始 Pi 终端界面，使用独立的 Pi 登录、模型配置和交互命令。网页输入的 key 不会复制到 Pi 配置中。
