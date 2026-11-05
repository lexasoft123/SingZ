# Linux ARM64 (Orange Pi 5 and similar boards)

The Linux desktop port builds and packages natively on ARM64 (`linux-arm64`),
the same pipeline as the x64 leg with the architecture-specific pieces
swapped. The first target is the Orange Pi 5 (Rockchip RK3588S), but nothing
in the build is RK3588-specific.

## What runs on the board

- The stem splitter is the same CPU ONNX pack as Windows and Intel Macs:
  relocatable CPython + demucs-onnx + onnxruntime, built for
  `aarch64-unknown-linux-gnu`. The pack manifest is stamped
  `linux-arm64`, and `packComplete()` in `src/main/models.ts` refuses a
  pack whose manifest target does not match `linux-${process.arch}` — an
  x64 pack dropped onto an ARM64 install reads as "not installed", never
  as a working splitter.
- The lyrics engines (`llama-server`, `crispasr`) and `singz-analyze` are
  compiled with `GGML_NATIVE=OFF` and no board-specific ISA extensions:
  baseline ARMv8, CPU inference. "CPU-only" describes the AI acceleration
  at this stage — the RK3588 NPU and Mali GPU are not used by the models.
  The desktop UI itself renders through the system's normal GL stack and
  can use the Mali graphics driver; that driver path is the part awaiting
  on-board qualification.
- `assert-portable-binary.sh` reads each helper's ELF class/machine with
  `readelf` (under `LC_ALL=C`) and rejects a binary that does not match its
  `vendor/linux-*` directory, so a mislabeled cached x64 helper cannot
  reach an arm64 package.

## Compatibility floor: Debian 13 ARM64

Debian 13 (trixie) ARM64 is the intended supported target, and the package
is built there against glibc 2.41. The build's glibc version does not by
itself establish the minimum runtime version; the required symbol versions
do. The completed ARM64 `llama-server` has been verified to require at most
`GLIBC_2.38` and `GLIBCXX_3.4.32`, but this does not establish the whole
package baseline because the other helpers, native addon, and Electron are
still being built and audited. Aggregate symbol requirements and support on
other distributions remain unqualified. In particular, neither Ubuntu
24.04's incompatibility nor its compatibility can be inferred from the build
glibc version or dependency metadata alone. Full-package qualification and
board qualification remain pending.

## Board qualification status

Configured, not yet hardware-qualified. The ARM64 CI leg (below) is set up
to install the package on an ARM64 host and exercise bundled-splitter
extraction, six-stem split, save/reopen, playback, lyrics and mixer
controls — the same installed-app gate the x64 leg runs. On real Orange Pi
5 hardware the following remains open:

- Mali G610/Panthor GL behavior under the vendor kernel (Chromium's
  fallback paths if the driver is incomplete).
- Physical audio I/O. Hosted Linux CI gives Chromium a private PulseAudio
  software sink and runs browser-mode playback — no physical audio device
  exists on the runner, so those runs establish nothing about real
  endpoints. Playback, capture, monitoring and underrun recovery over a
  physical FLOW 8 USB interface are board-qualification work. The Debian
  stand's `snd-aloop` ALSA loopback check is a separate software-device check,
  not hosted CI.
- Split latency and throughput: no numbers have been measured on an
  RK3588. Quote nothing until the board has run the parity gates.

## CI and local builds

`.github/workflows/linux.yml` runs both legs from one matrix: `x64` on
`ubuntu-26.04`, `arm64` on `ubuntu-26.04-arm` (GitHub's ARM64 hosted
image). Each leg builds in the same Debian 13 (trixie) + Clang 21
container and installs/tests its own `.deb` on its own host, so the ARM64
host natively executes the Debian 13-built binaries. Engine, compiler and
npm caches are keyed per architecture; one leg can never restore the
other's compiled binaries.

Local reproduction is identical to the x64 stand, on an ARM64 machine or
ARM64 VM/container running Debian 13:

```sh
SINGZ_CI_STAGE=build bash scripts/ci/linux-package.sh          # Debian 13 arm64 + clang-21
SINGZ_CI_STAGE=installed-test bash scripts/ci/linux-package.sh # installs the arm64 .deb
```

On the Debian 13 x64 stand, an ARM64 QEMU user-mode container can build
and run the package. That validation scope is functional correctness
only: instruction-set emulation proves the pipeline and gates pass, and
says nothing about real-board speed, thermals, or GPU behavior. Present
its results as emulated, never as board numbers.
