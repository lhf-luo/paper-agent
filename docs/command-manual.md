# Paper Agent 命令手册

> 本手册只记录当前正式命令语法。系统不保留旧版本 CLI 别名。

相关文档：[系统指南](system-guide.md) | [CLI 安装说明](cli.md) | [模型配置](model-configuration.md) | [Windows 配置](windows-setup.md)

## 1. 命令约定

安装后统一使用：

```text
paper-agent [command] [options] [PDF]
```

未安装用户级命令时，可从仓库根目录直接运行：

```powershell
.\paper-agent.ps1 <参数>   # Windows
```

```bash
./run.sh <参数>            # macOS / Linux
```

除安装命令外，下文均以 `paper-agent` 为例。含空格的路径必须加引号。

## 2. 命令速查

| 命令 | 作用 |
| --- | --- |
| `paper-agent` | 启动本地 Web 工作区 |
| `paper-agent <paper.pdf>` | 在 Web 阅读器打开 PDF |
| `paper-agent agent` | 启动 Pi 终端 |
| `paper-agent --agent <paper.pdf> [要求]` | 在 Pi 中使用论文研究 Skill，并可追加自然语言要求 |
| `paper-agent init` | 运行首次配置向导 |
| `paper-agent models add` | 添加模型端点、拉取模型并设置活动模型 |
| `paper-agent models probe-image --model <provider/model>` | 使用生成的 PNG 验证模型图片输入能力 |
| `paper-agent models list` | 列出已配置模型，不显示密钥 |
| `paper-agent --doctor` | 运行环境与配置诊断 |
| `paper-agent --status` | 显示系统状态 |
| `paper-agent --verify <profile>` | 运行验证流程 |
| `paper-agent --team <action>` | 管理本地团队演示 |
| `paper-agent --setup` | 重装锁定依赖并构建 Web |
| `paper-agent install` | 安装或修复用户级命令 |
| `paper-agent --uninstall` | 删除用户级命令 |
| `paper-agent --help` | 显示帮助 |
| `paper-agent --version` | 显示版本和源码路径 |

## 3. 安装与首次配置

### Windows

```powershell
Set-Location D:\paper-agent\paper-agent
.\paper-agent.ps1 install
```

安装器会检查 Node.js、安装锁定依赖、构建 Web、创建用户级命令并更新当前用户的 `PATH`。安装完成后应打开一个新终端。

### macOS / Linux

```bash
npm ci --ignore-scripts
npm run web:build
./run.sh install
```

默认在 `~/.local/bin/` 创建命令。启动器会输出需要加入 `PATH` 的目录。

### 首次配置向导

```powershell
paper-agent init
```

向导配置 Web 行为、存储路径、默认个人 namespace、搜索设置、模型端点名称和团队连接信息。模型 API key 推荐单独使用 `models add` 配置。

## 4. Web 工作区

### 默认启动

```powershell
paper-agent
```

默认监听 loopback 随机可用端口，并按配置决定是否自动打开浏览器。

### 打开 PDF

```powershell
paper-agent "D:\papers\example.pdf"
```

只传 PDF 路径时使用 Web 可视化阅读器。相对路径以执行命令时的当前目录为基准。

### 不自动打开浏览器

```powershell
paper-agent --no-open
```

终端会打印带临时会话 token 的完整 URL。应打开该完整 URL，而不是只打开主机和端口。

### 指定端口

```powershell
paper-agent --port 43127
paper-agent --no-open --port 43127
```

端口范围是 `0` 到 `65535`；`0` 表示由系统选择可用端口。

## 5. Pi Agent

### 交互会话

```powershell
paper-agent agent
```

### 论文工作流

```powershell
paper-agent --agent "D:\papers\example.pdf"
paper-agent --agent "D:\papers\example.pdf" "重点检查消融实验和训练成本"
paper-agent --agent "D:\papers\example.pdf" "完整阅读并准备复现条件清单"
```

研究深度不由命令枚举决定。`paper-research` Skill 根据自然语言选择快速略读、方法精读、全文研究或复现准备：未提供要求时先略读；明确“只分析方法”时执行方法精读；普通“精读”“深度阅读”执行全文研究并严格输出 12 节；复现请求在全文研究后继续检查 Artifact 和复现条件。

## 6. 模型配置

### 交互添加

```powershell
paper-agent models add
```

命令依次完成：

1. 读取 Provider ID、Base URL 和 API key。
2. 请求兼容服务的 `/models` 端点。
3. 显示发现的模型并选择活动模型。
4. 将模型元数据写入 `.paper-agent/config/models.json`，将 Provider 认证写入 `.paper-agent/config/auth.json`。

交互输入会遮蔽 API key。除自动化环境外，不建议把密钥直接写进命令行历史。

### 非交互参数

```powershell
paper-agent models add `
  --provider deepseek `
  --base-url https://api.deepseek.com/v1 `
  --api openai-completions `
  --active deepseek-flash `
  --yes
