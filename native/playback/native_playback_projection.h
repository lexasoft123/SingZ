#pragma once

#include <cstdint>

namespace singz::playback_internal {

// Normalize an audible projection into the active loop without signed
// subtraction.  Extreme negative projections are possible when status is
// sampled before enough latency history exists, so the arithmetic must remain
// defined even though the caller will publish that projection as unavailable.
constexpr int64_t loopAdjustedProjectFrame(int64_t projected,
                                           bool loopEnabled,
                                           int64_t loopStart,
                                           int64_t loopEnd) noexcept {
  if (!loopEnabled || loopStart < 0 || loopEnd <= loopStart ||
      (projected >= loopStart && projected < loopEnd))
    return projected;
  const uint64_t span = static_cast<uint64_t>(loopEnd - loopStart);
  uint64_t offset = 0;
  if (projected >= loopStart) {
    offset = (static_cast<uint64_t>(projected) -
              static_cast<uint64_t>(loopStart)) %
             span;
  } else {
    uint64_t distanceRemainder = 0;
    if (projected >= 0) {
      distanceRemainder =
          (static_cast<uint64_t>(loopStart) -
           static_cast<uint64_t>(projected)) %
          span;
    } else {
      const uint64_t negativeMagnitude =
          static_cast<uint64_t>(-(projected + 1)) + 1u;
      distanceRemainder =
          ((static_cast<uint64_t>(loopStart) % span) +
           (negativeMagnitude % span)) %
          span;
    }
    offset = distanceRemainder == 0 ? 0 : span - distanceRemainder;
  }
  return loopStart + static_cast<int64_t>(offset);
}

} // namespace singz::playback_internal
