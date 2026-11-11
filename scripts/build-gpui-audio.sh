#!/bin/bash
# Build this checkout's standalone GPUI audio helper. No Electron dependency.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/experiments/gpui-player/target/debug/singz-gpui-audio"
if [ "$#" -gt 0 ] && [[ "$1" != --* ]]; then OUT="$1"; shift; fi
exec python3 "$ROOT/scripts/build-gpui-native.py" --audio-output "$OUT" "$@"
