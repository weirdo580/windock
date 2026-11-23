# 读取本机正在播放的媒体（Windows SMTC），循环输出 JSON 行。
# 由主进程常驻拉起，渲染层通过主进程缓存读取，避免频繁启动进程。
$ErrorActionPreference = 'Stop'
# 必须显式设成 UTF-8，否则中文歌名/歌词经管道输出到 Node 会被转成乱码或问号
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$Utf8 = New-Object System.Text.UTF8Encoding($false)
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
} catch { }

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}

[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionPlaybackInfo, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionTimelineProperties, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null

function Get-Manager {
  try {
    return Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
  } catch {
    return $null
  }
}

$manager = Get-Manager

function Emit($obj) {
  $json = $obj | ConvertTo-Json -Compress -Depth 3
  $bytes = $Utf8.GetBytes($json + "`n")
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}

function Read-Thumbnail($props) {
  $stream = $null
  $net = $null
  $memory = $null
  try {
    $thumbnail = $props.Thumbnail
    if ($null -eq $thumbnail) { return '' }
    $stream = Await ($thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($null -eq $stream -or $stream.Size -le 0 -or $stream.Size -gt 8388608) { return '' }
    $asStream = [System.IO.WindowsRuntimeStreamExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsStreamForRead' -and $_.GetParameters().Count -eq 1
    } | Select-Object -First 1
    $net = $asStream.Invoke($null, @($stream))
    $memory = New-Object System.IO.MemoryStream
    $net.CopyTo($memory)
    $bytes = $memory.ToArray()
    if ($bytes.Length -eq 0) { return '' }
    $mime = [string]$stream.ContentType
    if (!$mime.StartsWith('image/')) {
      if ($bytes.Length -gt 7 -and $bytes[0] -eq 0x89 -and $bytes[1] -eq 0x50) { $mime = 'image/png' }
      else { $mime = 'image/jpeg' }
    }
    return 'data:' + $mime + ';base64,' + [Convert]::ToBase64String($bytes)
  } catch {
    return ''
  } finally {
    if ($null -ne $memory) { try { $memory.Dispose() } catch { } }
    if ($null -ne $net) { try { $net.Dispose() } catch { } }
  }
}

$lastKey = ''
$lastCoverKey = ''
while ($true) {
  try {
    if ($null -eq $manager) { $manager = Get-Manager }
    $session = if ($null -ne $manager) { $manager.GetCurrentSession() } else { $null }
    if ($null -eq $session) {
      $lastCoverKey = ''
      Emit @{ ok = $true; empty = $true }
    } else {
      $props = Await ($session.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $info = $session.GetPlaybackInfo()
      $status = if ($null -ne $info) { [string]$info.PlaybackStatus } else { '' }
      $controls = if ($null -ne $info) { $info.Controls } else { $null }
      $timeline = $session.GetTimelineProperties()
      $pos = 0.0; $dur = 0.0
      if ($null -ne $timeline) {
        $pos = ([double]$timeline.Position.TotalSeconds)
        $dur = ([double]$timeline.EndTime.TotalSeconds - [double]$timeline.StartTime.TotalSeconds)
      }
      $title = [string]$props.Title
      $artist = [string]$props.Artist
      $album = [string]$props.AlbumTitle
      $appId = [string]$session.SourceAppUserModelId
      $coverKey = $appId + "`n" + $title + "`n" + $artist + "`n" + $album
      $cover = $null
      if ($coverKey -ne $lastCoverKey) {
        $lastCoverKey = $coverKey
        $cover = Read-Thumbnail $props
      }
      $payload = @{
        ok = $true
        empty = $false
        title = $title
        artist = $artist
        album = $album
        appId = $appId
        playing = ($status -eq 'Playing')
        position = [math]::Round($pos, 2)
        duration = [math]::Round($dur, 2)
        canNext = [bool]($null -ne $controls -and $controls.IsNextEnabled)
        canPrev = [bool]($null -ne $controls -and $controls.IsPreviousEnabled)
      }
      if ($null -ne $cover) { $payload.cover = $cover }
      Emit $payload
    }
  } catch {
    $detail = $_.Exception.Message
    if ($null -ne $_.Exception.InnerException) { $detail = $_.Exception.InnerException.Message }
    Emit @{ ok = $false; error = $detail; line = $_.InvocationInfo.ScriptLineNumber }
  }
  Start-Sleep -Milliseconds 900
}
