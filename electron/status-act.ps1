param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$Value = 0,
  [int]$SelfPid = 0
)
$ErrorActionPreference = 'SilentlyContinue'

switch ($Action) {
  'brightness' {
    # real monitor brightness via WMI
    $v = [int][Math]::Max(0, [Math]::Min(100, $Value))
    Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods |
      Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Brightness = $v; Timeout = 0 } | Out-Null
  }
  'volume' {
    # step the system volume by 2% per key event
    Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class KeyX {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
}
"@
    $vk = if ($Value -ge 0) { 0xAF } else { 0xAE }
    $steps = [Math]::Min(50, [Math]::Abs($Value))
    for ($i = 0; $i -lt $steps; $i++) {
      [KeyX]::keybd_event($vk, 0, 0, [IntPtr]::Zero)
      [KeyX]::keybd_event($vk, 0, 2, [IntPtr]::Zero)
      Start-Sleep -Milliseconds 18
    }
  }
  'mute' {
    Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class KeyY {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
}
"@
    [KeyY]::keybd_event(0xAD, 0, 0, [IntPtr]::Zero)
    [KeyY]::keybd_event(0xAD, 0, 2, [IntPtr]::Zero)
  }

  'ime' {
    # Switch the user's own app between Chinese and English input mode.
    # 1) bring the last non-WinDock foreground window back to the front (clicking
    #    the Dock takes focus away, so a plain key injection would hit the Dock)
    # 2) tap Shift inside that window's thread: Microsoft Pinyin / Sogou toggle
    Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public class KeyZ {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern byte MapVirtualKeyA(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
}
"@
    $cache = Join-Path $env:TEMP 'windock-ime-target.txt'
    $cached = [Int64]0
    if (Test-Path $cache) {
      $raw = [System.IO.File]::ReadAllText($cache)
      if ($raw -match '^\d+$') { $cached = [Int64]$raw }
    }

    $fg = [KeyZ]::GetForegroundWindow()
    $fgPid = 0
    if ($fg -ne [IntPtr]::Zero) { [KeyZ]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null }
    $owned = ($fgPid -ne 0 -and $SelfPid -ne 0 -and $fgPid -eq $SelfPid)
    # the window in front right now is the app the user is typing in: WinDock's
    # own windows are non-activating, so simply tapping Shift there is exactly
    # like the user pressing Shift. Only when the front window belongs to WinDock
    # do we fall back to the last window the watcher recorded.
    $target = [Int64]0
    if ($fg -ne [IntPtr]::Zero -and -not $owned -and -not [KeyZ]::IsIconic($fg)) {
      $target = $fg.ToInt64()
    } elseif ($cached -gt 0) {
      $ch = [IntPtr]$cached
      if ([KeyZ]::IsWindow($ch) -and -not [KeyZ]::IsIconic($ch)) { $target = $cached }
    }
    if ($target -le 0) { Write-Output 'ime-fail'; break }
    $h = [IntPtr]$target
    if (-not [KeyZ]::IsWindow($h)) { Write-Output 'ime-fail'; break }

    # hand the front position to that window when it is not already in front
    if ([KeyZ]::GetForegroundWindow() -ne $h) {
      $bp = 0
      $tid = [KeyZ]::GetWindowThreadProcessId($h, [ref]$bp)
      $me = [KeyZ]::GetCurrentThreadId()
      # attach to the target thread so SetForegroundWindow is not refused by the
      # foreground lock
      [KeyZ]::AttachThreadInput($me, $tid, $true) | Out-Null
      [KeyZ]::SetForegroundWindow($h) | Out-Null
      [KeyZ]::BringWindowToTop($h) | Out-Null
      Start-Sleep -Milliseconds 60
      [KeyZ]::AttachThreadInput($me, $tid, $false) | Out-Null

      $ok = $false
      for ($i = 0; $i -lt 6; $i++) {
        if ([KeyZ]::GetForegroundWindow() -eq $h) { $ok = $true; break }
        [KeyZ]::SwitchToThisWindow($h, $false)
        Start-Sleep -Milliseconds 70
      }
      if (-not $ok) { Write-Output 'ime-fail'; break }
    }

    # let the IME re-attach to that window, then toggle with a real Shift
    Start-Sleep -Milliseconds 160
    $scan = [KeyZ]::MapVirtualKeyA(0x10, 0)
    [KeyZ]::keybd_event(0x10, $scan, 0, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    [KeyZ]::keybd_event(0x10, $scan, 2, [IntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    Write-Output 'ime-ok'
  }
}
