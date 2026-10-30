param(
  [Parameter(Mandatory = $true)][string]$CcacheExecutable,
  [Parameter(Mandatory = $true)][string]$BaseDirectory,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$CompilerArguments
)

$env:CCACHE_BASEDIR = $BaseDirectory
$env:CCACHE_NOHASHDIR = '1'
$env:CCACHE_COMPILERCHECK = 'content'
$singzSloppiness = @($env:CCACHE_SLOPPINESS -split ',' | Where-Object { $_ })
foreach ($singzRequired in @('pch_defines', 'time_macros')) {
  if ($singzSloppiness -notcontains $singzRequired) {
    $singzSloppiness += $singzRequired
  }
}
$env:CCACHE_SLOPPINESS = $singzSloppiness -join ','

& $CcacheExecutable @CompilerArguments
exit $LASTEXITCODE
