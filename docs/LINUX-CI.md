# Linux desktop package CI

`.github/workflows/linux.yml` builds Linux amd64 Debian packages on pull
requests, pushes to `main`, `v*` tags, and manual dispatch. It uploads qualified
installers; it does not publish a release or alter macOS/Windows release jobs.

## Build and qualification stages

The workflow calls the shared `scripts/ci/linux-package.sh` recipe twice:

1. `SINGZ_CI_STAGE=build` runs as an ordinary developer user inside the official
   `node:24-trixie` container with Debian 13 and Clang 21 from trixie-backports.
   The source tree and npm/compiler caches are bind-mounted. The container has
   Docker's default isolation, no extra capabilities or host devices, and no
   credentials. It builds the normal engines, bundled splitter and `.deb`, runs
   static/native/unit/build gates, and verifies artifact provenance, checksums
   and Electron manifest compatibility. Electron runtime execution is deferred
   to the installed-test stage; build-only success is not qualification.
2. `SINGZ_CI_STAGE=installed-test` runs as the GitHub runner's ordinary user on
   the `ubuntu-26.04` host. It installs the Debian package and exercises its
   actual `/opt/SingZ/singz` executable, including the deferred addon load smoke
   and `tests/e2e/linux/package-smoke.cjs`. The newer host libc can execute the
   Debian-baseline binaries without making the package depend on Ubuntu's newer
   build ABI. The separate Debian stand remains the baseline runtime check.

The test launcher adds no `--no-sandbox`, `--privileged`, extra container
capabilities or seccomp exceptions. It preserves the application's existing
BrowserWindow preferences (`sandbox: false` in the current desktop app); this
qualification does not assert renderer sandboxing. Package artifacts are
uploaded only after installed-host testing passes.

The workflow uses the established Node 24 desktop toolchain. Debian trixie
variants are maintained by the [official Node image project](https://github.com/nodejs/docker-node).
The `ubuntu-26.04` x64 runner is listed in the
[official runner-image support table](https://github.com/actions/runner-images#available-images).

## Cache safety and outputs

Engine outputs are cached only against an exact source/input key. There is no
engine-output prefix fallback: existence-based skip guards must not receive an
older pinned helper or splitter pack. Compiler objects and npm downloads can
use prefix fallbacks because their own content/integrity checks establish
whether a cached entry is reusable. Native addon manifests, source fingerprints
and checksums still run on every packaged artifact.

Successful jobs upload `dist/*.deb`, available Linux update metadata and
checksum files as `SingZ-linux-amd64`. Diagnostics under
`build/native/linux-package-ci` and `build/native/linux-package-e2e` are uploaded
even after a failure. Artifacts are retained for 14 days.

## Credentials and Drive tests

This workflow injects no repository secrets and no account tokens. Its Drive
coverage uses local test fixtures. A fresh checkout without the ignored OAuth
application configuration therefore produces a package with real Drive sign-in
unconfigured. To produce a configured installer, an explicitly authorized
trusted build must supply `mobile/gdrive.config.json`; do not infer that CI has
done so merely because mocked Drive tests passed. The existing Debian stand's
configured package and real-account approval/sync/download qualification are
separate evidence.

## Hosted audio and the Debian stand

GitHub-hosted kernels are not assumed to expose `/dev/snd` or `snd-aloop`.
Hosted testing sets `SINGZ_E2E_REQUIRE_LOOPBACK=0` and
`SINGZ_E2E_AUDIO=browser` and reports its actual audio
mode. The host installs `pulseaudio` and `pulseaudio-utils`; the recipe starts
an isolated ordinary-user daemon with a null sink so Chromium AudioContext
playback has a real clock even when no ALSA hardware exists. Its local UNIX
socket is held in a private mode-0700 temporary directory, `PULSE_SERVER` is
passed only to the test child, and the daemon is stopped on exit. This is a
silent software sink, not native device qualification. The job validates the
installed package, local splitting, project save/open, lyrics and desktop
controls without claiming native hardware-audio coverage.

The Debian stand runs the same packaged-app harness with
`SINGZ_E2E_REQUIRE_LOOPBACK=1` to prove ALSA playback/capture on the kernel
loopback cable. That mandatory stand result is not replaced by a hosted
browser-audio pass. Physical FLOW 8/Pi qualification remains a different scope.

The stand also runs `SINGZ_E2E_AUDIO=browser` with the loopback requirement off
to qualify the hosted-runner path independently of native hardware. The required
native run remains a separate result. Its forced-underrun regression suspends
only its own isolated Electron main process briefly, checks that the UI stops
and records the failure, then proves explicit Play cleanup/reopen. Browser
Chromium stays muted throughout; native signal generation uses only the named
kernel loopback cable.

Qualification uses a four-second synthetic local song for real six-stem and
lead/backing splitting, plus a separate twelve-second FLAC project for lyric,
transport and mixer checks. Each run removes its isolated profile and extracted
engine copy after saving diagnostics. Set `SINGZ_E2E_KEEP_SCRATCH=1` only for a
debug run that needs its temporary files; repeated retained profiles on a
tmpfs-backed `/tmp` consume RAM and can trigger an OOM kill.

## Verified on the Debian stand (2026-10-30)

The Clang 21 build passed 2,020 unit tests (three platform-specific skips) and
all 55 native CTest suites. The installed package passed required ALSA-loopback
Wayland qualification, forced-underrun cleanup/retry, measured headphone gain
and channel switching, offline cold restore, the separate browser-audio path,
and X11 startup/window/preference persistence. The normal VNC app also played
the downloaded Father and Son project to completion with no xruns or DSP errors
and retained its real Drive sign-in, with test hooks disabled.

Installer: `SingZ-0.26.5-linux-amd64.deb`.
SHA-256: `3398eb188f36ceda6b87f81efff2e0a535c225f408b6571a7b0c2edba906743d`.
The stand has 15 GiB RAM; the complete installed-test unit reported a 9 GiB
peak including file cache. A low-memory hosted runner needs adequate swap or
a larger runner. GitHub execution itself has not yet been run; the workflow
and shared recipe were validated locally and on the Debian stand.
