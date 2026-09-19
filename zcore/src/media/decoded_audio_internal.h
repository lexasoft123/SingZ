#pragma once

#include <zcore/media/decoded_audio.h>
#include <zcore/media/streaming_audio_source.h>

#include <cstddef>
#include <cstdio>
#include <memory>
#include <vector>

namespace singz::media_internal {

// The media layer's own limits, shared by the whole-file decoder and the
// streaming sources so a file is never acceptable to one and refused by the
// other. Stated once: a second copy only agrees until someone edits the first.
inline constexpr uint32_t kMaximumSupportedChannels = 64;
inline constexpr uint32_t kMinimumSupportedSampleRate = 8000;
inline constexpr uint32_t kMaximumSupportedSampleRate = 768000;

struct WorkingAudio {
  uint32_t sampleRate = 0;
  uint64_t frameCount = 0;
  std::vector<std::vector<float>> channels;
};

// ---- WAV, one definition for the whole-file decoder and the streaming source
//
// `prepareDecodedAudio` and the streaming WAV source read the same files and
// must hand back the same floats for them: a lane the desktop measures through
// the streaming source is checked against a decode of the same file, and a
// phone streams exactly the lanes it would otherwise have decoded. Two parsers
// would be two answers to "is this WAV acceptable, and where is its audio", so
// both go through these.

// Where a WAV's audio is and how to read it. Only the shapes both readers
// accept get this far: integer PCM at 16, 24 or 32 bits and IEEE float at 32,
// plain or WAVE_FORMAT_EXTENSIBLE with the canonical valid-bit count.
struct WavLayout {
  uint32_t sampleRate = 0;
  uint16_t channels = 0;
  uint16_t bitsPerSample = 0;
  bool floatingPoint = false;
  uint32_t bytesPerFrame = 0;
  uint64_t dataOffset = 0;  // file offset of the first frame
  uint64_t frames = 0;      // whole frames the data chunk states
};

// A positioned read over whatever holds the file. Returns bytes read, 0 at
// the end, -1 on an I/O error; never moves anything another reader relies on.
struct WavByteSource {
  void* context = nullptr;
  int64_t (*readAt)(void* context, uint64_t offset, unsigned char* buffer,
                    size_t bytes) noexcept = nullptr;
  uint64_t length = 0;  // physical file length
};

// Walks the RIFF chunks up to `data` and validates what it finds. The same
// statuses the decoder always returned: MalformedData for a damaged RIFF,
// UnsupportedFormat for a sound one this code does not read (8-bit, 64-bit
// float, RF64 sentinels, reduced valid bits).
[[nodiscard]] DecodedAudioStatus parseWavLayout(const WavByteSource& source,
                                                const DecodeCancellation& cancel,
                                                WavLayout* layout) noexcept;

// Converts `frames` interleaved frames of `layout`'s encoding into planar
// float at `planar[c] + offset`. The scale is the decoder's: s / 2^(bits-1),
// computed in double; float samples pass through unclamped. Stops at the first
// non-finite float and reports how many whole frames came before it, so a
// streaming caller can hand those over before reporting the damage.
[[nodiscard]] DecodedAudioStatus convertWavFrames(const unsigned char* bytes,
                                                  uint64_t frames,
                                                  const WavLayout& layout,
                                                  float* const* planar,
                                                  size_t offset,
                                                  uint64_t* converted) noexcept;

// ---- descriptor helpers shared by the streaming sources ---------------------
// (flac_streaming_source.cpp defines them; see the comments there.)
int consumeAsDescriptor(OwnedFileDescriptor* descriptor) noexcept;
int64_t readAt(int fd, void* buffer, size_t bytes, int64_t offset) noexcept;
int64_t fileLength(int fd) noexcept;
void closeRawDescriptor(int fd) noexcept;

// The streaming WAV source. Takes ownership of `fd` whatever it returns.
[[nodiscard]] std::unique_ptr<StreamingAudioSource> openWavStreamingSource(
    int fd, const StreamingAudioOpenOptions& options, DecodedAudioStatus* status);

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
