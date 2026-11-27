param(
  [int]$SelfPid = 0,
  [int]$IntervalMs = 1000
)
# Long running status watcher: prints one JSON line per tick.
# 轻采样：无线 radio / 电源计划 / Wi-Fi 每 3 拍，电量每 8 拍；
# 亮度由常驻控制进程（status-ctl.ps1）回读，这里不碰 WMI，避免整机发卡。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$Utf8 = [System.Text.UTF8Encoding]::new($false)
$stdout = [Console]::OpenStandardOutput()

$netsh = Join-Path $env:WINDIR 'System32\netsh.exe'
$powercfg = Join-Path $env:WINDIR 'System32\powercfg.exe'
$lastWifi = @{ connected = $false; ssid = ''; signal = 0 }
$lastBat = $null
$lastRadio = @{ wifi = 'On' }
$lastPower = 'normal'
$tick = 0

# ---- WinRT Radio：真正和 Windows「飞行模式」一致的状态源 ----
$radioReady = $false
$asTaskGeneric = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  [Windows.Devices.Radios.Radio, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
  $radioReady = $true
} catch { $radioReady = $false }

# ---- 电池：WinForms PowerStatus（复用系统电源状态，每拍都能读，不用 WMI；
#      能分清「插着电但没充」和「正在充电」，拔电/插电一秒内就跟上）----
$script:powerReady = $false
try { Add-Type -AssemblyName System.Windows.Forms; $script:powerReady = $true } catch { $script:powerReady = $false }
function Read-Battery {
  if (-not $script:powerReady) { return $null }
  try {
    $br = [System.Windows.Forms.SystemInformation]::PowerStatus
    if (($br.BatteryChargeStatus -band [System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery) -ne 0) { return $null }
    $pct = [int][Math]::Round(($br.BatteryLifePercent * 100))
    if ($pct -lt 0) { $pct = 0 }
    if ($pct -gt 100) { $pct = 100 }
    $ac = ($br.PowerLineStatus -eq [System.Windows.Forms.PowerLineStatus]::Online)
    $chg = (($br.BatteryChargeStatus -band [System.Windows.Forms.BatteryChargeStatus]::Charging) -ne 0)
    return @{
      percent  = $pct
      charging = $chg
      ac       = $ac
      full     = ($pct -ge 100 -and $ac)
    }
  } catch { return $null }
}

function Await-Radio($op, $type) {  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(3000) | Out-Null
  return $task.Result
}
function Read-Radio {
  if (-not $radioReady) { return $null }
  try {
    $list = Await-Radio ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
    $wifi = 'Unknown'
    foreach ($r in $list) {
      if ($r.Kind -eq [Windows.Devices.Radios.RadioKind]::WiFi) { $wifi = [string]$r.State }

    }
    return @{ wifi = $wifi }
  } catch { return $null }
}

# ---- 一次性探测：这台电脑真的有什么。没有的模块前端就不显示，避免出现按了没反应的假控件 ----
function Read-Caps {
  $c = @{ battery = $false; brightness = $false; wifi = $false; ime = $false }
  try {
    $br = [System.Windows.Forms.SystemInformation]::PowerStatus
    $c.battery = (($br.BatteryChargeStatus -band [System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery) -eq 0)
  } catch { }
  try {
    $mon = @(Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop)
    $c.brightness = ($mon.Count -gt 0)
  } catch { }
  try {
    $nic = @(Get-NetAdapter -Physical -ErrorAction Stop | Where-Object { $_.InterfaceDescription -match 'Wi-Fi|Wireless|WLAN|802\.11|无线' })
    $c.wifi = ($nic.Count -gt 0)
  } catch { }
  if (-not $c.wifi) {
    try {
      $wout = (& $netsh wlan show interfaces) | Out-String
      if ($wout -match '(?m)^\s*(Name|名称)\s*:') { $c.wifi = $true }
    } catch { }
  }
  if (-not $c.wifi -and $radioReady) {
    try {
      $r = Read-Radio
      if ($r) { $c.wifi = $true }
    } catch { }
  }
  try {
    $c.ime = ([System.Windows.Forms.InputLanguage]::InstalledInputLanguages.Count -gt 1)
  } catch { }
  return $c
}

$caps = Read-Caps

while ($true) {
  $result = [ordered]@{
    wifi    = @{ connected = $lastWifi.connected; ssid = $lastWifi.ssid; signal = $lastWifi.signal }
    battery = $lastBat
    radio   = $lastRadio
    power   = $lastPower
    caps    = $caps
  }

  if (($tick % 3) -eq 0) {
    # 无线 radio（Wi-Fi 的真实开关状态）
    $r = Read-Radio
    if ($r) { $lastRadio = $r }
    $result.radio = $lastRadio

    # Wi-Fi 详情（netsh 较慢，和 radio 一起每 3 拍一次）
    try {
      $wifi = & $netsh wlan show interfaces
      $stateLine = ($wifi | Select-String 'State\s*:\s*(.+)').Matches
      $w = @{ connected = $false; ssid = ''; signal = 0 }
      if ($stateLine.Count -gt 0) {
        $st = $stateLine[0].Groups[1].Value.Trim()
        if ($st -eq 'connected') {
          $ssidLine = ($wifi | Select-String 'SSID\s*:\s*(.+)').Matches
          $sigLine = ($wifi | Select-String 'Signal\s*:\s*(\d+)%').Matches
          $w.connected = $true
          if ($ssidLine.Count -gt 0) { $w.ssid = $ssidLine[0].Groups[1].Value.Trim() }
          if ($sigLine.Count -gt 0) { $w.signal = [int]$sigLine[0].Groups[1].Value }
        }
      }
      $lastWifi = $w
      $result.wifi = @{ connected = $w.connected; ssid = $w.ssid; signal = $w.signal }
    } catch { }

  }

  # 电源计划：省电（节能）为 saver，其余 normal。每 2 拍查一次，拔电后开省电能很快变黄
  if (($tick % 2) -eq 0) {
    try {
      $line = (& $powercfg /getactivescheme) -join ' '
      if ($line -match '省电|节能|Power saver') { $lastPower = 'saver' } else { $lastPower = 'normal' }
    } catch { }
    $result.power = $lastPower
  }

  # 电量/插电/充电：每拍都读，图标颜色和格子实时跟着变
  $batNow = Read-Battery
  if ($batNow) { $lastBat = $batNow }
  $result.battery = $lastBat

  $json = $result | ConvertTo-Json -Compress -Depth 4
  $bytes = $Utf8.GetBytes($json + "`n")
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()

  $tick++
  Start-Sleep -Milliseconds $IntervalMs
}
