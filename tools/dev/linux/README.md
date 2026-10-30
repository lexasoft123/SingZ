# Debian 13 native development container

Use rootless Podman on a Debian Linux host. The image contains GCC, Clang 21,
CMake/Ninja, Node/npm and Linux audio/graphics development headers. It does
not by itself qualify hardware. The source now includes the initial Linux
ALSA device backend described below. The image runs `tini` as PID 1 so
orphaned test children are reaped. Existing containers built before this change
can run qualification through `tini -s -- bash scripts/ci/linux-package.sh`
after installing Debian’s `tini` package inside the container.

Host prerequisites, installed from Debian repositories:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends podman uidmap passt slirp4netns \
  fuse-overlayfs dbus-user-session rsync ca-certificates
podman info --format '{{.Host.Security.Rootless}}'
```

The user must have subordinate UID/GID ranges in `/etc/subuid` and
`/etc/subgid`. Do not run the development container with sudo or privileged
access. It needs neither audio/GPU devices nor a graphical session to run
the deterministic native suites.

For a persistent SSH-only development host, enable the user's systemd manager:

```sh
sudo loginctl enable-linger "$USER"
sudo systemctl start "user@$(id -u).service"
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemctl --user daemon-reload
systemctl --user start dbus.socket
```

The reload is useful when `dbus-user-session` was installed after the user
manager had already started. Verify that Podman reports rootless mode and
the intended cgroup manager before starting a build.

From the source root, resolve and record the base image before building:

```sh
podman pull docker.io/library/debian:13-slim
base_image=$(podman image inspect docker.io/library/debian:13-slim \
  --format '{{index .RepoDigests 0}}')
podman build --build-arg DEBIAN_BASE="$base_image" \
  --file tools/dev/linux/Containerfile --tag localhost/singz-dev:debian13 .
```

The base digest and the installed-package manifest make each built image
traceable. Apt packages are resolved when the image is built; rebuilds are
not guaranteed identical without a pinned package snapshot. Preserve the
built image and its inspection metadata for a reproducible test rerun.
Clang 21 and its runtime/linker packages come from Debian's signed
`trixie-backports` repository. `CC=clang-21` and `CXX=clang++-21` are the image
defaults; CMake records the exact compiler version in each build directory.

Create a persistent development container with source, output and cache kept
separate. Run these commands on the Linux host from the source root:

```sh
mkdir -p ../container-work ../container-cache/ccache ../container-cache/npm
podman create --name singz-dev --userns=keep-id \
  --user "$(id -u):$(id -g)" \
  --volume "$PWD:/src:ro" \
  --volume "$PWD/../container-work:/work:rw" \
  --volume "$PWD/../container-cache:/cache:rw" \
  localhost/singz-dev:debian13
podman start singz-dev
podman exec singz-dev bash tools/dev/linux/native-tests.sh
```

`native-tests.sh` builds all default native targets with Clang 21 in Release,
enables the host tools and test suite, and runs all registered tests serially.
CTest failure propagates to the caller. It saves configure/build/CTest logs,
environment details and JUnit results under `../container-work/native-clang21-release`.
Tests with fixed temporary paths cannot safely run concurrently in the same
container. Build jobs default to four to leave memory/CPU headroom.

For a second compiler, use an independent build directory:

```sh
podman exec --env CC=gcc --env CXX=g++ \
  --env SINGZ_BUILD_ROOT=/work/native-gcc-release \
  singz-dev bash tools/dev/linux/native-tests.sh
