#include "audio_host_android_callback_policy.h"

#include <cstdint>

#if defined(SINGZ_ANDROID_AUDIO_HOST_RT_COMPILE) && (defined(__cpp_exceptions) || defined(__EXCEPTIONS) || defined(_CPPUNWIND))
#error "Android AudioHost callback policy must compile without exceptions"
#endif
#if defined(SINGZ_ANDROID_AUDIO_HOST_RT_COMPILE) && (defined(__GXX_RTTI) || defined(_CPPRTTI))
#error "Android AudioHost callback policy must compile without RTTI"
#endif

namespace singz::detail {

AndroidAudioHostTimestampProjection projectAndroidAudioHostTimestamp(
    const AndroidAudioHostTimestampAnchor& anchor, uint64_t framePosition,
    uint32_t sampleRate, uint64_t callbackEntryNs) noexcept {
  if (!anchor.valid || anchor.frameTimeNs == 0 || anchor.sampledAtNs == 0 ||
      sampleRate == 0 || callbackEntryNs < anchor.sampledAtNs ||
      anchor.sampledAtNs < anchor.frameTimeNs ||
      anchor.sampledAtNs - anchor.frameTimeNs >
          kAndroidAudioHostTimestampFreshnessNs ||
      callbackEntryNs - anchor.sampledAtNs >
          kAndroidAudioHostTimestampFreshnessNs) {
    return {};
  }
  const long double delta =
      (static_cast<long double>(framePosition) - anchor.framePosition) *
      1000000000.0L / sampleRate;
  const long double projected =
      static_cast<long double>(anchor.frameTimeNs) + delta;
  if (projected <= 0.0L ||
      projected >= static_cast<long double>(UINT64_MAX)) {
    return {};
  }
  return {static_cast<uint64_t>(projected), true};
}

bool androidAudioHostDeadlineMiss(uint64_t callbackEntryNs,
                                  uint64_t callbackEndNs, uint32_t frames,
                                  uint32_t sampleRate) noexcept {
  if (callbackEntryNs == 0 || callbackEndNs < callbackEntryNs || frames == 0 ||
      sampleRate == 0) {
    return false;
  }
  const uint64_t deadline =
      (static_cast<uint64_t>(frames) * 1000000000ULL) / sampleRate;
  return callbackEndNs - callbackEntryNs > deadline;
}

}  // namespace singz::detail
