#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "$0")" && pwd)
mobile_root=$(cd "$script_dir/.." && pwd)
repo_root=$(cd "$mobile_root/.." && pwd)
test_root=$(mktemp -d)
trap 'rm -rf "$test_root"' EXIT

# Mirror the pod's public header set: every header under native/playback,
# so a new header the session includes (the graph document, the projection)
# cannot silently break this runner while the pod itself still builds.
mkdir -p "$test_root/include/SingzPlaybackSession"
for header in "$repo_root"/native/playback/*.h; do
  ln -s "$header" "$test_root/include/SingzPlaybackSession/$(basename "$header")"
done

xcrun clang++ -std=c++20 -fobjc-arc \
  -framework Foundation \
  -I"$test_root/include" \
  -I"$repo_root/zcore/include" \
  -I"$repo_root/zdsp/include" \
  -I"$mobile_root/ios/FolderAccess" \
  "$repo_root/zcore/src/media/owned_file_descriptor.cpp" \
  "$mobile_root/ios/FolderAccess/NativePlaybackAuthorizedPath.mm" \
  "$mobile_root/ios/FolderAccess/NativePlaybackAudioSessionPolicy.mm" \
  "$mobile_root/ios/FolderAccess/NativePlaybackBridgeResult.mm" \
  "$mobile_root/ios/FolderAccess/NativePlaybackBridgeSchema.mm" \
  "$mobile_root/ios/schema-tests/native_playback_bridge_schema_tests.mm" \
  -o "$test_root/native-playback-bridge-schema-tests"

"$test_root/native-playback-bridge-schema-tests"
