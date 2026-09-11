# Windows 安装指南

Paper Agent 的 Node.js 依赖安装在项目的 `node_modules/` 中。Poppler、Tesseract 和 PDF2zh Next 是外部命令，可以安装在任意目录，不需要复制到项目仓库。

## 必需组件

| 组件 | 用途 | 是否必需 |
| --- | --- | --- |
| Git | 获取和更新项目 | 是 |
| Node.js 22.19 或更高版本 | 运行服务和 TypeScript | 是 |
| Poppler 22.05 或更高版本 | PDF 文本、页数、布局和图像处理 | 是 |
| Tesseract OCR | 扫描 PDF 和图片文字识别 | 可选 |
| PDF2zh Next | PDF 翻译 | 可选 |

## 安装项目

```powershell
git clone https://github.com/lhf-luo/paper-agent.git
Set-Location paper-agent
.\paper-agent.ps1 install
paper-agent init
paper-agent --doctor
```

## 配置外部命令

安装 Poppler 或 Tesseract 后，在“设置与诊断”的“外部命令目录”中填写可执行文件所在目录。多个目录用分号分隔，例如：

```text
D:\AI-Tools\poppler\Library\bin;D:\AI-Tools\tesseract
```

也可以直接编辑 `.paper-agent/config/app.json`：

```json
{
  "externalTools": {
    "commandDirectories": [
      "D:\\AI-Tools\\poppler\\Library\\bin",
      "D:\\AI-Tools\\tesseract"
    ]
  }
}
```

或者使用环境变量覆盖配置：

```powershell
[Environment]::SetEnvironmentVariable(
  "PAPER_AGENT_EXTERNAL_TOOL_PATHS",
  "D:\AI-Tools\poppler\Library\bin;D:\AI-Tools\tesseract",
  "User"
)
```

命令查找顺序为：`PAPER_AGENT_EXTERNAL_TOOL_PATHS`、应用配置、系统 `PATH`。Paper Agent 不扫描整个磁盘，也不要求固定安装路径。

Poppler 目录应包含 `pdftotext.exe`、`pdfinfo.exe`、`pdftoppm.exe` 和 `pdfimages.exe`。Tesseract 目录应包含 `tesseract.exe`；需要中文 OCR 时还应在其 `tessdata` 目录安装 `chi_sim.traineddata`。

PDF2zh Next 使用单独的 `pdfTranslation.command` 配置，可以填写命令名或 `pdf2zh_next.exe` 的完整路径。参见 [系统指南](system-guide.md#pdf-与图表分析)。

## 验证

保存设置后，新的应用操作会立即使用配置。如果修改的是环境变量，请重新启动 Paper Agent。运行：

```powershell
paper-agent --doctor
```

诊断应报告 `pdftotext`、`pdfinfo`、`pdftoppm` 和 `pdfimages` 可用。Tesseract 与 PDF2zh Next 缺失只会禁用对应可选功能。
