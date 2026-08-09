[CmdletBinding()]
param(
	[Parameter(Position = 0)]
	[ValidateSet("demo", "status", "stop")]
	[string]$Action = "demo",

	[switch]$NoLaunch,

	[switch]$Agent,

	[switch]$NoOpen
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "local-environment.ps1")

$demoRoot = if ($env:PAPER_AGENT_TEAM_DEMO_ROOT) {
	[IO.Path]::GetFullPath($env:PAPER_AGENT_TEAM_DEMO_ROOT)
} else {
	Join-Path $env:LOCALAPPDATA "paper-agent\team-demo"
}
$stateFile = Join-Path $demoRoot "state.json"
$authFile = Join-Path $demoRoot "auth.json"
$tokenFile = Join-Path $demoRoot "token.txt"
$dataRoot = Join-Path $demoRoot "corpus"
$backupRoot = Join-Path $demoRoot "backups"
$stdoutFile = Join-Path $demoRoot "server.out.log"
$stderrFile = Join-Path $demoRoot "server.err.log"
$serverScript = Join-Path $PaperAgentEnvironment.ProjectRoot "scripts\team-corpus-server.ts"

function Read-DemoState {
	if (-not (Test-Path -LiteralPath $stateFile -PathType Leaf)) { return $null }
	return Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
}

function Test-DemoHealth([int]$Port) {
	try {
		$response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2
		return $response.StatusCode -eq 200
	} catch { return $false }
}

function Test-DemoProcess($State) {
	if (-not $State) { return $false }
	$process = Get-Process -Id $State.pid -ErrorAction SilentlyContinue
	if (-not $process -or $process.ProcessName -notmatch '^node') { return $false }
	if ($State.startTimeUtcTicks -and $process.StartTime.ToUniversalTime().Ticks -ne [long]$State.startTimeUtcTicks) {
		return $false
	}
	$processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $($State.pid)" -ErrorAction SilentlyContinue
	return [bool]($processInfo -and $processInfo.CommandLine -like "*team-corpus-server.ts*")
}

function Show-DemoStatus {
	$state = Read-DemoState
	if (-not $state) {
		Write-Host "Team demo is not initialized."
		return
	}
	$process = if (Test-DemoProcess $state) { Get-Process -Id $state.pid -ErrorAction SilentlyContinue } else { $null }
	$healthy = Test-DemoHealth ([int]$state.port)
	Write-Host "Team demo status" -ForegroundColor Cyan
	Write-Host "Running: $([bool]$process)"
	Write-Host "Healthy: $healthy"
	Write-Host "URL: http://127.0.0.1:$($state.port)"
	Write-Host "Data: $dataRoot"
}

function Stop-Demo {
	$state = Read-DemoState
	if (-not $state) {
		Write-Host "Team demo is not running."
		return
	}
	$process = Get-Process -Id $state.pid -ErrorAction SilentlyContinue
	if ($process) {
		if (-not (Test-DemoProcess $state)) {
			throw "Refusing to stop PID $($state.pid) because it is not the Paper Agent team demo server."
		}
		Stop-Process -Id $state.pid
		$process.WaitForExit(5000) | Out-Null
	}
	Remove-Item -LiteralPath $stateFile -Force -ErrorAction SilentlyContinue
	Write-Host "Team demo stopped. Demo data was kept at $demoRoot" -ForegroundColor Green
}

if ($Action -eq "status") { Show-DemoStatus; return }
if ($Action -eq "stop") { Stop-Demo; return }

