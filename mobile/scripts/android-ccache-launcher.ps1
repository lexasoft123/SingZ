param(
  [Parameter(Mandatory = $true)][string]$CcacheExecutable,
  [Parameter(Mandatory = $true)][string]$BaseDirectory,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$CompilerArguments
)

# Compatibility entry point for previously configured Ninja graphs.
$sharedLauncher = Join-Path $PSScriptRoot '../../scripts/ccache-launcher.ps1'
& $sharedLauncher $CcacheExecutable $BaseDirectory @CompilerArguments
exit $LASTEXITCODE