```

Source transfer to a remote host must exclude credentials, `.git`, local
configuration, dependency trees and build outputs. For the native baseline,
only the root CMake files, `cmake/`, `zcore/`, `zdsp/`, `native/`,
`third_party/native/`, `tools/native/`, `tools/dev/linux/`, `tests/native/`,
`tests/shared/`, `tests/fixtures/` and `assets/pitch/` are required.
Record the source snapshot checksum and local Git revision alongside results;
a working-tree snapshot can differ from that revision.

Hardware tests later need explicitly scoped devices and scheduling permissions.
Whole-system A/B boot tests need a separate VM or Pi, not this container.

## ALSA playback and capture

Desktop Linux now selects `zcore/platform/linux/` rather than the unsupported
host. It requires `libasound2-dev`, `libudev-dev` and `pkg-config` (already in
the compiler image). Direct hardware PCM endpoints have exclusive ownership;
there is no sound-server or rate-conversion fallback. Inventory UIDs use a
verified USB serial, physical path or virtual-card identity, and reject
duplicates. Capability discovery briefly opens an unconfigured, nonblocking
PCM handle; it never starts audio. Cached capability bounds survive EBUSY
while a stream is active. Exact rate, channel count, format, period and ring
size are negotiated and checked again at open.

Output and capture have separate wakeable workers. Capture adapters and duplex
hosts share one prepared capture endpoint through four bounded, noncopyable
subscriber leases. Removing one subscriber does not close another's stream.
The graph callback remains separate from ALSA polling, allocation and locking.
Capture is initially 48kHz/256 frames; output can negotiate another bounded
period. Desktop song playback requests at least 1024 frames when the endpoint
permits it (bounded by its maximum and the 4096-frame engine limit). The ALSA
ring holds four periods: about 85 ms at 48 kHz instead of the 21 ms ring
used by a 256-frame period. Live microphone monitoring keeps its smaller
period. PCM conversion covers float32, signed 16-bit, packed 24-bit, 24-bit in
32-bit storage and signed 32-bit. Non-finite samples are zeroed and counted.
Timestamps are monotonic queue-depth estimates, explicitly not hardware
timestamps. Period/ring sizes are diagnostics, not measured acoustic latency;
zero legacy latency components mean unknown, not a proven zero-latency route.

XRUN, device-loss and failed-render paths stop output and report terminal
status. The desktop retires its Playing indication, preserves the last known
position, writes one terminal diagnostic to the app log and offers explicit
Play recovery through exact cleanup and a fresh graph. They do not silently
restart a song. Reopening a failed shared capture
endpoint requires retiring its affected leases. Udev sound events invalidate
the shared service inventory, including a mixer attached after startup.

Run the existing container test command for the full native suite. On a
writable Linux checkout, a focused Clang 21 preset is also available:

```sh
cmake --preset linux-alsa
cmake --build --preset linux-alsa
ctest --preset linux-alsa
```

The deterministic ALSA test uses the `null` plugin and injected short writes,
EINTR/EAGAIN, XRUN, zero progress and device loss. It does not need `/dev/snd`.
The Linux sanitizer-gate script explicitly builds/runs this suite as well as
its existing preset filters.

For the kernel loopback test, install **on the host**:

```sh
sudo apt-get install --no-install-recommends kmod alsa-utils
```

The kernel must include sound and `CONFIG_SND_ALOOP=m`. The original Debian
cloud kernel omitted sound support. The stand's measured run used the signed
standard Debian kernel `6.12.113+deb13-amd64`, installed through
`linux-image-amd64` and selected with a one-shot GRUB boot. The existing cloud
kernel/default boot selection was retained; choose the standard kernel again
after reboot, or deliberately change the development host's boot default.
Run tests as the ordinary user with audio-device access, not as root. Only
module loading needs sudo; no privileged container/device mount is necessary.

From the source root on the host:

```sh
SINGZ_NATIVE_BUILD_DIR=/absolute/path/to/container-work/native-clang21-release \
  bash tools/dev/linux/alsa-loopback.sh
