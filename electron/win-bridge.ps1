# Minimized-windows bridge + dock z-order keeper.
# Emits one JSON line every ~200ms:
# {"ok":true,"fullscreen":false,"z":"top|below|free|","items":[{"h":<hwnd>,"t":"<title>","e":"<exe path>"}]}
#
# z reports the dock layer that was enforced this tick:
#   top   = kept above normal windows (nothing overlaps the dock card)
#   below = pushed under a window that overlaps the dock card
#   free  = dock card is clear, alwaysOnTop disabled by config
#   ""    = not managed (auto-hide mode, dock hidden, or handle missing)
param([int]$DockPid = 0, [string]$DockHwnd = '0', [string]$ZoneFile = '')
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class MinWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO {
    public int cbSize;
    public RECT rcMonitor;
    public RECT rcWork;
    public uint dwFlags;
  }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr OpenProcess(uint a, bool b, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, int f, StringBuilder s, ref int n);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h, ref MONITORINFO info);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr h, out uint key, out byte alpha, out uint flags);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int val, int size);

  const int GWL_EXSTYLE = -20;
  const int WS_EX_TOPMOST = 0x00000008;
  const int WS_EX_LAYERED = 0x00080000;
  const int DWMWA_CLOAKED = 14;
  static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
  static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
  static readonly IntPtr HWND_TOP = new IntPtr(0);
  const uint SWP_NOSIZE = 0x0001;
  const uint SWP_NOMOVE = 0x0002;
  const uint SWP_NOACTIVATE = 0x0010;
  const uint SWP_NOOWNERZORDER = 0x0200;
  const uint SWP_NOSENDCHANGING = 0x0400;
  const uint ZFLAGS = SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING;

  static string ExeOf(uint pid) {
    IntPtr hp = OpenProcess(0x1000, false, pid);
    if (hp == IntPtr.Zero) return "";
    StringBuilder sb = new StringBuilder(1024);
    int n = 1024;
    bool ok = QueryFullProcessImageName(hp, 0, sb, ref n);
    CloseHandle(hp);
    return ok ? sb.ToString(0, n) : "";
  }

  public static List<string> List() {
    List<string> rows = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || !IsIconic(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;
      StringBuilder sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      string t = sb.ToString().Trim();
      if (t.Length == 0) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      string e = ExeOf(pid);
      rows.Add(((long)h.ToInt64()).ToString() + "\u0001" + t.Replace("\u0001", " ") + "\u0001" + e);
      return true;
    }, IntPtr.Zero);
    return rows;
  }

  public static bool IsForegroundFullscreen(uint dockPid) {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return false;
    uint pid;
    GetWindowThreadProcessId(h, out pid);
    if (pid == dockPid) return false;

    StringBuilder cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    string clsName = cls.ToString();
    if (clsName == "Progman" || clsName == "WorkerW" || clsName == "Shell_TrayWnd") return false;

    // A maximized normal window is not fullscreen. It is zoomed and still has
    // a caption; Chromium may extend its client area under the taskbar.
    // A real fullscreen window either is not zoomed or has no caption
    // (Electron/Chromium fullscreen uses a borderless client covering the screen).
    if (IsIconic(h)) return false;
    if (IsZoomed(h)) {
      int style = GetWindowLong(h, -16);
      if ((style & 0x00C00000) != 0) return false;
    }
    // Compare the client area, not the window rect: a maximized window's DWM
    // frame can extend a few pixels past the monitor, which must not be treated
    // as fullscreen. A real fullscreen window's client area covers the monitor.
    RECT cr;
    if (!GetClientRect(h, out cr)) return false;
    POINT origin;
    origin.X = 0; origin.Y = 0;
    if (!ClientToScreen(h, ref origin)) return false;
    RECT r;
    r.Left = origin.X;
    r.Top = origin.Y;
    r.Right = origin.X + (cr.Right - cr.Left);
    r.Bottom = origin.Y + (cr.Bottom - cr.Top);
    IntPtr monitor = MonitorFromWindow(h, 2);
    if (monitor == IntPtr.Zero) return false;
    MONITORINFO info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    if (!GetMonitorInfo(monitor, ref info)) return false;

    RECT m = info.rcMonitor;
    const int tolerance = 2;
    // Use "covers the whole monitor" instead of exact rect equality: games
    // switched to another resolution can report a larger client area.
    return r.Left <= m.Left + tolerance
      && r.Top <= m.Top + tolerance
      && r.Right >= m.Right - tolerance
      && r.Bottom >= m.Bottom - tolerance;
  }

  // ---------------- dock z-order ----------------

  static bool IsTopMost(IntPtr h) {
    return (GetWindowLong(h, GWL_EXSTYLE) & WS_EX_TOPMOST) != 0;
  }

  // Windows on another virtual desktop and UWP windows on their way out stay
  // in the z-order with real rectangles; treating them as visible would keep
  // the dock pinned underneath an invisible window.
  static bool IsCloaked(IntPtr h) {
    try {
      int v;
      if (DwmGetWindowAttribute(h, DWMWA_CLOAKED, out v, sizeof(int)) != 0) return false;
      return v != 0;
    } catch (Exception) { return false; }
  }

  // Fully transparent click-through overlays (recording HUDs, wallpaper
  // layers) report a full-screen rect but show nothing.
  static bool IsInvisibleLayered(IntPtr h) {
    if ((GetWindowLong(h, GWL_EXSTYLE) & WS_EX_LAYERED) == 0) return false;
    uint key;
    byte alpha;
    uint flags;
    if (!GetLayeredWindowAttributes(h, out key, out alpha, out flags)) return false;
    return (flags & 0x00000001) != 0 && alpha == 0;
  }

  static bool IsShellWindow(string cls) {
    switch (cls) {
      case "Progman":
      case "WorkerW":
      case "Shell_TrayWnd":
      case "Shell_SecondaryTrayWnd":
      case "SysShadow":
      case "ForegroundStaging":
      case "tooltips_class32":
      case "TaskListThumbnailWnd":
      case "MultitaskingViewFrame":
      case "XamlExplorerHostIslandWindow":
      case "Windows.UI.Core.CoreWindow":
        return true;
    }
    return false;
  }

  // True when the window is a real, on-screen application window whose rect
  // overlaps the dock card rect it is compared against.
  static bool Blocks(IntPtr h, IntPtr dock, int l, int t, int r, int b) {
    if (h == dock) return false;
    if (!IsWindowVisible(h) || IsIconic(h)) return false;
    StringBuilder cls = new StringBuilder(256);
    GetClassName(h, cls, 256);
    if (IsShellWindow(cls.ToString())) return false;
    if (IsCloaked(h)) return false;
    RECT wr;
    if (!GetWindowRect(h, out wr)) return false;
    if (wr.Right - wr.Left <= 0 || wr.Bottom - wr.Top <= 0) return false;
    if (IsInvisibleLayered(h)) return false;
    return wr.Left < r && wr.Right > l && wr.Top < b && wr.Bottom > t;
  }

  public static IntPtr ResolveDock(IntPtr hint, uint dockPid) {
    if (hint != IntPtr.Zero && IsWindow(hint)) return hint;
    IntPtr best = IntPtr.Zero;
    long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      if (pid != dockPid) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }

  public static RECT DockRect(IntPtr h) {
    RECT r;
    if (!IsWindow(h) || !IsWindowVisible(h) || !GetWindowRect(h, out r)) {
      return new RECT();
    }
    return r;
  }

  // Apply the configured layer: always-on-top wins over normal windows; when it
  // is off, the dock is sunk below the deepest window overlapping its card.
  public static string ApplyZOrder(IntPtr dockHint, uint dockPid, int zl, int zt, int zr, int zb, bool wantTop) {
    IntPtr dock = ResolveDock(dockHint, dockPid);
    if (dock == IntPtr.Zero) return "";
    if (zr <= zl || zb <= zt) return "";
    if (!IsWindowVisible(dock)) return "";

    IntPtr lastOverlap = IntPtr.Zero;
    int lastOverlapIndex = -1;
    IntPtr desktopWnd = IntPtr.Zero;
    int desktopIndex = -1;
    int dockIndex = -1;
    int i = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h == dock) {
        dockIndex = i;
      } else {
        StringBuilder cls = new StringBuilder(256);
        GetClassName(h, cls, 256);
        string cn = cls.ToString();
        // The desktop shell (Progman / wallpaper WorkerW) is the floor: the
        // dock must never sink below it, or a desktop refresh hides the dock
        // behind the wallpaper. Remember the topmost such window.
        if ((cn == "Progman" || cn == "WorkerW") && IsWindowVisible(h) && desktopWnd == IntPtr.Zero) {
          desktopWnd = h; desktopIndex = i;
        }
        if (Blocks(h, dock, zl, zt, zr, zb)) {
          lastOverlap = h; lastOverlapIndex = i; // deepest overlap wins
        }
      }
      i++;
      return true;
    }, IntPtr.Zero);

    if (dockIndex < 0) return "";

    // Always-on-top on: bring the dock above every normal window immediately.
    if (wantTop) {
      if (!IsTopMost(dock)) SetWindowPos(dock, HWND_TOPMOST, 0, 0, 0, 0, ZFLAGS);
      return "top";
    }

    // Always-on-top off: clear topmost, then sink below the deepest overlapping
    // window — but never below the desktop shell. When the desktop is focused,
    // Explorer raises Progman above every app window, so sinking below an app
    // would also drop the dock behind the wallpaper; clamp to the desktop floor.
    if (IsTopMost(dock)) SetWindowPos(dock, HWND_NOTOPMOST, 0, 0, 0, 0, ZFLAGS);
    // Anchor that places the dock just ABOVE the desktop shell. HWND_NOTOPMOST
    // is a no-op once the dock is already non-topmost, so insert relative to the
    // window that currently sits directly above Progman/WorkerW instead.
    IntPtr aboveDesktop = IntPtr.Zero;
    if (desktopWnd != IntPtr.Zero) {
      aboveDesktop = GetWindow(desktopWnd, 3 /* GW_HWNDPREV */);
      if (aboveDesktop == IntPtr.Zero || aboveDesktop == dock) aboveDesktop = HWND_TOP;
    }
    if (lastOverlap != IntPtr.Zero) {
      if (desktopWnd != IntPtr.Zero && lastOverlapIndex > desktopIndex) {
        // Overlapping window is below the desktop shell (desktop focused):
        // keep the dock above the wallpaper rather than hiding it.
        if (aboveDesktop != IntPtr.Zero) SetWindowPos(dock, aboveDesktop, 0, 0, 0, 0, ZFLAGS);
      } else {
        SetWindowPos(dock, lastOverlap, 0, 0, 0, 0, ZFLAGS);
      }
      return "below";
    }
    // No app window overlaps the dock card. Sit just above the desktop shell so
    // an Explorer desktop refresh cannot leave the dock behind Progman/WorkerW.
    // This does not make the dock topmost: overlapping apps are handled above.
    if (aboveDesktop != IntPtr.Zero) SetWindowPos(dock, aboveDesktop, 0, 0, 0, 0, ZFLAGS);
    return "free";
  }

  // Auto-hide mode owns the layer itself (the dock has to float above whatever
  // is on screen when it slides out), so only the configured layer is restored.
  public static string RestoreLayer(IntPtr dockHint, uint dockPid, bool wantTop) {
    IntPtr dock = ResolveDock(dockHint, dockPid);
    if (dock == IntPtr.Zero) return "";
    if (wantTop) {
      if (!IsTopMost(dock)) SetWindowPos(dock, HWND_TOPMOST, 0, 0, 0, 0, ZFLAGS);
      return "top";
    }
    if (IsTopMost(dock)) SetWindowPos(dock, HWND_NOTOPMOST, 0, 0, 0, 0, ZFLAGS);
    return "free";
  }
}
"@

