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

$delay = 30
while ($true) {
  Write-Log 'WORKER_START'
  $started = Get-Date
  # stdout обработчика содержит только коды состояния, без секретов и текстов задач.
  & $node $worker 2>&1 | ForEach-Object { Write-Log ([string]$_) }
  $code = $LASTEXITCODE
  Write-Log "WORKER_EXIT $code"
  # Второй экземпляр не нужен: обработчик уже работает в другом процессе.
  if ((Get-Content -LiteralPath $log -Tail 3 -Encoding UTF8) -match 'WORKER_ALREADY_RUNNING') { Write-Log 'STOP_DUPLICATE'; exit 0 }
  if (((Get-Date) - $started).TotalMinutes -gt 10) { $delay = 30 } else { $delay = [Math]::Min($delay * 2, 300) }
  Write-Log "RESTART_IN ${delay}s"
  Start-Sleep -Seconds $delay
}