```

The runner loads the `SingZLoop` virtual card, records the host/binary identity,
and tests both virtual cables. It refuses a different card fixture, so generated
signals never reach the physical/default sound device. It verifies an output
channel swap through two independent capture lanes, capture-only operation,
duplex/input sharing, input detach during playback, output suspend/resume with
another capture lease active, and quiescence after stop. The module stays
loaded for further development; the runner does not add boot-time settings.

The Clang 21 stand run passed **55/55 native tests**, strict source warnings,
targeted ASan/UBSan and TSan cases, and kernel loopback under both sanitizers.
A separate production-mode `.node` build (`SINGZ_CORE_TESTS=OFF`) was exercised
with real Electron: automatic absent/attach/remove/re-attach inventory updates,
a generated cue and six prepared stems through ALSA into capture/YIN analysis,
then stop/unload cleanup. A 220Hz six-stem fixture was detected around 220.002Hz.
The addon also loaded and enumerated ALSA devices in standalone Node 22;
the headless appliance coordinator itself is not implemented yet.
Evidence is generated under `build/native/linux-alsa-results-20261029/`.

This proves the amd64 development path, not Pi/FLOW timing or mixer routing.
The existing addon still exposes one JS capture/analyzer owner; the appliance
needs its per-microphone API. ARM64 and physical hardware qualification remain
pending; normal amd64 app integration is described below. The direct CMake
addon smoke uses an unstamped development artifact and does not bypass or
claim validation by the shipping artifact loader.

## Normal Linux app and Debian packaging

The canonical addon builder accepts `linux-x64` and `linux-arm64`. ELF64
architecture checks, content-addressed manifests, exact file checksums and
compiled Electron/source identities apply to Linux as well. Linux builds
currently require a native host of the requested architecture; accepting an
ARM64 artifact format does not qualify the Pi build.

Build the addon inside the development container's writable app snapshot,
using the same complete native source trees as the renderer snapshot:

```sh
CC=clang-21 CXX=clang++-21 npm run capture:addon -- linux-x64
bash scripts/vendor-analyze.sh linux-x64
bash scripts/vendor-llama.sh linux-x64
bash scripts/vendor-crispasr.sh linux-x64
bash scripts/build-onnx-pack.sh linux-x64
npm run build
```

Use Node 22.12 or newer for the current Electron tooling. Keep the compiler
container separate from the host compositor. The final `npm run dist --
--linux --x64` command also runs a real Electron addon smoke test, so run
that packaging phase in a host graphical session (Cage/VNC is sufficient).
It consumes the container-built addon only if its source identity still
matches. The host packaging phase needs Git, `binutils` (`ar`, `readelf`), the
Electron runtime libraries and Node/npm; it does not need a compiler when
the addon, analysis helper, transcription engines and splitter archive are
current. `dist` builds missing Linux engines and the pack automatically, so
prepare these in the compiler container first. `--dir` produces an unpacked development
app; the default Linux target produces a Debian 13 `.deb`. Publication is
disabled by default. Install a locally built package with:

```sh
sudo apt-get install --no-install-recommends ./dist/SingZ-<version>-linux-amd64.deb
```

The first Linux amd64 installer includes a relocatable Python runtime,
ONNX Runtime CPU, the six-stem Demucs model, Beat This! and the backing-vocal
model. First-run setup extracts this archive through the existing validated,
recoverable pack installation; it requires no system Python, pip or model
download. Cancelled extraction leaves the previous pack available. The
archive remains in app resources for reinstalling. Optional lyrics models
still download through the normal model manager; their CPU executables are
bundled. Linux GPU splitting and ARM64 splitter packs are not qualified.
The build validates beat timings against the Torch reference and checks
that lead plus backing vocals reconstruct the input before creating a pack.

The first complete amd64 package was installed and exercised on Debian 13
under Cage/wayvnc. A fresh profile installed the included splitter offline,
then a 12-second musical excerpt went through the normal file input, six-stem
CPU split, lead/backing separation, Save, reopen and native ALSA Play button.
The last run took 27.2 seconds for the combined split workflow on the 8-vCPU
VM; this is not a Pi performance measurement. All seven saved tracks were
checked for finite stereo audio and matching lengths. Instrument stems were
FLAC; floating-point lead/backing WAVs stayed lossless as the project format
requires. Cancelling a real reinstall during extraction kept the installed
pack usable and removed its staging directory. Evidence and the installer
are under `build/native/linux-normal-package-results-20261029/`.

Google Drive needs the normal OAuth application build configuration. The
clean compiler snapshot deliberately excludes it, so that build hides Drive
until the configuration is separately authorized and supplied. Automated
tests still use `SINGZ_NO_SYNC=1` regardless of build configuration.

The follow-up Drive-enabled installer uses the separately authorized OAuth
application configuration. Evidence is under
`build/native/linux-drive-package-results-20261029/`. The Debian package
depends on `xdg-utils` for external URLs. The minimal VNC stand also needs a
browser (Firefox ESR is installed there); its development Wayland session sets
`BROWSER=firefox-esr` and `MOZ_ENABLE_WAYLAND=1`. Connecting uses the normal
browser and loopback OAuth flow. A user's account sign-in is still separate
from enabling the application configuration.

### Google Drive sign-in from the TV

The current Linux package uses phone approval for Connect: it shows a QR
code for Google's verification URL and the exact approval code. Scan with
any phone camera, enter that code on the phone and approve access there.
There is no TV browser or keyboard step, and the phone need not be on the
same LAN. Arrow keys move between dialog actions, Enter selects, and
Back/Escape cancels. Codes expire and can be replaced. EN/RU dialog copy is
included, with English fallback for other locales.

Provision a separate OAuth application client before using real Google:

1. Open [Google Cloud Console → Clients](https://console.cloud.google.com/auth/clients)
   and select the **existing SingZ project**. Keep Google Drive API enabled.
2. If the consent screen is in Testing, add your account under Google Auth
   Platform → Audience → Test users.
3. Choose Create client → **TVs and Limited Input devices**. Name it
   **SingZ TV**. This flow does not use a loopback redirect URI.
4. Add the two fields below to the existing ignored
   `mobile/gdrive.config.json`, preserving its Desktop client fields:

   ```json
   {
     "tvClientId": "YOUR_TV_CLIENT_ID.apps.googleusercontent.com",
     "tvClientSecret": "YOUR_TV_CLIENT_SECRET"
   }
   ```

5. Rebuild with `npm run dist -- --linux --x64` and install that package.
   `scripts/apply-gdrive-config.cjs` bakes both clients into the main process;
   credentials are not exposed through renderer IPC. Keep the JSON and
   generated configuration modules out of Git.

Desktop browser sessions remain readable. New TV tokens record the issuing
client and refresh with TV credentials; a replaced/missing client requires
reconnection rather than trying its refresh token against another client.
Settings carrying tokens are written with mode 0600 on Linux. Without TV
credentials, Connect explains the setup requirement. It never launches a TV
browser; Windows and macOS retain their existing browser sign-in.

The installed-app test uses a private fake Google/Drive server: QR decoding,
15-character code layout, polling, cancellation, denial, expiry, D-pad retry,
approval, durable tokens and refresh/sync all passed. Actual Google approval
and access to the existing library still need the real TV client and a human
approval. Evidence: `build/native/linux-tv-drive-results-20261029/`.
[Google's device-flow requirements and supported scopes](https://developers.google.com/identity/protocols/oauth2/limited-input-device).

Launch the installed `/opt/SingZ/singz` with `vnc-session.sh` as shown below.
No desktop manager or graphical login is needed. In Settings, enable **Use
native DSP playback**, choose an output marked **(ALSA)** and choose the
native microphone/input channel. Linux native playback is deliberately
opt-in. Direct ALSA endpoints are exclusive; when several outputs exist,
select one explicitly. Chromium remains on its silent sink for a native
output, and an unsupported graph cannot silently play through another
speaker. Native inventory also participates in output-route reconciliation,
so a saved ALSA route is not treated as a missing Chromium device.

The base native decoder supports WAV/FLAC/MP3. A full FFmpeg codec runtime
has not been qualified for Linux; unsupported formats keep the existing
capability refusal/fallback behavior. With a direct ALSA output selected,
a refused native graph shows an error instead of silently using another
route. Native playback finishes v1 WAV-to-FLAC migration before adopting
stem paths, since background conversion can unlink files before Play.

Generated evidence is stored under `build/native/linux-app-results-20261029/`.
The amd64 packaged-app test selects real ALSA endpoints through Settings,
loads a synthetic six-stem project through the hidden file input and uses
the app's normal engine/microphone adapters. On the kernel loopback cable,
a 220 Hz fixture was captured around 220.9 Hz by the packaged Crepe path.
Automated runs launch with `SINGZ_MUTE=1` and `SINGZ_NO_SYNC=1`. A signal test
may lift the native mute only after asserting both selected endpoints are
`snd-aloop`; Chromium stays muted, no physical endpoint is used, and the
native mute is restored at teardown. No shipping source-identity checks
are disabled for this test.

### Linux headphone monitoring controls

The desktop Settings monitor controls now support provider-confirmed ALSA
duplex endpoints. Direct USB, PCI and kernel loopback routes advertise the
monitor capability; unclassified routes remain unavailable. Discovery also
queries period-size bounds and supplies a bounded preferred period (256
frames where allowed). Actual sample rate, format and period still have to
negotiate successfully at open. Capability approval does not measure
mic-to-headphone latency.

Choose the same native input and monitoring output endpoint, select physical
input/output channels, confirm wired headphones and press **Start monitoring**.
The existing gain, pre/post meters, channel selectors and Stop controls apply.
Starting monitoring pauses and retires a native song graph while retaining
the silent Chromium sink. Stop proves native teardown before restoring the
renderer route, and leaves the song paused. Failed song cleanup retains its
existing recovery owner and prevents a second monitor owner. Prepare-ahead
cannot reacquire playback while the headphone monitor owns the route.

The installed Debian package was exercised under Cage/VNC through actual
Settings controls. A separate `aplay` source sends 220 Hz on channel 1 and
330 Hz on channel 2 into `hw:SingZLoop,1,0`; the monitor uses PCM 0 duplex,
and an independent `arecord` tap reads PCM 1 capture. Thus the input source
and monitored output use opposite cables without feeding the output back
into the input. Only the named virtual device is used. The run proved:

- native song playback transfers to microphone monitoring;
- both output channels carry the selected input tone;
- moving gain from -6 to -18 dB produces the expected 12 dB reduction;
- selecting input channel 2 changes the monitored tone to 330 Hz;
- Stop quiesces monitor output, and native playback can acquire it again.

Evidence, screenshots and the installer are generated under
`build/native/linux-monitor-results-20261029/`. Temporary Electron drivers
stay outside the repository. Test-owned `aplay`/`arecord` processes are stopped
at teardown. Physical Pi/FLOW timing, USB-loss recovery and sustained
monitoring remain hardware qualification gates; the appliance's default
vocal monitoring still belongs to FLOW 8.

### Optional emulated HDA device

An ICH9 controller without a codec appears in PCI and ALSA card inventory
but exposes no PCM endpoints; the guest reports `no codecs found!`.
The Proxmox stand activated `audio0: device=ich9-intel-hda,driver=none`
with microphone/duplex codecs after a graceful full VM shutdown/start;
codec hotplug is unavailable. The installed app passed duplex HDA testing
at 48 kHz: 151 analysis frames, 339 playback callbacks and zero xruns.
Both native and Chromium audio remained muted in this test. Re-arm the sound-capable
kernel before restarting a guest whose default is still the cloud kernel.
The silent virtual backend exercises enumeration, negotiation, playback,
capture delivery and teardown. It cannot establish physical microphone
signal quality, USB behavior or acoustic latency. Keep `snd-aloop` for
signal/routing assertions.

## Wayland VNC debugging

Run the compositor and VNC server on the **Linux host**, outside Podman. The
development launcher uses labwc, a 1920×1080 headless output and wayvnc with
keyboard/pointer input. It binds only `127.0.0.1:5900`; SSH provides access
and authentication. It reads an explicit empty wayvnc config so a personal
config cannot silently change that policy. No desktop or login manager is
required. Upstream references: [labwc](https://github.com/labwc/labwc),
[Cage](https://github.com/cage-kiosk/cage),
[wayvnc](https://github.com/any1/wayvnc),
[headless operation and SSH](https://github.com/any1/wayvnc/blob/master/FAQ.md).

Install host packages:

```sh
sudo apt-get install --no-install-recommends labwc cage wayvnc wlr-randr \
  wayland-utils grim foot fonts-dejavu-core novnc websockify
