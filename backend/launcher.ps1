#Requires -Version 5.1
<#
  panhub_praser backend launcher（Windows PowerShell 版）
  = backend/launcher.sh（v1.2.2）的语义等价实现：同样的子命令、参数、产物路径、提示文案风格。

    用法：.\backend\launcher.ps1 {setup|start|stop|status|restart|debug|logs|build|backup|reset}
          也接受 -- / - 前缀（.\backend\launcher.ps1 --stop 等价 .\backend\launcher.ps1 stop）
          无参数 = 打印用法 + 当前状态

  子命令语义、config.json 读写、.dev.vars 生成规则、wrangler 启动参数（--ip / inspector 端口
  9229 递增并写回 config.json）、端口避让、PID 落 data\run\ 等，全部与 launcher.sh 一致；
  逐项对照见文件末尾注释「与 launcher.sh v1.2.2 的差异」。

  Windows 特有实现（替代 bash 里不可用的部分）：
  - 无 tmux：debug 用独立控制台窗口跑 wrangler 交互面板（真 TTY、零管道，b/d/e/t/c/x 可用），
    backend 后台 → backend.log，另开一个日志窗口 tail；start 模式统一隐藏窗口后台跑
  - 无 SIGTERM：stop 用 taskkill /T /F 结束整个进程树（等效 SIGKILL，没有优雅退出阶段）
  - PID 归属校验：Get-Process + Win32_Process.CommandLine 必须指向本仓库（防 PID 复用误杀）
  - 端口检测：.NET TcpListener 独占绑定（不依赖 ss/netstat/curl，也不需要管理员）
  - HTTP 就绪探测：System.Net.WebRequest（PS 5.1 的 curl 是 Invoke-WebRequest 别名，会遮蔽 curl.exe）
  - 权限 600：用 icacls 去掉继承、只留当前用户（best-effort；Windows 没有 chmod）
  - 启动方式：写 data\run\*.cmd 包装脚本 + Start-Process（cmd 的 `> log 2>&1` 与 bash 的合并重定向等价）
  - config.json 读写仍走 node（与 launcher.sh 完全同一段脚本，JSON 格式与 bash 版一致）
  - 需要 PowerShell 5.1（Windows 10/11 自带）或 PowerShell 7+；只需普通用户权限，不提权
#>

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

# ---------------- 参数 ----------------
# 脚本刻意不声明 param()：$args 才能原样收下 --stop / -stop 这类 token（与 bash 版 `${1#--}` 等价）
$script:InvokedArgs = @($args)

