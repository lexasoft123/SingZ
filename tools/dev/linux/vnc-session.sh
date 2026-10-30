#!/usr/bin/env bash
# Host-side development session. Do not run inside the compiler container.
set -euo pipefail

if [[ ${1:-} == --inside-session ]]; then
  shift
  session_dir=$1
  shift
  app_pid=
  vnc_pid=
  web_pid=
  cleanup() {
    trap - EXIT INT TERM
    [[ -z $app_pid ]] || kill "$app_pid" 2>/dev/null || true
    [[ -z $vnc_pid ]] || kill "$vnc_pid" 2>/dev/null || true
    [[ -z $web_pid ]] || kill "$web_pid" 2>/dev/null || true
    wait 2>/dev/null || true
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 0' TERM

  wlr-randr --output HEADLESS-1 --custom-mode 1920x1080@60Hz
  # An explicit empty config prevents a user's default config from changing
  # authentication/bind settings. SSH supplies transport authentication.
  wayvnc --config "$session_dir/wayvnc.conf" \
    --socket "$session_dir/wayvncctl" --disable-resizing 127.0.0.1 5900 &
  vnc_pid=$!
  "$@" &
  app_pid=$!
  session_pids=("$vnc_pid" "$app_pid")
  if [[ ${SINGZ_VNC_WEB:-0} == 1 ]]; then
    websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 &
    web_pid=$!
    session_pids+=("$web_pid")
  fi
  # Either process exiting ends this debug session. systemd kills remaining
  # descendants in the unit's cgroup, including Electron subprocesses.
  wait -n "${session_pids[@]}"
  exit $?
fi

if [[ ${1:-} != -- || $# -lt 2 ]]; then
  echo 'Usage: bash tools/dev/linux/vnc-session.sh -- APPLICATION [ARGUMENTS...]' >&2
  exit 2
fi
shift
if [[ $(id -u) == 0 ]]; then
  echo 'Run the VNC development session as an ordinary user.' >&2
  exit 1
fi
compositor=${SINGZ_VNC_COMPOSITOR:-labwc}
case "$compositor" in
  cage|labwc) ;;
  *) echo 'SINGZ_VNC_COMPOSITOR must be cage or labwc.' >&2; exit 2 ;;
esac
for dependency in "$compositor" wayvnc wlr-randr; do
  command -v "$dependency" >/dev/null
done
if [[ ${SINGZ_VNC_WEB:-0} == 1 ]]; then
  command -v websockify >/dev/null
  [[ -f /usr/share/novnc/vnc.html ]]
fi
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
[[ -d $XDG_RUNTIME_DIR && -O $XDG_RUNTIME_DIR ]] || {
  echo 'A user-owned XDG_RUNTIME_DIR is required; start the systemd user manager.' >&2
  exit 1
}
session_dir=$(mktemp -d "$XDG_RUNTIME_DIR/singz-vnc.XXXXXX")
trap 'rm -rf "$session_dir"' EXIT
trap 'exit 130' INT
trap 'exit 0' TERM
: > "$session_dir/wayvnc.conf"

# CPU rendering is deliberate on the headless development host. It provides
# no evidence about Pi GPU acceleration. The compositor passes its socket name
# to the child; never guess wayland-0/1 or borrow another session's display.
unset DISPLAY WAYLAND_DISPLAY
export WLR_BACKENDS=headless WLR_HEADLESS_OUTPUTS=1
export WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman
export SINGZ_MUTE=1 SINGZ_NO_SYNC=1
if [[ $compositor == cage ]]; then
  cage -- bash "$(realpath "$0")" --inside-session "$session_dir" "$@"
else
  cat > "$session_dir/rc.xml" <<'XML'
<labwc_config>
  <keyboard><default /></keyboard>
  <mouse><default /></mouse>
  <windowRules>
    <windowRule identifier="*">
      <action name="Maximize" />
    </windowRule>
  </windowRules>
</labwc_config>
XML
  # labwc accepts its session command as one shell string. Put the actual
  # argv in a Bash script so spaces and metacharacters retain their identity.
  {
    printf '#!/usr/bin/env bash\nexec '
    printf '%q ' bash "$(realpath "$0")" --inside-session "$session_dir" "$@"
    printf '\n'
  } > "$session_dir/client.sh"
  printf -v session_command 'bash %q' "$session_dir/client.sh"
  export LABWC_UPDATE_ACTIVATION_ENV=0
  labwc --config-dir "$session_dir" --session "$session_command"
fi