```

| 参数 | 作用 |
| --- | --- |
| `--provider <id>` | 设置 Provider ID；留空时根据 Base URL 推断 |
| `--base-url <url>` | 设置兼容 API 的基础 URL |
| `--api <kind>` | `openai-completions` 或 `openai-responses` |
| `--api-key <key>` | 直接传入密钥；可能进入 shell 历史 |
| `--active <model-id>` | 指定发现列表中的活动模型 |
| `--yes` | 自动选择默认模型，不进行交互确认 |
| `--json` | 输出机器可读 JSON |

未指定 `--api` 时，新 Provider 固定使用 `openai-completions`，不会继承当前激活模型的协议。命令会自动写入与 Pi relay 一致的客户端请求头；同一 Provider 再次配置时会替换该 Provider 的旧模型条目。只有中转服务完整支持 Responses API 的工具结果续传时，才应使用 `--api openai-responses`。OpenOX 当前应使用 `openai-completions`。

### 查看模型

```powershell
paper-agent models list
paper-agent models list --json
```

输出包含配置路径、活动模型和模型列表，但不会打印 API key。

### 图片输入能力探测

```powershell
paper-agent models probe-image --model deepseek/deepseek-flash
```

命令会发送一张动态生成的 PNG 色带图，只有模型正确读出色带顺序才判定支持图片输入。普通 `/models` 列表和模型名称都不作为多模态能力证据。

## 7. 诊断与状态

### 环境诊断

```powershell
paper-agent --doctor
```

检查 Node.js、依赖、Web 构建、Poppler、OCR、模型配置和团队配置。

### 模型工具调用探测

```powershell
paper-agent --doctor --probe-model
```

该命令会向支持自动探测的 OpenAI 兼容端点发送一个小请求。`anthropic-messages` 和 `google-generative-ai` 需要在 Pi 会话中通过真实工具任务验证。

### 系统状态

```powershell
paper-agent --status
```

显示命令安装、个人资料库、Pi 凭据和团队连接状态。输出不应包含密钥值。

## 8. 验证命令

```powershell
paper-agent --verify quick
paper-agent --verify full
paper-agent --verify live
```

| Profile | 内容 |
| --- | --- |
| `quick` | lint、类型检查、Web 构建、测试和本地冒烟检查 |
| `full` | 在 quick 基础上加入固定真实 PDF 发布门禁 |
| `live` | 加入真实 Provider 和公开 Git 网络检查 |

`live` 会访问外部服务，可能需要 Provider 凭据和可用网络。

## 9. 团队演示

```powershell
paper-agent --team demo
paper-agent --team demo --agent
paper-agent --team status
paper-agent --team stop
```

| Action | 作用 |
| --- | --- |
| `demo` | 启动仅监听 loopback 的单人团队服务并打开 Web |
| `demo --agent` | 启动相同服务并进入 Pi 终端 |
| `status` | 检查演示服务状态 |
| `stop` | 停止经过状态文件校验的演示进程 |

团队演示只用于本机流程测试，不是生产部署方案。

## 10. 维护命令

### 重装项目依赖

```powershell
paper-agent --setup
```

按照 lockfile 重装依赖并重新构建 Web。Windows 上若出现原生模块 `EPERM`，先关闭正在使用项目的 Paper Agent/Pi 进程。

### 修复用户级命令

```powershell
paper-agent install
```

仓库移动、依赖变化或命令 shim 丢失后重新执行。Windows 也可以从新仓库路径运行 `.\paper-agent.ps1 install`。

### 卸载命令

```powershell
paper-agent --uninstall
```

该操作删除用户级 shim、对应用户 `PATH` 项和 `PAPER_AGENT_HOME`，不会删除源码、`.paper-agent` 数据、PDF、个人库或 Pi 凭据。

## 11. Pi 会话内命令

进入 `paper-agent agent` 后可使用：

| 命令 | 用途 |
| --- | --- |
| `/paper <paper.pdf> [研究问题或要求]` | 使用 paper-research Skill 启动论文阅读流程 |
| `/collect [--save] [--namespace name] [--max N] <查询>` | 收集文献；只有 `--save` 会持久化到个人库 |
| `/library [请求]` | 搜索、审计、导出或整理个人/团队资料库 |
| `/team [请求]` | 搜索、提案、审核、审计或备份团队库 |

示例：

```text
/paper @D:\papers\example.pdf 重点检查损失函数
/collect --max 30 retrieval augmented generation evaluation
/collect --save --namespace rag retrieval augmented generation evaluation
/library 导出最近保存的论文为 BibTeX
/team 查看待审核提案
```

## 12. 开发者命令

以下命令在仓库根目录执行：

| 命令 | 用途 |
| --- | --- |
| `npm run web:dev` | 启动 Vite 开发服务器 |
| `npm run web:build` | 构建 Web 静态资源 |
| `npm run typecheck` | 检查服务端 TypeScript |
| `npm run typecheck:web` | 检查 Web TypeScript |
| `npm test` | 运行 Vitest 测试套件 |
| `npm run test:cli-smoke` | 运行 CLI 和本地 Web 冒烟检查 |
| `npm run test:team-server` | 运行团队服务冒烟检查 |
| `npm run check` | 运行 lint、类型检查、Web 构建和测试 |
| `npm run release:check` | 运行完整检查和 PDF 资产评估门禁 |


## 13. 退出状态与排错

- 成功执行通常返回退出码 `0`。
- 参数错误、依赖缺失、诊断失败或测试失败返回非零退出码。
- `paper-agent models list --json` 适合脚本读取；不要解析面向人的普通文本输出。
- 找不到 `paper-agent` 时，重新打开终端或检查用户 `PATH`。
- 仓库移动后，回到新路径重新运行安装命令。
- 出现 `No models available` 时，运行 `paper-agent models add`，再用 `paper-agent --doctor` 检查。
- 缺少 PDF 工具时，安装 Poppler `>=22.05`，在设置页“外部命令目录”中填写其 `bin` 目录，保存后重新诊断。工具可以安装在任意位置，也可通过 `PAPER_AGENT_EXTERNAL_TOOL_PATHS` 或系统 `PATH` 提供。
