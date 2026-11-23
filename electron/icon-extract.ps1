param([string]$Exe, [string]$Out)

# Take the largest embedded icon (256 -> 48), fall back to the associated icon.
# Used by main process when Electron's app.getFileIcon returns empty (protected System32 apps).
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class IcoX{[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern uint PrivateExtractIcons(string f,int i,int cx,int cy,IntPtr[] h,uint[] ids,uint n,uint fl);[DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr h);}'

$ExtractSource = $Exe
if ([System.IO.Path]::GetExtension($Exe).ToLowerInvariant() -eq '.lnk') {
  try {
    $Shell = New-Object -ComObject WScript.Shell
    $Shortcut = $Shell.CreateShortcut($Exe)
    $Target = [string]$Shortcut.TargetPath
    if ($Target -and [System.IO.File]::Exists($Target)) { $ExtractSource = $Target }
  } catch { }
}

try {
  $h = New-Object 'IntPtr[]' 1
  $id = New-Object 'uint32[]' 1
  foreach ($sz in @(256, 128, 64, 48, 32)) {
    $n = [IcoX]::PrivateExtractIcons($ExtractSource, 0, $sz, $sz, $h, $id, 1, 0)
    if ($n -gt 0 -and $h[0] -ne [IntPtr]::Zero) {
      $ico = [System.Drawing.Icon]::FromHandle($h[0])
      $bmp = $ico.ToBitmap()
      $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $bmp.Dispose()
      [void][IcoX]::DestroyIcon($h[0])
      Write-Output '{"ok":true}'
      return
    }
  }

  $ico2 = [System.Drawing.Icon]::ExtractAssociatedIcon($ExtractSource)
  if ($null -ne $ico2) {
    $bmp2 = $ico2.ToBitmap()
    $bmp2.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp2.Dispose()
    Write-Output '{"ok":true}'
    return
  }
  Write-Output '{"ok":false}'
} catch {
  Write-Output ('{"ok":false,"err":"' + ($_.Exception.Message -replace '"', "'") + '"}')
}
