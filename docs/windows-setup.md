# Windows 安装指南（给安装 Agent 的说明文档）

> 目标：在 Windows 上安装并运行 Paper Agent。
> **安装原则**：npm 依赖装入项目 `node_modules/`；**所有系统工具统一安装到项目根下的 `dependence/` 目录**（不污染系统）。
> 项目根示例：`D:\paper-agent`（下文用 `<PROJECT>` 表示）。

---

## 依赖总览

| 依赖 | 安装位置 | 用途 | 必需 |
| --- | --- | --- | --- |
| Node.js 24.x | `<PROJECT>\dependence\node\` | 运行服务（直接执行 TS） | ✅ 必需 |
| Python 3.12 | 已有（用户已安装，不装） | arXiv/PDF 下载通道 | ✅ 已有 |
| Poppler | `<PROJECT>\dependence\poppler\` | 读 PDF（pdftotext/pdfinfo/pdftoppm） | ✅ 必需 |
| Tesseract + chi_sim | `<PROJECT>\dependence\tesseract\` | OCR（图片/扫描 PDF） | ⚠️ 可选 |
| npm 包（全部） | `<PROJECT>\node_modules\` | 项目依赖（npm ci 自动装） | ✅ 必需 |

---

## 第 1 步：创建目录

```powershell
cd <PROJECT>
New-Item -ItemType Directory -Path dependence -Force
```

## 第 2 步：Node.js 24（便携版，装到 dependence\node）

```powershell
# 1) 下载便携 zip（选 v24 最新版）:
#    https://nodejs.org/dist/latest-v24.x/  找 node-v24.x.x-win-x64.zip
# 2) 解压:
Expand-Archive node-v24.x.x-win-x64.zip -DestinationPath dependence
Rename-Item dependence\node-v24.x.x-win-x64 dependence\node

# 3) 验证:
dependence\node\node.exe --version      # 必须 v24.xx.x

# 4) 设置环境变量（ps1 和脚本优先用它）:
[Environment]::SetEnvironmentVariable("PAPER_AGENT_NODE_BIN", "<PROJECT>\dependence\node\node.exe", "User")
```

## 第 3 步：Python（已有，无需安装）

用户已安装 Python，本步骤只做检测与绑定：

```powershell
# 1) 确认 python 可用:
python --version          # 需 3.10+

# 2) 设置环境变量，让下载通道直接用你的 Python:
#    （填 python.exe 的完整路径，例如 C:\Python312\python.exe）
[Environment]::SetEnvironmentVariable("PAPER_AGENT_PYTHON_BIN", "你的 python.exe 完整路径", "User")

# 3) 验证:
$env:PAPER_AGENT_PYTHON_BIN; python -c "import sys; print(sys.version)"
```

> 若你的 python 已在 PATH 且不想设变量，可跳过（脚本回退到 PATH 中的 `python3`）。
> Windows 上若只有 `python`（无 `python3` 别名），建议设置 `PAPER_AGENT_PYTHON_BIN`，否则下载通道可能找不到命令。

## 第 4 步：Poppler（装到 dependence\poppler）

```powershell
# 1) 下载便携版:
#    https://github.com/oschwartz10612/poppler-windows/releases  (poppler-xx.zip)
# 2) 解压到 dependence\poppler（内部含 Library\bin\pdftotext.exe）
Expand-Archive poppler-xx.zip -DestinationPath dependence\poppler

# 3) 把 bin 加入用户 PATH:
$popplerBin = "<PROJECT>\dependence\poppler\Library\bin"
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";" + $popplerBin, "User")

# 4) 验证（新开 PowerShell）:
pdftotext -v
pdfinfo -v
pdftoppm -v
```

## 第 5 步：Tesseract + 中文包（可选，装到 dependence\tesseract）

```powershell
# 1) 下载便携版 tesseract（含训练数据）:
#    https://github.com/UB-Mannheim/tesseract/wiki 或官方 releases
# 2) 解压到 dependence\tesseract（内部含 tesseract.exe 和 tessdata\）
# 3) 确认中文语言包存在:
Test-Path dependence\tesseract\tessdata\chi_sim.traineddata   # 没有则下载 chi_sim.traineddata 放进去

# 4) 加入 PATH:
[Environment]::SetEnvironmentVariable("Path", $env:Path + ";<PROJECT>\dependence\tesseract", "User")

# 5) 验证（新开 PowerShell）:
tesseract --version
tesseract --list-langs   # 应包含 chi_sim
```

## 第 6 步：npm 依赖（装到 node_modules）

```powershell
cd <PROJECT>
# 推荐方式（自动装 + 构建 + 装命令）:
.\paper-agent.ps1 install

# 或手动:
dependence\node\npm.cmd ci --ignore-scripts
dependence\node\npm.cmd run web:build
```

> 注意：`npm ci` 会装全部依赖（pi-coding-agent、typebox、react、vite、undici、
> react-markdown、remark-gfm 等），来自 package-lock.json，无需手动安装任何一个 npm 包。

## 第 7 步：配置文件

```powershell
cd <PROJECT>
New-Item -ItemType Directory -Path .paper-agent -Force
Copy-Item config.example.json .paper-agent\config.json

# 编辑 .paper-agent\config.json 填入（必填）:
#   model.apiKey                      → 模型 API Key（DeepSeek 等）
# 可选:
#   network.proxyUrl / proxyEnabled   → Windows 常用 http://127.0.0.1:7890
#   credentials.semanticScholarApiKey / coreApiKey / exaApiKey / openAlexMailto
#   team.serverUrl / team.token       → 团队部署时
```

## 第 8 步：验证

```powershell
cd <PROJECT>
.\paper-agent.ps1 --doctor          # 检查 Node/npm 包/PDF 工具/模型
.\paper-agent.ps1                   # 启动网页
```

---

## 常见问题

- **pdftotext 找不到**：Poppler 的 bin 目录没进 PATH（第 4 步），或需要重开 PowerShell。
- **python 下载失败**：确认 `PAPER_AGENT_PYTHON_BIN` 指向你已有的 python.exe（Windows 无 python3 别名时必须设置）。
- **Node 版本报错**：`dependence\node\node.exe --version` 必须 v24+。
- **网页空白**：`npm run web:build` 后 dist\web\index.html 应非空。
- **代理**：搜索 Provider 走代理时，把 `network.proxyEnabled` 设为 true（默认 127.0.0.1:7890 需匹配你的代理软件）。