New-Item -ItemType Directory -Force -Path $demoRoot, $dataRoot, $backupRoot | Out-Null
& icacls.exe $demoRoot /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)(F)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Unable to restrict access to $demoRoot" }
$state = Read-DemoState
if ((Test-DemoProcess $state) -and (Test-DemoHealth ([int]$state.port))) {
	$port = [int]$state.port
} else {
	$port = 4317
	$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $port)
	try {
		$listener.Start()
	} catch {
		$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
		$listener.Start()
		$port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
	} finally {
		$listener.Stop()
	}

	$tokenBytes = New-Object byte[] 32
	$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
	try { $rng.GetBytes($tokenBytes) } finally { $rng.Dispose() }
	$token = [Convert]::ToBase64String($tokenBytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
	$sha256 = [Security.Cryptography.SHA256]::Create()
	try { $sha = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($token)) } finally { $sha256.Dispose() }
	$tokenHash = ([BitConverter]::ToString($sha) -replace '-', '').ToLowerInvariant()
	$utf8NoBom = New-Object Text.UTF8Encoding($false)
	$authJson = @{ identities = @(@{ name = "solo-demo-admin"; tokenSha256 = $tokenHash; roles = @("admin") }) } |
		ConvertTo-Json -Depth 5
	[IO.File]::WriteAllText($authFile, $authJson, $utf8NoBom)
	[IO.File]::WriteAllText($tokenFile, $token, $utf8NoBom)
	& icacls.exe $authFile /inheritance:r /grant:r "${env:USERNAME}:(F)" | Out-Null
	if ($LASTEXITCODE -ne 0) { throw "Unable to restrict access to $authFile" }
	& icacls.exe $tokenFile /inheritance:r /grant:r "${env:USERNAME}:(F)" | Out-Null
	if ($LASTEXITCODE -ne 0) { throw "Unable to restrict access to $tokenFile" }

	$previous = @{
		Auth = $env:PAPER_AGENT_TEAM_AUTH_FILE
		Root = $env:PAPER_AGENT_TEAM_ROOT
		Backup = $env:PAPER_AGENT_TEAM_BACKUP_ROOT
		HostValue = $env:PAPER_AGENT_TEAM_HOST
		Port = $env:PAPER_AGENT_TEAM_PORT
	}
	try {
		$env:PAPER_AGENT_TEAM_AUTH_FILE = $authFile
		$env:PAPER_AGENT_TEAM_ROOT = $dataRoot
		$env:PAPER_AGENT_TEAM_BACKUP_ROOT = $backupRoot
		$env:PAPER_AGENT_TEAM_HOST = "127.0.0.1"
		$env:PAPER_AGENT_TEAM_PORT = "$port"
		$quotedServerScript = '"' + $serverScript.Replace('"', '\"') + '"'
		$process = Start-Process -FilePath $PaperAgentEnvironment.NodeExe -ArgumentList $quotedServerScript -WorkingDirectory $PaperAgentEnvironment.ProjectRoot -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru
	} finally {
		$env:PAPER_AGENT_TEAM_AUTH_FILE = $previous.Auth
		$env:PAPER_AGENT_TEAM_ROOT = $previous.Root
		$env:PAPER_AGENT_TEAM_BACKUP_ROOT = $previous.Backup
		$env:PAPER_AGENT_TEAM_HOST = $previous.HostValue
		$env:PAPER_AGENT_TEAM_PORT = $previous.Port
	}

	$healthy = $false
	foreach ($attempt in 1..30) {
		Start-Sleep -Milliseconds 200
		if (Test-DemoHealth $port) { $healthy = $true; break }
		if ($process.HasExited) { break }
	}
	if (-not $healthy) {
		if (-not $process.HasExited) { Stop-Process -Id $process.Id }
		$errorText = if (Test-Path -LiteralPath $stderrFile) { Get-Content -LiteralPath $stderrFile -Raw } else { "no server log" }
		throw "Team demo server failed to start: $errorText"
	}
	@{
		pid = $process.Id
		port = $port
		startedAt = (Get-Date).ToString("o")
		startTimeUtcTicks = $process.StartTime.ToUniversalTime().Ticks
	} |
		ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding UTF8
}

$previousClientUrl = $env:PAPER_AGENT_TEAM_SERVER_URL
$previousClientToken = $env:PAPER_AGENT_TEAM_TOKEN
$previousClientNamespace = $env:PAPER_AGENT_TEAM_NAMESPACE
$previousClientDemo = $env:PAPER_AGENT_TEAM_DEMO
try {
	$env:PAPER_AGENT_TEAM_SERVER_URL = "http://127.0.0.1:$port"
	$env:PAPER_AGENT_TEAM_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
	$env:PAPER_AGENT_TEAM_NAMESPACE = "solo-demo"
	$env:PAPER_AGENT_TEAM_DEMO = "1"
	$interfaceName = if ($Agent) { "Pi agent" } else { "Web workspace" }
	Write-Host "Local team demo is ready. Starting the Paper Agent $interfaceName as demo administrator." -ForegroundColor Green
	Write-Host "The service remains local to this computer. Run paper-agent --team stop when finished."
	if ($NoLaunch) {
		Write-Host "Demo service started without a user interface for automated verification."
		return
	}
	if ($Agent) {
		& (Join-Path $PSScriptRoot "start-local.ps1")
	} else {
		$webArguments = @((Join-Path $PaperAgentEnvironment.ProjectRoot "scripts\web-server.ts"), "--port", "0")
		if ($NoOpen) { $webArguments += "--no-open" }
		& $PaperAgentEnvironment.NodeExe @webArguments
	}
	$paperAgentExitCode = $LASTEXITCODE
} finally {
	$env:PAPER_AGENT_TEAM_SERVER_URL = $previousClientUrl
	$env:PAPER_AGENT_TEAM_TOKEN = $previousClientToken
	$env:PAPER_AGENT_TEAM_NAMESPACE = $previousClientNamespace
	$env:PAPER_AGENT_TEAM_DEMO = $previousClientDemo
}
exit $paperAgentExitCode
