# Separate, explicitly console-free process; slow WMI never blocks focus sampling.
param([Parameter(Mandatory=$true)][string]$App,
      [Parameter(Mandatory=$true)][string]$Flag,
      [Parameter(Mandatory=$true)][string]$Out)
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