# ---------------- 路径（launcher 在 backend\，仓库根是上一级） ----------------
$ScriptDir = $PSScriptRoot
if ([string]::IsNullOrEmpty($ScriptDir)) { $ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
$BackendDir = $ScriptDir
$RootDir    = Split-Path -Parent $ScriptDir
$DataDir    = Join-Path $BackendDir 'data'
$PeriodDir  = Join-Path $DataDir 'period'
$RunDir     = Join-Path $DataDir 'run'
$LogDir     = Join-Path $DataDir 'logs'
$BackupDir  = Join-Path $DataDir 'backups'
$ConfigFile = Join-Path $PeriodDir 'config.json'

$BackendEntry    = Join-Path $BackendDir 'src\index.js'
$WranglerCli     = Join-Path $RootDir 'node_modules\wrangler\bin\wrangler.js'
$WranglerShimCmd = Join-Path $RootDir 'node_modules\.bin\wrangler.cmd'
$DevVarsFile     = Join-Path $RootDir '.dev.vars'

$script:NodePath = 'node'

# ---------------- 输出（颜色 / 流语义与 bash 版一致：warn+fail 走 stderr） ----------------
$script:Esc = [char]27
$script:AnsiColor = @{ Cyan = 36; Green = 32; Yellow = 33; Red = 31; Dim = 2; Bold = 1 }
$script:HostColor = @{ Cyan = 'Cyan'; Green = 'Green'; Yellow = 'Yellow'; Red = 'Red'; Dim = 'DarkGray'; Bold = 'White' }

$script:UseAnsi = $false
try {
  if ($PSVersionTable.PSVersion.Major -ge 6) { $script:UseAnsi = $true }
  elseif ($Host.UI.PSObject.Properties['SupportsVirtualTerminal'] -and $Host.UI.SupportsVirtualTerminal) { $script:UseAnsi = $true }
} catch { $script:UseAnsi = $false }

function Write-Plain {
  param([string]$Text, [string]$Color = 'Cyan')
  if ($Color -eq '') { Write-Host $Text; return }
  if ($script:UseAnsi) {
    if ([Console]::IsOutputRedirected) { [Console]::Out.WriteLine($Text) }
    else { [Console]::Out.WriteLine("$($script:Esc)[$($script:AnsiColor[$Color])m$Text$($script:Esc)[0m") }
  } else {
    # PS 5.1 老控制台不支持 VT：用 Write-Host 上色（重定向时不被捕获，见文件末尾差异说明）
    Write-Host $Text -ForegroundColor $script:HostColor[$Color]
  }
}

function Write-ErrLine {
  param([string]$Text, [string]$Color = 'Yellow')
  if ($script:UseAnsi -and -not [Console]::IsErrorRedirected) {
    [Console]::Error.WriteLine("$($script:Esc)[$($script:AnsiColor[$Color])m$Text$($script:Esc)[0m")
  } else {
    [Console]::Error.WriteLine($Text)
  }
}

function Write-Info { param([string]$Message) Write-Plain "[launcher] $Message" 'Cyan' }
function Write-Ok   { param([string]$Message) Write-Plain "[launcher] $Message" 'Green' }
function Write-Warn { param([string]$Message) Write-ErrLine "[launcher] $Message" 'Yellow' }
function Fail {
  param([string]$Message)
  Write-ErrLine "[launcher] $Message" 'Red'
  exit 1
}

# ---------------- 工具 ----------------

function Get-PathNeedles {
  # 同一路径的两种分隔符写法（CommandLine 里可能是 / 或 \）
  param([string]$Path)
  return @(($Path -replace '\\', '/'), ($Path -replace '/', '\'))
}

function Get-ConfigValue {
  # 读 config.json 某字段（走 node，与 launcher.sh cfg_get 同一段脚本；缺字段返回空串）
  param([string]$Key, [string]$Default = '')
  if (-not (Test-Path -LiteralPath $ConfigFile)) { return $Default }
  $value = & node -e "const fs=require('node:fs'); const c=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); const v=process.argv[2].split('.').reduce((o,k)=>o&&o[k],c); process.stdout.write(v===undefined||v===null?'':String(v));" $ConfigFile $Key 2>$null
  if ($LASTEXITCODE -ne 0 -or $null -eq $value) { return $Default }
  $value = "$value".Trim()
  if ($value -eq '') { return $Default }
  return $value
}

function Test-ConfigReady {
  if (-not (Test-Path -LiteralPath $ConfigFile)) { return $false }
  return ((Get-ConfigValue 'webui.token') -ne '' -and (Get-ConfigValue 'proxy.token') -ne '')
}

function Test-PortFree {
  # .NET TcpListener 独占绑定探测（等价 launcher.sh 的 node net.createServer 探测）
  # 说明：Win 上必须保持 ExclusiveAddressUse=true（默认），否则 SO_REUSEADDR 会让探测恒真
  param([Parameter(Mandatory = $true)][int]$Port)
  $listener = $null
  try {
    $listener = New-Object -TypeName System.Net.Sockets.TcpListener -ArgumentList @([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    return $true
  } catch {
    return $false
  } finally {
    if ($null -ne $listener) { try { $listener.Stop() } catch { } }
  }
}

function Get-NextFreePort {
  param([Parameter(Mandatory = $true)][int]$Base)
  $candidate = $Base
  while (-not (Test-PortFree -Port $candidate)) {
    $candidate++
    if ($candidate -gt 65535) { Fail "端口区间耗尽（从 $Base 起）" }
  }
  return $candidate
}

function Invoke-Probe {
  # HTTP GET 探测：拿到任何 HTTP 响应（含 403/500）都算通（与 launcher.sh 的 curl 无 -f 同语义）
  param([string]$Url, [int]$TimeoutMs = 1000)
  try {
    $request = [System.Net.WebRequest]::Create($Url)
    $request.Method = 'GET'
    $request.Timeout = $TimeoutMs
    $request.Proxy = $null   # 回环探测不走系统代理
    $response = $null
    try {
      $response = $request.GetResponse()
    } catch [System.Net.WebException] {
      $response = $_.Exception.Response
      if ($null -eq $response) { return @{ Ok = $false; Body = '' } }
    }
    $reader = New-Object -TypeName System.IO.StreamReader -ArgumentList @($response.GetResponseStream())
    $body = $reader.ReadToEnd()
    $reader.Close()
    $response.Close()
    return @{ Ok = $true; Body = $body }
  } catch {
    return @{ Ok = $false; Body = '' }
  }
}

function Wait-HttpOk {
  # 等单 listener 就绪（最多 ~15s）
  param([Parameter(Mandatory = $true)][int]$Port)
  for ($i = 1; $i -le 50; $i++) {
    if ((Invoke-Probe -Url "http://127.0.0.1:$Port/api/proxy-config" -TimeoutMs 1000).Ok) { return $true }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Wait-Inspector {
  # 等 wrangler inspector 就绪（最多 ~30s），期间显示 wrangler 日志尾部便于排查
  param([Parameter(Mandatory = $true)][int]$Port)
  $wranglerLog = Join-Path $LogDir 'wrangler.log'
  for ($i = 1; $i -le 100; $i++) {
    $probe = Invoke-Probe -Url "http://127.0.0.1:$Port/json" -TimeoutMs 1000
    if ($probe.Ok -and $probe.Body.TrimStart().StartsWith('[')) { return $true }
    if (($i % 10) -eq 0 -and (Test-Path -LiteralPath $wranglerLog)) {
      $last = Get-Content -LiteralPath $wranglerLog -Tail 1 -ErrorAction SilentlyContinue
      if ($last) { Write-Warn "wrangler 启动中… 最新日志：$last" }
    }
    Start-Sleep -Milliseconds 300
  }
  return $false
}

function Protect-File {
  # bash `chmod 600` 的 Windows 等价物：去掉继承，只留当前用户完全控制（失败只告警，绝不提权）
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $icacls = Get-Command icacls.exe -ErrorAction SilentlyContinue
  if (-not $icacls) { Write-Warn "未找到 icacls.exe，跳过权限收敛（建议手动确认）：$Path"; return }
  try {
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & icacls.exe $Path /inheritance:r /grant:r "${me}:(F)" 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warn "权限收敛失败（不影响功能，建议手动确认）：$Path" }
  } catch {
    Write-Warn "权限收敛失败（不影响功能，建议手动确认）：$Path"
  }
}

function Get-BatchEncoding {
  # 生成的 .cmd 交给 cmd.exe 解析，必须用系统 ANSI 代码页（避免非 ASCII 路径乱码）
  try {
    $ansi = [System.Globalization.CultureInfo]::CurrentCulture.TextInfo.ANSICodePage
    return [System.Text.Encoding]::GetEncoding($ansi)
  } catch {
    return [System.Text.Encoding]::Default
  }
}

function Write-LaunchScript {
  # 写包装启动脚本（data\run\*.cmd）：cmd 负责 `> log 2>&1` 合并重定向 + 隐藏/独立窗口
  param([string]$Path, [string[]]$Lines)
  $text = ($Lines -join "`r`n") + "`r`n"
  [System.IO.File]::WriteAllText($Path, $text, (Get-BatchEncoding))
}

function Get-WranglerLaunchPrefix {
  # wrangler 启动命令前缀（引号已带好，供包装脚本用；与 launcher.sh 的 "$WRANGLER_BIN" 等价）
  if (Test-Path -LiteralPath $WranglerCli) { return '"' + $script:NodePath + '" "' + $WranglerCli + '"' }
  if (Test-Path -LiteralPath $WranglerShimCmd) { return '"' + $WranglerShimCmd + '"' }
  $onPath = Get-Command wrangler -ErrorAction SilentlyContinue
  if ($onPath) { return '"' + $onPath.Source + '"' }
  return ''
}

# ---------------- node / wrangler 检测 ----------------

function Test-NodeRuntime {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if (-not $nodeCmd) { Fail "缺少命令：node（请先安装，或确认 PATH）" }
  $script:NodePath = $nodeCmd.Source
  $raw = & node --version 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $raw) { Fail "node --version 执行失败（请确认 PATH）" }
  $ver = "$raw".Trim().TrimStart('v')
  $major = 0
  if (-not [int]::TryParse(($ver.Split('.')[0]), [ref]$major)) { Fail "无法解析 node 版本：$raw" }
  if ($major -lt 22) { Fail "node ≥ 22.5 才内置 node:sqlite（当前 v$ver）——请升级：https://nodejs.org" }
  & node -e "require('node:sqlite')" 2>$null
  if ($LASTEXITCODE -ne 0) { Fail "当前 node v$ver 没有 node:sqlite（需 ≥ 22.5）" }
  Write-Ok "node v$ver（node:sqlite ✓）"
}

function Test-Wrangler {
  if (Test-Path -LiteralPath $WranglerCli) {
    $v = & node $WranglerCli --version 2>$null | Select-Object -First 1
    Write-Ok "wrangler：$v（root node_modules）"
    return
  }
  if (Test-Path -LiteralPath $WranglerShimCmd) {
    Write-Ok "wrangler：$WranglerShimCmd（root node_modules shim）"
    return
  }
  $onPath = Get-Command wrangler -ErrorAction SilentlyContinue
  if ($onPath) {
    Write-Warn "root node_modules 没有 wrangler，但 PATH 里有：$($onPath.Source)（版本可能不一致）"
    return
  }
  Fail "未找到 wrangler —— 请先 npm install（或 .\backend\launcher.ps1 setup 会自动装）"
}

# ---------------- 依赖安装 ----------------

function Install-Deps {
  $need = $false
  if (-not (Test-Path -LiteralPath (Join-Path $RootDir 'node_modules\wrangler'))) {
    Write-Warn "root 依赖未装（缺 wrangler），npm install 中…"
    $need = $true
  }
  if (-not (Test-Path -LiteralPath (Join-Path $BackendDir 'node_modules'))) {
    Write-Warn "backend 依赖未装，npm install 中…"
    $need = $true
  }
  if (-not $need) { return }
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { Fail "缺少命令：npm（请先安装，或确认 PATH）" }
  Push-Location $RootDir
  try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Fail "root npm install 失败（请看上方输出）" }
  } finally { Pop-Location }
  Push-Location $BackendDir
  try {
    & npm install --no-fund --no-audit
    if ($LASTEXITCODE -ne 0) { Fail "backend npm install 失败（请看上方输出）" }
  } finally { Pop-Location }
}

# ---------------- config 初始化（生成端口+双令牌） ----------------

function Initialize-Config {
  # 调用 backend 的 loadConfig：首启生成随机端口 + 双令牌并写回 config.json
  $configUrl = ([System.Uri](Join-Path $BackendDir 'src\config.js')).AbsoluteUri
  & node --input-type=module -e "const m = await import(process.argv[1]); m.loadConfig();" $configUrl
  if ($LASTEXITCODE -ne 0) { Fail "config 初始化失败（backend\src\config.js）" }
}

# ---------------- .dev.vars 自动生成（设计稿 §5，setup/start/debug 均调用） ----------------

function Sync-DevVars {
  if (-not (Test-ConfigReady)) { Fail "未初始化（无 config.json 或缺令牌）→ .\backend\launcher.ps1 setup" }
  $token = Get-ConfigValue 'proxy.token'
  $proxyPort = Get-ConfigValue 'proxy.port'
  $cur = ''
  $traceOk = $false
  $backendUrlOk = $false
  if (Test-Path -LiteralPath $DevVarsFile) {
    foreach ($line in @(Get-Content -LiteralPath $DevVarsFile -ErrorAction SilentlyContinue)) {
      if ($cur -eq '' -and $line -match '^PROXY_TOKEN=(.*)$') { $cur = $Matches[1] }
      if ($line.Trim() -eq 'TRACE_D1=0') { $traceOk = $true }
      if ($line.Trim() -eq "BACKEND_URL=http://127.0.0.1:$proxyPort") { $backendUrlOk = $true }
    }
  }
  if ($cur -eq $token -and $traceOk -and $backendUrlOk) {
    Write-Ok ".dev.vars 已同步：$DevVarsFile（PROXY_TOKEN 与 config.json 一致）"
    return
  }
  # v1.2.2（wip2 修正）：BACKEND_URL 让本地 functions 也能走 cookie-pick 取号（云端分支同一路径）；
  # 云端部署时由部署者把该值改为公网 backend 地址（本机回环仅 B 端本机形态有效）
  # 内容与 bash 版字节一致（LF 结尾、无 BOM）
  $content = "PROXY_TOKEN=$token`nTRACE_D1=0`nBACKEND_URL=http://127.0.0.1:$proxyPort`n"
  [System.IO.File]::WriteAllText($DevVarsFile, $content, (New-Object -TypeName System.Text.UTF8Encoding -ArgumentList @($false)))
  Protect-File $DevVarsFile
  Write-Ok ".dev.vars 已生成/更新：$DevVarsFile（仅当前用户可读；PROXY_TOKEN 与 config.json 同一把 + TRACE_D1=0 + BACKEND_URL）"
}

# ---------------- 摘要 / 文档 ----------------

function Get-TokenTail {
  param([string]$Token)
  if ([string]::IsNullOrEmpty($Token)) { return '' }
  if ($Token.Length -le 7) { return $Token }
  return $Token.Substring($Token.Length - 7)
}

function Write-Summary {
  $proxyPort = Get-ConfigValue 'proxy.port'
  $proxyTail = Get-TokenTail (Get-ConfigValue 'proxy.token')
  $webuiTail = Get-TokenTail (Get-ConfigValue 'webui.token')
  $wranglerPort = Get-ConfigValue 'wrangler.port'
  $wranglerBind = Get-ConfigValue 'wrangler.bind' '0.0.0.0'
  if ($proxyPort -eq '') { $proxyPort = '?' }
  if ($wranglerPort -eq '') { $wranglerPort = '8787' }
  Write-Plain ''
  Write-Plain '  panhub 指挥中心已就绪' 'Bold'
  Write-Plain '  ─────────────────────────────────────────────' ''
  Write-Plain "  管理面板 / 指挥中心 : http://${wranglerBind}:${proxyPort}（WebUI 令牌 …${webuiTail}；回环/固定内网 IP 可进）" 'Cyan'
  Write-Plain "  增强 hop  /api/proxy : http://${wranglerBind}:${proxyPort}/api/proxy（X-Proxy-Token …${proxyTail}）" 'Cyan'
  Write-Plain "  wrangler（转发引擎）: ${wranglerBind}:${wranglerPort}（PANHUB_BIND=${wranglerBind}，企业内网可直连）" 'Cyan'
  Write-Plain '  完整令牌            : backend\data\period\config.json（仅当前用户可读）' ''
  Write-Plain '  wrangler 环境       : 根 .dev.vars（PROXY_TOKEN + TRACE_D1=0，仅当前用户可读，自动同步）' ''
  Write-Plain '  ─────────────────────────────────────────────' ''
  Write-Plain '  文档: docs\backend-wrangler-plan.md（设计稿 v1.2.2）| README.md（使用）' ''
  Write-Plain '  日志: data\logs\backend.log + wrangler.log（.\backend\launcher.ps1 logs）' ''
  Write-Plain '  排查: .\backend\launcher.ps1 debug（wrangler 独立窗口面板 + backend 后台日志）' ''
  Write-Plain ''
}

function Write-DocHint {
  Write-Info "使用文档：$RootDir\docs\backend-wrangler-plan.md §5 / README.md"
  Write-Info "常用：.\backend\launcher.ps1 start | stop | status | restart | logs | debug"
}

# ---------------- 进程管理 ----------------

function Get-PidFilePath { param([string]$Name) return (Join-Path $RunDir "$Name.pid") }

function Get-SavedPid {
  param([string]$Name)
  $file = Get-PidFilePath $Name
  if (-not (Test-Path -LiteralPath $file)) { return 0 }
  $raw = Get-Content -LiteralPath $file -Raw -ErrorAction SilentlyContinue
  if ($null -eq $raw) { return 0 }
  $parsed = 0
  if ([int]::TryParse($raw.Trim(), [ref]$parsed)) { return $parsed }
  return 0
}

function Save-Pid {
  param([string]$Name, [int]$ProcessId)
  Set-Content -LiteralPath (Get-PidFilePath $Name) -Value $ProcessId -Encoding ASCII
}

function Test-PidAlive {
  param([int]$ProcessId)
  if ($ProcessId -le 0) { return $false }
  return ($null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue))
}

function Get-ProcessCommandLine {
  param([int]$ProcessId)
  try {
    $proc = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -ne $proc -and $null -ne $proc.CommandLine) { return [string]$proc.CommandLine }
  } catch { }
  return ''
}

function Test-OurPid {
  # 校验 PID 归属本仓库（防 PID 复用误杀；bash 版定义了 is_our_pid 但没在 kill 路径里用）
  param([int]$ProcessId, [string[]]$Needles)
  $cmdline = Get-ProcessCommandLine $ProcessId
  if ($cmdline -ne '') {
    foreach ($needle in $Needles) {
      if ($needle -ne '' -and $cmdline.IndexOf($needle, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true }
    }
    return $false
  }
  # 拿不到 CommandLine（CIM 被禁用/无权限）：退回进程名近似判断（等价 bash 的 readlink exe 含 node）
  $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $proc) { return $false }
  if ($proc.ProcessName -match '^(node|cmd)$') {
    Write-Warn "无法读取 PID $ProcessId 的命令行（CIM 不可用），按进程名近似校验为“本仓库进程”"
    return $true
  }
  return $false
}

function Stop-PidFile {
  param([string]$Name, [string[]]$Needles)
  $file = Get-PidFilePath $Name
  if (-not (Test-Path -LiteralPath $file)) { return }
  $targetPid = Get-SavedPid $Name
  Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
  if ($targetPid -le 0) { return }
  if (-not (Test-PidAlive $targetPid)) { return }
  if (-not (Test-OurPid -ProcessId $targetPid -Needles $Needles)) {
    Write-Warn "$Name（PID $targetPid）命令行不属于本仓库，已跳过（防误杀）；确认后手动：Stop-Process -Id $targetPid -Force"
    return
  }
  Write-Info "停止 $Name（PID $targetPid）…"
  # Windows 没有可投递的 SIGTERM（TerminateProcess 即 SIGKILL）：taskkill /T 连带子进程树（workerd 等）
  & taskkill.exe /PID $targetPid /T /F 2>&1 | Out-Null
  if (Test-PidAlive $targetPid) { Stop-Process -Id $targetPid -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 300
}

function Stop-All {
  Stop-PidFile -Name 'backend' -Needles (@(Get-PathNeedles $BackendDir) + @(Get-PathNeedles (Get-PidFilePath 'backend')))
  Stop-PidFile -Name 'wrangler' -Needles (@(Get-PathNeedles $RootDir) + @(Get-PathNeedles $RunDir) + @(Get-PathNeedles $WranglerCli) + @(Get-PathNeedles $WranglerShimCmd) + @('wrangler'))
  Write-Ok '全部已停止'
}

function Ensure-Runtime {
  foreach ($dir in @($RunDir, $LogDir)) {
    if (-not (Test-Path -LiteralPath $dir)) { [void](New-Item -ItemType Directory -Path $dir -Force) }
  }
}

# ---------------- 启动 ----------------

function Set-WranglerPorts {
  # 端口避让结果写回 config.json（backend 的 wrangler.port / inspectorPort 与实际一致）
  param([Parameter(Mandatory = $true)][int]$Port, [Parameter(Mandatory = $true)][int]$InspectorPort)
  & node -e "const fs=require('node:fs'); const p=process.argv[1]; const c=JSON.parse(fs.readFileSync(p,'utf8')); c.wrangler=c.wrangler||{}; c.wrangler.port=Number(process.argv[2]); c.wrangler.inspectorPort=Number(process.argv[3]); fs.writeFileSync(p,JSON.stringify(c,null,2));" $ConfigFile $Port $InspectorPort
  if ($LASTEXITCODE -ne 0) { Fail "写回 config.json 失败（wrangler.port=$Port / inspectorPort=$InspectorPort）" }
}

function Set-PrepareBind {
  # PANHUB_BIND → config.json proxy.host / webui.host / wrangler.bind（wrangler --ip 同源，拍板之二）
  # 0.0.0.0（默认）= 企业内网全接口；webui.host=0.0.0.0 永不匹配真实 Host → 管理面板仍仅回环可进
  # 具体内网 IP = B 端固定地址：webui Host 检查放行该 IP（员工可直连管理面板）
  $bind = $env:PANHUB_BIND
  if ([string]::IsNullOrEmpty($bind)) { $bind = '0.0.0.0' }
  if ($bind -eq '0.0.0.0') {
    Write-Warn 'PANHUB_BIND=0.0.0.0（默认）—— wrangler 转发端口全接口监听（企业内网可达）；管理面板仍仅本机（/api/web/* Host 检查）'
    Write-Warn '  → 要开放管理面板请设 PANHUB_BIND=<服务器固定内网 IP>（如 192.168.1.10），webui 只允许该 IP 绑定'
  } elseif ($bind -eq '127.0.0.1') {
    Write-Info 'PANHUB_BIND=127.0.0.1 —— 仅本机（wrangler + backend 均回环）'
  } else {
    Write-Warn "PANHUB_BIND=$bind —— backend/webui 与 wrangler 均绑 $bind（企业固定内网 IP；webui Host 检查放行该 IP）"
  }
  & node -e "const fs=require('node:fs'); const p=process.argv[1]; const c=JSON.parse(fs.readFileSync(p,'utf8')); c.proxy=c.proxy||{}; c.webui=c.webui||{}; c.wrangler=c.wrangler||{}; c.proxy.host=process.argv[2]; c.webui.host=process.argv[2]; c.wrangler.bind=process.argv[2]; fs.writeFileSync(p,JSON.stringify(c,null,2));" $ConfigFile $bind
  if ($LASTEXITCODE -ne 0) { Fail "写回 config.json 失败（bind=$bind）" }
}

function Start-Wrangler {
  $prefix = Get-WranglerLaunchPrefix
  if ($prefix -eq '') { Fail '未找到 wrangler —— 请先 npm install（或 .\backend\launcher.ps1 setup 会自动装）' }
  $basePort = [int](Get-ConfigValue 'wrangler.port' '8787')
  $baseInspector = [int](Get-ConfigValue 'wrangler.inspectorPort' '9229')
  $port = Get-NextFreePort -Base $basePort
  $inspectorPort = Get-NextFreePort -Base $baseInspector
  $bind = Get-ConfigValue 'wrangler.bind' '0.0.0.0'
  Set-WranglerPorts -Port $port -InspectorPort $inspectorPort   # 写回：backend 转发目标/健康监听与实际一致
  Write-Info "启动 wrangler pages dev（:${port}，inspector :${inspectorPort}，绑 ${bind}）…"
  # cwd=ROOT_DIR：wrangler pages dev . 的托管目录 + .dev.vars 读取位置（launcher 在 backend\ 下必须显式 cd）
  # 令牌经 .dev.vars 自动注入，不再 --binding
  $launchScript = Join-Path $RunDir 'wrangler-run.cmd'
  Write-LaunchScript -Path $launchScript -Lines @(
    '@echo off',
    ('cd /d "' + $RootDir + '"'),
    ($prefix + " pages dev . --port $port --inspector-port $inspectorPort --ip $bind --show-interactive-dev-session=false --log-level info > `"$LogDir\wrangler.log`" 2>&1")
  )
  $proc = Start-Process -FilePath $launchScript -WindowStyle Hidden -PassThru
  if ($null -eq $proc) { return $false }
  Save-Pid 'wrangler' $proc.Id
  if (-not (Wait-Inspector -Port $inspectorPort)) {
    Write-Warn "wrangler inspector 未就绪，看日志：.\backend\launcher.ps1 logs（或 Get-Content '$LogDir\wrangler.log' -Tail 40）"
    return $false
  }
  Write-Ok "wrangler 已就绪（:${port}，inspector :${inspectorPort}）"
  return $true
}

function Start-BackendDetached {
  # backend 后台启动（后台 → backend.log；等待方负责先让 wrangler 就绪，保证 attach）
  $bport = Get-ConfigValue 'proxy.port'
  if ($bport -eq '') { Fail 'config.json 缺少 proxy.port，请先 .\backend\launcher.ps1 setup' }
  # prepare_bind 已由 Start/Invoke-Debug 在 wrangler 启动前调用（避免重复警告）
  $bind = Get-ConfigValue 'proxy.host' '127.0.0.1'
  Write-Info "启动 backend（${bind}:${bport}，后台运行 → backend.log）…"
  # 不设 PANHUB_NO_SPAWN：launcher 已先等 wrangler inspector 就绪，backend 探测到会 attach
  # （保留 wrangler 健康监听 + stdout 解析）；仅当 wrangler 没起来才自动 spawn 兜底
  $launchScript = Join-Path $RunDir 'backend-run.cmd'
  Write-LaunchScript -Path $launchScript -Lines @(
    '@echo off',
    ('cd /d "' + $BackendDir + '"'),
    ('"' + $script:NodePath + '" "' + $BackendEntry + '" > "' + (Join-Path $LogDir 'backend.log') + '" 2>&1')
  )
  $proc = Start-Process -FilePath $launchScript -WindowStyle Hidden -PassThru
  if ($null -eq $proc) { return $false }
  Save-Pid 'backend' $proc.Id
  return $true
}

function Start-Backend {
  if (-not (Start-BackendDetached)) { return $false }
  $bport = [int](Get-ConfigValue 'proxy.port' '0')
  if (-not (Wait-HttpOk -Port $bport)) {
    Write-Warn "backend 未就绪，看日志：.\backend\launcher.ps1 logs"
    return $false
  }
  Write-Ok "backend 已就绪（http://127.0.0.1:${bport}）"
  return $true
}

# ---------------- 命令实现 ----------------

function Invoke-Setup {
  Write-Plain ''
  Write-Plain '══ panhub 指挥中心 setup（首次/重置初始化）══' 'Bold'
  Test-NodeRuntime
  Test-Wrangler
  Install-Deps
  Write-Plain ''
  Write-Info '初始化 config.json（随机端口 + 双令牌）…'
  Initialize-Config
  if (-not (Test-ConfigReady)) { Fail "config 初始化异常：$ConfigFile" }
  Protect-File (Join-Path $PeriodDir 'config.json')
  Protect-File (Join-Path $PeriodDir 'secret.key')
  Write-Ok "config.json 已生成：$ConfigFile（仅当前用户可读，等价 600）"
  Sync-DevVars
  Write-Summary
  Write-Plain '  下一步：'
  Write-Plain '    首次排查  : .\backend\launcher.ps1 debug（wrangler 独立窗口面板 + backend 后台日志）'
  Write-Plain '    日常启动  : .\backend\launcher.ps1 start'
  Write-Plain '    停止      : .\backend\launcher.ps1 stop'
  Write-Plain ''
}

function Invoke-Start {
  if (-not (Test-ConfigReady)) { Write-Warn '未初始化，先跑 setup'; Invoke-Setup }
  Ensure-Runtime
  Sync-DevVars
  Stop-All        # 幂等：先清理旧 PID（restart 语义安全）
  Set-PrepareBind # 必须先写 wrangler.bind，Start-Wrangler 才拿得到 --ip（v1.2.2 微调）
  if (-not (Start-Wrangler)) { Show-Status; exit 1 }
  if (-not (Start-Backend)) { Show-Status; exit 1 }
  Write-Plain ''
  Write-Summary
  Write-Ok '服务已后台运行（PID 见 data\run\）。停止：.\backend\launcher.ps1 stop'
}

function Invoke-Stop { Stop-All }

function Show-Status {
  $bport = Get-ConfigValue 'proxy.port'
  $proxyTail = Get-TokenTail (Get-ConfigValue 'proxy.token')
  $wranglerPort = Get-ConfigValue 'wrangler.port'
  Write-Plain ''
  Write-Plain '══ panhub 指挥中心状态 ══' 'Bold'
  if (-not (Test-ConfigReady)) {
    Write-Warn '未初始化（无 config.json 或缺令牌）→ .\backend\launcher.ps1 setup'
    return
  }
  $backendPid = Get-SavedPid 'backend'
  $wranglerPid = Get-SavedPid 'wrangler'
  if (Test-PidAlive $backendPid) {
    Write-Ok "backend   运行中  PID $backendPid  http://127.0.0.1:${bport}（WebUI 令牌 …${proxyTail}）"
  } else {
    Write-Warn "backend   未运行（PID 文件 $(Get-PidFilePath 'backend')）"
  }
  if (Test-PidAlive $wranglerPid) {
    Write-Ok "wrangler  运行中  PID $wranglerPid  :${wranglerPort}"
  } else {
    Write-Warn "wrangler  未运行（PID 文件 $(Get-PidFilePath 'wrangler')）"
  }
  Write-Plain "  日志: $LogDir\backend.log + wrangler.log（.\backend\launcher.ps1 logs）" 'Dim'
  Write-Plain ''
}

function Invoke-Restart {
  Invoke-Stop
  Invoke-Start
}

function Invoke-Debug {
  if (-not (Test-ConfigReady)) { Write-Warn '未初始化，先跑 setup'; Invoke-Setup }
  Ensure-Runtime
  Sync-DevVars
  Stop-All
  $prefix = Get-WranglerLaunchPrefix
  if ($prefix -eq '') { Fail '未找到 wrangler —— 请先 npm install（或 .\backend\launcher.ps1 setup 会自动装）' }
  $port = Get-NextFreePort -Base ([int](Get-ConfigValue 'wrangler.port' '8787'))
  $inspectorPort = Get-NextFreePort -Base ([int](Get-ConfigValue 'wrangler.inspectorPort' '9229'))
  Set-WranglerPorts -Port $port -InspectorPort $inspectorPort
  Set-PrepareBind
  $bind = Get-ConfigValue 'wrangler.bind' '0.0.0.0'

  Write-Warn 'Windows 无 tmux：wrangler 在独立控制台窗口跑真 TTY 面板（零管道，b/d/e/t/c/x 可用）；backend 后台 → backend.log'
  # 左窗口：wrangler 前台交互面板，零管道（与 launcher.sh debug 的 tmux 左 pane 等价）
  $wranglerScript = Join-Path $RunDir 'wrangler-debug.cmd'
  Write-LaunchScript -Path $wranglerScript -Lines @(
    '@echo off',
    ('cd /d "' + $RootDir + '"'),
    ($prefix + " pages dev . --port $port --inspector-port $inspectorPort --ip $bind --log-level info")
  )
  $proc = Start-Process -FilePath $wranglerScript -PassThru   # 可见窗口（真 TTY）
  if ($null -eq $proc) { Fail '启动 wrangler 面板窗口失败' }
  Save-Pid 'wrangler' $proc.Id
  Write-Info "等待 wrangler inspector 就绪（:${inspectorPort}）…"
  if (Wait-Inspector -Port $inspectorPort) {
    Write-Ok 'wrangler 面板已就绪'
  } else {
    Write-Warn 'wrangler inspector 未就绪（面板可能启动失败）；backend 将按 autoSpawn 自行拉起（若面板其实活着会抢端口，退出后检查面板输出）'
  }
  Start-BackendDetached
  # 右窗口：后端日志 tail（等价 launcher.sh debug 的右 pane tail -f）
  $backendLog = Join-Path $LogDir 'backend.log'
  if (-not (Test-Path -LiteralPath $backendLog)) { [void](New-Item -ItemType File -Path $backendLog -Force) }
  $logScript = Join-Path $RunDir 'backend-log-tail.cmd'
  Write-LaunchScript -Path $logScript -Lines @(
    '@echo off',
    ('powershell.exe -NoExit -Command "Get-Content -LiteralPath ''' + $backendLog + ''' -Wait -Tail 20"')
  )
  [void](Start-Process -FilePath $logScript)
  Write-Plain ''
  Write-Info 'wrangler 交互面板在新窗口（b/d/e/t/c/x 快捷键）；backend 后台运行，日志在另一个窗口（backend.log）'
  Write-Info '停止：.\backend\launcher.ps1 stop（会一并关闭上面两个窗口的进程）'
}

function Show-Logs {
  # debug 模式 wrangler 输出在面板（无 wrangler.log）；start 模式有。缺文件则建空文件跟随
  $backendLog = Join-Path $LogDir 'backend.log'
  $wranglerLog = Join-Path $LogDir 'wrangler.log'
  if (-not (Test-Path -LiteralPath $backendLog)) {
    Write-Warn 'backend.log 还不存在（先 start/debug），建空文件跟随'
    [void](New-Item -ItemType File -Path $backendLog -Force)
  }
  if (-not (Test-Path -LiteralPath $wranglerLog)) {
    Write-Warn 'wrangler.log 还不存在（debug 模式 wrangler 输出在面板），建空文件跟随'
    [void](New-Item -ItemType File -Path $wranglerLog -Force)
  }
  Write-Info 'Ctrl+C 退出。backend + wrangler 双日志（data\logs\；debug 时 wrangler 看面板）'
  # PowerShell 没有 tail -f 多文件：两个 job 各 follow 一个文件，逐行写回当前控制台
  $jobs = @()
  foreach ($file in @($backendLog, $wranglerLog)) {
    $jobs += Start-Job -ArgumentList $file -ScriptBlock {
      param($path)
      $name = [System.IO.Path]::GetFileName($path)
      Get-Content -LiteralPath $path -Wait -Tail 20 | ForEach-Object { "[$name] $_" }
    }
  }
  try {
    while ($true) {
      Receive-Job -Job $jobs
      if (-not ($jobs | Where-Object { $_.State -eq 'Running' })) { break }
      Start-Sleep -Milliseconds 400
    }
  } finally {
    $jobs | Stop-Job -ErrorAction SilentlyContinue
    $jobs | Remove-Job -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-Build {
  Write-Info '重建 backend webui dist…'
  Push-Location $BackendDir
  try {
    & npm run build:webui
    if ($LASTEXITCODE -ne 0) { Fail 'webui 构建失败（请看上方 npm 输出）' }
  } finally { Pop-Location }
  Write-Ok "webui dist 已重建（$BackendDir\webui\dist）"
  Write-Info '提示：wrangler pages dev 直接托管源码树，通常不需要 build；仅手动部署时才需要'
}

function Invoke-Backup {
  if (-not (Test-Path -LiteralPath $PeriodDir)) { Fail "没有可备份的数据（$PeriodDir 不存在）" }
  if (-not (Test-Path -LiteralPath $BackupDir)) { [void](New-Item -ItemType Directory -Path $BackupDir -Force) }
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $tarCmd = Get-Command tar.exe -ErrorAction SilentlyContinue
  if ($tarCmd) {
    $tarball = Join-Path $BackupDir "panhub-period-$stamp.tar.gz"
    Push-Location $DataDir
    try {
      & tar.exe -czf $tarball 'period'
      if ($LASTEXITCODE -ne 0) { Fail "tar 打包失败：$tarball" }
    } finally { Pop-Location }
    Write-Ok "已备份 → $tarball"
    Write-Info '恢复：tar xzf <备份> -C backend\data\（含 secret.key 必须一起，否则 cookie 密文无法解密）'
    return
  }
  # 兜底：Win10 1803 之前没有内置 tar.exe → 用 Compress-Archive 打 zip（产物后缀不同，见 README）
  $zip = Join-Path $BackupDir "panhub-period-$stamp.zip"
  Write-Warn '未找到 tar.exe（Windows 10 1803+ 才有内置 tar），改用 zip 备份'
  Compress-Archive -LiteralPath $PeriodDir -DestinationPath $zip -Force
  Write-Ok "已备份 → $zip"
  Write-Info '恢复：Expand-Archive <备份> -DestinationPath backend\data\（含 secret.key 必须一起，否则 cookie 密文无法解密）'
}

function Invoke-Reset {
  Write-Warn '重置管理系统：备份现有 data\ → 停服 → 清空 → 全新 setup（旧令牌作废）'
  $ans = Read-Host '确认重置？[y/N]'
  if ($ans -match '^(y|yes)$') {
    Invoke-Backup      # 与 bash 版一致：备份失败即中止（bash 的 `cmd_backup || true` 因 exit 语义同样中止）
    Stop-All
    if (Test-Path -LiteralPath $PeriodDir) { Remove-Item -LiteralPath $PeriodDir -Recurse -Force }
    Write-Ok '旧配置已清除，重新 setup'
    Invoke-Setup
  } else {
    Write-Info '已取消'
  }
}

function Show-Usage {
  $usage = @'
panhub_praser backend launcher（Windows PowerShell 版；语义等价 backend/launcher.sh v1.2.2）

用法: .\backend\launcher.ps1 {命令}      （也接受 -- / - 前缀：--stop 等价 stop）

命令:
  setup    首次/重置初始化：检测 node/wrangler → 装依赖 → 生成端口+双令牌 + 根 .dev.vars
  start    后台启动 wrangler + backend（PID 落 data\run\）
  stop     停止全部（taskkill /T /F 结束进程树；Windows 无 SIGTERM）
  status   进程 / 端口 / URL / 令牌摘要
  restart  重启
  debug    前台排查：wrangler 独立窗口真 TTY 交互面板（零管道）+ backend 后台日志 + 日志窗口
  logs     实时看 backend.log + wrangler.log（debug 时 wrangler 输出在面板）
  build    重建 backend webui dist（可选）
  backup   打包 data\period + secret.key → data\backups\
  reset    备份 → 停服 → 清空 → 重新 setup（全新令牌）

环境变量:
  PANHUB_BIND=0.0.0.0   默认：wrangler 转发端口全接口监听（企业内网可直连），webui 仍仅回环可进
  PANHUB_BIND=<内网IP>   B 端固定地址：wrangler + backend/webui 均绑该 IP，webui Host 检查放行（管理面板可直连）
  PANHUB_NO_SPAWN=1     backend 跳过 spawn 但允许 attach（测试用；探测失败自然降级 off）

PowerShell 里设置环境变量的写法（仅当前会话）:
  $env:PANHUB_BIND = '127.0.0.1'; .\backend\launcher.ps1 start
'@
  Write-Plain $usage ''
}

# ---------------- 分发 ----------------

$raw = ''
if ($script:InvokedArgs.Count -gt 0) { $raw = [string]$script:InvokedArgs[0] }
$command = $raw.TrimStart('-').ToLowerInvariant()

if ($raw -eq '') {
  Show-Usage
  Write-Plain ''
  Show-Status
  exit 0
}

switch ($command) {
  'setup'   { Invoke-Setup }
  'start'   { Invoke-Start }
  'stop'    { Invoke-Stop }
  'status'  { Show-Status }
  'restart' { Invoke-Restart }
  'debug'   { Invoke-Debug }
  'logs'    { Show-Logs }
  'build'   { Invoke-Build }
  'backup'  { Invoke-Backup }
  'reset'   { Invoke-Reset }
  'help'    { Show-Usage }
  'h'       { Show-Usage }
  default {
    Write-Warn "未知命令：$raw"
    Show-Usage
    exit 1
  }
}

exit 0

# ============================================================================
# 与 launcher.sh v1.2.2 的差异（Windows 平台约束所致，逐项在此登记）
#
# 1) 进程停止：bash 是 SIGTERM → 等 6s → SIGKILL；Windows 没有可投递的 SIGTERM，
#    用 taskkill /PID <pid> /T /F（结束整个进程树，连 workerd 一起），等效 SIGKILL，无优雅退出阶段。
#    保存的 wrangler PID 是包装 cmd.exe 的 PID（启动脚本里再拉起 node），/T 保证子进程一并结束。
# 2) debug：无 tmux（不检测也不使用 tmux）。wrangler 在独立可见控制台窗口跑真 TTY 面板（零管道、
#    b/d/e/t/c/x 可用），backend 后台 → backend.log，另开窗口 Get-Content -Wait 跟随日志。
#    bash 有 tmux 时会把这两个 pane 放进一个会话；PS 版统一用 Windows 原生双窗口，且不阻塞当前终端
#    （bash 的 tmux 分支会 attach 并占住终端）。
# 3) PID 归属校验：PS 版在 kill 前用 Win32_Process.CommandLine 核对 PID 确实属于本仓库，
#    不匹配只告警不杀（bash 版定义了 is_our_pid 但没有在 kill 路径使用）。
# 4) 端口探测：.NET TcpListener 独占绑定（不用 ss/netstat/curl）。差异点：Windows 独占绑定会把
#    TIME_WAIT 端口视为占用，避让起步值可能比 bash 版多 +1，属正常。
# 5) HTTP 就绪探测：System.Net.WebRequest（bash 用 curl）。PS 5.1 里 curl 是 Invoke-WebRequest 别名，
#    会遮蔽 curl.exe，故不用 curl。
# 6) 权限：bash chmod 600 在 Windows 无对应物，改用 icacls 去掉继承、只留当前用户（best-effort，
#    失败仅告警，绝不提权）。config.json 的 600 由 node chmodSync 在 Windows 上本就是空操作，
#    这里在 setup 后同样调用 icacls 收敛。
# 7) 输出：warn/fail 与 bash 一样走 stderr；颜色在 PowerShell 5.1 老控制台（无 VT）下走 Write-Host，
#    此时 stdout 内容无法被 `>` 捕获（PowerShell 宿主限制），PS 7+ 无此问题。
# 8) 启动方式：写 data\run\*.cmd 包装脚本 + Start-Process（隐藏窗口），cmd 的 `> log 2>&1` 与
#    bash 的 `>"$LOG_DIR/x.log" 2>&1` 等价；日志路径与 bash 完全相同。
# 9) cfg 缺字段：bash `cfg_get x || echo 默认值` 在字段为空串时不会回退（会传出空值），
#    PS 版显式回退到同一默认值（8787 / 9229 / 0.0.0.0 / 127.0.0.1）。属修正，不改 bash 版行为。
# 10) reset 前置备份失败即中止：与 bash 相同（bash 的 `cmd_backup || true` 因 fail 用 exit 而同样中止）。
# 11) 未实现 Windows 专属提权路径：所有命令只需普通用户权限；任何需要提权的操作都不静默执行。
# ============================================================================
