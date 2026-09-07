#pragma once

#include <zcore/media/decoded_audio.h>

#include <cstdio>
#include <vector>

namespace singz::media_internal {

struct WorkingAudio {
  uint32_t sampleRate = 0;
  uint64_t frameCount = 0;
  std::vector<std::vector<float>> channels;
};

#if defined(SINGZ_ZCORE_FFMPEG)
DecodedAudioStatus decodeFfmpeg(
    std::FILE* file, DecodedAudioSourceFormat detectedFormat,
    DecodedAudioSourceFormat declaredFormat,
    const DecodedAudioPrepareOptions& options,
    DecodeCancellation cancellation, WorkingAudio* output) noexcept;
const char* ffmpegRuntimeVersion() noexcept;
const char* ffmpegRuntimeLicense() noexcept;
bool ffmpegRuntimeCompatible() noexcept;
uint32_t ffmpegCodecCapabilityMask() noexcept;
#endif

}  // namespace singz::media_internal
