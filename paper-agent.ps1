# ==============================================================================
# Paper Agent — Windows 启动器
#
# 【系统依赖(首次使用前需安装)】
#   1. Node.js 24.x  (官方安装包: https://nodejs.org)   —— 必需, 低于 24 无法直接执行 TypeScript
#        winget install OpenJS.NodeJS.LTS
#   2. Python 3.10+  (下载 arXiv/PDF 需要; 已有则设 PAPER_AGENT_PYTHON_BIN 指向 python.exe)
#        检查: python --version
#   3. Poppler      (pdftotext / pdfinfo / pdftoppm, 读取 PDF 必需)
#        winget install oschwartz.116.11  (或 choco install poppler)
#        装完后把 Poppler 的 bin 目录加入系统 PATH
#   4. Tesseract OCR (图片表格/手写 OCR, 可选)
#        winget install UB-Mannheim.TesseractOCR
#        并安装中文语言包 chi_sim (安装器勾选)
#
# 【项目 npm 依赖】 由本脚本自动执行 `npm ci` 安装(无需手动):
#   @earendil-works/pi-coding-agent, typebox, react, react-dom, react-markdown,
#   remark-gfm, vite, undici 等 —— 全部来自 package.json / package-lock.json
#
# 【首次配置】 安装后运行 `paper-agent --init` 向导; 或手动编辑:
#   .paper-agent/config.json   (模板: config.example.json)
# ==============================================================================
[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[string]$Action,

	[Parameter(Position = 1, ValueFromRemainingArguments = $true)]
	[string[]]$Arguments
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot
$ScriptsRoot = Join-Path $ProjectRoot "scripts"
$CliBinRoot = if ($env:PAPER_AGENT_CLI_BIN) {
	$env:PAPER_AGENT_CLI_BIN
} else {
	Join-Path $env:LOCALAPPDATA "paper-agent\bin"
}

function Show-Usage {
	Write-Host @"
Paper Agent

Install once, then use the command from PowerShell or CMD:
  .\paper-agent.ps1 install
  paper-agent

Start and paper modes:
  paper-agent                              Open the local Web workspace
  paper-agent paper.pdf                    Open a PDF in the visual reader
  paper-agent --no-open                    Run the Web service without opening a browser
  paper-agent --port 4317                  Use a fixed local Web port
  paper-agent agent                        Start the original Pi agent session
  paper-agent --agent paper.pdf            Open a PDF in the Pi agent
  paper-agent --agent --mode full paper.pdf

Management:
  paper-agent --doctor                     Check Node, Pi, models, and PDF tools
  paper-agent --doctor --probe-model       Send a small tool-calling capability probe
  paper-agent init                         Run the first-use configuration wizard
  paper-agent --setup                      Install exact project dependencies
  paper-agent --status                     Show local corpus and team status
  paper-agent --verify quick|full|live      Run a verification profile
  paper-agent --team demo|status|stop       Manage the local team demo
  paper-agent --team demo --agent           Open the team demo in Pi instead of Web
  paper-agent --version                    Show the source version
  paper-agent --uninstall                  Remove the user-level command shim
  paper-agent --help                       Show this help

Legacy subcommands such as 'paper-agent doctor' and '.\paper-agent.ps1 start'
remain supported. Put extra paper instructions after the PDF path.
"@
}

function Resolve-SetupNode {
	if ($env:PAPER_AGENT_NODE_BIN -and (Test-Path -LiteralPath $env:PAPER_AGENT_NODE_BIN -PathType Leaf)) {
		return (Get-Item -LiteralPath $env:PAPER_AGENT_NODE_BIN).FullName
	}
	$bundled = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
	if (Test-Path -LiteralPath $bundled -PathType Leaf) { return $bundled }
	$system = Get-Command node -ErrorAction SilentlyContinue
	if ($system) { return $system.Source }
	throw "Node.js was not found. Install Node.js 24 or newer (https://nodejs.org) and rerun setup."
}

function Test-ProjectDependencies {
	$required = @(
		"node_modules\@earendil-works\pi-coding-agent\dist\cli.js",
			"node_modules\typebox\package.json",
			"node_modules\vite\bin\vite.js",
			"node_modules\react\package.json",
			"node_modules\undici\package.json",
			"node_modules\react-markdown\package.json"
	)
	if ($required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $ProjectRoot $_) -PathType Leaf) }) {
		return $false
	}
	$installedLock = Join-Path $ProjectRoot "node_modules\.package-lock.json"
	if (-not (Test-Path -LiteralPath $installedLock -PathType Leaf)) { return $false }
	$installedAt = (Get-Item -LiteralPath $installedLock).LastWriteTimeUtc
	foreach ($source in @("package-lock.json")) {
		$sourcePath = Join-Path $ProjectRoot $source
		if ((Test-Path -LiteralPath $sourcePath -PathType Leaf) -and
			(Get-Item -LiteralPath $sourcePath).LastWriteTimeUtc -gt $installedAt.AddSeconds(1)) {
			return $false
		}
	}
	return $true
}

