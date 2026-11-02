#!/usr/bin/env bash
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
clang++ -std=c++17 -framework Foundation \
  "$repo/mobile/ios/SingzTorrent/NavigationPolicyTests.mm" -o "$work/navigation-test"
"$work/navigation-test"
