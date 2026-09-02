#!/bin/sh
set -eu

if [ "$#" -lt 3 ]; then
  echo "usage: android-ccache-launcher.sh <ccache> <base-dir> <compiler> [args...]" >&2
  exit 2
fi

singz_ccache_executable=$1
singz_ccache_base_dir=$2
shift 2

export CCACHE_BASEDIR=$singz_ccache_base_dir
export CCACHE_NOHASHDIR=1
export CCACHE_COMPILERCHECK=content

# Replace this shell process rather than nesting another env wrapper. During a
# compile edge `ps ... | grep clang` therefore sees only ccache + real clang.
exec "$singz_ccache_executable" "$@"
