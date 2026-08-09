[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-environment.ps1")

$requiredCommands = @("pdftotext", "pdftoppm", "pdfinfo", "pdfimages")
$commands = foreach ($name in $requiredCommands) {
	[pscustomobject]@{ Name = $name; Path = Assert-PaperAgentCommand $name; Required = $true }
}
$tesseract = Get-Command tesseract -ErrorAction SilentlyContinue
$commands += [pscustomobject]@{
	Name = "tesseract"
	Path = if ($tesseract) { $tesseract.Source } else { "not installed (optional)" }
	Required = $false
}

$nodeVersion = & $PaperAgentEnvironment.NodeExe --version
$piVersion = & $PaperAgentEnvironment.NodeExe $PaperAgentEnvironment.PiCli --version
$configuredProviders = @()
if (Test-Path -LiteralPath $PaperAgentEnvironment.PiAuthFile -PathType Leaf) {
	try {
		$auth = Get-Content -Raw -LiteralPath $PaperAgentEnvironment.PiAuthFile | ConvertFrom-Json
		$configuredProviders = @(
			$auth.PSObject.Properties |
				ForEach-Object { $_.Name } |
				Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
		)
	} catch {
		throw "Pi authentication file is not valid JSON: $($PaperAgentEnvironment.PiAuthFile)"
	}
}
$providerEnvironmentVariables = @(
	"ANTHROPIC_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"DEEPSEEK_API_KEY",
	"GEMINI_API_KEY",
	"OPENROUTER_API_KEY",
	"XAI_API_KEY",
	"GROQ_API_KEY",
	"MISTRAL_API_KEY"
)
$configuredEnvironmentProviders = @(
	$providerEnvironmentVariables | Where-Object {
		$value = [Environment]::GetEnvironmentVariable($_)
		-not [string]::IsNullOrWhiteSpace($value)
	}
)
$modelsFile = Join-Path $env:USERPROFILE ".pi\agent\models.json"
$configuredCustomProviders = @()
if (Test-Path -LiteralPath $modelsFile -PathType Leaf) {
	try {
		$modelsConfig = Get-Content -Raw -LiteralPath $modelsFile | ConvertFrom-Json
		$configuredCustomProviders = @(
			$modelsConfig.providers.PSObject.Properties |
				Where-Object { $_.Value.models -and @($_.Value.models).Count -gt 0 } |
				ForEach-Object { $_.Name }
		)
	} catch {
		throw "Pi models file is not valid JSON: $modelsFile"
	}
}
$previousErrorActionPreference = $ErrorActionPreference
try {
	# Poppler writes its help text to stderr, which PowerShell 5.1 otherwise treats as an error.
	$ErrorActionPreference = "Continue"
	$pdftotextHelp = & pdftotext -h 2>&1 | Out-String
} finally {
	$ErrorActionPreference = $previousErrorActionPreference
}
if ($pdftotextHelp -notmatch "-tsv") {
	throw "pdftotext is installed but does not support the required -tsv option"
}

Write-Host "paper-agent local environment is ready." -ForegroundColor Green
Write-Host "Project: $($PaperAgentEnvironment.ProjectRoot)"
Write-Host "Node.js: $nodeVersion ($($PaperAgentEnvironment.NodeExe))"
Write-Host "Pi: $piVersion (project-local)"
if ($configuredProviders.Count -gt 0) {
	Write-Host "Pi authentication: configured providers: $($configuredProviders -join ', ')" -ForegroundColor Green
} elseif ($configuredEnvironmentProviders.Count -gt 0) {
	Write-Host "Pi authentication: configured through environment: $($configuredEnvironmentProviders -join ', ')" -ForegroundColor Green
} elseif ($configuredCustomProviders.Count -gt 0) {
	Write-Host "Pi custom model providers: $($configuredCustomProviders -join ', ')" -ForegroundColor Green
} else {
	Write-Warning "Pi has no model provider credentials. Start Pi and run /login before using agent features."
}
$commands | Format-Table -AutoSize
