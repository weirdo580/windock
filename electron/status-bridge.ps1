# 一次性采集本机系统状态（Wi-Fi / 电池 / 输入法 / 亮度），输出一行 UTF-8 JSON。
# 由主进程在 status:get 时拉起；采集失败的字段返回 null，不影响其它项。
# 注意：只用 PowerShell 5.1 也能解析的写法，避免 here-string 与深嵌套。
param([int]$SelfPid = 0)
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$Utf8 = [System.Text.UTF8Encoding]::new($false)

$result = [ordered]@{
  wifi       = @{ connected = $false; ssid = ''; signal = 0 }
  battery    = $null
  ime        = 'zh'
  brightness = $null
}

# ---------- Wi-Fi ----------
try {
  $netsh = Join-Path $env:WINDIR 'System32\netsh.exe'
  $wifi = & $netsh wlan show interfaces
  $stateLine = ($wifi | Select-String 'State\s*:\s*(.+)').Matches
  if ($stateLine.Count -gt 0) {
    $state = $stateLine[0].Groups[1].Value.Trim()
    if ($state -eq 'connected') {
      $ssidLine = ($wifi | Select-String 'SSID\s*:\s*(.+)').Matches
      $sigLine = ($wifi | Select-String 'Signal\s*:\s*(\d+)%').Matches
      $result.wifi.connected = $true
      if ($ssidLine.Count -gt 0) { $result.wifi.ssid = $ssidLine[0].Groups[1].Value.Trim() }
      if ($sigLine.Count -gt 0) { $result.wifi.signal = [int]$sigLine[0].Groups[1].Value }
    }
  }
} catch { }

# ---------- 电池（插电 / 充电 / 电量 / 是否充满） ----------
try {
  Add-Type -AssemblyName System.Windows.Forms
  $br = [System.Windows.Forms.SystemInformation]::PowerStatus
  if (($br.BatteryChargeStatus -band [System.Windows.Forms.BatteryChargeStatus]::NoSystemBattery) -eq 0) {
    $pct = [int][Math]::Round(($br.BatteryLifePercent * 100))
    if ($pct -lt 0) { $pct = 0 }
    if ($pct -gt 100) { $pct = 100 }
    $ac = ($br.PowerLineStatus -eq [System.Windows.Forms.PowerLineStatus]::Online)
    $result.battery = @{
      percent  = $pct
      charging = (($br.BatteryChargeStatus -band [System.Windows.Forms.BatteryChargeStatus]::Charging) -ne 0)
      ac       = $ac
      full     = ($pct -ge 100 -and $ac)
    }
  }
} catch { }

# ---------- 屏幕亮度 ----------
try {
  $mon = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness | Select-Object -First 1
  if ($mon) { $result.brightness = [int]$mon.CurrentBrightness }
} catch { }

# ---------- 输入法（前台窗口当前键盘布局） ----------
try {
  $sig = '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();' +
         '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);' +
         '[DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint tid);'
  $src = 'using System;using System.Runtime.InteropServices;public class ImeX{' + $sig + '}'
  Add-Type -TypeDefinition $src
  $hw = [ImeX]::GetForegroundWindow()
  $bp = 0
  $tid = [ImeX]::GetWindowThreadProcessId($hw, [ref]$bp)
  $kl = [ImeX]::GetKeyboardLayout($tid)
  $lang = $kl.ToInt64() -band 0xFFFF
  # 记住“用户自己正在用的前台窗口”，供切换输入法时把焦点还回去
  try {
    if ($hw -ne [IntPtr]::Zero -and ($SelfPid -eq 0 -or $bp -ne $SelfPid)) {
      $cache = Join-Path $env:TEMP 'windock-ime-target.txt'
      [System.IO.File]::WriteAllText($cache, $hw.ToInt64().ToString())
    }
  } catch { }
  # 只区分中文/英文：0x0804 简体中文
  if ($lang -eq 0x0804) {
    # 是中文布局时，再看 IME 转换模式：开启 NATIVE 才是“中”，否则是“英”
    $result.ime = 'zh'
    try {
      $sig2 = '[DllImport("imm32.dll")] public static extern IntPtr ImmGetContext(IntPtr h);' +
              '[DllImport("imm32.dll")] public static extern bool ImmGetConversionStatus(IntPtr ctx, out int conv, out int sentence);' +
              '[DllImport("imm32.dll")] public static extern bool ImmReleaseContext(IntPtr h, IntPtr ctx);'
      $src2 = 'using System;using System.Runtime.InteropServices;public class ImeY{' + $sig2 + '}'
      Add-Type -TypeDefinition $src2
      $ctx = [ImeY]::ImmGetContext($hw)
      if ($ctx -ne [IntPtr]::Zero) {
        $conv = 0
        $sent = 0
        if ([ImeY]::ImmGetConversionStatus($ctx, [ref]$conv, [ref]$sent)) {
          # IME_CMODE_NATIVE = 0x0001
          if (($conv -band 0x0001) -ne 0) { $result.ime = 'zh' } else { $result.ime = 'en' }
        }
        [ImeY]::ImmReleaseContext($hw, $ctx) | Out-Null
      }
    } catch { }
  } else { $result.ime = 'en' }
} catch { }

$json = $result | ConvertTo-Json -Compress -Depth 4
$bytes = $Utf8.GetBytes($json)
$out = [Console]::OpenStandardOutput()
$out.Write($bytes, 0, $bytes.Length)
$out.Flush()
