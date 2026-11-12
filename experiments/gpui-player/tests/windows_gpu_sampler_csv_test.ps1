# Regression for windows_gpu_sampler.ps1's frame statistics on synthetic PresentMon v2 CSVs.
#   powershell -NoProfile -ExecutionPolicy Bypass -File windows_gpu_sampler_csv_test.ps1
# Exits 1 on the first failed expectation. Needs no PresentMon and no running app.
$ErrorActionPreference='Stop'
$sampler=Join-Path $PSScriptRoot 'windows_gpu_sampler.ps1'
$dir=Join-Path ([IO.Path]::GetTempPath()) ("singz-csv-test-"+[Guid]::NewGuid().ToString('N'));New-Item -ItemType Directory -Path $dir|Out-Null
$period=1000.0/60
# rows: slot index -> 'shown' or 'skipped'; removed slots are simply absent from the CSV.
function Write-Csv($name,$slots,$skippedSlots){
  $lines=@('Application,ProcessID,CPUStartTime,DisplayLatency,DisplayedTime')
  foreach($i in $slots){
    $cpu=$i*$period
    if($skippedSlots -contains $i){$lines+="app.exe,1,$cpu,NA,NA"}else{$lines+="app.exe,1,$cpu,5.0,16.6"}
  }
  $path=Join-Path $dir $name;Set-Content -LiteralPath $path -Value $lines -Encoding ASCII;return $path
}
# PresentMon 2.3.1's console CSV has TimeInMs and MsUntilDisplayed instead (a real capture's header).
function Write-CsvV3($name,$slots,$skippedSlots){
  $lines=@('Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,TimeInMs,MsBetweenSimulationStart,MsBetweenPresents,MsBetweenDisplayChange,MsInPresentAPI,MsRenderPresentLatency,MsUntilDisplayed')
  foreach($i in $slots){
    $t=$i*$period
    if($skippedSlots -contains $i){$lines+="app.exe,1,0x1,DXGI,0,0,0,Composed: Flip,$t,NA,1,NA,0.5,1,NA"}else{$lines+="app.exe,1,0x1,DXGI,0,0,0,Composed: Flip,$t,NA,1,16.6,0.5,1,5.0"}
  }
  $path=Join-Path $dir $name;Set-Content -LiteralPath $path -Value $lines -Encoding ASCII;return $path
}
function Get-Stats($csv){
  $out=Join-Path $dir 'out.json'
  & powershell -NoProfile -ExecutionPolicy Bypass -File $sampler -CsvInput $csv -CsvOut $out -CsvExpectedHz 60|Out-Null
  return (Get-Content -LiteralPath $out -Raw|ConvertFrom-Json).frames
}
function Expect($name,$actual,$expected){
  if($actual -ne $expected){Write-Error "FAIL $name : got $actual, expected $expected";exit 1}
  Write-Host "ok   $name = $actual"
}
$all=0..119
Expect 'clean run drops' (Get-Stats (Write-Csv 'clean.csv' $all @())).dropped 0
# One frame the compositor never showed: exactly one drop. The old code moved the skipped
# frame to the end of the series, so the gap it left was counted a second time (2).
Expect 'skipped frame inline counts once' (Get-Stats (Write-Csv 'skip.csv' $all @(60))).dropped 1
Expect 'skipped frame is reported as skipped' (Get-Stats (Write-Csv 'skip2.csv' $all @(60))).skipped 1
# Two adjacent skipped frames: two drops.
Expect 'two skipped frames' (Get-Stats (Write-Csv 'skip3.csv' $all @(60,61))).dropped 2
# A frame missing entirely (never presented at all): one drop.
Expect 'missing frame counts once' (Get-Stats (Write-Csv 'gone.csv' ($all|Where-Object{$_ -ne 60}) @())).dropped 1
# A skipped frame plus a separate missing frame: two.
Expect 'skipped and missing' (Get-Stats (Write-Csv 'both.csv' ($all|Where-Object{$_ -ne 90}) @(30))).dropped 2
Expect 'v3 clean run drops' (Get-Stats (Write-CsvV3 'v3clean.csv' $all @())).dropped 0
Expect 'v3 skipped frame counts once' (Get-Stats (Write-CsvV3 'v3skip.csv' $all @(60))).dropped 1
Expect 'v3 fps' ([Math]::Round((Get-Stats (Write-CsvV3 'v3fps.csv' $all @())).fps)) 60
Remove-Item -LiteralPath $dir -Recurse -Force
Write-Host 'all expectations hold'
