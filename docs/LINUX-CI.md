# Linux desktop package CI

`.github/workflows/linux.yml` builds Linux Debian packages on pull
requests, pushes to `main`, `v*` tags, and manual dispatch — one matrix
leg per architecture: `x64` (amd64) and `arm64`, each on its matching
hosted runner image (the ARM64 leg runs on `ubuntu-26.04-arm`). Successful
runs upload installers and checksums; they do not publish a release.
See [LINUX-ARM64.md](LINUX-ARM64.md) for the Orange Pi 5 target notes.

## Build and test stages

The workflow calls `scripts/ci/linux-package.sh` twice per leg; the script
maps the host machine (`x86_64`/`aarch64`) to the SingZ target arch
(`linux-x64`/`linux-arm64`) and the Debian package arch (`amd64`/`arm64`):

1. `SINGZ_CI_STAGE=build` runs in a Debian 13 container using Node 24 and
   Clang 21. It installs dependencies, runs TypeScript/unit/native checks,
   builds the bundled processing engines and splitter pack, and creates the
   `.deb`. Native artifact manifests and checksums are verified during
   packaging.
2. `SINGZ_CI_STAGE=installed-test` installs the package on the runner host
   and tests `/opt/SingZ/singz`. It loads the installed native addon and
   runs the desktop app under headless Wayland and X11, exercising bundled
   splitter extraction, local splitting, project save/open, playback,
   lyrics, and mixer controls.

The container builds Debian-baseline binaries; each runner installs the
matching-architecture package and executes it natively, so the glibc floor
is whatever Debian 13 ships. Package upload happens only after those tests
pass.

## Audio testing

Hosted runners use a private PulseAudio null sink and
`SINGZ_E2E_AUDIO=browser`, so playback has a running audio clock without a
physical sound device. This verifies the packaged desktop path; native ALSA
signal routing requires a Linux host with `snd-aloop`.

For native loopback testing, build the package and follow
[the Linux development instructions](../tools/dev/linux/README.md#alsa-loopback-testing).
The packaged-app harness accepts `SINGZ_E2E_REQUIRE_LOOPBACK=1` to require
its named virtual playback/capture device. Leave `SINGZ_E2E_AUDIO` unset
for that mode. Automated audio tests use virtual devices and remain silent.

## Caches and artifacts

Compiled engines and the splitter pack use an exact source/input cache key
prefixed with the leg's architecture — an x64 cache entry can never be
restored into an arm64 build or vice versa. Compiler objects and npm
downloads use their own per-architecture keys and integrity checks and can
reuse compatible cache entries. Native source fingerprints and package
checksums are checked on every build.

Successful legs upload `dist/*.deb`, Linux update metadata, and checksum
files as `SingZ-linux-amd64` / `SingZ-linux-arm64`. Logs and screenshots
under `build/native/linux-package-ci-<arch>` and
`build/native/linux-package-e2e-<arch>` are uploaded as
`linux-desktop-diagnostics-<arch>`, including after failures. Artifacts are
retained for 14 days.

For local reproduction, use Node 24 and Clang 21 on Linux (x86_64 or
aarch64). The workflow lists the required build and desktop runtime
packages. Run
`SINGZ_CI_STAGE=build bash scripts/ci/linux-package.sh` in the build
environment,
then `SINGZ_CI_STAGE=installed-test bash scripts/ci/linux-package.sh` on
the host with desktop test dependencies installed. The latter uses `sudo`
only to install the generated Debian package.
