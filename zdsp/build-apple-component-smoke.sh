#!/usr/bin/env bash
set -euo pipefail

repo_root=${1:?repository root is required}
output_root=${2:?output directory is required}
mkdir -p "$output_root"

sources=(
  "$repo_root/zdsp/src/api/contracts.cpp"
  "$repo_root/zdsp/src/runtime/realtime_arena.cpp"
  "$repo_root/zdsp/src/runtime/builtin_nodes.cpp"
  "$repo_root/zdsp/src/runtime/graph_compiler.cpp"
  "$repo_root/zdsp/src/runtime/graph_runner.cpp"
  "$repo_root/zdsp/src/offline/offline_renderer.cpp"
)

build_slice() {
  local sdk=$1
  local arch=$2
  local slice_root="$output_root/$sdk-$arch"
  mkdir -p "$slice_root/objects"
  local sdk_path
  sdk_path=$(xcrun --sdk "$sdk" --show-sdk-path)
  local compiler
  compiler=$(xcrun --sdk "$sdk" --find clang++)
  local object
  for source in "${sources[@]}"; do
    object="$slice_root/objects/$(basename "${source%.cpp}").o"
    "$compiler" -std=c++20 -O3 -DNDEBUG -fno-exceptions -fno-rtti \
      -fvisibility=hidden -fvisibility-inlines-hidden \
      -Wall -Wextra -Wpedantic -Werror -arch "$arch" -isysroot "$sdk_path" \
      -I"$repo_root/zdsp/include" -I"$repo_root/zcore/include" \
      -c "$source" -o "$object"
  done
  local archive="$slice_root/libzdsp_component.a"
  xcrun --sdk "$sdk" ar rcs "$archive" "$slice_root"/objects/*.o
  local symbols="$slice_root/symbols.txt"
  xcrun --sdk "$sdk" nm -m "$archive" > "$symbols"
  if grep -E 'Java_|RCT|facebook|FLAC|Ort|VST|AudioUnit|AVAudio' "$symbols"; then
    echo "forbidden product/platform dependency leaked into $archive" >&2
    return 1
  fi
  if grep '_ZN4zdsp' "$symbols" | grep ' external ' | \
      grep -v 'private external' | grep -v '(undefined)'; then
    echo "zdsp C++ symbol is not hidden/private-external in $archive" >&2
    return 1
  fi
  test -s "$archive"
  printf 'apple-component sdk=%s arch=%s archive=%s\n' "$sdk" "$arch" "$archive"
}

build_slice iphoneos arm64
build_slice iphonesimulator x86_64
build_slice iphonesimulator arm64

simulator_universal="$output_root/iphonesimulator-universal/libzdsp_component.a"
mkdir -p "$(dirname "$simulator_universal")"
xcrun lipo -create \
  "$output_root/iphonesimulator-x86_64/libzdsp_component.a" \
  "$output_root/iphonesimulator-arm64/libzdsp_component.a" \
  -output "$simulator_universal"
universal_info=$(xcrun lipo -info "$simulator_universal")
case "$universal_info" in
  *arm64*x86_64*|*x86_64*arm64*) ;;
  *)
    echo "simulator archive is not arm64+x86_64 universal: $universal_info" >&2
    exit 1
    ;;
esac
printf 'apple-component sdk=iphonesimulator arch=arm64+x86_64 archive=%s\n' \
  "$simulator_universal"
