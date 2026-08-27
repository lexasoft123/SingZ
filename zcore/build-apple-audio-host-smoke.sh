#!/usr/bin/env bash
set -euo pipefail

repo_root=${1:?repository root is required}
output_root=${2:?output directory is required}
mkdir -p "$output_root"

callback_sources=(
  "$repo_root/zcore/src/device/audio_host_callback.cpp"
)
control_sources=(
  "$repo_root/zcore/src/device/audio_host.cpp"
  "$repo_root/zcore/src/device/audio_host_unsupported.cpp"
  "$repo_root/zcore/platform/ios/audio_host_ios.cpp"
)

build_slice() {
  local sdk=$1
  local arch=$2
  local slice_root="$output_root/$sdk-$arch"
  mkdir -p "$slice_root/objects"
  local sdk_path compiler source object
  sdk_path=$(xcrun --sdk "$sdk" --show-sdk-path)
  compiler=$(xcrun --sdk "$sdk" --find clang++)
  for source in "${callback_sources[@]}"; do
    object="$slice_root/objects/$(basename "${source%.cpp}")-callback.o"
    "$compiler" -std=c++20 -O3 -DNDEBUG -fno-exceptions -fno-rtti \
      -fvisibility=hidden -fvisibility-inlines-hidden \
      -Wall -Wextra -Wpedantic -Werror -arch "$arch" -isysroot "$sdk_path" \
      -I"$repo_root/zcore/include" -c "$source" -o "$object"
  done
  for source in "${control_sources[@]}"; do
    object="$slice_root/objects/$(basename "${source%.cpp}")-control.o"
    "$compiler" -std=c++20 -O3 -DNDEBUG \
      -fvisibility=hidden -fvisibility-inlines-hidden \
      -Wall -Wextra -Wpedantic -Werror -arch "$arch" -isysroot "$sdk_path" \
      -I"$repo_root/zcore/include" -c "$source" -o "$object"
  done
  local archive="$slice_root/libzcore_audio_host_contract.a"
  xcrun --sdk "$sdk" ar rcs "$archive" "$slice_root"/objects/*.o
  local symbols="$slice_root/symbols.txt"
  xcrun --sdk "$sdk" nm "$archive" > "$symbols"
  grep -q 'invokeAudioHostCallback' "$symbols"
  grep -q 'createPlatformAudioHostBackend' "$symbols"
  grep -q 'AudioHost4open' "$symbols"
  if grep -E 'zdsp|AudioUnit|AVAudioSession|Java_|RCT' "$symbols"; then
    echo "product/DSP/platform-session dependency leaked into $archive" >&2
    return 1
  fi
  printf 'zcore-audio-host sdk=%s arch=%s archive=%s\n' "$sdk" "$arch" "$archive"
}

build_slice iphoneos arm64
build_slice iphonesimulator arm64
build_slice iphonesimulator x86_64
