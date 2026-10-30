#pragma once

namespace singz::detail {

// Read-only packaging probe. Referencing this from the JNI library keeps the
// dormant provider object in libsingzcore.so without opening an audio stream.
const char* androidAudioHostProviderBuildMarker() noexcept;

}  // namespace singz::detail
