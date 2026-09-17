<#
.SYNOPSIS
  Установка и обновление локального обработчика Хью (Synapse) для текущего пользователя Windows.

.DESCRIPTION
  Без прав администратора и без новых паролей Windows. Всё лежит в %LOCALAPPDATA%\SynapseHugh
  с DACL «только владелец и SYSTEM». Что делает:
    1. проверяет Node 24 и официальный закреплённый Codex 0.154.0 (бинарь из -VendorSource);
    2. копирует код worker и рантайма (из этого репозитория) и vendor Codex в устойчивые пути;
    3. собирает доверенный каталог моделей из встроенного набора ЭТОГО бинаря
       (codex debug models --bundled) и прогоняет НАСТОЯЩУЮ проверку изоляции
       (test-support/run-isolation-check.js) — доказательство пишется только при успехе;
    4. генерирует ключ worker (если его ещё нет) и печатает ТОЛЬКО его SHA256 для сервера;
    5. пишет config.json, собирает скрытый запускатель, регистрирует задачу планировщика
       (текущий пользователь, при входе, Interactive/Limited, без ограничения времени,
       перезапуск при сбое, один экземпляр, не зависит от батареи) и запускает её.
  Обновление сохраняет secret\, state\ и codex-home\ (ключ, очередь, вход в подписку).
  Удаляются только подкаталоги app\, vendor\, build\, bin\ внутри корня установки.
  Настольная сессия Codex (%USERPROFILE%\.codex) не читается и не копируется.

.PARAMETER VendorSource
  Каталог vendor\x86_64-pc-windows-msvc официального пакета @openai/codex-win32-x64 0.154.0.
  Например: C:\Users\Vlad\AppData\Local\npm-cache\_npx\4897a91091a83573\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc

.PARAMETER Endpoint
  https://<сервер>/content/project-chat-worker — обязателен при первой установке; при обновлении
  можно не указывать, берётся из существующего config.json.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File ops\local-hugh\install\Install-SynapseHugh.ps1 `
    -VendorSource "C:\Users\Vlad\AppData\Local\npm-cache\_npx\4897a91091a83573\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc" `
    -Endpoint "https://<сервер>/content/project-chat-worker"
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string] $VendorSource,
  [string] $Endpoint,
  [string] $NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string[]] $Companies = @('palitra-love'),
  [string] $Model = 'gpt-5.5',
  [switch] $RegenerateKey,
  [switch] $SkipTask,
  [switch] $NoStart,
  [switch] $ShowKeyHash,
  [switch] $Uninstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'SynapseHughWorker'
$PinnedCodexVersion = '0.154.0'
$RequiredNodeMajor = 24
$Root = Join-Path $env:LOCALAPPDATA 'SynapseHugh'
$RepoOps = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path   # <repo>\ops
$SourceRuntime = Join-Path $RepoOps 'hugh-runtime'
$SourceLocal = Join-Path $RepoOps 'local-hugh'

$Layout = @{
  App       = Join-Path $Root 'app'
  Vendor    = Join-Path $Root 'vendor'
  Build     = Join-Path $Root 'build'
  Bin       = Join-Path $Root 'bin'
  Secret    = Join-Path $Root 'secret'
  State     = Join-Path $Root 'state'
  Logs      = Join-Path $Root 'logs'
  CodexHome = Join-Path $Root 'codex-home'
  Workspace = Join-Path $Root 'workspace'
}
$ConfigPath = Join-Path $Root 'config.json'
$KeyPath = Join-Path $Layout.Secret 'worker.key'
$StatusPath = Join-Path $Layout.State 'status.json'
$LockPath = Join-Path $Layout.State 'worker.lock'
$CodexExe = Join-Path $Layout.Vendor 'x86_64-pc-windows-msvc\bin\codex.exe'
$LauncherExe = Join-Path $Layout.Bin 'SynapseHughLauncher.exe'
$LauncherVbs = Join-Path $Layout.Bin 'SynapseHughLauncher.vbs'

function Write-Step([string] $Message) { Write-Host "==> $Message" }

# Внешние программы под $ErrorActionPreference='Stop' в Windows PowerShell 5.1 роняют скрипт
# на первой же строке stderr. Поэтому они запускаются с 'Continue', а код выхода проверяется явно.
function Invoke-Native([scriptblock] $Block) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Block } finally { $ErrorActionPreference = $previous }
}