$dockHandle = [IntPtr]::Zero
try { $dockHandle = [IntPtr]([int64]$DockHwnd) } catch { $dockHandle = [IntPtr]::Zero }
$zone = $null
$zoneStamp = [datetime]::MinValue

while ($true) {
  if ($ZoneFile) {
    try {
      $fi = New-Object System.IO.FileInfo($ZoneFile)
      if ($fi.Exists -and $fi.LastWriteTimeUtc -ne $zoneStamp) {
        $zoneStamp = $fi.LastWriteTimeUtc
        $zone = Get-Content -LiteralPath $ZoneFile -Raw -ErrorAction Stop | ConvertFrom-Json
      }
    } catch { }
  }

  $items = New-Object System.Collections.ArrayList
  try {
    foreach ($row in [MinWin]::List()) {
      $f = $row -split ([string][char]1)
      if ($f.Count -lt 2) { continue }
      $exe = ''
      if ($f.Count -ge 3) { $exe = $f[2] }
      [void]$items.Add([ordered]@{ h = [long]$f[0]; t = $f[1]; e = $exe })
    }
  } catch { }
  $fullscreen = $false
  try { $fullscreen = [MinWin]::IsForegroundFullscreen([uint32]$DockPid) } catch { }

  $z = ''
  try {
    if ($dockHandle -ne [IntPtr]::Zero -and $zone) {
      $wantTop = ([int]$zone.top -eq 1)
      if ([int]$zone.hide -eq 1) {
        $z = [MinWin]::RestoreLayer($dockHandle, [uint32]$DockPid, $wantTop)
      } else {
        $r = [MinWin]::DockRect($dockHandle)
        if ($r.Right -gt $r.Left -and $r.Bottom -gt $r.Top) {
          $w = $r.Right - $r.Left
          $h = $r.Bottom - $r.Top
          $zl = $r.Left + [int][math]::Round($w * [double]$zone.ox)
          $zt = $r.Top + [int][math]::Round($h * [double]$zone.oy)
          $zr = $zl + [int][math]::Round($w * [double]$zone.ow)
          $zb = $zt + [int][math]::Round($h * [double]$zone.oh)
          $z = [MinWin]::ApplyZOrder($dockHandle, [uint32]$DockPid, $zl, $zt, $zr, $zb, $wantTop)
        }
      }
    }
  } catch { }

  $json = @{ ok = $true; fullscreen = $fullscreen; z = $z; items = $items } | ConvertTo-Json -Depth 4 -Compress
  # 只在内容真变了才推：原来 5Hz 无条件输出，Electron 每次都转发给渲染层，
  # 常驻的 Dock 因此每秒重绘 5 次（带 SVG/背景模糊，非常费 CPU）。
  if ($json -ne $lastJson) {
    $lastJson = $json
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json + "`n")
    [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
    [Console]::OpenStandardOutput().Flush()
  }
  Start-Sleep -Milliseconds 200
}
