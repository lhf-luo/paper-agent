[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[string]$PdfPath,

	[Parameter(Position = 1, ValueFromRemainingArguments = $true)]
	[string[]]$Instructions
)

$ErrorActionPreference = "Stop"
$CallerDirectory = (Get-Location).Path
. (Join-Path $PSScriptRoot "local-environment.ps1")
Set-Location $PaperAgentEnvironment.ProjectRoot
& $PaperAgentEnvironment.NodeExe (Join-Path $PSScriptRoot "initialize-pi.ts")
if ($LASTEXITCODE -ne 0) { throw "Pi configuration initialization failed." }
if (-not $env:PI_CODING_AGENT_DIR) {
	$env:PI_CODING_AGENT_DIR = Join-Path $PaperAgentEnvironment.ProjectRoot ".paper-agent\pi"
}

$extension = Join-Path $PaperAgentEnvironment.ProjectRoot "src\index.ts"
$skills = Join-Path $PaperAgentEnvironment.ProjectRoot ".agents\skills"
$arguments = @(
	$PaperAgentEnvironment.PiCli,
	"--no-approve",
	"--no-extensions",
	"--extension", $extension,
	"--skill", $skills
)

if ($PdfPath) {
	$inputPdf = if ([IO.Path]::IsPathRooted($PdfPath)) { $PdfPath } else { Join-Path $CallerDirectory $PdfPath }
	$resolvedPdf = (Resolve-Path -LiteralPath $inputPdf -ErrorAction Stop).Path
	if ([IO.Path]::GetExtension($resolvedPdf).ToLowerInvariant() -ne ".pdf") {
		throw "Expected a PDF file: $resolvedPdf"
	}
	$extra = ($Instructions -join " ").Trim()
	$initialPrompt = "/paper `"$resolvedPdf`""
	if ($extra) { $initialPrompt += " $extra" }
	$arguments += $initialPrompt
	Set-Location (Split-Path -Parent $resolvedPdf)
}

& $PaperAgentEnvironment.NodeExe @arguments
exit $LASTEXITCODE