function Assert-InsideRoot([string] $Path) {
  # Защита от удаления произвольных путей: удаляем только внутри корня установки, не сам корень.
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\')
  if (-not $full.StartsWith($rootFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Отказ: путь $full вне каталога установки $rootFull"
  }
}

function Remove-Managed([string] $Path) {
  Assert-InsideRoot $Path
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force }
}

function Set-PrivateAcl([string] $Path, [string] $Sid) {
  # Только владелец и SYSTEM; наследование от LocalAppData снято (там есть Администраторы).
  Invoke-Native { & icacls $Path /inheritance:r /grant:r "*${Sid}:(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null }
  if ($LASTEXITCODE -ne 0) { throw "icacls не смог задать права на $Path" }
}

function Reset-ChildAcl([string] $Path) {
  # Дочерние элементы получают ровно унаследованные права корня (включая ключ и состояние).
  Get-ChildItem -LiteralPath $Path -Force | ForEach-Object {
    $child = $_.FullName
    Invoke-Native { & icacls $child /reset /T /C /Q | Out-Null }
  }
}

function Get-KeyHash([string] $Key) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::ASCII.GetBytes($Key)
    return ([System.BitConverter]::ToString($sha.ComputeHash($bytes)) -replace '-', '').ToLowerInvariant()
  } finally { $sha.Dispose() }
}

function New-WorkerKey {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLowerInvariant()
}

