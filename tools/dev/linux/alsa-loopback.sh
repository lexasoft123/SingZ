#!/usr/bin/env bash
# Run on the Linux host, never inside the device-free compiler container.
set -euo pipefail
source_root=$(cd "$(dirname "$0")/../../.." && pwd)
build_root=${SINGZ_NATIVE_BUILD_DIR:-$source_root/build/native/linux-alsa}
if [[ ! -x $build_root/audio_host_linux_tests ]]; then
  echo 'Build with: cmake --preset linux-alsa && cmake --build --preset linux-alsa' >&2
  echo 'For a container build, set SINGZ_NATIVE_BUILD_DIR to its host output directory.' >&2
  exit 1
fi
if [[ $(id -u) == 0 ]]; then
  echo 'Run tests as the ordinary audio-group user; sudo is only for modprobe.' >&2
  exit 1
fi
sudo modprobe snd-aloop id=SingZLoop pcm_substreams=2
{
  uname -a
  id
  cat /proc/asound/cards
  sha256sum "$build_root/audio_host_linux_tests"
} > "$build_root/alsa-loopback-environment.txt"
# The binary refuses any fixture other than the named virtual Loopback card.
# Generated signals never pass through the physical/default sound device.
timeout 30s "$build_root/audio_host_linux_tests" --loopback SingZLoop \
  2>&1 | tee "$build_root/alsa-loopback.log"
