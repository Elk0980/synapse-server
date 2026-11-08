# №194: автозапуск локального обработчика очереди Codex при входе в Windows.
# Ставит задачу планировщика для текущего пользователя, без прав администратора.
# Секретный адрес MCP не попадает в аргументы задачи: он лежит в приватном файле настроек.
#
# Установка:   powershell -NoProfile -ExecutionPolicy Bypass -File ops\content\agent-launch-worker-autostart.ps1
# Удаление:    powershell -NoProfile -ExecutionPolicy Bypass -File ops\content\agent-launch-worker-autostart.ps1 -Uninstall
# Проверка:    powershell -NoProfile -ExecutionPolicy Bypass -File ops\content\agent-launch-worker-autostart.ps1 -Status
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Status,
  [string]$ConfigPath = (Join-Path $env:LOCALAPPDATA 'Synapse\agent-worker.json'),
  [string]$TaskName = 'Synapse - обработчик Codex'
)
$ErrorActionPreference = 'Stop'

if ($Status) {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if (-not $task) { Write-Output 'Автозапуск не установлен.'; exit 1 }
  $info = Get-ScheduledTaskInfo -TaskName $TaskName
  Write-Output ("Задача: {0}; состояние: {1}; последний запуск: {2}; код: {3}" -f $TaskName, $task.State, $info.LastRunTime, $info.LastTaskResult)
  exit 0
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output 'Автозапуск удалён. Файл настроек не тронут.'
  } else { Write-Output 'Автозапуск не был установлен.' }
  exit 0
}

$runner = Join-Path $PSScriptRoot 'agent-launch-worker-run.ps1'
if (-not (Test-Path -LiteralPath $runner -PathType Leaf)) { throw 'Не найден agent-launch-worker-run.ps1 рядом с установщиком.' }
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "Нет файла настроек $ConfigPath. Создайте его по образцу из ops/tasks-mcp/AGENT_LAUNCH.md (раздел «Автозапуск»)."
}
# Файл настроек содержит секретный адрес: доступ только у текущего пользователя.
$acl = Get-Acl -LiteralPath $ConfigPath
$me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$foreign = $acl.Access | Where-Object {
  if ($_.AccessControlType -ne 'Allow') { return $false }
  try { $sid = $_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { return $true }
  # Владелец, SYSTEM и локальные администраторы допустимы; остальные — нет.
  $sid -notin @($me.Value, 'S-1-5-18', 'S-1-5-32-544')
}
if ($foreign) {
  throw "Файл $ConfigPath доступен другим пользователям. Ограничьте доступ: icacls `"$ConfigPath`" /inheritance:r /grant:r `"$($env:USERNAME):F`""
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$runner`" -ConfigPath `"$ConfigPath`""
$action = New-ScheduledTaskAction -Execute $powershell -Argument $arguments -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Synapse №194: локальный обработчик очереди Codex (agent-launch-local-worker.js) с сигналом «в сети» раз в минуту.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Автозапуск установлен и запущен: $TaskName."
Write-Output 'Готово, когда на доске (Задачи → Агенты) видно «Обработчик Codex: в сети» — обычно в течение 1–2 минут.'
