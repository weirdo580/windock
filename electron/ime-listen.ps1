param(
  [int]$SelfPid = 0
)
# 常驻中英切换助手。stdin 一行一条命令：
#   ime   -> 把前台交还给你自己的窗口，打一次真实 Shift，回复 ok:zh / ok:en / fail
#   state -> 回复当前记录的 zh / en
#   ping  -> 回复 pong
# 另外装一个低级键盘钩子：只认"单独点一下 Shift"（不跟字母、不带注入标记），
# 你自己用 Shift 切中英时，Dock 上的字也能跟着走。
$ErrorActionPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
$Utf8 = [System.Text.UTF8Encoding]::new($false)
$stdout = [Console]::OpenStandardOutput()
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$cacheFile = Join-Path $env:TEMP 'windock-ime-target.txt'
$stateFile = Join-Path $env:TEMP 'windock-ime-state.txt'

try {
  Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;

public class ImeTap {
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern byte MapVirtualKeyA(uint code, uint mapType);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SetWindowsHookEx(int id, HookProc cb, IntPtr mod, uint tid);
  [DllImport("user32.dll")] public static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] public static extern IntPtr GetModuleHandle(string name);
  [DllImport("user32.dll")] public static extern int GetMessage(out MSG m, IntPtr h, uint min, uint max);
  [DllImport("user32.dll")] public static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] public static extern IntPtr DispatchMessage(ref MSG m);

  public delegate IntPtr HookProc(int code, IntPtr w, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct Kb { public uint vk; public uint scan; public uint flags; public uint time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; public uint lPrivate; }

  static HookProc proc;
  static IntPtr hook = IntPtr.Zero;
  static string stateFile = "";
  static bool shiftDown = false;
  static bool combo = false;
  static DateTime downAt = DateTime.Now;
  public static volatile string State = "zh";

  public static void Start(string file, string initial) {
    stateFile = file;
    State = initial;
    var t = new Thread(Run);
    t.IsBackground = true;
    t.Start();
  }

  static void Run() {
    proc = Callback;
    hook = SetWindowsHookEx(13, proc, GetModuleHandle(null), 0);
    try { File.WriteAllText(stateFile + ".hook.log", "hook=" + hook.ToString()); } catch (Exception) { }
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
  }

  static void Save(string s) {
    State = s;
    try { File.WriteAllText(stateFile, s); } catch (Exception) { }
  }

  public static void Toggle() {
    Save(State == "zh" ? "en" : "zh");
  }

  static IntPtr Callback(int code, IntPtr w, IntPtr l) {
    try {
      if (code >= 0) {
        Kb kb = (Kb)Marshal.PtrToStructure(l, typeof(Kb));
        uint msg = (uint)w.ToInt64();
        bool down = msg == 0x100 || msg == 0x104;
        bool up = msg == 0x101 || msg == 0x105;
        if (kb.vk == 0x10) {
          if (down) { shiftDown = true; combo = false; downAt = DateTime.Now; }
          if (up && shiftDown) {
            shiftDown = false;
            if (!combo && (DateTime.Now - downAt).TotalMilliseconds < 700) Toggle();
          }
        } else if (down && shiftDown) {
          combo = true;
        }
      }
    } catch (Exception) { }
    return CallNextHookEx(hook, code, w, l);
  }

  public static string Title(IntPtr h) {
    var sb = new System.Text.StringBuilder(256);
    GetWindowText(h, sb, 256);
    return sb.ToString();
  }

  // Alt 轻点 + SetForegroundWindow：从后台进程把前台交回用户自己的窗口，实测最可靠
  public static bool Focus(IntPtr target) {
    if (GetForegroundWindow() == target) return true;
    keybd_event(0x12, 0x38, 0, IntPtr.Zero);
    Thread.Sleep(25);
    ShowWindow(target, 9);
    SetForegroundWindow(target);
    BringWindowToTop(target);
    Thread.Sleep(60);
    keybd_event(0x12, 0x38, 2, IntPtr.Zero);
    Thread.Sleep(90);
    return GetForegroundWindow() == target;
  }

  public static void tapShift() {
    byte scan = MapVirtualKeyA(0x10, 0);
    keybd_event(0x10, scan, 0, IntPtr.Zero);
    Thread.Sleep(45);
    keybd_event(0x10, scan, 2, IntPtr.Zero);
  }
}
"@
} catch { }

$initial = 'zh'
try {
  $raw = (Get-Content $stateFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($raw -eq 'en' -or $raw -eq 'zh') { $initial = $raw }
} catch { }
try { [ImeTap]::Start($stateFile, $initial) } catch { }
Start-Sleep -Milliseconds 200

function Reply([string]$text) {
  $bytes = $Utf8.GetBytes($text + "`n")
  try { $stdout.Write($bytes, 0, $bytes.Length); $stdout.Flush() } catch { }
}

function ReadTarget() {
  try {
    $raw = [System.IO.File]::ReadAllText($cacheFile)
    $v = [int64]$raw.Trim()
    if ($v -le 0) { return [IntPtr]::Zero }
    $h = [IntPtr]$v
    if (-not [ImeTap]::IsWindow($h)) { return [IntPtr]::Zero }
    if (-not [ImeTap]::IsWindowVisible($h)) { return [IntPtr]::Zero }
    if ([ImeTap]::IsIconic($h)) { return [IntPtr]::Zero }
    if ([ImeTap]::Title($h).Length -eq 0) { return [IntPtr]::Zero }
    $p = 0
    [ImeTap]::GetWindowThreadProcessId($h, [ref]$p) | Out-Null
    if ($SelfPid -ne 0 -and $p -eq $SelfPid) { return [IntPtr]::Zero }
    return $h
  } catch { return [IntPtr]::Zero }
}

while ($true) {
  $line = $reader.ReadLine()
  if ($null -eq $line) { break }
  $cmd = $line.Trim()

  if ($cmd -eq 'ime') {
    $fg = [ImeTap]::GetForegroundWindow()
    $fp = 0
    if ($fg -ne [IntPtr]::Zero) { [ImeTap]::GetWindowThreadProcessId($fg, [ref]$fp) | Out-Null }
    $target = [IntPtr]::Zero
    if ($fg -ne [IntPtr]::Zero -and ($SelfPid -eq 0 -or $fp -ne $SelfPid) -and [ImeTap]::Title($fg).Length -gt 0 -and -not [ImeTap]::IsIconic($fg) -and [ImeTap]::IsWindowVisible($fg)) {
      $target = $fg
    } else {
      $target = ReadTarget
      if ($target -eq [IntPtr]::Zero) { Reply 'fail'; continue }
      if (-not [ImeTap]::Focus($target)) { Reply 'fail'; continue }
    }
    # 真实 Shift（钩子会把它当成一次单独 Shift 记账，所以这里不再手动 Toggle）
    $before = [ImeTap]::State
    [ImeTap]::tapShift()
    Start-Sleep -Milliseconds 260
    if ([ImeTap]::State -eq $before) {
      # 钩子没收到（极少数情况），自己补记一次，保证界面和真实切换同向
      [ImeTap]::Toggle()
    }
    Reply ('ok:' + [ImeTap]::State)
  } elseif ($cmd -eq 'state') {
    Reply ([ImeTap]::State)
  } elseif ($cmd -eq 'ping') {
    Reply 'pong'
  }
}
