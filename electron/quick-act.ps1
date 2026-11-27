param(
  [string]$Action = 'ping',
  [string]$Value = ''
)
# 快捷面板的子面板数据与动作。输出一行 JSON。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$netsh   = Join-Path $env:WINDIR 'System32\netsh.exe'
$powercfg = Join-Path $env:WINDIR 'System32\powercfg.exe'
$dswitch = Join-Path $env:WINDIR 'System32\DisplaySwitch.exe'

function Out-Json($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 6
  [Console]::Out.WriteLine($json)
}

# ---- WinRT Radio：和 Windows 设置里「飞行模式」同一个 Wi-Fi 开关 ----
$script:radioReady = $false
$script:asTask = $null
function Init-Radio {
  if ($script:radioReady) { return $true }
  try {
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    [Windows.Devices.Radios.Radio, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
    $script:asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
    $script:radioReady = $true
  } catch { $script:radioReady = $false }
  return $script:radioReady
}
function Await-Radio($op, $type) {
  $task = $script:asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(4000) | Out-Null
  return $task.Result
}

function Get-RadioList {
  if (-not (Init-Radio)) { return $null }
  try {
    return Await-Radio ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
  } catch { return $null }
}
function Read-Radio {
  $list = Get-RadioList
  if (-not $list) { return $null }
  $wifi = 'Unknown'
  foreach ($r in $list) {
    if ($r.Kind -eq [Windows.Devices.Radios.RadioKind]::WiFi) { $wifi = [string]$r.State }
  }
  return @{ wifi = $wifi }
}
function Set-Radio($on) {
  $list = Get-RadioList
  if (-not $list) { return $null }
  $want = if ($on) { [Windows.Devices.Radios.RadioState]::On } else { [Windows.Devices.Radios.RadioState]::Off }
  $ok = $false
  $found = $false
  foreach ($r in $list) {
    if ($r.Kind -eq [Windows.Devices.Radios.RadioKind]::WiFi) {
      $found = $true
      $st = Await-Radio ($r.SetStateAsync($want)) ([Windows.Devices.Radios.RadioAccessStatus])
      if ([string]$st -eq 'Allowed') { $ok = $true }
    }
  }
  if (-not $found) { return $null }
  return $ok
}

# ---- 让网卡真的扫一遍：netsh 只给缓存，WlanScan 才会把刚出现的网络扫进来 ----
$script:wlanReady = $false
function Invoke-WlanScan {
  # 每 4 秒最多真扫一次，面板 3 秒一轮的轮询不至于把网卡一直按在扫描状态
  $stamp = Join-Path $env:TEMP 'windock-last-scan.txt'
  if (Test-Path $stamp) {
    $age = ([DateTime]::Now - (Get-Item $stamp).LastWriteTime).TotalSeconds
    if ($age -lt 4) { return }
  }
  try { [System.IO.File]::WriteAllText($stamp, '1') } catch { }
  if (-not $script:wlanReady) {
    try {
      Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class WinDockWlan {
  [DllImport("wlanapi.dll")] static extern int WlanOpenHandle(uint v, IntPtr p, out uint h, out uint neg);
  [DllImport("wlanapi.dll")] static extern int WlanCloseHandle(IntPtr h, IntPtr p);
  [DllImport("wlanapi.dll")] static extern int WlanEnumInterfaces(IntPtr h, IntPtr p, out IntPtr list);
  [DllImport("wlanapi.dll")] static extern int WlanScan(IntPtr h, IntPtr guid, IntPtr ssid, IntPtr ie, IntPtr p);
  [DllImport("wlanapi.dll")] static extern void WlanFreeMemory(IntPtr p);
  public static int ScanAll() {
    uint h = 0; uint neg; IntPtr list = IntPtr.Zero;
    // 客户端版本要用 1（Win7 的 2 在这台机器上拿到的句柄是无效的）
    if (WlanOpenHandle(1, IntPtr.Zero, out h, out neg) != 0) return 1;
    try {
      if (WlanEnumInterfaces((IntPtr)h, IntPtr.Zero, out list) != 0) return 2;
      int n = Marshal.ReadInt32(list, 0);
      long baseAddr = list.ToInt64();
      for (int i = 0; i < n; i++) {
        // WLAN_INTERFACE_INFO: GUID(16) + 描述(512) + 状态(4) = 532 字节，GUID 就在项首地址
        IntPtr item = new IntPtr(baseAddr + 8 + i * 532);
        WlanScan((IntPtr)h, item, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
      }
      return 0;
    } finally {
      if (list != IntPtr.Zero) WlanFreeMemory(list);
      WlanCloseHandle((IntPtr)h, IntPtr.Zero);
    }
  }
}
'@ -ErrorAction Stop
      $script:wlanReady = $true
    } catch { $script:wlanReady = $false }
  }
  if (-not $script:wlanReady) { return }
  try { [WinDockWlan]::ScanAll() | Out-Null } catch { }
}

# 加密类型归一：扫描结果里中文/英文都可能出现，UI 只认这几种
function Get-AuthKind([string]$auth) {
  if (-not $auth) { return 'unknown' }
  $a = $auth.ToLower()
  if ($a -match '企业|enterprise|802\.1x|eap') { return 'ent' }
  if ($a -match 'wpa3|sae') { return 'sae' }
  if ($a -match 'wep') { return 'wep' }
  if ($a -match 'wpa2|wpa') { return 'psk' }
  if ($a -match '开放|open|无') { return 'open' }
  return 'unknown'
}

# 没有保存过的新网络要连，只能现场写一份配置文件
function New-WlanXml([string]$ssid, [string]$key, [string]$kind) {
  $esc = $ssid.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
  $kEsc = $key.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
  $auth = 'WPA2PSK'; $enc = 'AES'; $keyType = 'passPhrase'
  if ($kind -eq 'sae') { $auth = 'WPA3SAE' }
  elseif ($kind -eq 'open') { $auth = 'open'; $enc = 'none' }
  elseif ($kind -eq 'wep') { $auth = 'open'; $enc = 'WEP'; $keyType = 'networkKey' }
  $shared = ''
  if ($kind -ne 'open') {
    $shared = "      <sharedKey><keyType>$keyType</keyType><protected>false</protected><keyMaterial>$kEsc</keyMaterial></sharedKey>`n"
  }
  return "<?xml version=`"1.0`" encoding=`"utf-8`"?>`n" +
    "<WLANProfile xmlns=`"http://www.microsoft.com/networking/WLAN/profile/v1`">`n" +
    "  <name>$esc</name>`n" +
    "  <SSIDConfig><SSID><name>$esc</name></SSID></SSIDConfig>`n" +
    "  <connectionType>ESS</connectionType>`n" +
    "  <connectionMode>auto</connectionMode>`n" +
    "  <MSM><security>`n" +
    "      <authEncryption><authentication>$auth</authentication><encryption>$enc</encryption><useOneX>false</useOneX></authEncryption>`n" +
    $shared +
    "  </security></MSM>`n" +
    "</WLANProfile>`n"
}

function Add-WlanProfile([string]$ssid, [string]$key, [string]$kind) {
  $path = Join-Path $env:TEMP ('windock-wlan-' + [guid]::NewGuid().ToString('N') + '.xml')
  try {
    [System.IO.File]::WriteAllText($path, (New-WlanXml $ssid $key $kind), (New-Object System.Text.UTF8Encoding($false)))
    $r = & $netsh wlan add profile filename="$path" user=current 2>&1
    return (($r -join ' ') -replace '\s+', ' ').Trim()
  } catch { return '' } finally {
    try { Remove-Item -LiteralPath $path -Force } catch { }
  }
}

function Get-Profiles {
  $saved = @()
  $profOut = & $netsh wlan show profiles 2>$null
  foreach ($l in $profOut) {
    # 自己写进去的配置（user=current）会显示成 Current User Profile，不能只认 All User Profile
    if ($l -match '^\s*(All User Profile|Current User Profile|所有用户配置文件|当前用户配置文件)\s*:\s*(.+)$') {
      $n = $Matches[2].Trim()
      if ($n) { $saved += $n }
    }
  }
  return $saved
}

# netsh connect 会立刻返回「已成功」，真正的结果要看接口状态
function Wait-WifiConnected([string]$ssid, [int]$timeoutMs = 6000) {
  $deadline = [DateTime]::Now.AddMilliseconds($timeoutMs)
  while ([DateTime]::Now -lt $deadline) {
    $state = ''; $ss = ''
    $out = & $netsh wlan show interfaces 2>$null
    foreach ($l in $out) {
      if ($l -match '^\s*(State|状态)\s*:\s*(.+)$') { $state = $Matches[2].Trim() }
      if ($l -match '^\s*SSID\s*:\s*(.+)$') { $ss = $Matches[1].Trim() }
    }
    if ($ss -eq $ssid -and $state -match 'connected|已连接') { return $true }
    Start-Sleep -Milliseconds 350
  }
  return $false
}

function Get-Wifi {
  $cur = ''
  $sig = 0
  $ifOut = & $netsh wlan show interfaces 2>$null
  foreach ($l in $ifOut) {
    if ($l -match '^\s*SSID\s*:\s*(.+)$') { $cur = $Matches[1].Trim() }
    if ($l -match '^\s*信号\s*:\s*(\d+)%') { $sig = [int]$Matches[1] }
    if ($l -match '^\s*Signal\s*:\s*(\d+)%') { $sig = [int]$Matches[1] }
  }
  $saved = Get-Profiles

  # 先让网卡真扫一遍，再读 netsh 的结果：这样刚出现的新网络才能进列表
  Invoke-WlanScan
  $nets = @()
  $scan = & $netsh wlan show networks mode=bssid 2>$null
  $curSsid = $null
  $curAuth = ''
  $curSig = 0
  foreach ($l in $scan) {
    if ($l -match '^SSID\s+\d+\s*:\s*(.*)$') {
      if ($curSsid) { $nets += [pscustomobject]@{ ssid = $curSsid; auth = $curAuth; signal = $curSig } }
      $curSsid = $Matches[1].Trim()
      $curAuth = ''
      $curSig = 0
    } elseif ($l -match '^\s*Authentication\s*:\s*(.+)$') {
      $curAuth = $Matches[1].Trim()
    } elseif ($l -match '^\s*(Signal|信号)\s*:\s*(\d+)%') {
      # 同一个 SSID 可能有多颗 BSSID，取最强的那颗
      $v = [int]$Matches[2]
      if ($v -gt $curSig) { $curSig = $v }
    }
  }
  if ($curSsid) { $nets += [pscustomobject]@{ ssid = $curSsid; auth = $curAuth; signal = $curSig } }

  $list = @()
  foreach ($n in $nets) {
    if (-not $n.ssid) { continue }
    $isSaved = $false
    foreach ($s in $saved) { if ($s -eq $n.ssid) { $isSaved = $true } }
    $kind = Get-AuthKind $n.auth
    $list += [pscustomobject]@{
      ssid      = $n.ssid
      auth      = $n.auth
      kind      = $kind
      secure    = ($kind -notin @('open', 'unknown'))
      saved     = $isSaved
      current   = ($cur -eq $n.ssid)
      signal    = $n.signal
      reachable = $true
    }
  }
  # 已保存但从扫描里没出现的网络也显示出来，方便重连
  foreach ($s in $saved) {
    $hit = $false
    foreach ($n in $list) { if ($n.ssid -eq $s) { $hit = $true } }
    if (-not $hit) {
      $list += [pscustomobject]@{ ssid = $s; auth = ''; kind = 'unknown'; secure = $true; saved = $true; current = ($cur -eq $s); signal = 0; reachable = $false }
    }
  }
  # 当前 > 现场扫到的（信号强的在前）> 只剩配置的
  $sorted = @($list | Sort-Object @{ Expression = { if ($_.current) { 0 } elseif ($_.reachable) { 1 } else { 2 } } }, @{ Expression = { -1 * $_.signal } }, @{ Expression = { $_.ssid } })
  if ($cur) {
    try { [System.IO.File]::WriteAllText((Join-Path $env:TEMP 'windock-last-ssid.txt'), $cur, (New-Object System.Text.UTF8Encoding($false))) } catch { }
  }
  return [pscustomobject]@{ current = $cur; signal = $sig; networks = $sorted }
}

$saverSchemeGuid = 'a1841308-3541-4fab-bc81-f71556f20b4a'
$overlayEcoGuid  = '961cc777-2547-4f9d-8174-7d86181b8a7a'
$overlayBalGuid  = '00000000-0000-0000-0000-000000000000'
$powerKey = 'HKLM:\SYSTEM\CurrentControlSet\Control\Power\User\PowerSchemes'

# 当前方案：/list 里看不到被隐藏的「节能」方案，只有 /getactivescheme 能拿到真实在用的那个
function Get-ActiveSchemeInfo {
  $guid = ''; $name = ''
  foreach ($l in (& $powercfg /getactivescheme 2>$null)) {
    if ($l -match 'GUID:\s*([0-9a-fA-F-]{36})\s*\((.+?)\)') { $guid = $Matches[1].ToLower(); $name = $Matches[2] }
  }
  return [pscustomobject]@{ guid = $guid; name = $name }
}
# 设置页「电源模式」（最佳能效 / 平衡 / 最佳性能）就是这个 overlay 值
function Get-OverlayInfo {
  $ac = ''; $dc = ''
  $k = Get-ItemProperty $powerKey
  if ($k) {
    if ($k.ActiveOverlayAcPowerScheme) { $ac = ([string]$k.ActiveOverlayAcPowerScheme).ToLower() }
    if ($k.ActiveOverlayDcPowerScheme) { $dc = ([string]$k.ActiveOverlayDcPowerScheme).ToLower() }
  }
  return [pscustomobject]@{ ac = $ac; dc = $dc }
}
function Test-SaverName($n) { return [bool]($n -match '省电|节能|Power saver|安静|静音|Quiet|Silent|低功耗|Eco') }
function Test-EcoOverlay($g) { return ($g -eq $overlayEcoGuid) }

function Get-Power {
  $out = & $powercfg /list 2>$null
  $plans = @()
  foreach ($l in $out) {
    if ($l -match 'GUID:\s*([0-9a-fA-F-]{36}).*?\((.+?)\)') {
      $guid = $Matches[1].ToLower()
      $name = $Matches[2]
      $active = $l.TrimEnd().EndsWith('*')
      $plans += [pscustomobject]@{ guid = $guid; name = $name; active = $active }
    }
  }
  $act = Get-ActiveSchemeInfo
  $ov = Get-OverlayInfo
  if ($act.guid -and -not (@($plans) | Where-Object { $_.guid -eq $act.guid })) {
    $plans += [pscustomobject]@{ guid = $act.guid; name = $act.name; active = $true; hidden = $true }
  }
  if ($act.guid) { foreach ($p in $plans) { $p.active = ($p.guid -eq $act.guid) } }
  $saver = (($act.guid -eq $saverSchemeGuid) -or (Test-SaverName $act.name))
  return [pscustomobject]@{ plans = $plans; activeGuid = $act.guid; activeName = $act.name; saver = $saver }
}

switch ($Action) {
  'wifi-scan' { Out-Json (Get-Wifi) }
  'wifi-connect' {
    # Value 可以是纯 SSID（用已保存的配置连），也可以是 {"ssid","password","kind"} 的 JSON（现场输密码）
    $ssid = $Value; $pw = ''; $kind = ''
    if ($Value -and $Value.TrimStart().StartsWith('{')) {
      try {
        $p = $Value | ConvertFrom-Json
        $ssid = [string]$p.ssid
        $pw = [string]$p.password
        $kind = [string]$p.kind
      } catch { }
    }
    $ssid = $ssid.Trim()
    if (-not $ssid) { Out-Json ([pscustomobject]@{ ok = $false; message = '没有指定网络' }); break }
    $savedList = Get-Profiles
    $exists = ($savedList -contains $ssid)
    $added = $false
    if ($pw -and -not $exists) {
      $msg = Add-WlanProfile $ssid $pw $kind
      if ($msg -notmatch '已添加|成功|successfully|added') {
        Out-Json ([pscustomobject]@{ ok = $false; message = ('写入网络配置失败：' + $msg) }); break
      }
      $added = $true
    }
    $r = & $netsh wlan connect name="$ssid" ssid="$ssid" 2>&1
    $ok = Wait-WifiConnected $ssid 6000
    if (-not $ok -and $added) {
      # 密码不对不该留下这份配置，免得列表里多出一个连不上的「已保存」
      & $netsh wlan delete profile name="$ssid" 2>&1 | Out-Null
    }
    if ($ok) { $text = "已连接 $ssid" }
    elseif ($added) { $text = '连接失败：密码不对或信号太弱' }
    elseif ($exists) { $text = '连接失败：已保存的密码可能已变更，忘记后重新输入即可' }
    else { $text = '连接失败' }
    Out-Json ([pscustomobject]@{ ok = $ok; ssid = $ssid; added = $added; message = $text })
  }
  'wifi-forget' {
    $profileList = Get-Profiles
    if (-not ($profileList -contains $Value)) { Out-Json ([pscustomobject]@{ ok = $false; message = '没有这个已保存的网络' }); break }
    $r = & $netsh wlan delete profile name="$Value" 2>&1
    $ok = ($r -join ' ') -match '已删除|删除|deleted'
    Out-Json ([pscustomobject]@{ ok = $ok; ssid = $Value; message = (($r -join ' ') -replace '\s+', ' ').Trim() })
  }
  # 左半块用：断开当前 Wi-Fi / 重新连回上一次的网络（不需要管理员）
  'wifi-switch' {
    $lastFile = Join-Path $env:TEMP 'windock-last-ssid.txt'
    if ($Value -eq 'off') {
      $r = & $netsh wlan disconnect 2>&1
      Out-Json ([pscustomobject]@{ ok = $true; on = $false; message = (($r -join ' ') -replace '\s+', ' ').Trim() })
    } else {
      $target = ''
      if (Test-Path $lastFile) { $target = (Get-Content $lastFile -Raw).Trim() }
      if (-not $target) {
        $profOut = & $netsh wlan show profiles 2>$null
        foreach ($l in $profOut) {
          if ($l -match '^\s*All User Profile\s*:\s*(.+)$') { $target = $Matches[1].Trim(); break }
          if ($l -match '^\s*所有用户配置文件\s*:\s*(.+)$') { $target = $Matches[1].Trim(); break }
        }
      }
      if (-not $target) { Out-Json ([pscustomobject]@{ ok = $false; on = $false; message = '没有保存过的网络' }); break }
      $r = & $netsh wlan connect name="$target" 2>&1
      $ok = ($r -join ' ') -match '已成功|successfully|完成'
      Out-Json ([pscustomobject]@{ ok = $ok; on = $ok; message = ($target + ' ' + (($r -join ' ') -replace '\s+', ' ')).Trim() })
    }
  }
  'magnifier-state' {
    $p = Get-Process magnify -ErrorAction SilentlyContinue
    Out-Json ([pscustomobject]@{ on = [bool]$p })
  }
  'magnifier-toggle' {
    $p = Get-Process magnify -ErrorAction SilentlyContinue
    if ($p) {
      $p | Stop-Process -Force
      Out-Json ([pscustomobject]@{ ok = $true; on = $false; message = '放大镜已关闭' })
    } else {
      Start-Process -FilePath (Join-Path $env:WINDIR 'System32\magnify.exe')
      Out-Json ([pscustomobject]@{ ok = $true; on = $true; message = '放大镜已开启' })
    }
  }
  'power-saver' {
    # 开：真的切到「节能」电源方案（Windows 会据此自动把设置里的电源模式调成最佳能效）
    # 关：回到开启之前的那个方案；每次切完都回读一遍确认，没切成功就如实返回 ok=false
    $prevFile = Join-Path $env:TEMP 'windock-power-prev.txt'
    $now = Get-ActiveSchemeInfo
    $isSaver = (($now.guid -eq $saverSchemeGuid) -or (Test-SaverName $now.name))
    if ($isSaver) {
      $back = '381b4222-f694-41f0-9685-ff5bb260df2e'
      if (Test-Path $prevFile) {
        $saved = (Get-Content $prevFile -Raw).Trim()
        if ($saved) { $back = $saved }
      }
      $r = & $powercfg /setactive $back 2>&1
      $after = Get-ActiveSchemeInfo
      $still = (($after.guid -eq $saverSchemeGuid) -or (Test-SaverName $after.name))
      $msg = ''
      if ($still) {
        $msg = ((($r -join ' ') -replace '\s+', ' ').Trim())
        if (-not $msg) { $msg = '没能恢复上一个电源方案' }
      }
      Out-Json ([pscustomobject]@{ ok = (-not $still); on = $still; active = $after.name; message = $msg })
    } else {
      if ($now.guid) { [System.IO.File]::WriteAllText($prevFile, [string]$now.guid, (New-Object System.Text.UTF8Encoding($false))) }
      $r = & $powercfg /setactive $saverSchemeGuid 2>&1
      $after = Get-ActiveSchemeInfo
      $on = (($after.guid -eq $saverSchemeGuid) -or (Test-SaverName $after.name))
      $msg = ''
      if (-not $on) {
        $msg = ((($r -join ' ') -replace '\s+', ' ').Trim())
        if (-not $msg) { $msg = '系统没有允许切换，可能需要管理员权限' }
      }
      Out-Json ([pscustomobject]@{ ok = $on; on = $on; active = $after.name; message = $msg })
    }
  }
  'wifi-toggle' {
    $out = & $netsh interface show interface 2>$null
    $name = 'WLAN'
    foreach ($l in $out) {
      if ($l -match 'WLAN|Wi-Fi|无线') {
        $parts = ($l -split '\s{2,}')
        if ($parts.Count -ge 4) { $name = $parts[3].Trim() }
        break
      }
    }
    if ($Value -eq 'off') {
      $r = & $netsh interface set interface "$name" disable 2>&1
      Out-Json ([pscustomobject]@{ ok = ($r -notmatch '拒绝访问|Access is denied|error'); message = (($r -join ' ') -replace '\s+',' ').Trim() })
    } else {
      $r = & $netsh interface set interface "$name" enable 2>&1
      Out-Json ([pscustomobject]@{ ok = ($r -notmatch '拒绝访问|Access is denied|error'); message = (($r -join ' ') -replace '\s+',' ').Trim() })
    }
  }
  'radio-state' { Out-Json (Read-Radio) }
  'radio-set' {
    # Value: wifi:on / wifi:off / all:on / all:off
    foreach ($item in ($Value -split ',')) {
      if (-not $item) { continue }
      $parts = ($item -split ':')
      $what = [string]$parts[0]
      $on = ($parts.Count -gt 1 -and [string]$parts[1] -eq 'on')
      if ($what -eq 'all' -or $what -eq 'wifi') { Set-Radio $on | Out-Null }
    }
    $after = Read-Radio
    Out-Json ([pscustomobject]@{ ok = $true; wifi = $(if ($after) { $after.wifi } else { $null }) })
  }
  'power-list' { Out-Json (Get-Power) }
  'power-set' {
    $r = & $powercfg /setactive $Value 2>&1
    Out-Json ([pscustomobject]@{ ok = (-not $r); message = (($r -join ' ') -replace '\s+',' ').Trim() })
  }
  'display-mode' {
    $arg = @{ internal = '/internal'; clone = '/clone'; extend = '/extend'; external = '/external' }[$Value]
    if (-not $arg) { $arg = '/internal' }
    Start-Process -FilePath $dswitch -ArgumentList $arg -WindowStyle Hidden
    Out-Json ([pscustomobject]@{ ok = $true; message = $arg })
  }
  'access-launch' {
    $exe = @{ magnifier = 'magnify.exe'; osk = 'osk.exe'; narrator = 'narrator.exe' }[$Value]
    if (-not $exe) { Out-Json ([pscustomobject]@{ ok = $false; message = 'unknown' }); break }
    Start-Process -FilePath (Join-Path $env:WINDIR ("System32\" + $exe)) -WindowStyle Hidden
    Out-Json ([pscustomobject]@{ ok = $true; message = $exe })
  }
  'ping' { Out-Json ([pscustomobject]@{ ok = $true; message = 'pong' }) }
  default { Out-Json ([pscustomobject]@{ ok = $false; message = ('unknown action ' + $Action) }) }
}
