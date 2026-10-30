#!/usr/bin/env bash
# Identical build/qualification stages for hosted CI and the Debian stand.
set -euo pipefail
cd "$(dirname "$0")/../.."
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Linux x64 is required' >&2; exit 1; }
[[ $(id -u) != 0 ]] || { echo 'Run as an ordinary user; sudo is used only for package installation.' >&2; exit 1; }
stage=${SINGZ_CI_STAGE:-all}
case "$stage" in build|installed-test|all) ;; *) echo "Invalid SINGZ_CI_STAGE: $stage" >&2; exit 1 ;; esac
report="$PWD/build/native/linux-package-ci"
mkdir -p "$report"
export SINGZ_MUTE=1 SINGZ_NO_SYNC=1
if [[ $stage == build || $stage == all ]]; then
  export CC=${CC:-clang-21} CXX=${CXX:-clang++-21}
  "$CXX" --version | tee "$report/compiler.txt"
  "$CXX" --version | head -n 1 | grep -E 'clang version 21\.' >/dev/null
  npm ci --no-audit 2>&1 | tee "$report/npm-ci.log"
  node mobile/scripts/sync-graph-document.js
  node mobile/scripts/build-training.mjs
  # A restored helper must match current sources before provenance unit tests.
  bash scripts/vendor-analyze.sh linux-x64 2>&1 | tee "$report/analyze-build.log"
  npm run typecheck 2>&1 | tee "$report/typecheck.log"
  npm test 2>&1 | tee "$report/unit-tests.log"
  native="$PWD/build/native/linux-ci-clang21"
  cmake -S . -B "$native" -G Ninja -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_C_COMPILER="$CC" -DCMAKE_CXX_COMPILER="$CXX" \
    -DSINGZ_BUILD_HOST_TOOLS=ON -DSINGZ_CORE_TESTS=ON -DBUILD_TESTING=ON \
    2>&1 | tee "$report/native-configure.log"
  cmake --build "$native" --parallel "${SINGZ_BUILD_JOBS:-2}" 2>&1 | tee "$report/native-build.log"
  ctest --test-dir "$native" --parallel 1 --timeout 180 --no-tests=error \
    --output-on-failure --output-junit "$report/native-tests.xml" 2>&1 | tee "$report/native-tests.log"
  # CI build-only containers cannot open the desktop. dist still verifies the
  # compiled addon identity/snapshot; the host stage MUST load and run it.
  SINGZ_CI_STAGE=build node scripts/dist.cjs --linux --x64 --publish never 2>&1 | tee "$report/dist.log"
  node scripts/verify-capture-artifact.cjs linux-x64
  (cd dist && sha256sum ./*.deb > SHA256SUMS)
fi
if [[ $stage == installed-test || $stage == all ]]; then
  mapfile -t packages < <(find "$PWD/dist" -maxdepth 1 -name 'SingZ-*-linux-amd64.deb' -type f)
  [[ ${#packages[@]} == 1 ]] || { echo 'Expected exactly one Linux amd64 installer' >&2; exit 1; }
  sudo apt-get install --reinstall --no-install-recommends -y "${packages[0]}" 2>&1 | tee "$report/install.log"
  dpkg-deb --info "${packages[0]}" > "$report/deb-info.txt"
  dpkg-deb --contents "${packages[0]}" > "$report/deb-contents.txt"
  cmp /opt/SingZ/resources/app.asar dist/linux-unpacked/resources/app.asar
  for file in singz-capture.node singz-capture.manifest.json singz-capture.node.sha256 singz-capture.node.source-hash singz-analyze llama-server crispasr gpu-splitter-linux-x64.tar.gz; do
    cmp "/opt/SingZ/resources/engines/$file" "dist/linux-unpacked/resources/engines/$file"
  done
  /opt/SingZ/resources/engines/singz-analyze build-info > "$report/analyze-build-info.txt"
  /opt/SingZ/resources/engines/llama-server --version > "$report/llama-version.txt" 2>&1
  /opt/SingZ/resources/engines/crispasr --help > "$report/crispasr-help.txt" 2>&1
  sha256sum "${packages[0]}" /opt/SingZ/resources/app.asar /opt/SingZ/resources/engines/singz-capture.node > "$report/installed-sha256.txt"
  export SINGZ_E2E_PACKAGED=${SINGZ_E2E_PACKAGED:-/opt/SingZ/singz}
  # Use the installed Electron runtime for this Node-API-only check. The app
  # UI is tested below through its normal desktop launcher.
  ELECTRON_RUN_AS_NODE=1 /opt/SingZ/singz tests/e2e/capture-addon-smoke.cjs \
    /opt/SingZ/resources/engines/singz-capture.node --current-source \
    2>&1 | tee "$report/installed-addon-smoke.log"
  # Private software sink gives Chromium a running clock on hardware-free CI.
  # Do not redirect a real user's PulseAudio daemon or expose a network socket.
  pulse_dir=$(mktemp -d "${TMPDIR:-/tmp}/singz-ci-pulse.XXXXXX")
  chmod 700 "$pulse_dir"
  pulse_pid=
  runtime_dir=
  cleanup() {
    [[ -z $pulse_pid ]] || kill "$pulse_pid" 2>/dev/null || true
    [[ -z $pulse_pid ]] || wait "$pulse_pid" 2>/dev/null || true
    [[ -z $runtime_dir ]] || rm -rf "$runtime_dir"
    rm -rf "$pulse_dir"
  }
  trap cleanup EXIT
  cat > "$pulse_dir/config.pa" <<EOF
load-module module-native-protocol-unix socket=$pulse_dir/native auth-anonymous=1
load-module module-null-sink sink_name=singz_ci rate=48000 channels=2
set-default-sink singz_ci
set-default-source singz_ci.monitor
EOF
  mkdir -m 700 "$pulse_dir/runtime"
  XDG_RUNTIME_DIR="$pulse_dir/runtime" pulseaudio --daemonize=no --use-pid-file=no --exit-idle-time=-1 \
    --log-target="file:$report/pulseaudio.log" --file="$pulse_dir/config.pa" -n &
  pulse_pid=$!
  export PULSE_SERVER="unix:$pulse_dir/native"
  for _ in {1..50}; do
    kill -0 "$pulse_pid" || { echo 'PulseAudio failed to start' >&2; exit 1; }
    [[ ! -S $pulse_dir/native ]] || break
    sleep 0.1
  done
  pactl info > "$report/pulse-info.txt"
  # Run both desktop display paths; hardware qualification is the Wayland leg.
  runtime_dir=$(mktemp -d "${TMPDIR:-/tmp}/singz-ci-wayland.XXXXXX")
  chmod 700 "$runtime_dir"
  XDG_RUNTIME_DIR="$runtime_dir" WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1 \
    WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman SINGZ_E2E_OZONE=wayland \
    SINGZ_E2E_RESULTS="$PWD/build/native/linux-package-e2e/wayland" \
    dbus-run-session -- cage -d -- node tests/e2e/linux/package-smoke.cjs \
    2>&1 | tee "$report/wayland-e2e.log"
  rm -rf "$runtime_dir"
  SINGZ_E2E_OZONE=x11 SINGZ_E2E_X11_SMOKE=1 \
    SINGZ_E2E_RESULTS="$PWD/build/native/linux-package-e2e/x11" \
    xvfb-run -a -s '-screen 0 1920x1080x24' \
    dbus-run-session -- node tests/e2e/linux/package-smoke.cjs \
    2>&1 | tee "$report/x11-e2e.log"
fi
