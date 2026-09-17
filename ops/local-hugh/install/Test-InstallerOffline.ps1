<#
.SYNOPSIS
  Офлайн-проверка установщика и запускателя без установки, без планировщика и без секретов.

.DESCRIPTION
  Запуск: powershell.exe -NoProfile -ExecutionPolicy Bypass -File ops\local-hugh\install\Test-InstallerOffline.ps1
  Что проверяется:
    1. Install-SynapseHugh.ps1 разбирается парсером PowerShell без ошибок;
    2. SynapseHughLauncher.cs компилируется в WinExe в отдельный каталог ops\local-hugh\test-output;
    3. запускатель: код выхода node.exe возвращается как есть, пути с пробелами передаются
       корректно, второй экземпляр выходит с 0, при завершении запускателя node.exe закрывается;
    4. запасной VBS-запускатель возвращает код выхода (если wscript доступен);
    5. Assert-InsideRoot/Remove-Managed из установщика удаляют только внутри корня (корень
       и внешние пути — отказ), функции берутся из AST установщика;
    6. параметры задачи планировщика собираются как объекты (ExecutionTimeLimit PT0S, перезапуск,
       батарея, один экземпляр, Interactive/Limited) — без Register-ScheduledTask.
  Любое рекурсивное удаление выполняется только после проверки, что путь лежит внутри test-output.
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string] $NodeExe = 'C:\Program Files\nodejs\node.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$InstallDir = $PSScriptRoot
$LocalHugh = (Resolve-Path (Join-Path $InstallDir '..')).Path
$Installer = Join-Path $InstallDir 'Install-SynapseHugh.ps1'
$LauncherSource = Join-Path $InstallDir 'SynapseHughLauncher.cs'
$LauncherVbs = Join-Path $InstallDir 'SynapseHughLauncher.vbs'
$TestOutputRoot = Join-Path $LocalHugh 'test-output'
$Run = Join-Path $TestOutputRoot ("run-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
$script:Failures = 0
$script:Passed = 0

function Check([bool] $Condition, [string] $Message) {
  if ($Condition) { $script:Passed++; Write-Host "  ok   $Message" }
  else { $script:Failures++; Write-Host "  FAIL $Message" -ForegroundColor Red }
}

function Assert-InsideTestOutput([string] $Path) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $root = [System.IO.Path]::GetFullPath($TestOutputRoot).TrimEnd('\')
  if (-not $full.StartsWith($root + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Отказ: $full вне $root"
  }
}

function Remove-TestPath([string] $Path) {
  Assert-InsideTestOutput $Path
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Wait-ProcessExit([System.Diagnostics.Process] $Process, [int] $Seconds) {
  return $Process.WaitForExit($Seconds * 1000)
}

New-Item -ItemType Directory -Force -Path $Run | Out-Null
Assert-InsideTestOutput $Run
$launchedPids = [System.Collections.Generic.List[int]]::new()

# Уборка выполняется при любом исходе: прерванный прогон не оставляет процессов и артефактов.
try {

# ---------------------------------------------------------------------------------------
Write-Host '== 1. Парсер установщика'
# Windows PowerShell 5.1 читает .ps1 без BOM в ANSI: кириллица в строках ломает разбор.
foreach ($script in @($Installer, $PSCommandPath)) {
  $head = [System.IO.File]::ReadAllBytes($script)[0..2]
  Check ($head[0] -eq 0xEF -and $head[1] -eq 0xBB -and $head[2] -eq 0xBF) "UTF-8 BOM: $(Split-Path -Leaf $script)"
}
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref] $tokens, [ref] $errors)
Check ($errors.Count -eq 0) "Install-SynapseHugh.ps1: ошибок разбора $($errors.Count)"
foreach ($e in $errors) { Write-Host "       $($e.Extent.StartLineNumber): $($e.Message)" }
$selfErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile($PSCommandPath, [ref] $tokens, [ref] $selfErrors) | Out-Null
Check ($selfErrors.Count -eq 0) 'Test-InstallerOffline.ps1 разбирается'

# Функции установщика для изолированной проверки: берём из AST, а не выполняем весь файл.
$functions = @{}
foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $true)) {
  $functions[$node.Name] = $node.Extent.Text
}
Check ($functions.ContainsKey('Assert-InsideRoot') -and $functions.ContainsKey('Remove-Managed')) 'в установщике есть Assert-InsideRoot и Remove-Managed'
$dangerous = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Remove-Item' }, $true)
$unguarded = @($dangerous | Where-Object {
  $text = $_.Extent.Text
  -not ($text -match '-LiteralPath \$Path' -or $text -match '-LiteralPath \$bundled' -or $text -match '-LiteralPath \$proof')
})
Check ($unguarded.Count -eq 0) "Remove-Item вне Remove-Managed только для файлов bundled/proof (незащищённых: $($unguarded.Count))"
$registers = $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Register-ScheduledTask' }, $true)
Check ($registers.Count -eq 1) 'Register-ScheduledTask встречается ровно один раз (под -SkipTask)'
# Правило среды: любой фоновый helper запускается скрыто — -WindowStyle Hidden, без -NoNewWindow.
$starts = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] -and $n.GetCommandName() -eq 'Start-Process' }, $true))
$visible = @($starts | Where-Object {
  $names = @($_.CommandElements | Where-Object { $_ -is [System.Management.Automation.Language.CommandParameterAst] } | ForEach-Object { $_.ParameterName })
  ($names -contains 'NoNewWindow') -or -not ($names -contains 'WindowStyle')
})
Check ($starts.Count -ge 1 -and $visible.Count -eq 0) "Start-Process в установщике только с -WindowStyle (всего $($starts.Count), без скрытия: $($visible.Count))"
$hiddenValues = @($starts | ForEach-Object {
  $elements = $_.CommandElements
  for ($i = 0; $i -lt $elements.Count; $i++) {
    if ($elements[$i] -is [System.Management.Automation.Language.CommandParameterAst] -and $elements[$i].ParameterName -eq 'WindowStyle' -and $i + 1 -lt $elements.Count) { $elements[$i + 1].Extent.Text }
  }
})
Check (@($hiddenValues | Where-Object { $_ -ne 'Hidden' }).Count -eq 0) '-WindowStyle везде равен Hidden'
# Запускатель: node.exe стартует без окна (CreateNoWindow) и со скрытым стилем окна.
$launcherText = Get-Content -LiteralPath $LauncherSource -Raw
Check ($launcherText -match 'CreateNoWindow\s*=\s*true') 'SynapseHughLauncher.cs: CreateNoWindow = true'
Check ($launcherText -match 'ProcessWindowStyle\.Hidden') 'SynapseHughLauncher.cs: ProcessWindowStyle.Hidden'
Check ($launcherText -match 'UseShellExecute\s*=\s*false') 'SynapseHughLauncher.cs: UseShellExecute = false'
$vbsText = Get-Content -LiteralPath $LauncherVbs -Raw
Check ($vbsText -match 'shell\.Run\(command,\s*0,\s*True\)') 'SynapseHughLauncher.vbs: Run(..., 0, True) — скрытое окно, ожидание'

