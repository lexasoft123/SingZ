param(
  [Parameter(Mandatory = $true)][string]$CcacheExecutable,
  [Parameter(Mandatory = $true)][string]$BaseDirectory,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$CompilerArguments
)

$env:CCACHE_BASEDIR = $BaseDirectory
$env:CCACHE_NOHASHDIR = '1'
$env:CCACHE_COMPILERCHECK = 'content'

& $CcacheExecutable @CompilerArguments
exit $LASTEXITCODE
