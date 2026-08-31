#include "audio_host_fifo.h"

#include <limits>

namespace singz::detail {
namespace {

uint32_t preparedCapacity(uint32_t requested) noexcept {
  if (requested == 0 || requested > (1u << 20)) return 0;
  uint32_t result = 1;
  while (result < requested) result <<= 1;
  return result;
}

}  // namespace

bool AudioHostPlanarFifo::prepare(uint32_t channels, uint32_t capacityFrames) {
  const uint32_t actualCapacity = preparedCapacity(capacityFrames);
  if (channels == 0 || channels > kAudioHostMaxChannels ||
      actualCapacity == 0 ||
      static_cast<size_t>(channels) >
          std::numeric_limits<size_t>::max() / actualCapacity) {
    return false;
  }
  channels_ = channels;
  capacityFrames_ = actualCapacity;
  samples_.assign(static_cast<size_t>(channels) * actualCapacity, 0.0F);
  // One-frame packets are the worst-case metadata load.
  spans_.assign(actualCapacity, {});
  reset();
  return true;
}

}  // namespace singz::detail
