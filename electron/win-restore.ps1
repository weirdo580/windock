param([string]$Hwnd)

# 还原指定 hwnd 的最小化窗口：powershell -File win-restore.ps1 <hwnd>
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Restorer {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
}
"@

try {
  $h = [IntPtr]([long]$Hwnd)
  [void][Restorer]::ShowWindowAsync($h, 9)   # SW_RESTORE
  Start-Sleep -Milliseconds 60
  [void][Restorer]::SetForegroundWindow($h)
  Write-Output '{"ok":true}'
} catch {
  Write-Output '{"ok":false}'
}
