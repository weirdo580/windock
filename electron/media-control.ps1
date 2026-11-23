# 对当前媒体会话执行一个控制动作：playpause / next / prev / stop
param([string]$action = 'playpause')
$ErrorActionPreference = 'Stop'
try { Add-Type -AssemblyName System.Runtime.WindowsRuntime } catch { }

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null

$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
$session = $manager.GetCurrentSession()
if ($null -eq $session) { [Console]::Out.WriteLine('{"ok":false,"error":"no-session"}'); exit 0 }

switch ($action) {
  'next' { $r = Await ($session.TrySkipNextAsync()) ([bool]) }
  'prev' { $r = Await ($session.TrySkipPreviousAsync()) ([bool]) }
  'playpause' { $r = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
  default { $r = Await ($session.TryTogglePlayPauseAsync()) ([bool]) }
}
[Console]::Out.WriteLine('{"ok":' + ([bool]$r).ToString().ToLower() + '}')
