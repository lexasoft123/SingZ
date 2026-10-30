#!/bin/sh
set -eu

if [ "$#" -lt 3 ]; then
  echo "usage: ccache-launcher.sh <ccache> <base-dir> <compiler> [args...]" >&2
  exit 2
fi
singz_ccache_executable=$1
singz_ccache_base_dir=$2
shift 2

export CCACHE_BASEDIR=$singz_ccache_base_dir
export CCACHE_NOHASHDIR=1
export CCACHE_COMPILERCHECK=content
# Preserve caller-specific allowances while satisfying Clang PCH prerequisites.
for singz_sloppy in pch_defines time_macros; do
  case ",${CCACHE_SLOPPINESS:-}," in
    *",$singz_sloppy,"*) ;;
    *) CCACHE_SLOPPINESS="${CCACHE_SLOPPINESS:+$CCACHE_SLOPPINESS,}$singz_sloppy" ;;
  esac
done
export CCACHE_SLOPPINESS

# No resident extra shell: one edge remains ccache + its compiler process.
exec "$singz_ccache_executable" "$@"
