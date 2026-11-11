# Build native GPUI helpers with the pinned codec SDK. No Node/Electron.
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\experiments\gpui-player\target\debug'),
    [ValidateRange(1, 4)][int]$Jobs = 2,
    [string]$CodecPack = '',
    [switch]$BasicOnly
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$arguments = @((Join-Path $PSScriptRoot 'build-gpui-native.py'), '--output-dir', $OutputDirectory, '--jobs', "$Jobs")
if ($CodecPack) { $arguments += @('--codec-pack', $CodecPack) }
if ($BasicOnly) { $arguments += '--basic-only' }
& python.exe @arguments
if ($LASTEXITCODE -ne 0) { throw "Native GPUI helper build failed: $LASTEXITCODE" }
