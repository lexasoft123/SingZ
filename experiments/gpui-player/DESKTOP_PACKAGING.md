# Native desktop preview packages

The native runtime uses Rust/GPUI and three standalone C++ tools. Packaging runs
without Node or Electron, and copies an already-built runtime. Shared UI fonts
are embedded by UIKit; both OFL notices travel with the package.

From the checkout root:

```sh
python3 scripts/package-gpui-desktop.py --platform linux \
  --runtime-dir experiments/gpui-player/target/debug --output-dir /tmp/SingZ-Linux
python3 scripts/package-gpui-desktop.py --platform windows \
  --runtime-dir experiments/gpui-player/target/debug --output-dir /tmp/SingZ-Windows
python3 scripts/package-gpui-macos.py \
  --runtime-dir experiments/gpui-player/target/debug \
  --output '/tmp/SingZ Preview.app' --version 0.26.5 --ad-hoc-sign
```

Each output must be fresh. Windows/Linux folders keep all four executables,
`pitch/`, `training-sounds/`, `licenses/`, README and the payload manifest together.
Linux assembly requires a POSIX host to retain executable modes. Windows assembly
snapshots the output parent's authorized access rights before publication; ZIP
distribution omits machine-specific ACLs. Required assets, native platform and
architecture are checked before exclusive publication. Source path/handle
identities and final payload hashes are recorded.

## Verified preview checkpoint, 2026-11-08

| Target | Verified behavior | Scope |
| --- | --- | --- |
| macOS arm64 | Signed bundle passes all 28 payload hashes and deep strict signature verification; normal hidden startup outside the checkout with isolated HOME, system-only PATH and no asset overrides; observed helper and app retire | Local macOS 26 minimum from the actual helper binaries. Startup-only SIGTERM is separate from the prior graceful lifecycle check |
| Linux x86_64 | VM403 Debian 13: Rust 823 passes/two ignored, C++ 277 checks; relocated package runs both real key/autosave cases; normal startup and own-client WM_DELETE exit 0; all 26 payload hashes/modes survive archive extraction | Libraries resolve from standard system locations, no RPATH/RUNPATH or missing libraries in this runtime. Linux binary snapshot predates the later Windows UTF-8 fix |
| Windows x86_64 | Dell: Rust 768 passes/two ignored, C++ 291 checks including real CJK/emoji WAV write/resume/read; relocated package runs both real key/autosave cases under a limited user with CJK/emoji project paths; normal startup and own-client WM_CLOSE exit 0 | Actual ANSI code page 1251. System-only PATH, isolated profile/cwd, no asset overrides; hidden/foreground, frameless resize and process-retirement guards pass |

The new portable assembler tests pass on Mac (12 passes/one platform skip) and
Windows (10 passes/three platform skips). Linux's earlier assembler checkpoint
passes 10 tests/one skip. Required pitch model, fifteen samples, calibration and
license notices are included. Optional inference/model packs remain separately
managed; universal OS/libc/runtime coverage, real-device/hotplug, production
visual/temporal parity and release signing/notarization remain open.

Two deployment failures were fixed from real Dell evidence: Python 3.12 path and
handle timestamps require separate same-API stability checks; private staging
ACLs must not lock a published package to the elevated assembler's owner group.
Mac/Linux helper snapshots precede the later Windows-specific path patch; their
Unix behavior is unchanged, and they are not claimed rebuilt from that later
source snapshot. Both identity proofs remain checked, and only new staged payload permissions
change. Native analyzer arguments and WAV I/O now cross Windows boundaries as
strict UTF-8/wide strings, including CLI input/output paths.

For normal Windows close tests, enumerate **only the real positive-size client**.
GPUI also owns a zero-size internal dispatcher window; closing every process
window destroys infrastructure and creates a false shutdown failure. A proposed
dispatcher change was disproved by an actual Win32 queue test and restored to
its exact original bytes. No such production change remains.

Deliverables and compact qualification results are in this session's
`gpui-native-packages-20261108` visualization directory. Raw lab logs remain on
VM403 and Dell; the packages are previews and carry the qualified target scope.

## Codec and Drive delivery follow-up

Default native helper builds now require the pinned FFmpeg SDK instead of silently
shipping WAV/FLAC/MP3-only support. Build it without Node using
`scripts/gpui-codec-runtime.py`, then run:

```sh
python3 scripts/build-gpui-native.py --codec-pack /path/to/codec-sdk --output-dir /path/to/runtime
```

`--basic-only` explicitly selects the reduced development build. Mac helpers use
only `@loader_path/ffmpeg`; Linux helpers use transitive `$ORIGIN/ffmpeg` RPATH;
Windows DLLs stage adjacent to the helpers. Packagers include all four dynamic
libraries and their corresponding-source/replacement notices. Mac codec data
belongs in Resources, while the four signed libraries remain in MacOS/ffmpeg.

The Mac native full codec matrix passes. Actual production helpers on Mac and
VM403 Linux render and measure the eight immutable MP3/AAC/M4A-AAC/M4A-ALAC/
Vorbis/Opus/AIFF/AIFC fixtures. Real anti-phase AIFF, silent input and Unicode
paths also pass Add Track measurement. The signed Mac bundle passes those eight
format paths, deep strict signature verification and all 36 final payload hashes.
These checks qualify helper admission/decoding, not a full player UI session.
The Windows codec build is still pending transfer approval.

Rust reads canonical `mobile/gdrive.config.json` directly, without generating
TypeScript. Set `SINGZ_GPUI_REQUIRE_DRIVE_CONFIG=1` for configured builds. Produce
safe metadata with `singz-gpui-player --native-build-info`, then supply
`--require-drive-config --build-info-file /path/to/info.json` to the packager.
The packager validates the supplied report against the unsigned UI executable
hash and target; it does not launch the app or retain credentials in the report.
Parser tests (10) and authentication tests (12) pass. Mac is configured; staging
app credentials to Dell/VM403 requires the explicit transfer approval requested
in this chat. Previous Windows/Linux preview packages remain unconfigured.

The refreshed `macos-current-clean/SingZ Native.app` preview includes the two standalone
native lyric executables (`llama-server`, `crispasr`) as well as the codec runtime.
Supply a curated pure-native directory to `--engines-dir`; a mixed Electron engine
directory containing `singz-capture.node` is refused before publication. Both
packagers reject selected Node addons and known Node/Electron runtimes. The
focused assembly suite passes 39 tests with one platform skip. This guard does
not reject ordinary native DLL dependencies or JavaScript documentation files.

The current normal app also includes the native footer Karaoke/reveal fixes.
Deep strict signature verification, all 38 final payload hashes, and both bundled
CLI `--help` launches pass. Staging copies payload bytes and modes into fresh
files/directories without inheriting source quarantine metadata. The focused Mac
assembly suite passes 26 tests with one xattr-API platform skip; actual bundle
xattr inspection and native launches provide the runtime check.
