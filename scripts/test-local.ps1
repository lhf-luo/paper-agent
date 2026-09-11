[CmdletBinding()]
param(
	[switch]$SkipPdfEvaluation,
	[switch]$RunLiveIntegration
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-environment.ps1")
Set-Location $PaperAgentEnvironment.ProjectRoot

& (Join-Path $PSScriptRoot "check-local-environment.ps1")

function Invoke-CheckedNode {
	param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
	& $PaperAgentEnvironment.NodeExe @Arguments
	if ($LASTEXITCODE -ne 0) {
		throw "Command failed with exit code ${LASTEXITCODE}: node $($Arguments -join ' ')"
	}
}

$mode = if ($RunLiveIntegration) { "live" } elseif ($SkipPdfEvaluation) { "quick" } else { "full" }
Write-Host "`nRunning the shared cross-platform verification profile: $mode" -ForegroundColor Cyan
Invoke-CheckedNode ".\scripts\verify.ts" "--mode" $mode
