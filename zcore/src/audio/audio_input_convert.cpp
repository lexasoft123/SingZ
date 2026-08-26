#include <zcore/audio/audio_input_convert.h>

#include <cmath>
#include <cstring>

namespace singz {

bool convertAudioInputChannel(const uint8_t* interleaved, uint32_t frames,
                              uint32_t channels, uint32_t selectedChannel,
                              AudioInputEncoding encoding, uint16_t validBits,
                              float* mono) noexcept {
  if (!interleaved || !mono || frames == 0 || channels == 0 ||
      selectedChannel >= channels)
    return false;

  uint32_t bytes = 0;
  uint16_t containerBits = 0;
  switch (encoding) {
    case AudioInputEncoding::Float32:
      bytes = 4;
      containerBits = 32;
      validBits = 32;
      break;
    case AudioInputEncoding::Pcm16:
      bytes = 2;
      containerBits = 16;
      break;
    case AudioInputEncoding::Pcm24:
      bytes = 3;
      containerBits = 24;
      break;
    case AudioInputEncoding::Pcm32:
      bytes = 4;
      containerBits = 32;
      break;
  }
  if (validBits == 0 || validBits > containerBits) return false;
  const size_t stride = static_cast<size_t>(channels) * bytes;
  const uint8_t* source = interleaved + static_cast<size_t>(selectedChannel) * bytes;
  if (encoding == AudioInputEncoding::Float32) {
    for (uint32_t frame = 0; frame < frames; ++frame) {
      std::memcpy(mono + frame, source + static_cast<size_t>(frame) * stride,
                  sizeof(float));
    }
    return true;
  }

  const float scale = std::ldexp(1.0f, static_cast<int>(validBits) - 1);
  const uint16_t shift = static_cast<uint16_t>(containerBits - validBits);
  for (uint32_t frame = 0; frame < frames; ++frame) {
    const uint8_t* sample = source + static_cast<size_t>(frame) * stride;
    int32_t value = 0;
    if (bytes == 2) {
      int16_t raw = 0;
      std::memcpy(&raw, sample, sizeof(raw));
      value = raw;
    } else if (bytes == 3) {
      value = static_cast<int32_t>(sample[0]) |
              (static_cast<int32_t>(sample[1]) << 8) |
              (static_cast<int32_t>(sample[2]) << 16);
      if (value & 0x00800000) value -= 0x01000000;
    } else {
      std::memcpy(&value, sample, sizeof(value));
    }
    // Extensible PCM valid bits are left-aligned. Division is defined for
    // negative values and exact here because the unused low bits are zero.
    if (shift) value = static_cast<int32_t>(
        static_cast<int64_t>(value) / (static_cast<int64_t>(1) << shift));
    mono[frame] = static_cast<float>(value) / scale;
  }
  return true;
}

}  // namespace singz
