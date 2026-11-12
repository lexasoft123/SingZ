<#
Windows (win32-x64) port of scripts/vendor-llama.sh and scripts/vendor-crispasr.sh:
builds llama-server.exe and crispasr.exe at the pinned revisions and publishes
them, with receipts, into vendor/win32-x64 through scripts/engine-artifact.cjs.

Run from an x64 MSVC environment (vcvars64.bat) with git, cmake, ninja and node
on PATH, under the native build lock:

  node scripts/with-native-build-lock.mjs --owner vendor-engines-win -- `
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts/vendor-engines-windows.ps1 [-Engine llama|crispasr|all]

The pins and cmake flags are read from / mirror the bash scripts; keep them in step.
#>
param(
  [ValidateSet('llama', 'crispasr', 'all')][string]$Engine = 'all',
  [ValidateRange(1, 4)][int]$Jobs = 4
)
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$Target = 'win32-x64'
foreach ($tool in 'git', 'cmake', 'ninja', 'node', 'cl') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) { throw "required tool missing from PATH: $tool (cl needs vcvars64.bat)" }
}
if (-not $env:SINGZ_NATIVE_BUILD_LOCK_HELD) { throw 'run under scripts/with-native-build-lock.mjs' }
node (Join-Path $Root 'scripts/assert-native-build-lock.cjs'); if ($LASTEXITCODE) { throw 'build lock not held' }

function Native([scriptblock]$Command) { & $Command; if ($LASTEXITCODE) { throw "command failed ($LASTEXITCODE): $Command" } }

# Static CRT (/MT): the engines must not import vcruntime140*.dll / msvcp140.dll /
# vcomp140.dll, which a clean machine may lack. CMP0091 makes the cmake
# runtime-library selection take effect; it also reaches every submodule target.
# MSVC has no static OpenMP runtime (/openmp always imports vcomp140.dll), so ggml
# runs on its own thread pool instead: -DGGML_OPENMP=OFF.
$StaticCrt = @('-DCMAKE_POLICY_DEFAULT_CMP0091=NEW', '-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreaded', '-DGGML_OPENMP=OFF')

$Specs = @{
  llama = @{
    Script = 'vendor-llama.sh'; Url = 'https://github.com/ggml-org/llama.cpp'; Dir = 'llama.cpp'
    RefVar = 'SINGZ_LLAMA_REF'; BuildTarget = 'llama-server'; Exe = 'llama-server.exe'
    Flags = @('-DBUILD_SHARED_LIBS=OFF', '-DLLAMA_BUILD_TESTS=OFF', '-DLLAMA_BUILD_EXAMPLES=OFF', '-DLLAMA_CURL=OFF', '-DLLAMA_OPENSSL=OFF', '-DGGML_NATIVE=OFF')
  }
  crispasr = @{
    Script = 'vendor-crispasr.sh'; Url = 'https://github.com/CrispStrobe/CrispASR'; Dir = 'CrispASR'
    RefVar = 'SINGZ_CRISPASR_REF'; BuildTarget = 'crispasr-cli'; Exe = 'crispasr.exe'
    Flags = @('-DCRISPASR_BUILD_TESTS=OFF', '-DBUILD_SHARED_LIBS=OFF', '-DGGML_NATIVE=OFF', '-DCMAKE_DISABLE_FIND_PACKAGE_OpenMP=ON')  # CrispASR's own find_package(OpenMP) links vcomp140
  }
}

function Build-Engine([string]$Name) {
  $s = $Specs[$Name]
  $text = Get-Content -Raw (Join-Path $Root "scripts/$($s.Script)")
  if ($text -notmatch ('REF=\$\{' + $s.RefVar + ':-([^}]+)\}')) { throw "cannot read pinned ref from $($s.Script)" }
  $ref = if ([Environment]::GetEnvironmentVariable($s.RefVar)) { [Environment]::GetEnvironmentVariable($s.RefVar) } else { $Matches[1] }
  $out = Join-Path $Root "vendor/$Target/$($s.Exe)"
  node (Join-Path $Root 'scripts/engine-artifact.cjs') check $Root $Name $Target $ref
  if ($LASTEXITCODE -eq 0) { Write-Host "cached: vendor/$Target/$($s.Exe)"; return }
  $producer = (node (Join-Path $Root 'scripts/engine-artifact.cjs') producer-hash $Root $Name).Trim()
  $src = Join-Path $Root ".engines-src/$($s.Dir)"
  New-Item -ItemType Directory -Force (Join-Path $Root '.engines-src') | Out-Null
  if (-not (Test-Path $src)) { Native { git -c core.longpaths=true clone --filter=blob:none $s.Url $src } }
  Native { git -C $src -c core.longpaths=true fetch --depth 1 origin $ref }
  Native { git -C $src -c core.longpaths=true checkout --detach FETCH_HEAD }
  Native { git -C $src -c core.longpaths=true submodule update --init --recursive --depth 1 }
  $commit = (git -C $src rev-parse HEAD).Trim()
  $build = Join-Path $src "build-$Target"
  Native { cmake -S $src -B $build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_COMPILER=cl -DCMAKE_CXX_COMPILER=cl @StaticCrt @($s.Flags) }
  Native { cmake --build $build --parallel $Jobs --target $s.BuildTarget }
  $bin = Join-Path $build "bin/$($s.Exe)"
  if (-not (Test-Path $bin)) { throw "build produced no $bin" }
  # Windows counterpart of assert-portable-binary.sh: report non-system DLL imports.
  # The VC runtime (vcruntime140*, msvcp140*, vcomp140) is deliberately NOT allowed:
  # with /MT the engine carries its own copy.
  $imports = (dumpbin /dependents $bin) -match '\.dll' | ForEach-Object { $_.Trim() }
  Write-Host "$($s.Exe) imports: $($imports -join ', ')"
  $local = $imports | Where-Object { $_ -notmatch '^(?i)(kernel32|user32|advapi32|shell32|ws2_32|bcrypt|crypt32|ole32|oleaut32|ntdll|gdi32|winmm|winhttp|mfplat|mfreadwrite|iphlpapi|api-ms-win-.*|ucrtbase)\.dll$' }
  if ($local) { throw "$($s.Exe) depends on non-system libraries: $($local -join ', ')" }
  Native { node (Join-Path $Root 'scripts/engine-artifact.cjs') publish $Root $Name $Target $ref $commit $bin $producer }
  Write-Host "vendored: $out"
}

foreach ($name in 'llama', 'crispasr') { if ($Engine -eq 'all' -or $Engine -eq $name) { Build-Engine $name } }
