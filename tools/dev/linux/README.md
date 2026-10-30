# Linux desktop development

Use Debian 13 and Clang 21 for the Linux native build. Native tests can run
inside rootless Podman; run the desktop app, compositor, and audio-device
tests on the Linux host.

## Native development container

Install Podman and its rootless dependencies on the host:

```sh
sudo apt-get update
sudo apt-get install --no-install-recommends podman uidmap passt slirp4netns \
  fuse-overlayfs dbus-user-session ca-certificates
podman info --format '{{.Host.Security.Rootless}}'
```

The user needs subordinate UID/GID ranges in `/etc/subuid` and `/etc/subgid`.
From the repository root, build the image and create a container with separate
source, build-output, and cache directories:

```sh
podman pull docker.io/library/debian:13-slim
base_image=$(podman image inspect docker.io/library/debian:13-slim \
  --format '{{index .RepoDigests 0}}')
podman build --build-arg DEBIAN_BASE="$base_image" \
  --file tools/dev/linux/Containerfile --tag localhost/singz-dev:debian13 .

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

The image includes GCC, Clang 21, CMake/Ninja, ccache, and Linux development
headers. Clang 21 comes from `trixie-backports` and is the default compiler.
`tini` reaps test subprocesses. The native suites need no audio/GPU devices
or graphical session.

`native-tests.sh` builds Release targets and runs CTest serially. Results,
logs, and the environment manifest are written to
`../container-work/native-clang21-release`. Use an independent directory
for another compiler:

```sh
podman exec --env CC=gcc --env CXX=g++ \
  --env SINGZ_BUILD_ROOT=/work/native-gcc-release \
  singz-dev bash tools/dev/linux/native-tests.sh
```

On a writable Linux checkout with the build dependencies installed, the
focused ALSA preset is also available:

```sh
cmake --preset linux-alsa
cmake --build --preset linux-alsa
ctest --preset linux-alsa
```

## ALSA loopback testing

The Linux backend supports native playback, capture, and headphone monitoring.
Direct ALSA endpoints are exclusive. Select the intended native device in
Settings; the backend checks its rate, channel count, format, and buffer
sizes when opening it. Terminal device errors stop playback and allow an
explicit Play retry.

Deterministic ALSA tests use the `null` plugin and injected device faults,
so they do not need `/dev/snd`. Signal-routing tests use the kernel loopback
module on the host:

```sh
sudo apt-get install --no-install-recommends kmod alsa-utils
SINGZ_NATIVE_BUILD_DIR=/absolute/path/to/container-work/native-clang21-release \
  bash tools/dev/linux/alsa-loopback.sh
```

The host kernel must support `CONFIG_SND_ALOOP=m`, and the ordinary user must
have access to audio devices. The script loads `snd-aloop` as `SingZLoop` and
tests playback/capture, channel routing, shared capture, stop, and resume.
Only module loading uses sudo. Generated test signals use the named virtual
card, keeping physical speakers silent. The script leaves the module loaded
for further testing.

## Build and install the desktop package

Use Node 24 for Electron tooling and a native Linux host of the requested
architecture. The native-test container's Debian Node version is sufficient
for its C++ runner; a complete desktop build requires the newer toolchain.
Install the Linux build/runtime dependencies listed in
[the CI workflow](../../../.github/workflows/linux.yml).

From a writable checkout:

```sh
export CC=clang-21 CXX=clang++-21
npm ci
node mobile/scripts/sync-graph-document.js
node mobile/scripts/build-training.mjs
bash scripts/vendor-analyze.sh linux-x64
npm run typecheck
npm test
npm run dist -- --linux --x64 --publish never
```

Packaging builds missing native helpers and the offline CPU splitter pack,
then verifies the addon against its source and Electron version. It also runs
an Electron addon smoke test, so use a graphical session or Xvfb for the
packaging phase. `--dir` creates an unpacked app instead of an installer.

Install the generated Debian package:

```sh
sudo apt-get install --no-install-recommends ./dist/SingZ-*-linux-amd64.deb
```

The package includes the six-stem splitter, beat-analysis model, and
lead/backing-vocal model with their runtime. First-run setup extracts the
bundled pack without requiring system Python or model downloads. Optional
lyrics models use the app's normal model manager.

Launch `/opt/SingZ/singz`. In Settings, enable **Use native DSP playback**
and select an output marked **(ALSA)** to test native playback. Select the
native microphone/input channel for capture. Headphone monitoring uses a
compatible duplex endpoint; select its channels and confirm wired headphones
before choosing **Start monitoring**. Starting monitoring pauses native song
playback; stopping monitoring leaves the song paused.

The baseline native decoder supports WAV, FLAC, and MP3. Other formats retain
the existing capability/fallback behavior. Linux GPU splitting and ARM64
splitter packs are not yet qualified.

## Wayland VNC debugging

Run the compositor and VNC server on the host, outside Podman:

```sh
sudo apt-get install --no-install-recommends labwc cage wayvnc wlr-randr \
  wayland-utils grim foot fonts-dejavu-core novnc websockify
export XDG_RUNTIME_DIR="/run/user/$(id -u)"
systemd-run --user --unit=singz-vnc-debug --collect --property=Type=exec \
  --setenv=SINGZ_VNC_WEB=1 \
  /usr/bin/bash "$PWD/tools/dev/linux/vnc-session.sh" -- \
  /opt/SingZ/singz --ozone-platform=wayland
```

A user-owned `XDG_RUNTIME_DIR` and running systemd user manager are required.
The launcher creates a 1920×1080 headless labwc session with keyboard/pointer
input. Alt+Tab switches windows. Set `SINGZ_VNC_COMPOSITOR=cage` for a single-app
session, or replace the application command with `foot` for a debug terminal.
The launcher mutes automated audio and disables sync during debugging.

From the developer computer, create an SSH tunnel:

```sh
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:5901:127.0.0.1:5900 \
  -L 127.0.0.1:6081:127.0.0.1:6080 developer@DEVELOPMENT_HOST
```

Open `http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale`, or connect
a VNC client to `127.0.0.1:5901`. Use ZRLE encoding if a native viewer displays
incomplete frames. `SINGZ_VNC_WEB=1` enables noVNC; without it only native VNC
runs. Both server ports bind to loopback and are reached through SSH.

Inspect or stop the session:

```sh
journalctl --user -u singz-vnc-debug --no-pager
systemctl --user stop singz-vnc-debug
```

Stopping the unit also stops its app and VNC subprocesses. Disconnecting a
viewer leaves the app running. The headless session uses software rendering;
it is useful for UI debugging, not GPU or physical audio-latency measurements.

See [Linux package CI](../../../docs/LINUX-CI.md) for the installed-app
Wayland/X11 test recipe and uploaded build artifacts.
