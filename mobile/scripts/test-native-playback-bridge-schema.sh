#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
mobile_root=$(cd "$script_dir/.." && pwd)
repo_root=$(cd "$mobile_root/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

mkdir -p "$test_root/include/SingzPlaybackSession"
ln -s "$repo_root/native/playback/native_playback_session.h" \
  "$test_root/include/SingzPlaybackSession/native_playback_session.h"

xcrun clang++ -std=c++20 -fobjc-arc \
  -framework Foundation \
  -I"$test_root/include" \
  -I"$repo_root/zcore/include" \
  -I"$mobile_root/ios/FolderAccess" \
  "$repo_root/zcore/src/media/owned_file_descriptor.cpp" \
  "$mobile_root/ios/FolderAccess/NativePlaybackAuthorizedPath.mm" \
  "$mobile_root/ios/FolderAccess/NativePlaybackBridgeResult.mm" \
  "$mobile_root/ios/FolderAccess/NativePlaybackBridgeSchema.mm" \
  "$mobile_root/ios/schema-tests/native_playback_bridge_schema_tests.mm" \
  -o "$test_root/native-playback-bridge-schema-tests"

"$test_root/native-playback-bridge-schema-tests"
