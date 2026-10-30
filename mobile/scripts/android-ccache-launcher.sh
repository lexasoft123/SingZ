#!/bin/sh
set -eu

# Compatibility entry point for already-configured Ninja graphs. New graphs
# point directly to the shared launcher; exec leaves no extra resident wrapper.
singz_repo_root=$(cd "$(dirname "$0")/../.." && pwd)
exec /bin/sh "$singz_repo_root/scripts/ccache-launcher.sh" "$@"
