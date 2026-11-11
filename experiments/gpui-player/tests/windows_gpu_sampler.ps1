<#
.SYNOPSIS
  Windows GPU sampler for SingZ. Two modes, chosen by parameter set.

  Poll   (default; used by run_windows_ui.ps1): appends GPU engine utilisation for
         the named app's processes to a JSONL file while a flag file exists.
         A separate, console-free process so slow WMI never blocks focus sampling.

  Capture (C-07 Windows leg): runs PresentMon against a named process tree for a
         fixed window and writes ONE JSON file with per-frame present times, fps,
         frame-time p50/p99/max, dropped frames, GPU use per adapter and the DWM
         share, in the shape that tests/perf/perf_harness.py merges into the C-06
         report (--frames-json).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File windows_gpu_sampler.ps1 `
    -ProcessName singz-gpui-player -Seconds 60 -ExpectedHz 60 -Out frames-win.json

  Needs PresentMon 2.3.1 or newer (see tests/perf/README.md): PresentMon.exe on PATH,
  or -PresentMon <path>, or env SINGZ_PRESENTMON. Run elevated or as a member of
  "Performance Log Users". The app must be visible, unoccluded and on mains power.
  Pass -Hidden for a hidden run: frames are reported null, never zero.
#>
[CmdletBinding(DefaultParameterSetName='Poll')]
param(
  [Parameter(ParameterSetName='Poll',Mandatory=$true)][string]$App,
  [Parameter(ParameterSetName='Poll',Mandatory=$true)][string]$Flag,
  [Parameter(ParameterSetName='Poll',Mandatory=$true)][string]$Out,

  [Parameter(ParameterSetName='Capture',Mandatory=$true)][string]$ProcessName,
  [Parameter(ParameterSetName='Capture',Mandatory=$true)][double]$Seconds,
  [Parameter(ParameterSetName='Capture',Mandatory=$true)][string]$CaptureOut,
  [Parameter(ParameterSetName='Capture')][int]$RootPid=0,
  [Parameter(ParameterSetName='Capture')][string]$PresentMon='',
  [Parameter(ParameterSetName='Capture')][double]$ExpectedHz=0,
  [Parameter(ParameterSetName='Capture')][switch]$Hidden,
  [Parameter(ParameterSetName='Capture')][switch]$NoDemand,
  [Parameter(ParameterSetName='Capture')][string]$KeepCsv='',

  # Offline: analyse an existing PresentMon CSV (used by windows_gpu_sampler_csv_test.ps1).
  [Parameter(ParameterSetName='Csv',Mandatory=$true)][string]$CsvInput,
  [Parameter(ParameterSetName='Csv',Mandatory=$true)][string]$CsvOut,
  [Parameter(ParameterSetName='Csv')][double]$CsvExpectedHz=0,
  [Parameter(ParameterSetName='Csv')][switch]$CsvNoDemand
)
$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'

if($PSCmdlet.ParameterSetName -eq 'Poll'){
$ProgressPreference='SilentlyContinue';$ErrorActionPreference='Stop'
while(Test-Path -LiteralPath $Flag){
 foreach($process in (Get-Process -Name 'singz-gpui-player' -ErrorAction SilentlyContinue)){
  if($process.HasExited -or $process.Path-ne$App){continue}
  $value=$null;$available=$false;$errorText=$null
  try{
   $engines=@(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -Filter "Name LIKE 'pid_$($process.Id)_%'" -ErrorAction Stop)
   if($engines.Count-gt0){$value=($engines|Measure-Object UtilizationPercentage -Sum).Sum;$available=$true}
  }catch{$errorText=$_.ToString()}
  $row=[pscustomobject]@{pid=$process.Id;utc=[DateTime]::UtcNow.ToString('o');gpuEnginePercent=$value;available=$available;error=$errorText}
  [IO.File]::AppendAllText($Out,($row|ConvertTo-Json -Compress)+[Environment]::NewLine,[Text.Encoding]::UTF8)
 }
 Start-Sleep -Milliseconds 500
}
  exit 0
}

# ---------------------------------------------------------------- Capture mode
$HiddenReason='hidden window presents no frames'
function Get-Percentile([double[]]$sorted,[double]$p){
  $i=[Math]::Min([Math]::Max([int][Math]::Ceiling($sorted.Count*$p),1),$sorted.Count)-1
  return $sorted[$i]
}
function Get-NullFrames($reason,[int]$samples){
  return [ordered]@{fps=$null;frameTimeMs=$null;dropped=$null;reason=$reason;presentedSamples=$samples;skipped=0;windowS=$null;demandSamples=0}
}
# Same formulas as experiments/gpui-player/src/frame_log.rs (D-02 5.2).
# $times: presented times in seconds, in order; $null/<=0 marks a drawable that was never shown.
function Get-FrameStats([object[]]$times,[double]$periodS,[bool]$demand){
  $skipped=@($times|Where-Object{$null -eq $_ -or $_ -le 0}).Count
  $valid=New-Object System.Collections.ArrayList;$zerosBefore=New-Object System.Collections.ArrayList;$z=0
  foreach($t in $times){ if($null -eq $t -or $t -le 0){$z++} else {[void]$valid.Add([double]$t);[void]$zerosBefore.Add($z);$z=0} }
  if($valid.Count -lt 2){ return (Get-NullFrames 'fewer than two presented frames' $times.Count) }
  $deltas=@();for($i=1;$i -lt $valid.Count;$i++){$deltas+=($valid[$i]-$valid[$i-1])}
  $span=$valid[$valid.Count-1]-$valid[0]
  $sorted=[double[]]($deltas|Sort-Object)
  $period=if($periodS -gt 0){$periodS}else{Get-Percentile $sorted 0.5}
  $dropped=[int64]$skipped
  if($demand){
    # Same rule as frame_log.rs: a late gap repaid by early ones within the next 3 frames spans
    # fewer slots together than apart; the vsync grid kept its phase, so only net missing slots count.
    $slots={param([double]$d) [int64][Math]::Max([Math]::Round($d/$period,[MidpointRounding]::AwayFromZero),1)}
    $i=0
    while($i -lt $deltas.Count){
      $zerosHere=[int64]$zerosBefore[$i+1]
      $jumped=$false
      if((& $slots $deltas[$i]) -gt 1 -and $zerosHere -eq 0){
        $total=[double]$deltas[$i];$apart=(& $slots $deltas[$i])
        for($j=1;$j -le 3;$j++){
          if($i+$j -ge $deltas.Count -or [int64]$zerosBefore[$i+$j+1] -ne 0){break}
          $total+=$deltas[$i+$j];$apart+=(& $slots $deltas[$i+$j])
          if((& $slots $total) -lt $apart){
            $dropped+=[Math]::Max((& $slots $total)-($j+1),0)
            $i+=$j+1;$jumped=$true;break
          }
        }
      }
      if($jumped){continue}
      $dropped+=[Math]::Max((& $slots $deltas[$i])-1-$zerosHere,0)
      $i++
    }
  }
  return [ordered]@{
    fps=if($span -gt 0){($valid.Count-1)/$span}else{$null}
    frameTimeMs=[ordered]@{p50=(Get-Percentile $sorted 0.5)*1000;p99=(Get-Percentile $sorted 0.99)*1000;max=$sorted[$sorted.Count-1]*1000;periodMs=$period*1000}
    dropped=$dropped;reason=$null;presentedSamples=$times.Count;skipped=$skipped;windowS=$span
    demandSamples=if($demand){$valid.Count}else{0}
  }
}
function Get-Tree([int]$root){
  $kids=@{}
  foreach($p in Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId){
    $k=[int]$p.ParentProcessId; if(-not $kids.ContainsKey($k)){$kids[$k]=New-Object System.Collections.ArrayList}; [void]$kids[$k].Add([int]$p.ProcessId)
  }
  $tree=New-Object System.Collections.ArrayList;[void]$tree.Add($root)
  for($i=0;$i -lt $tree.Count;$i++){ if($kids.ContainsKey([int]$tree[$i])){ foreach($c in $kids[[int]$tree[$i]]){[void]$tree.Add($c)} } }
  return ,@($tree)
}
# GPU engine counters are named pid_<pid>_luid_0x<hi>_0x<lo>_phys_<n>_eng_<n>_engtype_<type>.
# CIM class and property names are not localised (unlike Get-Counter paths).
function Get-GpuTick([int[]]$pids){
  $byAdapter=@{}
  foreach($e in @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction Stop)){
    if($e.Name -notmatch '^pid_(\d+)_luid_(0x[0-9a-fA-F]+_0x[0-9a-fA-F]+)_phys_\d+_eng_\d+_engtype_(.+)$'){continue}
    if($pids -notcontains [int]$Matches[1]){continue}
    $luid=$Matches[2];$type=$Matches[3]
    if(-not $byAdapter.ContainsKey($luid)){$byAdapter[$luid]=@{total=0.0;types=@{}}}
    $byAdapter[$luid].total+=[double]$e.UtilizationPercentage
    if(-not $byAdapter[$luid].types.ContainsKey($type)){$byAdapter[$luid].types[$type]=0.0}
    $byAdapter[$luid].types[$type]+=[double]$e.UtilizationPercentage
  }
  return $byAdapter
}
function Add-Ticks($acc,$tick){
  foreach($luid in $tick.Keys){
    if(-not $acc.ContainsKey($luid)){$acc[$luid]=@{totals=New-Object System.Collections.ArrayList;types=@{}}}
    [void]$acc[$luid].totals.Add($tick[$luid].total)
    foreach($t in $tick[$luid].types.Keys){
      if(-not $acc[$luid].types.ContainsKey($t)){$acc[$luid].types[$t]=New-Object System.Collections.ArrayList}
      [void]$acc[$luid].types[$t].Add($tick[$luid].types[$t])
    }
  }
}
function Format-Adapters($acc){
  $rows=@()
  foreach($luid in ($acc.Keys|Sort-Object)){
    $totals=@($acc[$luid].totals)
    $engines=[ordered]@{}
    foreach($t in ($acc[$luid].types.Keys|Sort-Object)){ $engines[$t]=[Math]::Round((@($acc[$luid].types[$t])|Measure-Object -Average).Average,2) }
    $rows+=[ordered]@{luid=$luid;samples=$totals.Count;meanPercent=[Math]::Round(($totals|Measure-Object -Average).Average,2);maxPercent=[Math]::Round(($totals|Measure-Object -Maximum).Maximum,2);meanPercentByEngine=$engines}
  }
  return ,$rows
}

# Presented times (seconds) from a PresentMon CSV, in submission order. A frame that was never
# shown (DisplayLatency/DisplayedTime NA) stays IN PLACE as 0.0: the stats pair it with the gap
# it leaves, so a skipped frame is counted once, not once as skipped and again as a missed slot.
# Rows between skipped markers are put in display order; skipped markers never move.
function Get-PresentedTimes($rows){
  $cols=@(); if($rows.Count -gt 0){$cols=$rows[0].PSObject.Properties.Name}
  $isV2=($cols -contains 'CPUStartTime') -and ($cols -contains 'DisplayLatency')
  $isV1=($cols -contains 'TimeInSeconds') -and ($cols -contains 'msUntilDisplayed')
  if($rows.Count -gt 0 -and -not $isV2 -and -not $isV1){throw "unrecognised PresentMon CSV columns: $($cols -join ',')"}
  $out=New-Object System.Collections.ArrayList;$segment=New-Object System.Collections.ArrayList
  foreach($r in $rows){
    $t=0.0
    if($isV2){
      if($r.DisplayLatency -ne 'NA' -and $r.DisplayedTime -ne 'NA'){$t=(([double]$r.CPUStartTime)+([double]$r.DisplayLatency))/1000.0}
    }else{
      if($r.msUntilDisplayed -ne 'NA'){$t=([double]$r.TimeInSeconds)+([double]$r.msUntilDisplayed)/1000.0}
    }
    if($t -gt 0){[void]$segment.Add($t)}
    else{
      foreach($v in ($segment|Sort-Object)){[void]$out.Add([double]$v)}
      $segment.Clear();[void]$out.Add(0.0)
    }
  }
  foreach($v in ($segment|Sort-Object)){[void]$out.Add([double]$v)}
  return ,@($out)
}

if($PSCmdlet.ParameterSetName -eq 'Csv'){
  $times=Get-PresentedTimes @(Import-Csv -LiteralPath $CsvInput)
  $period=if($CsvExpectedHz -gt 0){1.0/$CsvExpectedHz}else{0.0}
  $f=if($times.Count -eq 0){Get-NullFrames 'no presents in the CSV' 0}else{Get-FrameStats $times $period (-not $CsvNoDemand)}
  [IO.File]::WriteAllText($CsvOut,([ordered]@{frames=$f;presentedTimes=@($times|Where-Object{$_ -gt 0})}|ConvertTo-Json -Depth 6 -Compress),(New-Object Text.UTF8Encoding($false)))
  exit 0
}

$presentMonPath=$PresentMon
if(-not $presentMonPath){$presentMonPath=$env:SINGZ_PRESENTMON}
if(-not $presentMonPath){$cmd=Get-Command 'PresentMon.exe' -ErrorAction SilentlyContinue; if($cmd){$presentMonPath=$cmd.Source}}
if(-not $Hidden){
  if(-not $presentMonPath -or -not (Test-Path -LiteralPath $presentMonPath)){
    throw 'PresentMon not found: install PresentMon 2.3.1+ (tests/perf/README.md) and put it on PATH, or pass -PresentMon / set SINGZ_PRESENTMON'
  }
}
$exe=$ProcessName -replace '\.exe$',''
$root=$RootPid
if($root -le 0){
  $found=@(Get-Process -Name $exe -ErrorAction SilentlyContinue|Sort-Object StartTime)
  if($found.Count -eq 0){throw "no running process named $exe"}
  $root=$found[0].Id
}
$tree=[int[]](Get-Tree $root)
$names=@($tree|ForEach-Object{(Get-Process -Id $_ -ErrorAction SilentlyContinue).ProcessName}|Where-Object{$_}|Sort-Object -Unique)
$dwm=@(Get-Process -Name dwm -ErrorAction SilentlyContinue|ForEach-Object{$_.Id})

# DWM CPU is a counter delta, per process, over the capture window (as win-process-sample.ps1).
function Get-Cpu([int[]]$ids){$h=@{};foreach($i in $ids){$p=Get-Process -Id $i -ErrorAction SilentlyContinue;if($p -and $null -ne $p.CPU){$h[[int]$i]=[double]$p.CPU}};return $h}
$dwmCpu0=Get-Cpu $dwm;$treeCpu0=Get-Cpu $tree
$clock=[Diagnostics.Stopwatch]::StartNew()

$csv=if($KeepCsv){$KeepCsv}else{Join-Path ([IO.Path]::GetTempPath()) ("singz-presentmon-"+[Guid]::NewGuid().ToString('N')+".csv")}
$monProc=$null
if(-not $Hidden){
  $arguments=@('--output_file',('"'+$csv+'"'),'--timed',[string]$Seconds,'--terminate_after_timed','--stop_existing_session','--session_name','singz-c07','--no_console_stats')
  foreach($n in $names){$arguments+=@('--process_name',('"'+$n+'.exe"'))}
  $monProc=Start-Process -FilePath $presentMonPath -ArgumentList $arguments -PassThru -WindowStyle Hidden
}
$procTicks=@{};$dwmTicks=@{}
$end=[DateTime]::UtcNow.AddSeconds($Seconds)
while([DateTime]::UtcNow -lt $end){
  try{ Add-Ticks $procTicks (Get-GpuTick $tree); Add-Ticks $dwmTicks (Get-GpuTick $dwm) }catch{ $gpuError=$_.ToString() }
  Start-Sleep -Milliseconds 500
}
if($monProc){ if(-not $monProc.WaitForExit(30000)){ $monProc.Kill(); throw 'PresentMon did not stop after the timed capture' } }
$elapsed=$clock.Elapsed.TotalSeconds
$dwmCpu1=Get-Cpu $dwm;$treeCpu1=Get-Cpu $tree
function Get-CpuPercent($a,$b,$seconds){$d=0.0;foreach($k in $b.Keys){if($a.ContainsKey($k)){$x=$b[$k]-$a[$k];if($x -gt 0){$d+=$x}}};return [Math]::Round(100*$d/$seconds,2)}

# ---- frames
$presentedTimes=@();$presentMonVersion=$null;$frames=$null
if($Hidden){
  $frames=Get-NullFrames $HiddenReason 0
}else{
  if(-not (Test-Path -LiteralPath $csv)){throw 'PresentMon wrote no CSV'}
  $rows=@(Import-Csv -LiteralPath $csv|Where-Object{$tree -contains [int]$_.ProcessID})
  $presentedTimes=Get-PresentedTimes $rows
  $period=if($ExpectedHz -gt 0){1.0/$ExpectedHz}else{0.0}
  if($presentedTimes.Count -eq 0){ $frames=Get-NullFrames 'no presents captured: window not presenting (hidden, occluded or idle)' 0 }
  else{ $frames=Get-FrameStats $presentedTimes $period (-not $NoDemand) }
  $presentMonVersion=(Get-Item -LiteralPath $presentMonPath).VersionInfo.ProductVersion
  $presentedTimes=@($presentedTimes|Where-Object{$_ -gt 0})
}
if(-not $KeepCsv -and (Test-Path -LiteralPath $csv)){Remove-Item -LiteralPath $csv -Force}

$result=[ordered]@{
  schema='singz.perf.windows-frames.v1'
  frames=$frames
  expectedHz=if($ExpectedHz -gt 0){$ExpectedHz}else{$null}
  hidden=[bool]$Hidden
  process=[ordered]@{name=$exe;rootPid=$root;treePids=$tree;cpuPercent=Get-CpuPercent $treeCpu0 $treeCpu1 $elapsed}
  gpu=[ordered]@{perAdapter=(Format-Adapters $procTicks);error=$gpuError;note='UtilizationPercentage summed over the process tree engines per 500 ms tick; per adapter by LUID'}
  dwm=[ordered]@{pids=$dwm;cpuPercent=Get-CpuPercent $dwmCpu0 $dwmCpu1 $elapsed;gpuPerAdapter=(Format-Adapters $dwmTicks)}
  adapters=@(Get-CimInstance Win32_VideoController|ForEach-Object{[ordered]@{name=$_.Name;driver=$_.DriverVersion;refreshHz=$_.CurrentRefreshRate}})
  presentMon=[ordered]@{path=if($presentMonPath){Split-Path -Leaf $presentMonPath}else{$null};version=$presentMonVersion;columns='v2: CPUStartTime + DisplayLatency'}
  captureSeconds=$elapsed
  presentedTimes=@($presentedTimes)
}
$tmp=$CaptureOut+'.tmp'
[IO.File]::WriteAllText($tmp,($result|ConvertTo-Json -Depth 8 -Compress),(New-Object Text.UTF8Encoding($false)))
Move-Item -LiteralPath $tmp -Destination $CaptureOut -Force
