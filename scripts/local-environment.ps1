[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes\codex-primary-runtime\dependencies"
$BundledNodeExe = Join-Path $RuntimeRoot "node\bin\node.exe"
$SystemNode = Get-Command node -ErrorAction SilentlyContinue
$NodeExe = if (Test-Path -LiteralPath $BundledNodeExe -PathType Leaf) {
	$BundledNodeExe
} elseif ($SystemNode) {
	$SystemNode.Source
} else {
	throw "Node.js was not found. Install Node.js 22.19 or newer, then retry."
}
$PiCli = Join-Path $ProjectRoot "node_modules\@earendil-works\pi-coding-agent\dist\cli.js"
$ProjectBin = Join-Path $ProjectRoot "node_modules\.bin"

$nodeVersionText = & $NodeExe --version
if ($nodeVersionText -notmatch '^v(?<major>\d+)\.(?<minor>\d+)\.') {
	throw "Unable to determine Node.js version from: $nodeVersionText"
}
$nodeMajor = [int]$Matches.major
$nodeMinor = [int]$Matches.minor
if ($nodeMajor -lt 22 -or ($nodeMajor -eq 22 -and $nodeMinor -lt 19)) {
	throw "Node.js 22.19 or newer is required; found $nodeVersionText at $NodeExe"
}
if (-not (Test-Path -LiteralPath $PiCli -PathType Leaf)) {
	throw "Project dependencies are incomplete. Run npm ci, then retry."
}

# Keep the supported runtime and project-local commands ahead of the user's older global Node.js.
$env:PATH = (Split-Path -Parent $NodeExe) + ";" + $ProjectBin + ";" + $env:PATH

# External tools may live anywhere. An explicit environment override wins over
# the application config; the existing system PATH remains the final fallback.
$ExternalToolDirectories = @()
if (-not [string]::IsNullOrWhiteSpace($env:PAPER_AGENT_EXTERNAL_TOOL_PATHS)) {
	$ExternalToolDirectories = @($env:PAPER_AGENT_EXTERNAL_TOOL_PATHS -split [IO.Path]::PathSeparator)
} else {
	$AppConfigPath = Join-Path $ProjectRoot ".paper-agent\config\app.json"
	if (Test-Path -LiteralPath $AppConfigPath -PathType Leaf) {
		$AppConfig = Get-Content -Raw -LiteralPath $AppConfigPath | ConvertFrom-Json
		$ExternalToolDirectories = @($AppConfig.externalTools.commandDirectories)
	}
}
$ResolvedExternalToolDirectories = @(
	$ExternalToolDirectories |
		Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
		ForEach-Object {
			if ([IO.Path]::IsPathRooted($_)) { [IO.Path]::GetFullPath($_) }
			else { [IO.Path]::GetFullPath((Join-Path $ProjectRoot $_)) }
		} |
		Select-Object -Unique
)
if ($ResolvedExternalToolDirectories.Count -gt 0) {
	$env:PATH = ($ResolvedExternalToolDirectories -join [IO.Path]::PathSeparator) + [IO.Path]::PathSeparator + $env:PATH
}

$script:PaperAgentEnvironment = [pscustomobject]@{
	ProjectRoot = $ProjectRoot
	NodeExe = $NodeExe
	PiCli = $PiCli
	PiAuthFile = Join-Path $env:USERPROFILE ".pi\agent\auth.json"
}

function Assert-PaperAgentCommand {
	param(
		[Parameter(Mandatory = $true)]
		[string]$Name
	)
	$command = Get-Command $Name -ErrorAction SilentlyContinue
	if (-not $command) {
		throw "Required command is missing: $Name"
	}
	return $command.Source
}
