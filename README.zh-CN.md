# Paper Agent

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/A6y55/paper-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/A6y55/paper-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-active%20development-orange)](#项目状态)

一个以证据为中心的论文调研工作区，用于文献发现、一手 PDF、公开研究 artifact、个人知识库和经过审核的团队知识库。

Paper Agent 围绕真实调研主线 **文献搜索 → 获取 PDF 与 artifact → 略读 → 精读 → 实验 → 形成 idea** 组织功能。它负责搜集、整理、provenance、证据追踪和可复用记忆；深度理解、实验判断和研究 idea 仍由人完成。

## 你会得到什么

- 输入一次 `paper-agent` 即可打开的本地 Web 工作区，内置可流式响应的 Agent 对话页面。
- 多源论文检索、查询扩展、过滤、分页、缓存、去重、provider 健康状态、checkpoint 和失败续跑。
- 与一次性搜集任务分开的个人持久论文库。
- 将图表、表格和算法与 caption、section、正文 mention、上下文、跨页 continuation 关联，并支持人工调整裁剪框。
- 自动发现 PDF 中的 GitHub、GitLab、Zenodo、Figshare、数据集和补充材料链接。
- 在受限条件下下载 artifact 或 shallow clone Git 仓库，并记录来源 URL、最终 URL、SHA-256、commit、license 文件和失败原因。
- 由人主导的略读卡、比较矩阵和证据图工作区。
- 支持提议、审核、derived memory、artifact manifest、blob、审计事件、token 轮换和备份的团队知识库服务。
- 面向高级用户的原始 Pi 终端界面，用于 `/paper`、`/collect`、`/library` 和 `/team` 对话工作流。

## 快速开始

### 环境要求

- Git；
- Node.js `>=22.19.0`；
- Poppler `>=22.05`，包含 `pdftotext`、`pdftoppm`、`pdfinfo` 和 `pdfimages`；
- Tesseract 可选，用于 OCR 辅助；
- 只有使用 Web Agent 对话或 Pi 终端时才必须配置模型；其他本地 Web 页面和知识库不依赖模型。

### Windows

```powershell
git clone https://github.com/A6y55/paper-agent.git
Set-Location paper-agent
.\paper-agent.ps1 install
```

如果 PowerShell 阻止本地脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\paper-agent.ps1 install
```

安装后打开一个新终端，再运行：

```powershell
paper-agent init       # 可选的首次配置向导
paper-agent --doctor
paper-agent
```

`paper-agent` 默认打开本地 Web 工作区。安装器创建的是指向当前源码目录的用户级命令；如果移动了仓库，需要重新运行 `install`。

### macOS / Linux

```bash
# macOS
brew install poppler

# Debian / Ubuntu
sudo apt install poppler-utils
```

```bash
git clone https://github.com/A6y55/paper-agent.git
cd paper-agent
npm ci --ignore-scripts
npm run web:build
./run.sh install
```

如果 `~/.local/bin` 尚未加入 `PATH`，按安装器打印的一行命令配置即可。打开新终端后，macOS/Linux 与 Windows 使用相同的命令形式：

```bash
paper-agent init       # 可选的首次配置向导
paper-agent --doctor
paper-agent
```

仍可直接使用源码启动器 `./run.sh`；如果移动了源码目录，请重新执行 `./run.sh install`。

## 启动方式

| 命令 | 结果 |
| --- | --- |
| `paper-agent` | 打开本地 Web 工作区 |
| `paper-agent paper.pdf` | 在可视化阅读器中打开本地 PDF |
| `paper-agent --no-open` | 只运行本地服务并打印会话 URL，不自动打开浏览器 |
| `paper-agent --port 4317` | 使用固定的 loopback 端口 |
| `paper-agent init` | 运行首次配置向导 |
| `paper-agent --doctor` | 检查运行时、Web 资源、模型、Poppler 和 OCR |
| `paper-agent --doctor --probe-model` | 探测 OpenAI 兼容 tool calling，或提示需要在 Pi 会话中手工验证 |
| `paper-agent agent` | 启动面向高级用户的原始 Pi 终端界面 |
| `paper-agent --agent paper.pdf` | 在 Pi 中以 quick 模式打开 PDF |
| `paper-agent --agent --mode full paper.pdf` | 执行更深入的 Pi 论文流程 |
| `paper-agent --team demo` | 在 Web 工作区打开 loopback 单人团队库演示 |
| `paper-agent --team demo --agent` | 在 Pi 中打开同一个团队库演示 |

安装、状态、校验 profile、兼容旧语法和卸载行为见 [CLI 详细说明](docs/cli.md)。

## Web 工作区

默认界面按真实任务划分：

1. **总览**：查看个人库和后台任务状态。
2. **搜索论文**：选择 provider 和年份范围，查看部分失败，在 exact-plan 确认后保存选中的论文。
3. **Agent 对话**：配置模型 endpoint，创建 `once` 或 `persistent` 内存会话，流式接收回答、停止生成、查看工具调用并处理人工确认卡片。
4. **个人库**：搜索并按筛选状态过滤记录，添加私人标签、笔记和筛选决策，查看 PDF 版本，导出选中论文或整个 namespace，并批量准备 PDF 下载。
5. **任务中心**：跟踪长任务，暂停或取消任务，从 checkpoint 重试只读失败。
6. **PDF 与 Artifact 工作台**：分析本地 PDF，查看图表和正文关联，校正裁剪区域，发现 artifact，并在明确确认后获取。
7. **团队知识库**：检索分页共享记录，脱敏后提交个人记录，按角色审核共享内容，查看审计事件，管理 token 和备份。
8. **调研工作区**：创建带原文 locator 的略读卡、比较矩阵和证据图，把人工结论与 AI 辅助草稿分开。
9. **设置与诊断**：配置路径、provider、模型 endpoint 名称和团队 token 环境变量名，不保存真实密钥，也不会沿用已失效的旧模型验证结果。

Agent 对话页面可填写 Provider ID、Model ID、Base URL、API 类型和 API key。网页输入的 key 只保存在当前 Paper Agent 服务进程内存中，提交成功后密码框立即清空，服务重启后即失效；它不会写入项目配置、Pi 配置、浏览器存储、对话记录或错误响应。也可以让服务读取项目模型配置中指定的 API key 环境变量。下载、持久化写入、团队提议和配置变更仍必须在网页中明确确认。

本地 API 只监听 loopback，并由临时会话 token 保护。所有实质性操作都经过代码级 `prepare → fingerprint → confirm → 一次性 grant → execute` 关卡，包括 corpus 导入与导出、引用网络写入、PDF 下载、artifact 获取、个人标签/笔记/筛选状态、derived memory、裁剪校正、团队提议与审核、token 管理、备份以及模型能力探测。取消或改变计划后，旧确认路径不再有效；写任务不能复用旧 grant 重放。

第一次使用请先阅读 [Web Agent 使用指南](docs/web-agent-guide.zh-CN.md)，完整页面说明见 [Web 界面指南](docs/web-interface.md)。

## 调研主线

```text
研究问题
  -> 搜索已有个人/团队知识
  -> 请求文献 provider 并去重
  -> 获取一手 PDF 和选中的公开 artifact
  -> 略读与筛选
  -> 检查方法、图表、证据和实现细节
  -> 把可复用证据连同 provenance 写入知识库
  -> 由人完成实验、判断、创新性评估和 idea
```

内置 `literature-corpus-manager` Skill 明确区分两个维度：

| 维度 | 选项 | 默认值 |
| --- | --- | --- |
| 使用范围 | `personal` 或 `team` | `personal` |
| 生命周期 | `once` 或 `persistent` | `once` |

因此，一次临时搜索不会静默变成长期知识，个人笔记也不会绕过审核进入团队库。

## Agent 对话、Pi 终端与模型配置

主要对话入口是普通 Web 工作区中的 **Agent 对话** 页面。可在页面配置 provider、模型、Base URL、API 类型和临时 key，或让启动 Paper Agent 的进程读取项目模型设置中指定的 API key 环境变量。网页输入的 key 只存在于服务进程内存，重启后需要重新输入。

需要面向高级用户的原始 Pi 终端界面时运行：

```powershell
paper-agent agent
```

在 Pi 中使用内置 provider 时执行 `/login` 和 `/model`。使用自定义中转站时，把 API key 放在环境变量中，并在以下文件定义 provider：

- Windows：`%USERPROFILE%\.pi\agent\models.json`
- macOS/Linux：`~/.pi/agent/models.json`

中转站必须支持流式响应、tool/function calling、JSON Schema 参数和足够长的上下文。模型出现在 `/model` 中只代表配置被解析。Paper Agent 可自动探测 `openai-completions` 和 `openai-responses`；`anthropic-messages` 与 `google-generative-ai` 需要在 Pi 中执行真实的工具调用任务验证。

完整步骤见 [模型与中转站配置](docs/model-configuration.md)。

## 数据、Provenance 与安全

本地运行数据默认位于 `.paper-agent/`。个人 corpus、团队数据和一次性任务彼此分开。

Paper Agent 会记录标准化 identifier、provider 查询、分页、重试、来源 URL、PDF hash、artifact 重定向、checksum、Git commit、license 文件、失败、审核状态，以及适用场景下的追加式审计事件。

主要安全边界包括：

- 本地 Web 服务仅监听 loopback；
- 项目配置不保存 API key 或团队 bearer token；网页输入的模型 key 只在服务进程内存中，项目配置可以保存环境变量名，但不会保存变量值；
- 校验公网地址和重定向；
- 限制下载大小、时间、并发和重定向次数；
- artifact 文件和 Git clone 只允许公开 HTTPS；
- Git 使用 shallow clone，并禁用 hooks、submodule、交互凭据和 LFS smudge；
- 不自动解压 archive，不安装依赖，不执行获取的代码；
- 不绕过付费墙、登录或访问控制；
- 写任务不能绕过新的审查与确认直接重试；
- 确认由工具代码和匹配的 manifest fingerprint 强制执行，而不只依赖 Agent prompt。

## 文档导航

- [详细文档索引](docs/README.md)
- [Web Agent 使用指南](docs/web-agent-guide.zh-CN.md)
- [Web 界面](docs/web-interface.md)
- [CLI 安装与命令](docs/cli.md)
- [模型与中转站配置](docs/model-configuration.md)
- [文献 Provider 与失败恢复](docs/literature-providers.md)
- [PDF 与 Artifact 工作台](docs/pdf-artifact-workspace.md)
- [个人知识库](docs/libraries.md)
- [调研工作区](docs/research-workspace.md)
- [团队知识库](docs/team-knowledge-base.md)
- [论文调研工作流](docs/research-workflow.md)
- [生产团队库部署](deployment/team-corpus/README.md)

## 项目状态

Paper Agent 当前处于积极开发阶段，源码版本为 `0.1.0`，目前从本地源码 checkout 运行，尚未发布到 npm。

当前仍需继续强化旋转或扫描 PDF、非英语和出版社特定排版、异常复杂的浮动对象、实时 provider 波动，以及更完整的跨平台安装发布体验。

## 常见问题

### 为什么 `node` 报未知的 `.ts` 扩展名？

当前命令使用了过旧的系统 Node.js。请使用 Node `>=22.19`，或者通过已安装的 `paper-agent` 启动器运行；它会在可用时选择受支持的运行时。

### 为什么 Agent 对话或 Pi 提示没有可用模型？

非 Agent 的 Web 页面仍可管理本地数据，但 Agent 对话和 Pi 都需要可用模型凭据。Agent 对话中可提交 endpoint 与临时 key，或设置项目配置指定的环境变量；Pi 终端中可运行 `paper-agent agent` 后执行 `/login`，或者配置通过环境变量引用密钥的自定义 provider。

### 发现链接后会立刻下载或 clone 吗？

不会。发现阶段只读。获取阶段会先展示候选、目标和 manifest fingerprint，再要求用户显式确认。

### Paper Agent 会执行下载的仓库吗？

不会。它只负责记录和整理获取的材料，不执行代码、不安装依赖，也不自动解压 archive。

### 一个人能测试团队功能吗？

可以。运行 `paper-agent --team demo` 测试 Web 流程，或运行 `paper-agent --team demo --agent` 测试 Pi 流程，最后用 `paper-agent --team stop` 停止服务。该模式只监听 loopback，不是生产部署。
