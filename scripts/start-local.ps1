[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[string]$PdfPath,

	[Parameter(Position = 1, ValueFromRemainingArguments = $true)]
	[string[]]$Instructions,

	[ValidateSet("quick", "methods", "full", "reproduce")]
	[string]$Mode = "quick"
)

$ErrorActionPreference = "Stop"
$CallerDirectory = (Get-Location).Path
. (Join-Path $PSScriptRoot "local-environment.ps1")
Set-Location $PaperAgentEnvironment.ProjectRoot

$extension = Join-Path $PaperAgentEnvironment.ProjectRoot "src\index.ts"
$skill = Join-Path $PaperAgentEnvironment.ProjectRoot "skills\literature-corpus-manager"
$arguments = @(
	$PaperAgentEnvironment.PiCli,
	"--no-approve",
	"--no-extensions",
	"--extension", $extension,
	"--skill", $skill
)

if ($PdfPath) {
	$inputPdf = if ([IO.Path]::IsPathRooted($PdfPath)) { $PdfPath } else { Join-Path $CallerDirectory $PdfPath }
	$resolvedPdf = (Resolve-Path -LiteralPath $inputPdf -ErrorAction Stop).Path
	if ([IO.Path]::GetExtension($resolvedPdf).ToLowerInvariant() -ne ".pdf") {
		throw "Expected a PDF file: $resolvedPdf"
	}
	$extra = ($Instructions -join " ").Trim()
	$initialPrompt = "/paper $Mode `"$resolvedPdf`""
	if ($extra) { $initialPrompt += " $extra" }
	$arguments += $initialPrompt
	Set-Location (Split-Path -Parent $resolvedPdf)
}

& $PaperAgentEnvironment.NodeExe @arguments
exit $LASTEXITCODE