function Stop-WorkerTask {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($null -eq $task) { return }
  Write-Step "Останавливаю задачу $TaskName"
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # Ждём выход именно нашего процесса (PID из файла-замка), а не любых node.exe.
  if (Test-Path -LiteralPath $LockPath) {
    [int] $lockPid = 0
    $first = Get-Content -LiteralPath $LockPath -ErrorAction SilentlyContinue | Select-Object -First 1
    if ([int]::TryParse([string] $first, [ref] $lockPid)) {
      for ($i = 0; $i -lt 30 -and $lockPid -gt 0; $i++) {
        if ($null -eq (Get-Process -Id $lockPid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Seconds 1
      }
    }
  }
}

function Test-CodexVersion([string] $Exe) {
  if (-not (Test-Path -LiteralPath $Exe)) { throw "Бинарь Codex не найден: $Exe" }
  $output = Invoke-Native { (& $Exe --version 2>&1 | Out-String).Trim() }
  if ($LASTEXITCODE -ne 0) { throw "codex --version завершился с кодом $LASTEXITCODE" }
  if ($output -ne "codex-cli $PinnedCodexVersion") {
    throw "Ожидалась версия 'codex-cli $PinnedCodexVersion', получено '$output'"
  }
}

function Invoke-Node([string[]] $Arguments) {
  Invoke-Native { & $NodeExe @Arguments }
  if ($LASTEXITCODE -ne 0) { throw "node $($Arguments -join ' ') завершился с кодом $LASTEXITCODE" }
}

# ---------------------------------------------------------------------------------------
# Режимы без установки
# ---------------------------------------------------------------------------------------

if ($Uninstall) {
  Stop-WorkerTask
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Задача $TaskName удалена. Данные в $Root сохранены (ключ, очередь, вход в подписку)."
  } else {
    Write-Host "Задача $TaskName не зарегистрирована."
  }
  exit 0
}

if ($ShowKeyHash) {
  if (-not (Test-Path -LiteralPath $KeyPath)) { throw "Ключ ещё не создан: $KeyPath" }
  $existingKey = (Get-Content -LiteralPath $KeyPath -Raw).Trim()
  Write-Host "HUGH_LOCAL_WORKER_KEY_SHA256=$(Get-KeyHash $existingKey)"
  exit 0
}

# ---------------------------------------------------------------------------------------
# Проверки окружения
# ---------------------------------------------------------------------------------------

$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
$windowsPrincipal = New-Object System.Security.Principal.WindowsPrincipal($identity)
if ($windowsPrincipal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warning 'Скрипт запущен с правами администратора. Они не нужны; задача всё равно регистрируется как Limited.'
}
$sid = $identity.User.Value
$userName = $identity.Name   # DOMAIN\user — для триггера и принципала задачи

if (-not $VendorSource) { throw 'Нужен -VendorSource: каталог vendor\x86_64-pc-windows-msvc официального Codex 0.154.0' }
$VendorSource = (Resolve-Path -LiteralPath $VendorSource).Path
$sourceExe = Join-Path $VendorSource 'bin\codex.exe'
if (-not (Test-Path -LiteralPath $sourceExe)) { throw "В -VendorSource нет bin\codex.exe: $VendorSource" }

Write-Step 'Проверяю Node'
if (-not (Test-Path -LiteralPath $NodeExe)) { throw "Node не найден: $NodeExe" }
$nodeVersion = Invoke-Native { (& $NodeExe --version 2>&1 | Out-String).Trim() }
if ($nodeVersion -notmatch "^v$RequiredNodeMajor\.") { throw "Нужен Node $RequiredNodeMajor, найден '$nodeVersion'" }
Write-Host "    Node $nodeVersion"

Write-Step 'Проверяю исходный бинарь Codex'
Test-CodexVersion $sourceExe
Write-Host "    codex-cli $PinnedCodexVersion"

foreach ($required in @('runtime.js', 'job-store.js', 'limits.js', 'test-support\run-isolation-check.js', 'test-support\build-restricted-catalog.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceRuntime $required))) { throw "В репозитории нет ops\hugh-runtime\$required" }
}
foreach ($required in @('main.js', 'worker.js', 'transport.js', 'outbox.js')) {
  if (-not (Test-Path -LiteralPath (Join-Path $SourceLocal $required))) { throw "В репозитории нет ops\local-hugh\$required" }
}

if (-not $Endpoint) {
  if (Test-Path -LiteralPath $ConfigPath) {
    $existing = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $endpointProperty = $existing.PSObject.Properties['endpoint']
    if ($null -ne $endpointProperty) { $Endpoint = [string] $endpointProperty.Value }
  }
  if (-not $Endpoint) { throw 'Нужен -Endpoint https://<сервер>/content/project-chat-worker (первая установка)' }
}
$endpointUri = [System.Uri] $Endpoint
if ($endpointUri.Scheme -ne 'https') { throw 'Endpoint обязан быть https' }
if ($endpointUri.AbsolutePath.TrimEnd('/') -ne '/content/project-chat-worker') { throw 'Endpoint обязан оканчиваться на /content/project-chat-worker' }
if ($endpointUri.Query -or $endpointUri.Fragment -or $endpointUri.UserInfo) { throw 'Endpoint без параметров, якоря и учётных данных' }
foreach ($company in $Companies) {
  if ($company -notmatch '^[A-Za-z0-9._-]{1,64}$') { throw "Недопустимый код компании: $company" }
}
if ($Model -and $Model -notmatch '^[A-Za-z0-9.-]{1,64}$') { throw "Недопустимый слаг модели: $Model" }

# ---------------------------------------------------------------------------------------
# Каталоги и права
# ---------------------------------------------------------------------------------------

Stop-WorkerTask

Write-Step "Готовлю $Root (права: только владелец и SYSTEM)"
New-Item -ItemType Directory -Force -Path $Root | Out-Null
Set-PrivateAcl $Root $sid
foreach ($dir in $Layout.Values) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

# ---------------------------------------------------------------------------------------
# Код и vendor
# ---------------------------------------------------------------------------------------

Write-Step 'Копирую код worker и рантайма'
Remove-Managed $Layout.App
$appRuntime = Join-Path $Layout.App 'hugh-runtime'
$appLocal = Join-Path $Layout.App 'local-hugh'
New-Item -ItemType Directory -Force -Path (Join-Path $appRuntime 'test-support'), $appLocal | Out-Null
$isSource = { ($_.Name -like '*.js' -and $_.Name -notlike '*.test.js') -or $_.Name -eq 'package.json' }
Get-ChildItem -LiteralPath $SourceRuntime -File | Where-Object $isSource | Copy-Item -Destination $appRuntime
Get-ChildItem -LiteralPath (Join-Path $SourceRuntime 'test-support') -File -Filter '*.js' | Copy-Item -Destination (Join-Path $appRuntime 'test-support')
Get-ChildItem -LiteralPath $SourceLocal -File | Where-Object $isSource | Copy-Item -Destination $appLocal

Write-Step 'Копирую закреплённый vendor Codex в устойчивый путь'
$vendorTarget = Join-Path $Layout.Vendor 'x86_64-pc-windows-msvc'
Remove-Managed $vendorTarget
Copy-Item -LiteralPath $VendorSource -Destination $vendorTarget -Recurse -Force
Test-CodexVersion $CodexExe
Write-Host "    $CodexExe"

# ---------------------------------------------------------------------------------------
# Каталог моделей и настоящее доказательство изоляции
# ---------------------------------------------------------------------------------------

Write-Step 'Собираю доверенный каталог моделей из встроенного набора этого бинаря'
$bootstrap = Join-Path $Layout.Build 'bootstrap'
Remove-Managed $bootstrap
$bootstrapHome = Join-Path $bootstrap 'home'
New-Item -ItemType Directory -Force -Path (Join-Path $bootstrapHome 'AppData\Roaming'), (Join-Path $bootstrapHome 'AppData\Local') | Out-Null
$bundled = Join-Path $Layout.Build 'bundled-models.json'
$catalog = Join-Path $Layout.Build 'restricted-models.json'
$proof = Join-Path $Layout.Build 'tool-isolation-proof.json'
$savedEnv = @{}
foreach ($name in @('CODEX_HOME', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA')) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
  # Профиль подменяется на пустой: настольная сессия Codex владельца не подхватывается.
  [Environment]::SetEnvironmentVariable('CODEX_HOME', $bootstrap)
  [Environment]::SetEnvironmentVariable('HOME', $bootstrapHome)
  [Environment]::SetEnvironmentVariable('USERPROFILE', $bootstrapHome)
  [Environment]::SetEnvironmentVariable('APPDATA', (Join-Path $bootstrapHome 'AppData\Roaming'))
  [Environment]::SetEnvironmentVariable('LOCALAPPDATA', (Join-Path $bootstrapHome 'AppData\Local'))
  # stdout пишется в файл байт в байт: без перекодирования консолью PowerShell.
  # Фоновый helper запускается скрыто (-WindowStyle Hidden), без окна консоли.
  $process = Start-Process -FilePath $CodexExe -ArgumentList @('debug', 'models', '--bundled') `
    -RedirectStandardOutput $bundled -RedirectStandardError (Join-Path $bootstrap 'stderr.txt') `
    -WorkingDirectory $bootstrap -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw "codex debug models --bundled завершился с кодом $($process.ExitCode)" }
} finally {
  foreach ($name in $savedEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnv[$name]) }
}
if ((Get-Item -LiteralPath $bundled).Length -eq 0) { throw 'codex debug models --bundled не вернул каталог' }
$catalogArgs = @((Join-Path $appRuntime 'test-support\build-restricted-catalog.js'), '--input', $bundled, '--output', $catalog)
if ($Model) { $catalogArgs += @('--slug', $Model) }
Invoke-Node $catalogArgs
Remove-Item -LiteralPath $bundled -Force -ErrorAction SilentlyContinue
Remove-Managed $bootstrap

Write-Step 'Прогоняю настоящую проверку изоляции на закреплённом бинаре (mock-провайдер на loopback)'
if (Test-Path -LiteralPath $proof) { Remove-Item -LiteralPath $proof -Force }
Invoke-Node @((Join-Path $appRuntime 'test-support\run-isolation-check.js'), '--binary', $CodexExe, '--catalog', $catalog, '--proof', $proof)
if (-not (Test-Path -LiteralPath $proof)) { throw 'Доказательство изоляции не записано — установка остановлена' }

# ---------------------------------------------------------------------------------------
# Ключ worker
# ---------------------------------------------------------------------------------------

Write-Step 'Ключ worker'
$keyCreated = $false
if ($RegenerateKey -or -not (Test-Path -LiteralPath $KeyPath)) {
  [System.IO.File]::WriteAllText($KeyPath, (New-WorkerKey), [System.Text.Encoding]::ASCII)
  $keyCreated = $true
}
$workerKey = (Get-Content -LiteralPath $KeyPath -Raw).Trim()
if ($workerKey -notmatch '^[A-Za-z0-9._~-]{32,256}$') { throw 'Файл ключа повреждён; запустите с -RegenerateKey' }
$keyHash = Get-KeyHash $workerKey
$workerKey = $null

# ---------------------------------------------------------------------------------------
# Конфигурация
# ---------------------------------------------------------------------------------------

Write-Step 'Пишу config.json'
$config = [ordered]@{
  schema              = 1
  endpoint            = $Endpoint
  keyFile             = 'secret/worker.key'
  companies           = @($Companies)
  codexBinary         = 'vendor/x86_64-pc-windows-msvc/bin/codex.exe'
  codexHome           = 'codex-home'
  workspace           = 'workspace'
  catalogPath         = 'build/restricted-models.json'
  proofPath           = 'build/tool-isolation-proof.json'
  statePath           = 'state/hugh-runtime.sqlite'
  outboxPath          = 'state/worker-outbox.sqlite'
  statusPath          = 'state/status.json'
  logPath             = 'logs/worker.log'
  lockPath            = 'state/worker.lock'
  model               = $Model
  jobTimeoutMs        = 120000
  heartbeatIntervalMs = 20000
  renewIntervalMs     = 20000
}
[System.IO.File]::WriteAllText($ConfigPath, (($config | ConvertTo-Json -Depth 4) + "`n"), (New-Object System.Text.UTF8Encoding($false)))

# ---------------------------------------------------------------------------------------
# Скрытый запускатель
# ---------------------------------------------------------------------------------------

Write-Step 'Собираю скрытый запускатель'
Remove-Managed $Layout.Bin
New-Item -ItemType Directory -Force -Path $Layout.Bin | Out-Null
$launcherSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'SynapseHughLauncher.cs') -Raw
$useVbs = $false
try {
  Add-Type -TypeDefinition $launcherSource -OutputAssembly $LauncherExe -OutputType WindowsApplication -ReferencedAssemblies 'System.dll' -ErrorAction Stop
  if (-not (Test-Path -LiteralPath $LauncherExe)) { throw 'exe не появился' }
  Write-Host "    $LauncherExe"
} catch {
  Write-Warning "WinExe не собран ($($_.Exception.Message)); используется запасной VBS-запускатель"
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'SynapseHughLauncher.vbs') -Destination $LauncherVbs -Force
  $useVbs = $true
}

