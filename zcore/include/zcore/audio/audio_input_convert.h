#pragma once

#include <cstdint>

#if defined(__GNUC__) || defined(__clang__)
#define SINGZ_ZCORE_CALLBACK_LOCAL __attribute__((visibility("hidden")))
#else
#define SINGZ_ZCORE_CALLBACK_LOCAL
#endif

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
SINGZ_ZCORE_CALLBACK_LOCAL bool convertAudioInputChannel(
    const uint8_t* interleaved, uint32_t frames, uint32_t channels,
    uint32_t selectedChannel, AudioInputEncoding encoding, uint16_t validBits,
    float* mono) noexcept;

}  // namespace singz

#undef SINGZ_ZCORE_CALLBACK_LOCAL
