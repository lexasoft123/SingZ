#pragma once

#include <zcore/media/decoded_audio.h>
#include <zcore/media/streaming_audio_source.h>

#include <cstddef>
#include <cstdint>
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

// ---- reading a file (media_io.cpp) ------------------------------------------
//
// Positioned reads only, for every format: two sources routinely read one
// file through dup'ed descriptors that share a single file position.

// A positioned read over whatever holds the file — a descriptor for the
// streaming sources, the decoder's own FILE* for a whole-file decode. Returns
// bytes read, 0 at the end, -1 on an I/O error; never moves anything another
// reader relies on.
struct MediaByteSource {
  void* context = nullptr;
  int64_t (*readAt)(void* context, uint64_t offset, unsigned char* buffer,
                    size_t bytes) noexcept = nullptr;
  uint64_t length = 0;  // physical file length
};

int consumeAsDescriptor(OwnedFileDescriptor* descriptor) noexcept;
int64_t readAt(int fd, void* buffer, size_t bytes, int64_t offset) noexcept;
int64_t fileLength(int fd) noexcept;
void closeRawDescriptor(int fd) noexcept;
// A byte source over `*fd`. The pointer must outlive the source.
[[nodiscard]] MediaByteSource descriptorByteSource(const int* fd, uint64_t length) noexcept;
// Keeps reading until `bytes` arrived, the file ended, or it failed — a
// positioned read may legally return short. Bytes read, or -1.
[[nodiscard]] int64_t readFully(const MediaByteSource& source, uint64_t offset,
                                unsigned char* buffer, size_t bytes) noexcept;

// ---- which format (media_format.cpp) ----------------------------------------
//
// ONE detector for the whole-file decode and the streaming sources, so a file
// is never one format to one and another to the other.

// Classifies by content. `Auto` in `*format` means "no container this core
// knows"; a non-Ok status is an I/O error.
[[nodiscard]] DecodedAudioStatus detectMediaFormat(const MediaByteSource& source,
                                                   DecodedAudioSourceFormat* format) noexcept;
// Whether a declared format (from the product boundary's extension
// allowlist) agrees with what the content was detected as. Auto agrees with
// everything.
[[nodiscard]] bool declarationMatches(DecodedAudioSourceFormat declared,
                                      DecodedAudioSourceFormat detected) noexcept;
// Moves `*offset` past any ID3v2 tags there (several, with footers). False
// only on an I/O error.
[[nodiscard]] bool skipId3v2Tags(const MediaByteSource& source, uint64_t* offset) noexcept;

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

// Walks the RIFF chunks up to `data` and validates what it finds. The same
// statuses the decoder always returned: MalformedData for a damaged RIFF,
// UnsupportedFormat for a sound one this code does not read (8-bit, 64-bit
// float, RF64 sentinels, reduced valid bits).
[[nodiscard]] DecodedAudioStatus parseWavLayout(const MediaByteSource& source,
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

// The streaming WAV source. Takes ownership of `fd` whatever it returns.
[[nodiscard]] std::unique_ptr<StreamingAudioSource> openWavStreamingSource(
    int fd, const StreamingAudioOpenOptions& options, DecodedAudioStatus* status);

// ---- MP3, one definition for the whole-file decoder and the streaming source
// (mp3_streaming_source.cpp). Same reason as the WAV pair above: a lane streamed on a
// phone must be exactly the lane a whole-file decode would have produced.

// One Layer III frame of the audio, where it is in the file.
struct Mp3Frame {
  uint64_t offset = 0;
  uint32_t bytes = 0;
};

// The file, indexed: every audio frame (a Xing/Info/VBRI header frame is not
// one), and where the real audio sits in their concatenated output.
struct Mp3Layout {
  uint32_t sampleRate = 0;
  uint16_t channels = 0;
  uint32_t samplesPerFrame = 0;  // 1152 (MPEG-1) or 576 (MPEG-2/2.5)
  std::vector<Mp3Frame> frames;
  // Decoded samples dropped at the front: encoder delay + the decoder's 529,
  // when a LAME/Lavc tag states the delay. Zero otherwise.
  uint64_t skipFront = 0;
  // Frames of real audio after the gapless trim. Exact — counted off the
  // index, never estimated from a bitrate.
  uint64_t frameCount = 0;
  bool frameCountFromContainer = false;
};

// Walks every frame header once. UnsupportedFormat for a file with no Layer
// III stream (or a free-format / channel-changing one), MalformedData for one
// that has a stream and no frames.
[[nodiscard]] DecodedAudioStatus parseMp3Layout(const MediaByteSource& source,
                                                const DecodeCancellation& cancel,
                                                Mp3Layout* layout) noexcept;

// The first frame a decode must start from so that frame `frameIndex` comes
// out bit-identical to a decode from the top of the file.
[[nodiscard]] uint64_t mp3RunUpStart(const Mp3Layout& layout, uint64_t frameIndex) noexcept;

// Decodes indexed frames in order. `reset()` forgets all decoder state (the
// next frame starts a run-up).
class Mp3FrameDecoder {
 public:
  explicit Mp3FrameDecoder(const MediaByteSource& source);
  ~Mp3FrameDecoder();
  Mp3FrameDecoder(const Mp3FrameDecoder&) = delete;
  Mp3FrameDecoder& operator=(const Mp3FrameDecoder&) = delete;

  void reset() noexcept;
  // Writes samplesPerFrame x channels INTERLEAVED floats. A frame the decoder
  // cannot reconstruct (its reservoir lies before a cut) is written as
  // silence: it still occupies its place in time.
  [[nodiscard]] DecodedAudioStatus decode(const Mp3Frame& frame, const Mp3Layout& layout,
                                          float* interleaved) noexcept;

 private:
  struct State;
  std::unique_ptr<State> state_;
};

// The streaming MP3 source. Takes ownership of `fd` whatever it returns.
[[nodiscard]] std::unique_ptr<StreamingAudioSource> openMp3StreamingSource(
    int fd, const StreamingAudioOpenOptions& options, DecodedAudioStatus* status);

// ---- FLAC (flac_streaming_source.cpp) ---------------------------------------
// The streaming FLAC source. Takes ownership of `fd` whatever it returns.
[[nodiscard]] std::unique_ptr<StreamingAudioSource> openFlacStreamingSource(
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