```

From the source root on the host, start a temporary debug session:

```sh
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemd-run --user --unit=singz-vnc-debug --collect --property=Type=exec \
  --setenv=SINGZ_VNC_WEB=1 \
  /usr/bin/bash "$PWD/tools/dev/linux/vnc-session.sh" -- \
  foot --title=SingZ-VNC-debug bash --noprofile --norc
```

This first displays a terminal for connection/input checks. Replace the command
after `--` with the built interface executable. Build Electron/JS in a writable
workspace with `npm ci` and `npm run build`; the current Electron dependency
requires Node **22.12 or later**, whereas the original native-test image's
Debian Node 20 remains sufficient for its C++ test runner. Include
`mobile/package.json` and `mobile/scripts/apply-gdrive-config.js` in scoped
source snapshots: the package file establishes that script's CommonJS boundary.
Keep `mobile/gdrive.config.json` and generated credential modules excluded.
Native C++ builds continue to use **Clang 21**.

The verified stand uses Cage 0.2.0 and wayvnc 0.9.1. Raw VNC encoding produced
incomplete captures with both Cage and labwc 0.8.3; **ZRLE** produced complete
frames and successful pointer interaction with Cage. Select ZRLE in a native
viewer or use the noVNC browser viewer. This is a local qualification result,
not proof of a particular upstream defect. Labwc is now the development
default because desktop OAuth opens Firefox as a second application: Cage
could launch it without providing usable window switching. Labwc loads its
default keyboard/mouse bindings, retains decorations and maximizes windows;
Alt+Tab switches between SingZ and Firefox. `SINGZ_VNC_COMPOSITOR=cage` selects
the single-app kiosk comparison. The session command's exit stops either
compositor. Production TV authorization must work without this desktop UI.

For the current desktop interface, the application command is:

```sh
/absolute/path/to/ui/node_modules/electron/dist/electron \
  --ozone-platform=wayland /absolute/path/to/ui