# Права на всё содержимое: только владелец и SYSTEM (включая ключ, состояние, CODEX_HOME).
Reset-ChildAcl $Root

# ---------------------------------------------------------------------------------------
# Задача планировщика
# ---------------------------------------------------------------------------------------

$mainJs = Join-Path $appLocal 'main.js'
if (-not $SkipTask) {
  Write-Step "Регистрирую задачу $TaskName (пользователь $userName, при входе, Interactive/Limited)"
  $quoted = "`"$NodeExe`" `"$mainJs`" `"$ConfigPath`""
  if ($useVbs) {
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\wscript.exe') -Argument "//B //Nologo `"$LauncherVbs`" $quoted" -WorkingDirectory $Root
  } else {
    $action = New-ScheduledTaskAction -Execute $LauncherExe -Argument $quoted -WorkingDirectory $Root
  }
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName
  # ExecutionTimeLimit=0 (PT0S) — без ограничения; иначе планировщик убивает задачу через 72 часа.
  # Батарея: не запрещать запуск и не останавливать при переходе на батарею.
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -Hidden
  $taskPrincipal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force | Out-Null
  if (-not $NoStart) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host '    Задача запущена'
  }
}

# ---------------------------------------------------------------------------------------
# Итог
# ---------------------------------------------------------------------------------------

Write-Host ''
Write-Host 'Установка завершена.'
Write-Host "  Корень:             $Root"
Write-Host "  Codex:              $CodexExe (codex-cli $PinnedCodexVersion)"
Write-Host "  Каталог / proof:    $catalog / $proof"
Write-Host "  Конфигурация:       $ConfigPath"
Write-Host "  Статус (безопасно): $StatusPath"
Write-Host "  Журнал:             $(Join-Path $Layout.Logs 'worker.log')"
if ($keyCreated) { Write-Host '  Ключ worker:        создан (сам ключ не выводится)' } else { Write-Host '  Ключ worker:        сохранён прежний' }
Write-Host ''
Write-Host 'Для сервера (docker .env, без самого ключа):'
Write-Host "  HUGH_LOCAL_WORKER_KEY_SHA256=$keyHash"
Write-Host "  HUGH_LOCAL_WORKER_COMPANIES=$($Companies -join ',')"
Write-Host ''
Write-Host "Проверка: Get-Content `"$StatusPath`" ; Get-ScheduledTaskInfo -TaskName $TaskName"