function Get-RunningPaperAgentProcesses {
	$normalizedRoot = $ProjectRoot.Replace("/", "\")
	return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
		$commandLine = [string]$_.CommandLine
		$normalizedCommand = $commandLine.Replace("/", "\")
		$normalizedCommand.IndexOf($normalizedRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
		$normalizedCommand.IndexOf("pi-coding-agent", [StringComparison]::OrdinalIgnoreCase) -ge 0
	})
}

function Test-ProjectNativeModuleLocked {
	$nativeModule = Join-Path $ProjectRoot "node_modules\@earendil-works\pi-coding-agent\node_modules\@mariozechner\clipboard-win32-x64-msvc\clipboard.win32-x64-msvc.node"
	if (-not (Test-Path -LiteralPath $nativeModule -PathType Leaf)) { return $false }
	$stream = $null
	try {
		$stream = [IO.File]::Open($nativeModule, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
		return $false
	} catch [IO.IOException] {
		return $true
	} finally {
		if ($stream) { $stream.Dispose() }
	}
}

function Invoke-Setup {
	$running = Get-RunningPaperAgentProcesses
	if ($running.Count -or (Test-ProjectNativeModuleLocked)) {
		$pids = ($running | ForEach-Object { $_.ProcessId }) -join ", "
		$processText = if ($pids) { " (PID: $pids)" } else { "" }
		throw "Paper Agent files are currently in use$processText. Close every Pi/Paper Agent session using this checkout, then rerun the same install command."
	}

	$node = Resolve-SetupNode
	$version = & $node --version
	if ($version -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.' -or
		[int]$Matches.major -lt 24) {
		throw "Node.js 24 or newer is required (needed to run TypeScript directly); found $version at $node"
	}

	$npmBesideNode = Join-Path (Split-Path -Parent $node) "npm.cmd"
	$npmPath = if (Test-Path -LiteralPath $npmBesideNode -PathType Leaf) {
		(Get-Item -LiteralPath $npmBesideNode).FullName
	} else {
		$command = Get-Command npm.cmd -ErrorAction SilentlyContinue
		if ($command) { $command.Source }
	}
	if (-not $npmPath) {
		$command = Get-Command npm -ErrorAction SilentlyContinue
		if ($command) { $npmPath = $command.Source }
	}
	if (-not $npmPath) { throw "npm was not found next to the selected Node.js installation." }

	Push-Location $ProjectRoot
	$previousPath = $env:PATH
		try {
			$env:PATH = (Split-Path -Parent $node) + ";" + $previousPath
			Write-Host "Installing Paper Agent dependencies with $version..." -ForegroundColor Cyan
			$packageLock = Join-Path $ProjectRoot "package-lock.json"
			if (Test-Path -LiteralPath $packageLock -PathType Leaf) {
				& $npmPath ci --ignore-scripts
				if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
			} else {
				Write-Warning "package-lock.json is absent from this distribution; installing pinned package.json ranges."
				& $npmPath install --ignore-scripts
				if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
			}
			& $npmPath run web:build
			if ($LASTEXITCODE -ne 0) { throw "Web build failed with exit code $LASTEXITCODE" }
	} finally {
		$env:PATH = $previousPath
		Pop-Location
	}
	Write-Host "Setup complete." -ForegroundColor Green
}

function Add-UserPathEntry {
	param([Parameter(Mandatory = $true)][string]$Path)
	$current = [Environment]::GetEnvironmentVariable("Path", "User")
	$entries = @($current -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
	if (-not ($entries | Where-Object { $_.TrimEnd("\") -ieq $Path.TrimEnd("\") })) {
		[Environment]::SetEnvironmentVariable("Path", (($entries + $Path) -join ";"), "User")
	}
	if (-not (($env:PATH -split ";") | Where-Object { $_.TrimEnd("\") -ieq $Path.TrimEnd("\") })) {
		$env:PATH = "$Path;$env:PATH"
	}
}

function Remove-UserPathEntry {
	param([Parameter(Mandatory = $true)][string]$Path)
	$current = [Environment]::GetEnvironmentVariable("Path", "User")
	$entries = @($current -split ";" | ForEach-Object { $_.Trim() } | Where-Object {
		$_ -and $_.TrimEnd("\") -ine $Path.TrimEnd("\")
	})
	[Environment]::SetEnvironmentVariable("Path", ($entries -join ";"), "User")
}

function Install-CommandShim {
	New-Item -ItemType Directory -Path $CliBinRoot -Force | Out-Null
	$shim = Join-Path $CliBinRoot "paper-agent.cmd"
	$content = '@echo off' + "`r`n" + 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%PAPER_AGENT_HOME%\paper-agent.ps1" %*' + "`r`n"
	[IO.File]::WriteAllText($shim, $content, [Text.UTF8Encoding]::new($false))
	if (-not $env:PAPER_AGENT_SKIP_PATH_UPDATE) {
		[Environment]::SetEnvironmentVariable("PAPER_AGENT_HOME", $ProjectRoot, "User")
		Add-UserPathEntry $CliBinRoot
	}
	Write-Host "Installed command: $shim" -ForegroundColor Green
	if ($env:PAPER_AGENT_SKIP_PATH_UPDATE) {
		Write-Host "PATH update skipped for this portable/smoke installation."
	} else {
		Write-Host "Open a new PowerShell or CMD window, then run: paper-agent --doctor"
	}
}

function Invoke-Install {
	if (Test-ProjectDependencies) {
		Write-Host "Project dependencies are already available; skipping npm ci." -ForegroundColor Green
	} else {
		Write-Host "Project dependencies are missing or incomplete; repairing them first." -ForegroundColor Yellow
		Invoke-Setup
	}
	$webIndex = Join-Path $ProjectRoot "dist\web\index.html"
	if (-not (Test-Path -LiteralPath $webIndex -PathType Leaf)) {
		$node = Resolve-SetupNode
		Write-Host "Building the local Web interface..." -ForegroundColor Cyan
		& $node (Join-Path $ProjectRoot "node_modules\vite\bin\vite.js") build
		if ($LASTEXITCODE -ne 0) { throw "Web build failed with exit code $LASTEXITCODE" }
	}
	Install-CommandShim
	$configPath = Join-Path $ProjectRoot ".paper-agent\config.json"
	if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
		Write-Host ""
		Write-Host "config.json 未找到。首次配置:" -ForegroundColor Yellow
		Write-Host "  1) 复制模板:  Copy-Item config.example.json .paper-agent\config.json" -ForegroundColor Cyan
		Write-Host "  2) 填入模型 API Key / 团队配置, 或运行: paper-agent --init" -ForegroundColor Cyan
	}
	Write-Host "Next: paper-agent --doctor" -ForegroundColor Cyan
}

function Invoke-Uninstall {
	$shim = Join-Path $CliBinRoot "paper-agent.cmd"
	if (Test-Path -LiteralPath $shim -PathType Leaf) {
		$expectedHome = if ($env:PAPER_AGENT_HOME) { $env:PAPER_AGENT_HOME } else {
			[Environment]::GetEnvironmentVariable("PAPER_AGENT_HOME", "User")
		}
		if (-not ([IO.File]::ReadAllText($shim).Contains("%PAPER_AGENT_HOME%\paper-agent.ps1")) -or
			-not $expectedHome -or
			$expectedHome.TrimEnd("\") -ine $ProjectRoot.TrimEnd("\")) {
			throw "Refusing to remove an unrelated command at $shim."
		}
		Remove-Item -LiteralPath $shim -Force
	}
	if (-not $env:PAPER_AGENT_SKIP_PATH_UPDATE) {
		Remove-UserPathEntry $CliBinRoot
		[Environment]::SetEnvironmentVariable("PAPER_AGENT_HOME", $null, "User")
	}
	Write-Host "Removed the Paper Agent command shim. The source checkout and data were not deleted." -ForegroundColor Green
}

function Show-Status {
	Invoke-NodeScript -Script "scripts\status.ts"
}

function Invoke-NodeScript {
	param(
		[Parameter(Mandatory = $true)][string]$Script,
		[string[]]$ScriptArguments = @()
	)
	$node = Resolve-SetupNode
	$scriptPath = Join-Path $ProjectRoot $Script
	& $node $scriptPath @ScriptArguments
	if ($LASTEXITCODE -ne 0) { throw "$Script failed with exit code $LASTEXITCODE" }
}

function Invoke-Init {
	Invoke-NodeScript -Script "scripts\configure.ts"
}

function Invoke-Doctor {
	param([switch]$ProbeModel)
	$doctorArguments = if ($ProbeModel) { @("--probe-model") } else { @() }
	Invoke-NodeScript -Script "scripts\doctor.ts" -ScriptArguments $doctorArguments
}

function Invoke-Web {
	param(
		[string]$PdfPath,
		[switch]$NoOpen,
		[int]$Port = -1
	)
	if (-not (Test-ProjectDependencies)) {
		throw "Project dependencies are missing. Run paper-agent install first."
	}
	$webIndex = Join-Path $ProjectRoot "dist\web\index.html"
	if (-not (Test-Path -LiteralPath $webIndex -PathType Leaf)) {
		Write-Host "Building the local Web interface..." -ForegroundColor Cyan
		$node = Resolve-SetupNode
		& $node (Join-Path $ProjectRoot "node_modules\vite\bin\vite.js") build
		if ($LASTEXITCODE -ne 0) { throw "Web build failed with exit code $LASTEXITCODE" }
	}
	$webArguments = @()
	if ($PdfPath) {
		$inputPdf = if ([IO.Path]::IsPathRooted($PdfPath)) { $PdfPath } else { Join-Path (Get-Location).Path $PdfPath }
		$resolvedPdf = (Resolve-Path -LiteralPath $inputPdf -ErrorAction Stop).Path
		if ([IO.Path]::GetExtension($resolvedPdf).ToLowerInvariant() -ne ".pdf") { throw "Expected a PDF file: $resolvedPdf" }
		$webArguments += @("--pdf", $resolvedPdf)
	}
	if ($NoOpen) { $webArguments += "--no-open" }
	if ($Port -ge 0) { $webArguments += @("--port", "$Port") }
	Invoke-NodeScript -Script "scripts\web-server.ts" -ScriptArguments $webArguments
}

function Invoke-Agent {
	param(
		[string]$PdfPath,
		[ValidateSet("quick", "methods", "full", "reproduce")][string]$Mode = "quick",
		[string[]]$Instructions = @()
	)
	& (Join-Path $ScriptsRoot "start-local.ps1") -PdfPath $PdfPath -Mode $Mode -Instructions $Instructions
	exit $LASTEXITCODE
}

function Invoke-Verify {
	param([string]$Mode = "quick")
	$normalized = $Mode.ToLowerInvariant()
	if ($normalized -notin @("quick", "full", "live")) {
		throw "Unknown verify mode: $Mode. Use quick, full, or live."
	}
	Invoke-NodeScript -Script "scripts\verify.ts" -ScriptArguments @("--mode", $normalized)
}

function Invoke-TeamDemoCommand {
	param(
		[string]$TeamAction = "status",
		[string[]]$TeamArguments = @()
	)
	if ($TeamAction -notin @("demo", "status", "stop")) {
		throw "Unknown team action: $TeamAction. Use demo, status, or stop."
	}
	if ($TeamAction -ne "demo" -and $TeamArguments.Count) {
		throw "Team action $TeamAction does not accept additional options."
	}
	$useAgent = $false
	$noOpen = $false
	$noLaunch = $false
	foreach ($argument in $TeamArguments) {
		switch ($argument.ToLowerInvariant()) {
			"--agent" { $useAgent = $true }
			"--no-open" { $noOpen = $true }
			"--no-launch" { $noLaunch = $true }
				default { throw "Unknown team demo option: $argument. Use --agent, --no-open, or --no-launch." }
		}
	}
	& (Join-Path $ScriptsRoot "team-demo.ps1") $TeamAction -Agent:$useAgent -NoOpen:$noOpen -NoLaunch:$noLaunch
}

function Invoke-OptionSyntax {
	param([string[]]$Tokens)
	$mode = "quick"
	$pdfPath = $null
	$instructions = @()
	$useAgent = $false
	$noOpen = $false
	$port = -1
	$index = 0
	while ($index -lt $Tokens.Count) {
		$token = $Tokens[$index]
			switch ($token.ToLowerInvariant()) {
			"--help" { Show-Usage; return }
			"-h" { Show-Usage; return }
			"--version" { Write-Host "Paper Agent 0.1.0 ($ProjectRoot)"; return }
			"--install" { Invoke-Install; return }
			"--uninstall" { Invoke-Uninstall; return }
				"--setup" { Invoke-Setup; return }
				"--init" { Invoke-Init; return }
				"--doctor" { Invoke-Doctor -ProbeModel:($Tokens -contains "--probe-model"); return }
				"--probe-model" { Invoke-Doctor -ProbeModel; return }
				"--status" { Show-Status; return }
				"--agent" { $useAgent = $true; $index += 1; continue }
				"--web" { $useAgent = $false; $index += 1; continue }
				"--no-open" { $noOpen = $true; $index += 1; continue }
				"--port" {
					if (-not $Tokens[$index + 1]) { throw "--port requires a number from 0 to 65535." }
					$port = [int]$Tokens[$index + 1]
					if ($port -lt 0 -or $port -gt 65535) { throw "--port requires a number from 0 to 65535." }
					$index += 2
					continue
				}
			"--verify" {
				$verifyMode = if ($Tokens[$index + 1] -and -not $Tokens[$index + 1].StartsWith("-")) { $Tokens[$index + 1] } else { "quick" }
				Invoke-Verify $verifyMode
				return
			}
			"--team" {
				$teamAction = if ($Tokens[$index + 1]) { $Tokens[$index + 1] } else { "status" }
				$teamArguments = if ($Tokens.Count -gt ($index + 2)) {
					@($Tokens | Select-Object -Skip ($index + 2))
				} else { @() }
				Invoke-TeamDemoCommand -TeamAction $teamAction -TeamArguments $teamArguments
				return
			}
				"--mode" {
				if (-not $Tokens[$index + 1]) { throw "--mode requires quick, methods, full, or reproduce." }
					$mode = $Tokens[$index + 1].ToLowerInvariant()
					$useAgent = $true
				if ($mode -notin @("quick", "methods", "full", "reproduce")) {
					throw "Unknown paper mode: $mode. Use quick, methods, full, or reproduce."
				}
				$index += 2
				continue
			}
			default {
				if (-not $pdfPath -and $token -match '(?i)\.pdf$') { $pdfPath = $token }
				elseif ($pdfPath) { $instructions += $token }
				else { throw "Unknown option or argument: $token. Run paper-agent --help." }
				$index += 1
				continue
			}
		}
		}
		if ($useAgent) {
			if ($mode -ne "quick" -and -not $pdfPath) { throw "--mode $mode requires a PDF path." }
			Invoke-Agent -PdfPath $pdfPath -Mode $mode -Instructions $instructions
		} else {
			if ($instructions.Count) { throw "Extra paper instructions require --agent." }
			Invoke-Web -PdfPath $pdfPath -NoOpen:$noOpen -Port $port
		}
}

$tokens = @()
if ($Action) { $tokens += $Action }
if ($Arguments) { $tokens += $Arguments }
if (-not $tokens.Count) { Invoke-Web; exit $LASTEXITCODE }
if ($tokens[0].StartsWith("-")) { Invoke-OptionSyntax $tokens; exit $LASTEXITCODE }

$normalizedAction = $tokens[0].ToLowerInvariant()
$remaining = @($tokens | Select-Object -Skip 1)
switch ($normalizedAction) {
	"help" { Show-Usage }
	"install" { Invoke-Install }
	"uninstall" { Invoke-Uninstall }
	"setup" { Invoke-Setup }
	"init" { Invoke-Init }
	"doctor" { Invoke-Doctor -ProbeModel:($remaining -contains "--probe-model") }
	"status" { Show-Status }
	"start" {
		$pdf = if ($remaining.Count -and $remaining[0] -match '(?i)\.pdf$') { $remaining[0] } else { $null }
		Invoke-Web -PdfPath $pdf
	}
	"web" { Invoke-Web -PdfPath $(if ($remaining.Count -and $remaining[0] -match '(?i)\.pdf$') { $remaining[0] } else { $null }) }
	"agent" {
		$pdf = if ($remaining.Count -and $remaining[0] -match '(?i)\.pdf$') { $remaining[0] } else { $null }
		$extra = if ($pdf) { @($remaining | Select-Object -Skip 1) } else { $remaining }
		Invoke-Agent -PdfPath $pdf -Instructions $extra
	}
	"verify" { Invoke-Verify $(if ($remaining.Count) { $remaining[0] } else { "quick" }) }
	"team" {
		$teamAction = if ($remaining.Count) { $remaining[0] } else { "status" }
		$teamArguments = if ($remaining.Count -gt 1) { @($remaining | Select-Object -Skip 1) } else { @() }
		Invoke-TeamDemoCommand -TeamAction $teamAction -TeamArguments $teamArguments
	}
	default {
		if ($tokens[0] -match '(?i)\.pdf$') { Invoke-Web -PdfPath $tokens[0]; return }
		Show-Usage
		throw "Unknown action: $($tokens[0])"
	}
}
