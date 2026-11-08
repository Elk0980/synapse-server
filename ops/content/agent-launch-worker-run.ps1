# №194: запускатель обработчика очереди Codex для автозапуска Windows.
# Читает приватный JSON с переменными окружения, запускает node agent-launch-local-worker.js
# и перезапускает его после сбоя с нарастающей паузой. Сигнал «в сети» шлёт сам обработчик.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$ConfigPath)
$ErrorActionPreference = 'Stop'

$logDir = Join-Path $env:LOCALAPPDATA 'Synapse\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'agent-worker.log'
function Write-Log([string]$text) {
  $line = '{0} {1}' -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $text
  Add-Content -LiteralPath $log -Value $line -Encoding UTF8
  # Журнал не растёт бесконечно: оставляем последние ~2000 строк.
  if ((Get-Item -LiteralPath $log).Length -gt 512KB) {
    $tail = Get-Content -LiteralPath $log -Tail 2000 -Encoding UTF8
    Set-Content -LiteralPath $log -Value $tail -Encoding UTF8
  }
}

# Только известные переменные; значения в журнал не пишутся.
$allowed = @('TASKS_MCP_ENDPOINT', 'TASKS_AGENT_REPO', 'TASKS_AGENT_WORKTREE_DIR', 'TASKS_AGENT_STATE_DIR',
  'TASKS_AGENT_CODEX_BIN', 'TASKS_AGENT_WINDOWS_SANDBOX', 'CODEX_HOME', 'GH_CONFIG_DIR', 'NODE_EXE')
$config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($property in $config.PSObject.Properties) {
  if ($allowed -notcontains $property.Name) { Write-Log "CONFIG_KEY_REJECTED $($property.Name)"; exit 2 }
  if ($property.Name -ne 'NODE_EXE') { Set-Item -Path "Env:$($property.Name)" -Value ([string]$property.Value) }
}
foreach ($required in @('TASKS_MCP_ENDPOINT', 'TASKS_AGENT_REPO', 'TASKS_AGENT_WORKTREE_DIR', 'TASKS_AGENT_STATE_DIR')) {
  if (-not (Get-Item -Path "Env:$required" -ErrorAction SilentlyContinue)) { Write-Log "CONFIG_MISSING $required"; exit 2 }
}
$node = if ($config.NODE_EXE) { [string]$config.NODE_EXE } else { (Get-Command node -ErrorAction Stop).Source }
$worker = Join-Path $env:TASKS_AGENT_REPO 'ops\content\agent-launch-local-worker.js'
if (-not (Test-Path -LiteralPath $worker -PathType Leaf)) { Write-Log 'WORKER_NOT_FOUND'; exit 2 }

# Node пишет UTF-8: без этого русский текст в журнале превращается в кракозябры.
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$delay = 30
while ($true) {
  Write-Log 'WORKER_START'
  $started = Get-Date
  $duplicate = $false
  # В Windows PowerShell 5.1 каждая строка stderr становится ErrorRecord; при Stop это
  # оборвало бы запускатель. На время работы обработчика ошибки только пишутся в журнал.
  $ErrorActionPreference = 'Continue'
  # stdout/stderr обработчика содержат только коды состояния, без секретов и текстов задач.
  & $node $worker 2>&1 | ForEach-Object {
    $text = [string]$_
    if ($text -match 'WORKER_ALREADY_RUNNING') { $duplicate = $true }
    Write-Log $text
  }
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Write-Log "WORKER_EXIT $code"
  if ($duplicate) {
    # Обработчик уже работает в другом процессе. Не выходим насовсем: если тот упадёт,
    # этот запускатель через 5 минут поднимет обработчик снова.
    $delay = 300
  } elseif (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 30 } else { $delay = [Math]::Min($delay * 2, 300) }
  Write-Log "RESTART_IN ${delay}s"
  Start-Sleep -Seconds $delay
}
