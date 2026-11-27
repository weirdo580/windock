param()
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -Language CSharp @"
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume {
  int _0();
  int _1();
  int _2();
  int _3();
  int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
  int _5();
  int GetMasterVolumeLevelScalar(out float pfLevel);
  int _7();
  int _8();
  int _9();
  int _10();
  int SetMute(bool bMute, Guid pguidEventContext);
  int GetMute(out bool pbMute);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  int Activate(ref Guid id, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object aev);
}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int _0();
  int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }
public class WinDockAudio {
  static IAudioEndpointVolume Vol() {
    IMMDeviceEnumerator en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    IMMDevice dev = null;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev));
    Guid iid = typeof(IAudioEndpointVolume).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    return (IAudioEndpointVolume)o;
  }
  public static int GetLevel() {
    float f;
    Marshal.ThrowExceptionForHR(Vol().GetMasterVolumeLevelScalar(out f));
    return (int)Math.Round(f * 100);
  }
  public static void SetLevel(int pct) {
    Guid g = Guid.Empty;
    float f = Math.Max(0, Math.Min(100, pct)) / 100f;
    Marshal.ThrowExceptionForHR(Vol().SetMasterVolumeLevelScalar(f, g));
  }
  public static bool GetMute() {
    bool b;
    Marshal.ThrowExceptionForHR(Vol().GetMute(out b));
    return b;
  }
  public static void SetMute(bool m) {
    Guid g = Guid.Empty;
    Marshal.ThrowExceptionForHR(Vol().SetMute(m, g));
  }
}
"@

function Get-Bright {
  try {
    $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop
    if ($m) { return [int](($m | Select-Object -First 1).CurrentBrightness) }
  } catch { }
  return $null
}

function Set-Bright([int]$v) {
  try {
    Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop |
      Invoke-CimMethod -MethodName WmiSetBrightness -Arguments @{ Brightness = [byte]$v; Timeout = [uint32]0 } | Out-Null
    return $true
  } catch { return $false }
}

function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 5))
  [Console]::Out.Flush()
}

Emit @{ id = 0; ok = $true; ready = $true }

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if (-not $line) { continue }

  $id = 0
  $cmd = ''
  $v = $null
  try {
    $o = $line | ConvertFrom-Json
    $id = [int]$o.id
    $cmd = [string]$o.cmd
    $v = $o.v
  } catch { $cmd = $line }

  $out = @{ id = $id; ok = $true }

  switch ($cmd) {
    'volume' {
      $pct = [int]([double]$v)
      [WinDockAudio]::SetLevel($pct)
      $out.volume = @{ level = [WinDockAudio]::GetLevel(); muted = [WinDockAudio]::GetMute() }
    }
    'mute' {
      [WinDockAudio]::SetMute([bool]$v)
      $out.volume = @{ level = [WinDockAudio]::GetLevel(); muted = [WinDockAudio]::GetMute() }
    }
    'brightness' {
      $bv = [int]([double]$v)
      $out.ok = (Set-Bright $bv)
      $out.brightness = $bv
    }
    'get' {
      $out.volume = @{ level = [WinDockAudio]::GetLevel(); muted = [WinDockAudio]::GetMute() }
      $out.brightness = Get-Bright
    }
    default { $out.ok = $false }
  }

  Emit $out
}
