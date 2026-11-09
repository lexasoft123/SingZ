# Windows codec dependency checkpoint — 2026-11-09

This checkpoint repairs the native SDK inspector and verifies public FFmpeg DLLs
on Dell `DESKTOP-5G2SN2I`. It does not qualify decoding, the current GPUI app, or a
release package. No Node/Electron or app UI was launched.

## Actual build findings

The existing Dell builder and profile matched app checkpoint `165781d0`:

- Builder SHA-256: `371c0eb8bd281039e17d98faf7f043c4391dc3a61f9d59771042a89171b08c61`.
- Profile SHA-256: `def8b867ebe9355f546de38ffdfff0308ad92582d02b5ebe365b8e016521a951`.
- Official FFmpeg 8.0.1 archive SHA-256:
  `05ee0b03119b45c0bdb4df654b96802e909e0a752f72e4fe3794f487229e5a41`.

The first build failed compiler detection: only Russian MSVC resources were
installed, so even `VSLANG=1033` did not produce the English banner that pinned
FFmpeg configure recognizes. It selected GCC-style `-o` instead of MSVC `-Fo`;
the linker rejected the resulting compiler-test object. Keep this failed run.

The official Visual Studio installer added `en-US` to the existing Build Tools
instance using `modify --addProductLang en-US --quiet --norestart
--noUpdateInstaller`; it exited zero without requesting a restart. MSVC remains
19.44.35228, x64-hosted/x64-targeted. Process-local `VSLANG=1033` then passed the
actual Bash compiler/linker/librarian detection and a tiny x64 compile/link/run.
This prerequisite is important on localized machines; changing output encoding
alone cannot supply missing language resources. See Microsoft's
[installer parameters](https://learn.microsoft.com/en-us/visualstudio/install/use-command-line-parameters-to-install-visual-studio?view=vs-2022).

The fresh second build used the unchanged pinned source/flags, existing MSYS2
Bash/make and two compiler jobs. Configure, compilation and `make install`
succeeded. Final SDK inspection failed: FFmpeg installs its MSVC import libraries
as `bin/avcodec.lib`, `bin/avformat.lib`, `bin/avutil.lib` and
`bin/swresample.lib`, beside the DLLs. The inspector only accepted `lib/` paths.
The SDK destination was not published. Retained public build/install output:

`C:\Users\123\singz-lab\public-codecs-20261109\work-v2`

The source repair accepts the upstream `bin/<component>.lib` layout while
preserving the existing `lib/` layouts, immutable inventory checks and exact
CMake link/runtime paths. Runtime staging still delivers only DLLs and compliance
metadata. Its new regression reproduces the original failure, verifies these
paths and DLL-only staging, and still rejects a missing import library. All nine
focused codec assembly tests pass; their synthetic fixtures do not prove decode.
Packaging assembly checks also pass (13 passed, one Windows-only check skipped
on this macOS host).

## Actual DLL loading evidence

A separate public-API probe checked the retained install stage with the unchanged
remote inspector's binary/configuration helpers, then copied only the four DLLs
to a fresh `relocated-v1` directory. It retained original/relocated hashes and
resolved module paths. It ran inside the installed Python process with PATH
restricted to `C:\Windows\System32;C:\Windows` and an explicit DLL directory.

| DLL | ABI major | SHA-256 |
| --- | --- | --- |
| avcodec-62.dll | 62 | `5f0cc629264f59090d8fa7a8ab0e06cedc0995f62353fff1b0bfd07b49027587` |
| avformat-62.dll | 62 | `9b9baced435cd54bba9fb151541f8e4c2b4b24ab00ca3a2d3eb9ba427e0f88e5` |
| avutil-60.dll | 60 | `a64f4f483968fa674e575a003fcd2b366ea282c2f6000ffd71285fbb7e10f8da` |
| swresample-6.dll | 6 | `dc64fc3bbded98b8704fb727481b65de6f07a9c3652c95a5fee1d246cc3fb3c0` |

All four actual loaded module paths match that relocation directory. The probe
verifies version `8.0.1`, exact `LGPL version 2.1 or later`, matching configuration
tokens against the install receipt, all 20 required decoder lookups and all five
required demuxer lookups. DLL hashes remain unchanged. Parser availability and
actual decoding were not exercised. `dumpbin /dependents` reports are retained.

System-only PATH is not standalone-package proof: Python had already loaded its
own runtime and C runtime dependencies, including `vcruntime140.dll` from its
installation. The complete loaded-module list is retained. No SDK/build/MSYS
module path appears in it. The actual installed-stage check is deliberately
separate from immutable SDK inspection/publication, which failed above.

A second, separate WinAPI diagnostic compiled with MSVC `/MT` verifies loading
without Python. Its only imported DLL is `KERNEL32.dll`. From a fresh directory
containing the executable and four identical FFmpeg DLLs, with system-only PATH,
it loads each absolute DLL path using DLL-directory/system-directory search
flags, checks actual module paths, ABI majors, version and exact license, then
exits zero. The diagnostic executable SHA-256 is
`c7865ed7fa451b7f8c3c575b8bd49d7bbc9b412b700a3b6f55ed5fa0938241b1`.
The first launcher stopped before execution on a case-sensitive Python environment
lookup; the retained compiled executable was subsequently run successfully,
without rebuilding. Both records remain. These are standalone DLL load checks,
still not decoding, helper/app execution or final package qualification.

## Remaining qualification

The repaired private builder has not been sent to Dell. Automatic approval review
rejected private-source export to the target machines pending explicit user
source-transfer authorization. This checkpoint used only already-present tools,
the existing builder, public dependencies and a public-API diagnostic probe.

After authorized source delivery, publish a fresh SDK with the repaired builder,
verify its inventory, then build and exercise the codec-enabled native helpers
and app. Run the complete canonical codec fixture matrix, including failure,
cancellation, descriptor ownership and Unicode-path cases, followed by relocated
helper/app delivery checks. An older basic-only helper cannot gain codec support
by placing these DLLs beside it. Current Windows/Linux application workflows,
physical devices, real-account Drive and release qualification remain open.

Durable evidence is `gpui-windows-codecs-20261109` under this chat's visualization
directory: both build outcomes, language installation/preflight, installed-file
hashes, dependency reports, the public-API probe and its module list. No private
source, production OAuth configuration or compiled app was transferred here.
