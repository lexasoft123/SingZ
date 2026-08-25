#pragma once

#include <cstdint>

namespace singz {

enum class AudioInputEncoding {
  Float32,
  Pcm16,
  Pcm24,
  Pcm32,
};

// Deinterleave one channel and normalize it to the core's float32 contract.
// Integer valid bits are left-aligned in their container, as specified by
// WAVEFORMATEXTENSIBLE. The caller owns both buffers; this function allocates
// and locks nothing, so a platform capture callback may use it directly.
bool convertAudioInputChannel(const uint8_t* interleaved, uint32_t frames,
                              uint32_t channels, uint32_t selectedChannel,
                              AudioInputEncoding encoding, uint16_t validBits,
                              float* mono);

}  // namespace singz
