param([Parameter(Mandatory = $true)][string]$Origin, [switch]$Restart)
$ErrorActionPreference = 'Stop'
# Same rule as PREVIEW_ORIGIN_PATTERN in phone-preview-environment.mjs: Quick Tunnel or the fixed workers.dev entry.
$previewOriginPattern = '^https://((?!api\.)[a-z0-9-]+\.trycloudflare\.com|[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)$'
if ($Origin -notmatch $previewOriginPattern) {
  throw 'An issued Cloudflare preview origin is required.'
}
$previewRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $previewRoot 'OPERATIONS/native-runtime/resolve-node-runtime.ps1')
$runtime = Resolve-ClassHubNodeRuntime
Set-Location -LiteralPath $previewRoot
$previewDir = Join-Path $previewRoot '.local-runtime/preview-api'
$previewEnvironmentArguments = @()
foreach ($environmentFile in @('.env', '.env.local', '.env.admin.local')) {
  if ($environmentFile -eq '.env.local' -or (Test-Path -LiteralPath (Join-Path $previewRoot $environmentFile))) {
    $previewEnvironmentArguments += "--env-file=$environmentFile"
  }
}
$null = & $runtime.executable @previewEnvironmentArguments `
  scripts/start-phone-preview-process.mjs $Origin $previewDir --check
if ($LASTEXITCODE -ne 0) { throw 'Public preview configuration is unsafe; preserving the existing process.' }
$listeners = @(Get-NetTCPConnection -LocalPort 3301 -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -gt 0) {
  if (-not $Restart) { throw 'Phone preview port 3301 is already occupied.' }
  $savedState = Get-Content -Raw -Encoding UTF8 (Join-Path $previewDir 'processes.json') | ConvertFrom-Json
  $ownedApi = Get-CimInstance Win32_Process -Filter "ProcessId=$($savedState.apiPid)"
  if ($listeners.Count -ne 1 -or $listeners[0].OwningProcess -ne $savedState.apiPid -or
      $ownedApi.Name -ne 'node.exe' -or
      $ownedApi.CommandLine -notlike '*scripts/phone-preview-server.mjs*' -or
      $savedState.origin -notmatch $previewOriginPattern -or
      $ownedApi.CommandLine -notlike "*$($savedState.origin)*" -or
      ($savedState.apiStartedAt -and [Math]::Abs(($ownedApi.CreationDate.ToUniversalTime() - [DateTime]::Parse($savedState.apiStartedAt).ToUniversalTime()).TotalMilliseconds) -gt 2)) {
    throw 'The listener does not match the recorded phone-preview process; refusing to stop it.'
  }
  Stop-Process -Id $savedState.apiPid
  Wait-Process -Id $savedState.apiPid -Timeout 10 -ErrorAction SilentlyContinue
}
# Normalize duplicate PATH/Path names in this shell only; leave Windows settings unchanged.
$previewPathValue = [Environment]::GetEnvironmentVariable('Path', 'Process')
[Environment]::SetEnvironmentVariable('PATH', $null, 'Process')
[Environment]::SetEnvironmentVariable('Path', $previewPathValue, 'Process')
New-Item -ItemType Directory -Path $previewDir -Force | Out-Null
$launchResult = & $runtime.executable @previewEnvironmentArguments `
  scripts/start-phone-preview-process.mjs $Origin $previewDir
if ($LASTEXITCODE -ne 0) { throw 'Restricted public preview process could not be started.' }
$launchState = $launchResult | ConvertFrom-Json
$apiProcess = Get-Process -Id $launchState.apiPid -ErrorAction Stop
$statePath = Join-Path $previewDir 'processes.json'
$state = if (Test-Path -LiteralPath $statePath) {
  Get-Content -Raw -Encoding UTF8 -LiteralPath $statePath | ConvertFrom-Json
} else { [PSCustomObject]@{} }
$state | Add-Member -NotePropertyName apiPid -NotePropertyValue $apiProcess.Id -Force
$state | Add-Member -NotePropertyName apiStartedAt -NotePropertyValue $apiProcess.StartTime.ToUniversalTime().ToString('o') -Force
$state | Add-Member -NotePropertyName origin -NotePropertyValue $Origin -Force
$state | Add-Member -NotePropertyName originPort -NotePropertyValue 3301 -Force
$state | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 -LiteralPath $statePath
# A started process can still die during boot (2026-10-03: a stripped env flag made it refuse to start),
# so wait for /readyz. Otherwise recover-preview reports success and the watchdog logs a failed
# recovery as completed (T-WATCHDOG-PREVIEW-RETRY). Normal boot takes about 6 seconds.
$readyDeadline = (Get-Date).AddSeconds(90)
$previewReady = $false
while ((Get-Date) -lt $readyDeadline) {
  if (-not (Get-Process -Id $apiProcess.Id -ErrorAction SilentlyContinue)) { break }
  try { $previewReady = (Invoke-RestMethod -Uri 'http://127.0.0.1:3301/readyz' -TimeoutSec 3).status -eq 'ready' } catch { }
  if ($previewReady) { break }
  Start-Sleep -Milliseconds 500
}
if (-not $previewReady) { throw 'Phone preview API did not become ready; see .local-runtime/preview-api/api.stderr.log.' }
@{ apiPid = $apiProcess.Id; origin = $Origin } | ConvertTo-Json