```

Electron runs on the host and needs its normal Linux runtime libraries. Do not
add `--no-sandbox` to work around missing sandbox support. This is the existing
desktop UI for debugging; the appliance TV client and Linux native addon are
separate pending work. The launcher sets `SINGZ_MUTE=1` and `SINGZ_NO_SYNC=1`.
The Debian stand also needed `libgtk-3-0t64`, `libnss3`,
`libatk-bridge2.0-0t64`, `libcups2t64` and `libxss1`. After `npm ci`, run
`node node_modules/electron/install.js` if its Linux runtime is absent;
the Electron package verifies the download using its checksums. On this
headless software-rendered stand, add `--disable-gpu` to the Electron command;
omit that flag when qualifying real Pi acceleration.

The desktop startup maps Linux Wayland windows before waiting for their first
frame: a hidden initial surface stalled Cage's first-frame handshake. The
`SINGZ_E2E_HIDDEN` test override still keeps the window hidden. Real Electron
checks on the Debian stand exercised both modes after `npm run build`.

On the developer computer, keep this tunnel running:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:5901:127.0.0.1:5900 \
  -L 127.0.0.1:6081:127.0.0.1:6080 singz@DEVELOPMENT_HOST
```

Open `http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale` for the
browser viewer, or connect an RFB 3.8 VNC client using ZRLE to
`127.0.0.1:5901`. Legacy macOS Screen Sharing compatibility is not assumed.
`SINGZ_VNC_WEB=1` adds the loopback-only noVNC/websockify endpoint at 6080;
without it the launcher runs only native VNC. Neither port is opened on the
LAN.

