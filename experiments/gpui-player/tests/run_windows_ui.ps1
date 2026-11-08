# Run inside the logged-in user's session (a hidden interactive scheduled task
# is suitable). The Python driver uses only app-local input and native readbacks.
param(
    [Parameter(Mandatory=$true)][string]$Python,
    [Parameter(Mandatory=$true)][string]$App,
    [Parameter(Mandatory=$true)][string]$Out,
    [ValidateSet('key','graph','drive','adoption','title','import','delete','recording',
        'recording-publication','recording-publication-helper','recording-recovery',
        'training-input-cue','training-input-completing','training-output',
        'training-output-standalone','training-output-song','training-run')][string]$Case = 'graph'
)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
[Console]::OutputEncoding=[Text.Encoding]::UTF8
if([Diagnostics.Process]::GetCurrentProcess().SessionId -eq 0){throw 'UI verification requires the logged-in user session, not session zero.'}
$App=(Resolve-Path -LiteralPath $App).Path
$Python=(Resolve-Path -LiteralPath $Python).Path
if(Test-Path -LiteralPath $Out){throw 'Use a new output directory to preserve previous evidence.'}
New-Item -ItemType Directory -Path $Out|Out-Null
$Out=(Resolve-Path -LiteralPath $Out).Path
if(-not ('NativeGpuiProbe' -as [type])) {
Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class NativeGpuiProbe {
 public delegate bool EnumCallback(IntPtr window,IntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback,IntPtr extra);
 [StructLayout(LayoutKind.Sequential)] public struct WindowInfo { public uint size; public Rect window,client; public uint style,extendedStyle,status,borderWidth,borderHeight; public ushort atom,version; }
 [DllImport("user32.dll")] public static extern bool GetWindowInfo(IntPtr window,ref WindowInfo info);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window,out Rect rect);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window,out Rect rect);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr window,uint message,IntPtr wparam,IntPtr lparam);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("kernel32.dll")] public static extern uint SetErrorMode(uint mode);
 public static IntPtr[] Windows(int processId){var result=new List<IntPtr>();EnumWindows((w,p)=>{uint pid;GetWindowThreadProcessId(w,out pid);if(pid==processId)result.Add(w);return true;},IntPtr.Zero);return result.ToArray();}
}
'@
}
[NativeGpuiProbe]::SetErrorMode(0x8003)|Out-Null
# Compare both rectangles in physical pixels without changing any window/user setting.
$oldDpi=[NativeGpuiProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
if($oldDpi-eq[IntPtr]::Zero){throw 'Could not measure physical window geometry'}
function ForegroundIdentity {
 $window=[NativeGpuiProbe]::GetForegroundWindow();[uint32]$processId=0
 [NativeGpuiProbe]::GetWindowThreadProcessId($window,[ref]$processId)|Out-Null
 $process=Get-Process -Id $processId -ErrorAction SilentlyContinue
 $started=$null;if($process){try{$started=$process.StartTime.ToUniversalTime().ToString('o')}catch{}}
 [pscustomobject]@{hwnd=$window.ToInt64();pid=$processId;name=$(if($process){$process.ProcessName}else{$null});started=$started}
}
$foregroundBefore=ForegroundIdentity
$before=$foregroundBefore.hwnd
$foregroundFailure=$null
$folder=Split-Path $App
$paths=@($App,(Join-Path $folder 'singz-gpui-audio.exe'),(Join-Path $folder 'singz-gpui-input.exe'),(Join-Path $folder 'singz-analyze.exe'))
# Keep optional driver flags as separate, fixed arguments. ProcessStartInfo
# launches Python directly with UseShellExecute=false; no shell command is built.
$driverExtraArguments=@()
$driverName=switch($Case){
 'key'{'test_native_project_key_ui.py'}
 'graph'{'test_native_graph_ui.py'}
 'drive'{'test_native_drive_ui.py'}
 'adoption'{'test_native_drive_adoption_ui.py'}
 'title'{'test_native_title.py'}
 'import'{'test_native_library_import.py'}
 'delete'{'test_native_project_delete.py'}
 'recording'{'test_native_training_recording.py'}
 'recording-publication'{'test_native_recording_publication_recovery.py'}
 'recording-publication-helper'{$driverExtraArguments=@('--helper-stage');'test_native_recording_publication_recovery.py'}
 'recording-recovery'{'test_native_training_recording_recovery.py'}
 'training-input-cue'{'test_native_training_input_recovery.py'}
 'training-input-completing'{$driverExtraArguments=@('--completing');'test_native_training_input_recovery.py'}
 'training-output'{'test_native_training_recovery.py'}
 'training-output-standalone'{'test_native_training_recovery.py'}
 'training-output-song'{$driverExtraArguments=@('--song-backed');'test_native_training_recovery.py'}
 'training-run'{'test_native_training_run.py'}
}
$driver=Join-Path $PSScriptRoot $driverName
$driverOut=Join-Path $Out 'workflow'
$arguments=@(('"'+$driver+'"'),('"'+$App+'"'),('"'+$driverOut+'"'))+@($driverExtraArguments)
$run=$null;$stdout=$null;$stderr=$null
$clock=[Diagnostics.Stopwatch]::StartNew();$owned=@{};$previous=@{};$frames=@{};$frameHistory=@();$resizingSamples=@();$samples=@();$foregroundSamples=@();$failure=$null
function Processes {
 foreach($candidate in (Get-Process -Name 'singz-gpui-player','singz-gpui-audio','singz-gpui-input','singz-analyze' -ErrorAction SilentlyContinue)) {
  if(!$candidate.HasExited -and $paths -contains $candidate.Path){[pscustomobject]@{ProcessId=$candidate.Id;ExecutablePath=$candidate.Path}}
 }
}
# WMI GPU queries can take seconds. Keep them off the window/focus sampler so
# short-lived app processes cannot disappear while a performance query blocks.
$gpuFlag=Join-Path $Out 'gpu-running';[IO.File]::WriteAllText($gpuFlag,'running')
$gpuFile=Join-Path $Out 'gpu.jsonl'
$gpuStart=New-Object Diagnostics.ProcessStartInfo
$gpuStart.FileName=(Get-Process -Id $PID).Path
$gpuStart.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+(Join-Path $PSScriptRoot 'windows_gpu_sampler.ps1')+'" -App "'+$App+'" -Flag "'+$gpuFlag+'" -Out "'+$gpuFile+'"'
$gpuStart.UseShellExecute=$false;$gpuStart.CreateNoWindow=$true
$gpuStart.RedirectStandardOutput=$true;$gpuStart.RedirectStandardError=$true
$gpuRun=New-Object Diagnostics.Process;$gpuRun.StartInfo=$gpuStart
if(!$gpuRun.Start()){throw 'Could not start the console-free GPU sampler'}
$gpuStdout=$gpuRun.StandardOutput.ReadToEndAsync();$gpuStderr=$gpuRun.StandardError.ReadToEndAsync()
[pscustomobject]@{pid=$gpuRun.Id;started=$gpuRun.StartTime.ToUniversalTime().ToString('o');createNoWindow=$true}|ConvertTo-Json|Set-Content (Join-Path $Out 'gpu-owner.json') -Encoding UTF8

try {
 $start=New-Object Diagnostics.ProcessStartInfo;$start.FileName=$Python;$start.Arguments=$arguments -join ' ';$start.EnvironmentVariables['PYTHONUTF8']='1';$start.UseShellExecute=$false;$start.CreateNoWindow=$true;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
 $run=New-Object Diagnostics.Process;$run.StartInfo=$start
 if(!$run.Start()){throw 'Could not start the native UI driver'}
 $stdout=$run.StandardOutput.ReadToEndAsync();$stderr=$run.StandardError.ReadToEndAsync()
 while(!$run.HasExited){
  foreach($item in (Processes)){
   $process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
   if(!$process -or $process.HasExited){continue}
   $key="$($process.Id):$($process.StartTime.ToUniversalTime().Ticks)";$owned[$key]=[pscustomobject]@{pid=$process.Id;started=$process.StartTime.ToUniversalTime().ToString('o');path=$item.ExecutablePath}
   foreach($window in [NativeGpuiProbe]::Windows($process.Id)){
    if([NativeGpuiProbe]::IsWindowVisible($window)){throw "Owned native process created a visible window: $($process.Id)"}
    if($item.ExecutablePath-eq$App){
     $info=New-Object NativeGpuiProbe+WindowInfo;$info.size=[Runtime.InteropServices.Marshal]::SizeOf([type][NativeGpuiProbe+WindowInfo])
     if([NativeGpuiProbe]::GetWindowInfo($window,[ref]$info)){
      $outer=$info.window;$client=$info.client;$clientWidth=$client.right-$client.left;$clientHeight=$client.bottom-$client.top
      if($clientWidth-le0 -or $clientHeight-le0){continue}
      if($frames.ContainsKey($key) -and $frames[$key].clientWidth-eq$clientWidth -and $frames[$key].clientHeight-eq$clientHeight){continue}
      $candidateFrame=[pscustomobject]@{pid=$process.Id;hwnd=$window.ToInt64();outerWidth=$outer.right-$outer.left;outerHeight=$outer.bottom-$outer.top;clientWidth=$clientWidth;clientHeight=$clientHeight;seconds=$clock.Elapsed.TotalSeconds}
      if($candidateFrame.outerWidth-ne$clientWidth -or $candidateFrame.outerHeight-ne$clientHeight){throw 'Native window has an unexpected non-client frame'}
      $middleX=[int](($outer.left+$outer.right)/2);$middleY=[int](($outer.top+$outer.bottom)/2)
      $points=@(@('left',($outer.left+1),$middleY,10),@('right',($outer.right-2),$middleY,11),@('top',$middleX,($outer.top+1),12),@('bottom',$middleX,($outer.bottom-2),15),@('top-left',($outer.left+1),($outer.top+1),13),@('top-right',($outer.right-2),($outer.top+1),14),@('bottom-left',($outer.left+1),($outer.bottom-2),16),@('bottom-right',($outer.right-2),($outer.bottom-2),17))
      $hits=@()
      foreach($point in $points){
       $packed=([int64]($point[1]-band0xffff))-bor(([int64]($point[2]-band0xffff))-shl16)
       $hit=[NativeGpuiProbe]::SendMessage($window,0x84,[IntPtr]::Zero,[IntPtr]$packed).ToInt64()
       $hits+=[pscustomobject]@{edge=$point[0];x=$point[1];y=$point[2];actual=$hit;expected=$point[3]}
      }
      $afterInfo=New-Object NativeGpuiProbe+WindowInfo;$afterInfo.size=$info.size
      if(![NativeGpuiProbe]::GetWindowInfo($window,[ref]$afterInfo)){continue}
      if($outer.left-ne$afterInfo.window.left -or $outer.top-ne$afterInfo.window.top -or $outer.right-ne$afterInfo.window.right -or $outer.bottom-ne$afterInfo.window.bottom){
       $resizingSamples+=[pscustomobject]@{pid=$process.Id;before=$candidateFrame;afterWidth=$afterInfo.window.right-$afterInfo.window.left;afterHeight=$afterInfo.window.bottom-$afterInfo.window.top;hits=$hits;reason='Bounds changed while read-only edge queries were in flight'}
       continue
      }
      $candidateFrame|Add-Member -NotePropertyName resizeHitTests -NotePropertyValue $hits
      foreach($hit in $hits){if($hit.actual-ne$hit.expected){throw "Frameless resize hit test failed: $($hit.edge) returned $($hit.actual)"}}
      $frames[$key]=$candidateFrame;$frameHistory+=$candidateFrame
     }
    }
   }
   $foreground=[NativeGpuiProbe]::GetForegroundWindow();[uint32]$foregroundPid=0
   [NativeGpuiProbe]::GetWindowThreadProcessId($foreground,[ref]$foregroundPid)|Out-Null
   if($foregroundPid-eq$process.Id){throw 'Owned native process took foreground focus'}
   $cpu=$process.TotalProcessorTime.TotalSeconds;$now=$clock.Elapsed.TotalSeconds
    if($previous.ContainsKey($key)){$samples+=[pscustomobject]@{pid=$process.Id;started=$owned[$key].started;role=$(if($item.ExecutablePath-eq$App){'ui'}else{'helper'});seconds=$now;cpuPercentOneCore=100*($cpu-$previous[$key].cpu)/($now-$previous[$key].seconds);rssBytes=$process.WorkingSet64}}
    $previous[$key]=@{cpu=$cpu;seconds=$now}
  }
  $current=[NativeGpuiProbe]::GetForegroundWindow().ToInt64();$foregroundSamples+=$current
  if($current-ne$before){$foregroundFailure=ForegroundIdentity;throw 'Foreground window changed during verification'}
  if($clock.Elapsed.TotalSeconds-gt300){throw 'Owned UI workflow exceeded its deadline'}
  Start-Sleep -Milliseconds 250;$run.Refresh()
 }
 $run.WaitForExit()
 if($run.ExitCode-ne0){throw "Native UI driver failed: $($run.ExitCode)"}
 $expectedProcesses=if($Case-in@('key','graph','drive','adoption')){2}else{1}
 if($frames.Count-ne$expectedProcesses){throw "Expected $expectedProcesses native app processes for $Case; observed $($frames.Count)"}
 if([NativeGpuiProbe]::GetForegroundWindow().ToInt64()-ne$before){throw 'Foreground window changed during verification'}
 $remaining=@(Processes)
 if($remaining.Count-gt0){throw 'An owned native process survived the workflow'}
} catch {
 $failure=$_|Out-String
 if($run -and !$run.HasExited){Stop-Process -Id $run.Id -Force;$run.WaitForExit()}
 # Discover late analysis/helper children too, but only from this verification
 # copy. Snapshot their identities before retiring them; never kill by name.
 foreach($item in (Processes)){
  $process=Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
  if($process -and !$process.HasExited){$owned["$($process.Id):$($process.StartTime.ToUniversalTime().Ticks)"]=[pscustomobject]@{pid=$process.Id;started=$process.StartTime.ToUniversalTime().ToString('o');path=$item.ExecutablePath}}
 }
 foreach($identity in ($owned.Values|Sort-Object { $_.path-eq$App } -Descending)){$process=Get-Process -Id $identity.pid -ErrorAction SilentlyContinue;if($process -and !$process.HasExited -and $process.StartTime.ToUniversalTime().Ticks-eq([DateTime]::Parse($identity.started)).ToUniversalTime().Ticks){Stop-Process -Id $identity.pid -Force}}
} finally {
 Remove-Item -LiteralPath $gpuFlag -ErrorAction SilentlyContinue
 if(!$gpuRun.WaitForExit(1000)){$gpuRun.Kill();$gpuRun.WaitForExit()}
 [IO.File]::WriteAllText((Join-Path $Out 'gpu.stdout.log'),$gpuStdout.GetAwaiter().GetResult(),[Text.Encoding]::UTF8)
 [IO.File]::WriteAllText((Join-Path $Out 'gpu.stderr.log'),$gpuStderr.GetAwaiter().GetResult(),[Text.Encoding]::UTF8)
 if($stdout -and $stderr){[IO.File]::WriteAllText((Join-Path $Out 'driver.stdout.log'),$stdout.GetAwaiter().GetResult(),[Text.Encoding]::UTF8);[IO.File]::WriteAllText((Join-Path $Out 'driver.stderr.log'),$stderr.GetAwaiter().GetResult(),[Text.Encoding]::UTF8)}
 $helperArtifacts=@()
 foreach($path in $paths){if($path-ne$App -and (Test-Path -LiteralPath $path)){$helperArtifacts+=[pscustomobject]@{file=[IO.Path]::GetFileName($path);sha256=(Get-FileHash -Algorithm SHA256 $path).Hash.ToLowerInvariant()}}}
 $after=[NativeGpuiProbe]::GetForegroundWindow().ToInt64()
 [NativeGpuiProbe]::SetThreadDpiAwarenessContext($oldDpi)|Out-Null
 [pscustomobject]@{passed=($null-eq$failure);case=$Case;driverName=$driverName;driverExtraArguments=@($driverExtraArguments);failure=$failure;driverExitCode=$run.ExitCode;foregroundBefore=$before;foregroundAfter=$after;foregroundUnchanged=($before-eq$after);foregroundSamples=$foregroundSamples;foregroundBeforeOwner=$foregroundBefore;foregroundFailureOwner=$foregroundFailure;frameHistory=$frameHistory;resizingSamples=$resizingSamples;frames=@($frames.Values);ownedProcesses=@($owned.Values);samples=$samples;gpuSamplesFile='gpu.jsonl';liveFps=$null;performanceScope='UI/helper CPU and RSS separated by role; GPU-engine sum per app process; live display FPS unmeasured';helperArtifacts=$helperArtifacts;runnerSha256=(Get-FileHash -Algorithm SHA256 $PSCommandPath).Hash.ToLowerInvariant();driverSha256=(Get-FileHash -Algorithm SHA256 $driver).Hash.ToLowerInvariant();appSha256=(Get-FileHash -Algorithm SHA256 $App).Hash.ToLowerInvariant()}|ConvertTo-Json -Depth 8|Set-Content (Join-Path $Out 'runner.json') -Encoding UTF8
}
if($failure){throw $failure}