# ---------------------------------------------------------------------------------------
Write-Host '== 2. Компиляция запускателя'
$launcherExe = Join-Path $Run 'SynapseHughLauncher.exe'
$compiled = $false
try {
  Add-Type -TypeDefinition (Get-Content -LiteralPath $LauncherSource -Raw) -OutputAssembly $launcherExe -OutputType WindowsApplication -ReferencedAssemblies 'System.dll' -ErrorAction Stop
  $compiled = Test-Path -LiteralPath $launcherExe
} catch {
  Write-Host "       $($_.Exception.Message)"
}
Check $compiled 'SynapseHughLauncher.exe собран Add-Type -OutputType WindowsApplication'
if ($compiled) {
  $bytes = [System.IO.File]::ReadAllBytes($launcherExe)
  $peOffset = [System.BitConverter]::ToInt32($bytes, 0x3C)
  $subsystem = [System.BitConverter]::ToInt16($bytes, $peOffset + 4 + 20 + 68)
  Check ($subsystem -eq 2) "PE Subsystem = $subsystem (2 = WINDOWS_GUI, без консольного окна)"
}

# ---------------------------------------------------------------------------------------
Write-Host '== 3. Поведение запускателя'
$nodeOk = Test-Path -LiteralPath $NodeExe
Check $nodeOk "Node найден: $NodeExe"
if ($compiled -and $nodeOk) {
  # Каталог с пробелом и кавычек в пути быть не может, но пробел — обязательная проверка.
  $spaced = Join-Path $Run 'dir with space'
  New-Item -ItemType Directory -Force -Path $spaced | Out-Null
  $exitScript = Join-Path $spaced 'exit.js'
  $config = Join-Path $spaced 'config.json'
  [System.IO.File]::WriteAllText($exitScript, "const fs=require('fs');fs.writeFileSync(process.argv[2]+'.seen', JSON.stringify({argv:process.argv.slice(2), cwd:process.cwd()}));process.exit(7);")
  [System.IO.File]::WriteAllText($config, '{}')
  # Все фоновые запуски здесь скрытые (-WindowStyle Hidden), как требует правило среды.
  $p = Start-Process -FilePath $launcherExe -ArgumentList @("`"$NodeExe`"", "`"$exitScript`"", "`"$config`"") -WindowStyle Hidden -PassThru -Wait
  Check ($p.ExitCode -eq 7) "код выхода node (7) возвращён планировщику: $($p.ExitCode)"
  $seen = Get-Content -LiteralPath "$config.seen" -Raw | ConvertFrom-Json
  Check ($seen.argv[0] -eq $config) 'путь конфигурации с пробелом дошёл до main.js без искажений'
  Check ($seen.cwd -eq $spaced) 'рабочий каталог — каталог config.json'
  $missing = Start-Process -FilePath $launcherExe -ArgumentList @("`"$NodeExe`"", "`"$(Join-Path $spaced 'absent.js')`"", "`"$config`"") -WindowStyle Hidden -PassThru -Wait
  Check ($missing.ExitCode -eq 3) "отсутствующий main.js → код 3: $($missing.ExitCode)"
  $noArgs = Start-Process -FilePath $launcherExe -WindowStyle Hidden -PassThru -Wait
  Check ($noArgs.ExitCode -eq 2) "без аргументов → код 2: $($noArgs.ExitCode)"

  # Один экземпляр и завершение потомка вместе с запускателем.
  $sleepScript = Join-Path $Run 'sleep.js'
  $sleepConfig = Join-Path $Run 'sleep-config.json'
  $pidFile = "$sleepConfig.pid"
  [System.IO.File]::WriteAllText($sleepConfig, '{}')
  # main.js получает путь конфигурации третьим аргументом; PID пишется рядом с ней.
  [System.IO.File]::WriteAllText($sleepScript, "require('fs').writeFileSync(process.argv[2] + '.pid', String(process.pid));setTimeout(()=>{}, 60000);")
  $long = Start-Process -FilePath $launcherExe -ArgumentList @("`"$NodeExe`"", "`"$sleepScript`"", "`"$sleepConfig`"") -WindowStyle Hidden -PassThru
  $launchedPids.Add($long.Id)
  $childPid = 0
  for ($i = 0; $i -lt 50 -and $childPid -eq 0; $i++) {
    Start-Sleep -Milliseconds 100
    if (Test-Path -LiteralPath $pidFile) { [int]::TryParse((Get-Content -LiteralPath $pidFile -Raw), [ref] $childPid) | Out-Null }
  }
  Check ($childPid -gt 0) "node.exe запущен запускателем (PID $childPid)"
  if ($childPid -gt 0) { $launchedPids.Add($childPid) }
  $second = Start-Process -FilePath $launcherExe -ArgumentList @("`"$NodeExe`"", "`"$sleepScript`"", "`"$sleepConfig`"") -WindowStyle Hidden -PassThru
  $secondExited = Wait-ProcessExit $second 5
  Check ($secondExited -and $second.ExitCode -eq 0) "второй экземпляр вышел сразу с кодом 0 (mutex): exited=$secondExited code=$($second.ExitCode)"
  Check (-not $long.HasExited) 'первый экземпляр продолжает работать'
  if (-not $long.HasExited) { Stop-Process -Id $long.Id -Force }
  Start-Sleep -Milliseconds 800
  $childAlive = $null -ne (Get-Process -Id $childPid -ErrorAction SilentlyContinue)
  Check (-not $childAlive) 'после завершения запускателя node.exe закрыт (Job Object kill-on-close)'
  if ($childAlive) { Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------------------------------
Write-Host '== 4. Запасной VBS-запускатель'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
if ((Test-Path -LiteralPath $wscript) -and $nodeOk) {
  $exitScript2 = Join-Path $Run 'exit2.js'
  [System.IO.File]::WriteAllText($exitScript2, 'process.exit(5);')
  $vbs = Start-Process -FilePath $wscript -ArgumentList @('//B', '//Nologo', "`"$LauncherVbs`"", "`"$NodeExe`"", "`"$exitScript2`"", "`"$exitScript2`"") -WindowStyle Hidden -PassThru -Wait
  Check ($vbs.ExitCode -eq 5) "VBS-запускатель вернул код node (5): $($vbs.ExitCode)"
} else {
  Write-Host '  skip wscript.exe недоступен'
}

# ---------------------------------------------------------------------------------------
Write-Host '== 5. Границы удаления установщика (функции из AST)'
$Root = Join-Path $Run 'fake-root'
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'app'), (Join-Path $Run 'outside') | Out-Null
Invoke-Expression $functions['Assert-InsideRoot']
Invoke-Expression $functions['Remove-Managed']
Remove-Managed (Join-Path $Root 'app')
Check (-not (Test-Path -LiteralPath (Join-Path $Root 'app'))) 'Remove-Managed удаляет подкаталог внутри корня'
$refused = $false
try { Remove-Managed (Join-Path $Run 'outside') } catch { $refused = $true }
Check ($refused -and (Test-Path -LiteralPath (Join-Path $Run 'outside'))) 'путь вне корня — отказ, ничего не удалено'
$refusedRoot = $false
try { Remove-Managed $Root } catch { $refusedRoot = $true }
Check ($refusedRoot -and (Test-Path -LiteralPath $Root)) 'сам корень — отказ'
$refusedDots = $false
try { Remove-Managed (Join-Path $Root '..\outside') } catch { $refusedDots = $true }
Check ($refusedDots -and (Test-Path -LiteralPath (Join-Path $Run 'outside'))) 'обход через .. — отказ'
$refusedPrefix = $false
try { Remove-Managed "$Root-suffix" } catch { $refusedPrefix = $true }
Check $refusedPrefix 'похожий префикс каталога (root-suffix) — отказ'

# ---------------------------------------------------------------------------------------
Write-Host '== 6. Параметры задачи планировщика (объекты, без регистрации)'
try {
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -Hidden
  Check ($settings.ExecutionTimeLimit -eq 'PT0S') "ExecutionTimeLimit = $($settings.ExecutionTimeLimit) (PT0S — без предела 72 ч)"
  Check ($settings.RestartCount -eq 999) "RestartCount = $($settings.RestartCount)"
  Check ($settings.RestartInterval -eq 'PT1M') "RestartInterval = $($settings.RestartInterval)"
  Check ($settings.MultipleInstances -eq 'IgnoreNew') "MultipleInstances = $($settings.MultipleInstances)"
  Check ($settings.StartWhenAvailable -eq $true) 'StartWhenAvailable'
  Check ($settings.DisallowStartIfOnBatteries -eq $false) 'запуск на батарее разрешён'
  Check ($settings.StopIfGoingOnBatteries -eq $false) 'переход на батарею не останавливает'
  Check ($settings.Hidden -eq $true) 'Hidden'
  $principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Check ($principal.LogonType -eq 'Interactive') "LogonType = $($principal.LogonType)"
  Check ($principal.RunLevel -eq 'Limited') "RunLevel = $($principal.RunLevel)"
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
  Check ($trigger.CimClass.CimClassName -eq 'MSFT_TaskLogonTrigger') "триггер при входе: $($trigger.CimClass.CimClassName)"
  $registered = Get-ScheduledTask -TaskName 'SynapseHughWorker' -ErrorAction SilentlyContinue
  Check ($null -eq $registered) 'задача SynapseHughWorker НЕ зарегистрирована этой проверкой'
} catch {
  Check $false "модуль ScheduledTasks: $($_.Exception.Message)"
}

# ---------------------------------------------------------------------------------------
} finally {
  foreach ($launched in $launchedPids) {
    if (Get-Process -Id $launched -ErrorAction SilentlyContinue) { Stop-Process -Id $launched -Force -ErrorAction SilentlyContinue }
  }
  Start-Sleep -Milliseconds 300
  try {
    Remove-TestPath $Run
    # Пустой корень test-output убирается нерекурсивно и только по точному ожидаемому пути.
    $rootFull = [System.IO.Path]::GetFullPath($TestOutputRoot).TrimEnd('\')
    $expectedRoot = [System.IO.Path]::GetFullPath((Join-Path $LocalHugh 'test-output')).TrimEnd('\')
    if ($rootFull -eq $expectedRoot -and (Test-Path -LiteralPath $rootFull) -and
        -not (Get-ChildItem -LiteralPath $rootFull -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
      Remove-Item -LiteralPath $rootFull -Force
    }
  } catch {
    Write-Host "  предупреждение: артефакты не убраны ($($_.Exception.Message)): $Run"
  }
}

Write-Host ''
Write-Host "Итог: ok=$script:Passed fail=$script:Failures"
if ($script:Failures -gt 0) { exit 1 }
exit 0