The browser may label the inner VNC connection "unencrypted"; the remote link
is carried by the encrypted SSH tunnel and both inner endpoints are loopback.

Stop and inspect the session from SSH with:

```sh
systemctl --user stop singz-vnc-debug
journalctl --user -u singz-vnc-debug --no-pager
```

The transient user unit keeps the session alive after SSH disconnect and kills
the compositor, VNC and app subprocesses together when stopped. It does not
enable startup after reboot. Stop it before starting another session on the
same VNC port. Client disconnect/reconnect leaves the application running.
Headless rendering deliberately uses Pixman software rendering; it cannot
qualify Pi GPU performance, HDMI/CEC, audio timing or lyrics latency. Keep VNC
disabled during performance measurements and omit it from production services.
On a physical Pi, attach wayvnc to the actual kiosk session's Wayland socket
and output instead; the headless launcher creates a separate virtual display.

For a human loopback demo on a stand with only virtual audio sinks, the
command after `vnc-session.sh --` can be `env -u SINGZ_MUTE /opt/SingZ/singz
--mute-audio --ozone-platform=wayland`: the native signal can reach the
loopback analyzer while Chromium stays muted. The default launcher remains
silent for automation. This is not a setting for physical audio testing.

### Downloading Drive projects on the Linux/TV box

After phone approval, choose **Google Drive projects** in Catalog (or the
project picker), select a song, then **Download and open**. Downloads verify
Drive checksums, report progress and can be cancelled and resumed. Split
projects need only their declared stems and lyrics; their original audio is
not downloaded or synthesized. Unsplit projects still download the source.

The durable reader collection lives in `userData/drive-projects/<Drive ID>`
and also appears in the local catalog for offline playback. It is separate
from the upload library: opening, changing or deleting a downloaded copy
cannot remove other songs from Drive. Existing desktop upload/sync behaviour
continues to apply to the configured library only. Re-splitting from the
original is unavailable when that original is absent; stem controls, lyrics,
transposition, saving settings and vocal separation from an existing vocal
stem remain available. The Drive dialog opens an existing downloaded copy
without overwriting local edits.
