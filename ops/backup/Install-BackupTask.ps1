param(
  [Parameter(Mandatory=$true)][string]$Python,
  [Parameter(Mandatory=$true)][string]$Config,
  [string]$Script = "$PSScriptRoot\backup_v2.py"
)
$ErrorActionPreference = 'Stop'
# Подготовка задачи; запуск установщика только после приёмки Claude и ключа Влада.
foreach ($p in @($Python,$Config,$Script)) {
  if (!(Test-Path -LiteralPath $p -PathType Leaf)) { throw "Нет файла: $p" }
  if ($p.Contains('"')) { throw 'Недопустимая кавычка в пути' }
}
$action = New-ScheduledTaskAction -Execute $Python -Argument ('"{0}" pull "{1}"' -f $Script,$Config)
$daily = New-ScheduledTaskTrigger -Daily -At '04:30'
$logon = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 6) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'SynapseBackupToD' -Action $action -Trigger @($daily,$logon) -Settings $settings -Principal $principal -Description 'Загрузка зашифрованной копии; StartWhenAvailable; без открытого чата' | Out-Null
