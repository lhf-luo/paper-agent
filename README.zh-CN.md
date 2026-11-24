# Paper Agent

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/lhf-luo/paper-agent/actions/workflows/ci.yml/badge.svg)](https://github.com/lhf-luo/paper-agent/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.19-339933?logo=node.js&logoColor=white)](package.json)
[![Status](https://img.shields.io/badge/status-active%20development-orange)](#项目状态)

一个以证据为中心的论文调研工作区，用于文献发现、一手 PDF、公开研究 artifact、个人知识库和经过审核的团队知识库。

Paper Agent 围绕真实调研主线 **文献搜索 → 获取 PDF 与 artifact → 略读 → 精读 → 实验 → 形成 idea** 组织功能。它负责搜集、整理、provenance、证据追踪和可复用记忆；深度理解、实验判断和研究 idea 仍由人完成。

## 快速开始

### 环境要求

- Git；
- Node.js `>=22.19.0`；
- Poppler `>=22.05`，包含 `pdftotext`、`pdftoppm`、`pdfinfo` 和 `pdfimages`；
- Tesseract 可选，用于 OCR 辅助；
- 只有使用 Web Agent 对话或 Pi 终端时才必须配置模型；其他本地 Web 页面和知识库不依赖模型。

### Windows

```powershell
git clone https://github.com/lhf-luo/paper-agent.git
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
paper-agent
```

`paper-agent` 默认打开本地 Web 工作区，并使用固定端口 `43127` 供 Browser Connector 检测。安装器创建的是指向当前源码目录的用户级命令；如果移动了仓库，需要重新运行 `install`。

浏览器捕捉功能无需额外构建：打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，选择“加载已解压的扩展程序”，然后选择仓库中的 `browser-extension/` 目录。Paper Agent 运行时，Chrome/Edge 每次完成 PDF 下载都会自动导入个人文献库；确认导入成功后，扩展会删除浏览器下载目录中的原始文件，导入失败则保留。系统关闭期间的下载会被忽略，不会离线排队。

### macOS / Linux

```bash
# macOS
brew install poppler

# Debian / Ubuntu
sudo apt install poppler-utils
```

```bash
git clone https://github.com/lhf-luo/paper-agent.git
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

| 命令          | 结果                |
| ------------- | ------------------- |
| `paper-agent` | 打开本地 Web 工作区 |

安装、状态、校验 profile 和卸载行为见 [CLI 详细说明](docs/cli.md)。

## Web 工作区

默认界面按真实任务划分：

1. **总览**：查看个人库和后台任务状态。
2. **搜索论文**：选择 provider 和年份范围，查看部分失败，在 exact-plan 确认后保存选中的论文。
3. **Agent 对话**：配置模型 endpoint，创建 `once` 或 `persistent` 内存会话，流式接收回答、停止生成、查看工具调用并处理人工确认卡片。
4. **个人库**：搜索并按筛选状态过滤记录，添加私人标签、笔记和筛选决策，查看 PDF 版本，导出选中论文或整个个人库，并批量准备 PDF 下载。
5. **任务中心**：跟踪长任务，暂停或取消任务，从 checkpoint 重试只读失败。
6. **PDF 与 Artifact 工作台**：分析本地 PDF，查看图表和正文关联，校正裁剪区域，发现 artifact，并在明确确认后获取。
7. **团队知识库**：检索分页共享记录，脱敏后提交个人记录，按角色审核共享内容，查看审计事件，管理 token 和备份。
8. **调研工作区**：使用模板或空白 Markdown 创建略读、精读和比较笔记，并关联个人库论文与原文定位。
9. **设置与诊断**：配置路径、provider、模型 endpoint、分类操作确认策略，并粘贴一次性 `pateam1.` 团队接入串；团队密钥不会进入受 Git 跟踪的配置。

Agent 对话页面可填写 Provider ID、Model ID、Base URL、API 类型和 API key。网页输入的 key 只保存在当前 Paper Agent 服务进程内存中，提交成功后密码框立即清空，服务重启后即失效；它不会写入项目配置、Pi 配置、浏览器存储、对话记录或错误响应。也可以让服务读取项目模型配置中指定的 API key 环境变量。普通写入是否询问可在“设置与诊断”中控制；团队和系统级操作始终要求明确确认。

本地 API 只监听 loopback，并由临时会话 token 保护。结构化写操作都经过代码级 `prepare → fingerprint → 一次性 grant → execute` 关卡；需要人工确认时由用户签发 grant，关闭对应询问开关时由本地确认策略签发。取消或改变计划后，旧确认路径不再有效；写任务不能复用旧 grant 重放。

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

| 维度     | 选项                   | 默认值     |
| -------- | ---------------------- | ---------- |
| 使用范围 | `personal` 或 `team`   | `personal` |
| 生命周期 | `once` 或 `persistent` | `once`     |

## 数据、Provenance 与安全

本地运行数据默认位于 `.paper-agent/`。个人 corpus、团队数据和一次性任务彼此分开。

Paper Agent 会记录标准化 identifier、provider 查询、分页、重试、来源 URL、PDF hash、artifact 重定向、checksum、Git commit、license 文件、失败、审核状态，以及适用场景下的追加式审计事件。

主要安全边界包括：

- 本地 Web 服务仅监听 loopback；
- 网页输入的模型 key 只在服务进程内存中；`models add` 持久化的模型 key 单独保存在 Git 忽略的 `.paper-agent/config/auth.json`，不得提交或写入日志；经过验证的团队接入保存在 Git 忽略的 `.paper-agent/team-access.json`；
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
- [研究 Wiki](docs/research-wiki.md)
- [Agent 工具清单](docs/agent-tools.md)
- [团队知识库](docs/team-knowledge-base.md)
- [论文调研工作流](docs/research-workflow.md)
- [独立团队服务器部署](team-server/README.md)

