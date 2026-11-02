#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
clang++ -std=c++17 -framework Foundation \
  "$repo/mobile/ios/SingzTorrent/SessionCookieTests.mm" -o "$work/session-test"
"$work/session-test"
