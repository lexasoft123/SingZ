#pragma once

#include "zdsp/processor.h"

namespace zdsp {

// Control-domain view over immutable planar samples. The enclosing session
// keeps every pointed-to channel alive until the processor is deactivated and
// destroyed. The processor copies these pointers into fixed state; it does not
// participate in media lifetime management.
// The cursor starts at frame zero during prepare. Processor reset preserves it;
// positioned seek/loop belongs to a future transport/source contract.
struct DecodedBufferView {
  const float* const* channels;
  uint32_t channelCount;
  uint64_t frameCount;
  SampleRateHz sampleRate;
};

struct DecodedBufferSourceConfig {
  NodeId node;
  DecodedBufferView buffer;
};

[[nodiscard]] ZDSP_INTERNAL_API size_t decodedBufferSourceStateBytes() noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ProcessorHandle createDecodedBufferSource(
    const DecodedBufferSourceConfig& config,
    MutableByteView stateStorage) noexcept;

}  // namespace zdsp
