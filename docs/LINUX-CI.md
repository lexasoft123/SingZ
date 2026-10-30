# Linux desktop package CI

`.github/workflows/linux.yml` builds Linux amd64 Debian packages on pull
requests, pushes to `main`, `v*` tags, and manual dispatch. Successful runs
upload installers and checksums; they do not publish a release.

## Build and test stages

The workflow calls `scripts/ci/linux-package.sh` twice:

1. `SINGZ_CI_STAGE=build` runs in a Debian 13 container using Node 24 and
   Clang 21. It installs dependencies, runs TypeScript/unit/native checks,
   builds the bundled processing engines and splitter pack, and creates the
   `.deb`. Native artifact manifests and checksums are verified during packaging.
2. `SINGZ_CI_STAGE=installed-test` installs the package on the Ubuntu runner
   and tests `/opt/SingZ/singz`. It loads the installed native addon and runs
   the desktop app under headless Wayland and X11, exercising local splitting,
   project save/open, playback, lyrics, and mixer controls.

The container builds Debian-baseline binaries; the newer host runs the
installed-app tests. Package upload happens only after those tests pass.

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

Compiled engines and the splitter pack use an exact source/input cache key.
Compiler objects and npm downloads use their own integrity checks and can
reuse compatible cache entries. Native source fingerprints and package
checksums are checked on every build.

Successful jobs upload `dist/*.deb`, Linux update metadata, and checksum
files as `SingZ-linux-amd64`. Logs and screenshots under
`build/native/linux-package-ci` and `build/native/linux-package-e2e` are
uploaded as diagnostics, including after failures. Artifacts are retained
for 14 days.

For local reproduction, use Node 24 and Clang 21 on Linux x64. The workflow
lists the required build and desktop runtime packages. Run
`SINGZ_CI_STAGE=build bash scripts/ci/linux-package.sh` in the build environment,
then `SINGZ_CI_STAGE=installed-test bash scripts/ci/linux-package.sh` on the
host with desktop test dependencies installed. The latter uses `sudo` only
to install the generated Debian package.
