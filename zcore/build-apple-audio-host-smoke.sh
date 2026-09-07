#!/usr/bin/env bash
set -euo pipefail

repo_root=${1:?repository root is required}
output_root=${2:?output directory is required}
if [[ $output_root == / || $output_root == "$repo_root" ]]; then
  echo "refusing unsafe Apple smoke output directory: $output_root" >&2
  exit 2
fi
mkdir -p "$output_root"

callback_sources=(
  "$repo_root/zcore/src/audio/audio_input_timestamp.cpp"
  "$repo_root/zcore/src/device/audio_input_callback_gate.cpp"
  "$repo_root/zcore/src/device/audio_host_callback.cpp"
  "$repo_root/zcore/platform/ios/audio_host_ios_callback.cpp"
)
control_sources=(
  "$repo_root/zcore/src/device/audio_host.cpp"
  "$repo_root/zcore/src/device/audio_host_unsupported.cpp"
  "$repo_root/zcore/platform/ios/audio_host_ios_helpers.cpp"
  "$repo_root/zcore/platform/ios/audio_host_ios.mm"
)
link_support_sources=(
  "$repo_root/zcore/platform/ios/audio_input_ios_session.cpp"
  "$repo_root/zcore/platform/ios/audio_input_ios_session.mm"
  "$repo_root/tests/native/audio_host_ios_link_smoke.cpp"
)

session_mutators=(
  'setCategory:'
  'setMode:'
  'setActive:'
  'setPreferredInput:'
  'setPreferredSampleRate:'
  'setPreferredHardwareSampleRate:error:'
  'setPreferredIOBufferDuration:'
  'setPreferredInputNumberOfChannels:'
  'setPreferredOutputNumberOfChannels:'
  'setOutputMuted:'
  'setInputMuted:'
  'setIntendedSpatialExperience:'
  'setInputGain:'
  'overrideOutputAudioPort:'
  'setInputDataSource:'
  'setOutputDataSource:'
  'setPreferredDataSource:'
  'setPreferredPolarPattern:'
  'setAggregatedIOPreference:'
  'setSupportsMultichannelContent:'
  'setPreferredInputOrientation:'
  'setAllowHapticsAndSystemSoundsDuringRecording:'
  'setPrefersNoInterruptionsFromSystemAlerts:'
  'setPrefersInterruptionOnRouteDisconnect:'
  'setPrefersEchoCancelledInput:'
  'setPreferredMicrophoneInjectionMode:'
  'setPrefersSpatialAudio:'
  'prepareRouteSelectionForPlayback'
  'requestRecordPermission:'
  'requestRecordPermissionWithCompletionHandler:'
  'requestMicrophoneInjectionPermissionWithCompletionHandler:'
  'setDelegate:'
)

contains_session_mutator() {
  local strings_file=$1
  local selector
  for selector in "${session_mutators[@]}"; do
    if grep -Fq "$selector" "$strings_file"; then
      return 0
    fi
  done
  return 1
}

build_slice() {
  local sdk=$1
  local arch=$2
  local slice_root="$output_root/$sdk-$arch"
  rm -rf -- "$slice_root"
  mkdir -p "$slice_root/objects" "$slice_root/link-objects"
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
    local stem=${source%.cpp}
    stem=${stem%.mm}
    object="$slice_root/objects/$(basename "$stem")-control.o"
    local language_flags=()
    if [[ $source == *.mm ]]; then
      language_flags=(-fobjc-arc)
    fi
    "$compiler" -std=c++20 -O3 -DNDEBUG "${language_flags[@]}" \
      -fvisibility=hidden -fvisibility-inlines-hidden \
      -Wall -Wextra -Wpedantic -Werror -arch "$arch" -isysroot "$sdk_path" \
      -I"$repo_root/zcore/include" -c "$source" -o "$object"
  done
  local archive="$slice_root/libzcore_audio_host_contract.a"
  xcrun --sdk "$sdk" ar rcs "$archive" "$slice_root"/objects/*.o
  local symbols="$slice_root/symbols.txt"
  local strings_file="$slice_root/strings.txt"
  xcrun --sdk "$sdk" nm "$archive" > "$symbols"
  strings "$archive" > "$strings_file"
  grep -q 'invokeAudioHostCallback' "$symbols"
  grep -q 'createPlatformAudioHostBackend' "$symbols"
  grep -q 'AudioHost4open' "$symbols"
  grep -q 'AudioOutputUnitStart' "$symbols"
  grep -q 'AudioUnitRender' "$symbols"
  grep -q 'AVAudioSession' "$symbols"
  if grep -E 'zdsp|Java_|RCT' "$symbols"; then
    echo "product/DSP/session-mutation dependency leaked into $archive" >&2
    return 1
  fi
  if contains_session_mutator "$strings_file"; then
    echo "AVAudioSession mutator leaked into $archive" >&2
    return 1
  fi

  local negative_mutators="$slice_root/session-mutator-negative.txt"
  local selector
  for selector in "${session_mutators[@]}"; do
    printf '%s\n' "$selector" > "$negative_mutators"
    if ! contains_session_mutator "$negative_mutators"; then
      echo "AVAudioSession mutator gate negative fixture missed $selector" >&2
      return 1
    fi
  done
  for source in "${link_support_sources[@]}"; do
    local object_name
    object_name=$(basename "$source" | tr '.' '_')
    object="$slice_root/link-objects/$object_name.o"
    local language_flags=()
    if [[ $source == *.mm ]]; then
      language_flags=(-fobjc-arc)
    fi
    "$compiler" -std=c++20 -O3 -DNDEBUG "${language_flags[@]}" \
      -fvisibility=hidden -fvisibility-inlines-hidden \
      -Wall -Wextra -Wpedantic -Werror -arch "$arch" -isysroot "$sdk_path" \
      -I"$repo_root/zcore/include" -c "$source" -o "$object"
  done
  local linked="$slice_root/libzcore_audio_host_link_smoke.dylib"
  "$compiler" -arch "$arch" -isysroot "$sdk_path" -dynamiclib \
    -framework AudioToolbox -framework AVFoundation \
    -framework CoreFoundation -framework Foundation \
    "$archive" "$slice_root"/link-objects/*.o -o "$linked"
  xcrun --sdk "$sdk" nm "$linked" | grep -q 'singzIosAudioHostLinkSmoke'
  printf 'zcore-audio-host sdk=%s arch=%s archive=%s\n' "$sdk" "$arch" "$archive"
}

build_slice iphoneos arm64
build_slice iphonesimulator arm64
build_slice iphonesimulator x86_64
