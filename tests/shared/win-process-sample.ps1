# CPU and memory for a process tree on Windows, for the desktop session
# harness — which had neither, and printed n/a for every CPU and footprint row
# on this platform.
#
# Deliberately NOT Get-Counter: its counter PATHS are localized, so
# '\Process(*)\% Processor Time' returns nothing at all on a Russian Windows
# and the sampler reads as "quiet" while the machine is busy. Process CPU TIME
# is a number, in seconds, under a property name that is the same in every
# locale — sample it twice and divide.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File win-process-sample.ps1 -RootPid 1234 -WindowSec 2
#
# Prints one line of JSON: cpuPct is percent of ONE core summed over the tree
# (the same unit `top` gives on macOS), memMb is the summed working set.
param(
  [Parameter(Mandatory = $true)][int]$RootPid,
  [double]$WindowSec = 2
)
$ErrorActionPreference = 'Stop'

# The tree, by parent id. Win32_Process is a class name, not a localized
# string, so this survives the locale too.
$all = @{}
foreach ($p in Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId) {
  if (-not $all.ContainsKey([int]$p.ParentProcessId)) { $all[[int]$p.ParentProcessId] = New-Object System.Collections.ArrayList }
  [void]$all[[int]$p.ParentProcessId].Add([int]$p.ProcessId)
}
$tree = New-Object System.Collections.ArrayList
[void]$tree.Add($RootPid)
for ($i = 0; $i -lt $tree.Count; $i++) {
  $kids = $all[[int]$tree[$i]]
  if ($kids) { foreach ($k in $kids) { [void]$tree.Add($k) } }
}

# PER PROCESS, and that is the whole correctness of this script. `.CPU` is
# total processor SECONDS since the process started, so the interval cost is a
# difference — and differencing the SUM is wrong: an Electron app retires
# utility processes while it runs, and one that exits inside the window takes
# its whole lifetime out of the second sum. That made the summed delta
# NEGATIVE, and clamping a negative to zero is how this reported 0% CPU for a
# song that was playing, in all eight rows, on the first run.
#
# Snapshot the value into a double as it is read: `.CPU` is a script property
# on a LIVE Process object and re-reads the counter every time it is touched,
# so holding the object and subtracting later gives exactly zero.
function Sample($pids) {
  $cpu = @{}
  $mem = 0.0
  foreach ($id in $pids) {
    $proc = Get-Process -Id $id -ErrorAction SilentlyContinue
    if ($null -eq $proc) { continue }
    if ($null -ne $proc.CPU) { $cpu[[int]$id] = [double]$proc.CPU }
    $mem += [double]$proc.WorkingSet64
  }
  return @{ cpu = $cpu; mem = $mem }
}

$a = Sample $tree
$t0 = [Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds ([int]($WindowSec * 1000))
$b = Sample $tree
$elapsed = $t0.Elapsed.TotalSeconds

# Only processes alive in BOTH samples contribute. One that started inside the
# window is not counted (its share is small and its baseline unknown); one that
# ended is simply absent instead of poisoning the total.
$deltaCpu = 0.0
foreach ($id in $b.cpu.Keys) {
  if ($a.cpu.ContainsKey($id)) {
    $d = $b.cpu[$id] - $a.cpu[$id]
    if ($d -gt 0) { $deltaCpu += $d }
  }
}
$pct = if ($elapsed -gt 0) { ($deltaCpu / $elapsed) * 100 } else { 0 }

$out = @{
  cpuPct = [math]::Round($pct, 1)
  memMb  = [math]::Round($b.mem / 1MB, 0)
  procs  = $tree.Count
  paired = $(($b.cpu.Keys | Where-Object { $a.cpu.ContainsKey($_) }).Count)
  window = [math]::Round($elapsed, 2)
}
$out | ConvertTo-Json -Compress
