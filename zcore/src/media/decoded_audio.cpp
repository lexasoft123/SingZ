#include <zcore/media/decoded_audio.h>

#include <zcore/base/file_compat.h>
#include <zcore/legacy/resample.h>

#include <FLAC/stream_decoder.h>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <limits>
#include <new>
#include <numeric>
#include <utility>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace singz {
namespace {

constexpr uint32_t kMaximumSupportedChannels = 64;
constexpr uint32_t kMinimumSupportedSampleRate = 8000;
constexpr uint32_t kMaximumSupportedSampleRate = 768000;
constexpr uint64_t kDecodeChunkFrames = 4096;
constexpr uint32_t kMaximumReducedRateFactor = 4096;
constexpr uint64_t kMaximumResampleOperationsPerPoll = 262144;
constexpr char kCapabilityTag[] = "singz-prepared-audio-fd-wav-flac-v1";
constexpr std::array<unsigned char, 16> kExtensiblePcmGuid{
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
constexpr std::array<unsigned char, 16> kExtensibleFloatGuid{
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};

void closeDescriptor(int descriptor) noexcept {
  if (descriptor < 0) return;
#if defined(_WIN32)
  (void)_close(descriptor);
#else
  (void)::close(descriptor);
#endif
}

std::FILE* consumeAsFile(OwnedFileDescriptor* descriptor) noexcept {
  if (descriptor == nullptr || !descriptor->valid()) return nullptr;
  const int raw = descriptor->release();
#if defined(_WIN32)
  if (_setmode(raw, _O_BINARY) == -1) {
    closeDescriptor(raw);
    return nullptr;
  }
  std::FILE* file = _fdopen(raw, "rb");
#else
  std::FILE* file = fdopen(raw, "rb");
#endif
  if (file == nullptr) closeDescriptor(raw);
  return file;
}

struct FileOwner {
  explicit FileOwner(std::FILE* owned) noexcept : file(owned) {}
  std::FILE* file = nullptr;
  FileOwner(const FileOwner&) = delete;
  FileOwner& operator=(const FileOwner&) = delete;
  ~FileOwner() {
    if (file != nullptr) std::fclose(file);
  }
};

struct WorkingAudio {
  uint32_t sampleRate = 0;
  uint64_t frameCount = 0;
  std::vector<std::vector<float>> channels;
};

uint16_t little16(const unsigned char* value) noexcept {
  return static_cast<uint16_t>(value[0]) |
      static_cast<uint16_t>(static_cast<uint16_t>(value[1]) << 8);
}

uint32_t little32(const unsigned char* value) noexcept {
  return static_cast<uint32_t>(value[0]) |
      (static_cast<uint32_t>(value[1]) << 8) |
      (static_cast<uint32_t>(value[2]) << 16) |
      (static_cast<uint32_t>(value[3]) << 24);
}

bool validOptions(const DecodedAudioPrepareOptions& options) noexcept {
  return options.maximumChannels != 0 &&
      options.maximumChannels <= kMaximumSupportedChannels &&
      options.maximumFrames != 0 && options.maximumDecodedBytes != 0 &&
      options.maximumWorkingBytes != 0 &&
      options.maximumReducedRateFactor != 0 &&
      options.maximumReducedRateFactor <= kMaximumReducedRateFactor &&
      options.maximumResampleOperations != 0 &&
      options.maximumResampleOperationsPerPoll != 0 &&
      options.maximumResampleOperationsPerPoll <=
          kMaximumResampleOperationsPerPoll &&
      (options.requiredSampleRate == 0 ||
       (options.requiredSampleRate >= kMinimumSupportedSampleRate &&
        options.requiredSampleRate <= kMaximumSupportedSampleRate));
}

bool withinLimits(uint32_t channels, uint64_t frames,
                  const DecodedAudioPrepareOptions& options) noexcept {
  if (channels == 0 || channels > options.maximumChannels ||
      channels > kMaximumSupportedChannels || frames > options.maximumFrames)
    return false;
  if (frames != 0 && channels > std::numeric_limits<uint64_t>::max() / frames)
    return false;
  const uint64_t samples = frames * channels;
  if (samples > std::numeric_limits<size_t>::max() / sizeof(float)) return false;
  const size_t bytes = static_cast<size_t>(samples) * sizeof(float);
  return bytes <= options.maximumDecodedBytes &&
      bytes <= options.maximumWorkingBytes;
}

DecodedAudioStatus decodeWav(std::FILE* file,
                             const DecodedAudioPrepareOptions& options,
                             DecodeCancellation cancellation,
                             WorkingAudio* output) {
  unsigned char riff[12]{};
  if (std::fread(riff, 1, sizeof(riff), file) != sizeof(riff) ||
      std::memcmp(riff, "RIFF", 4) != 0 ||
      std::memcmp(riff + 8, "WAVE", 4) != 0)
    return DecodedAudioStatus::MalformedData;
  const uint32_t riffSize = little32(riff + 4);
  if (riffSize == std::numeric_limits<uint32_t>::max())
    return DecodedAudioStatus::UnsupportedFormat;
  if (riffSize < 4) return DecodedAudioStatus::MalformedData;
  const uint64_t containerEnd = uint64_t{8} + riffSize;
  if (fseeko(file, 0, SEEK_END) != 0) return DecodedAudioStatus::IoError;
  const auto physicalEnd = ftello(file);
  if (physicalEnd < 0 || containerEnd > static_cast<uint64_t>(physicalEnd))
    return DecodedAudioStatus::MalformedData;
  if (fseeko(file, 12, SEEK_SET) != 0) return DecodedAudioStatus::IoError;

  bool haveFormat = false;
  uint16_t format = 0;
  uint16_t channels = 0;
  uint16_t bitsPerSample = 0;
  uint16_t blockAlign = 0;
  uint32_t sampleRate = 0;
  uint32_t byteRate = 0;
  for (;;) {
    if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
    const auto chunkStartSigned = ftello(file);
    if (chunkStartSigned < 0) return DecodedAudioStatus::IoError;
    const uint64_t chunkStart = static_cast<uint64_t>(chunkStartSigned);
    if (chunkStart > containerEnd || containerEnd - chunkStart < 8)
      return DecodedAudioStatus::MalformedData;
    unsigned char chunk[8]{};
    if (std::fread(chunk, 1, sizeof(chunk), file) != sizeof(chunk))
      return DecodedAudioStatus::MalformedData;
    const uint32_t size = little32(chunk + 4);
    const bool dataChunk = std::memcmp(chunk, "data", 4) == 0;
    if (dataChunk && size == std::numeric_limits<uint32_t>::max())
      return DecodedAudioStatus::UnsupportedFormat;
    const uint64_t payloadStart = chunkStart + 8;
    const uint64_t payloadEnd = payloadStart + size;
    const uint64_t paddedEnd = payloadEnd + (size & 1u);
    if (payloadEnd < payloadStart || paddedEnd < payloadEnd ||
        paddedEnd > containerEnd)
      return DecodedAudioStatus::MalformedData;
    if (std::memcmp(chunk, "fmt ", 4) == 0) {
      if (size < 16) return DecodedAudioStatus::MalformedData;
      std::array<unsigned char, 40> fields{};
      const size_t captured = std::min<size_t>(size, fields.size());
      if (std::fread(fields.data(), 1, captured, file) != captured)
        return DecodedAudioStatus::MalformedData;
      if (fseeko(file, static_cast<int64_t>(paddedEnd), SEEK_SET) != 0)
        return DecodedAudioStatus::IoError;
      format = little16(fields.data());
      channels = little16(fields.data() + 2);
      sampleRate = little32(fields.data() + 4);
      byteRate = little32(fields.data() + 8);
      blockAlign = little16(fields.data() + 12);
      bitsPerSample = little16(fields.data() + 14);
      if (format == 0xfffe) {
        if (size < 40) return DecodedAudioStatus::MalformedData;
        const uint16_t extensionSize = little16(fields.data() + 16);
        const uint16_t validBits = little16(fields.data() + 18);
        if (extensionSize < 22 ||
            static_cast<uint64_t>(18) + extensionSize > size)
          return DecodedAudioStatus::MalformedData;
        if (std::memcmp(fields.data() + 24, kExtensiblePcmGuid.data(),
                        kExtensiblePcmGuid.size()) == 0) {
          format = 1;
        } else if (std::memcmp(fields.data() + 24,
                               kExtensibleFloatGuid.data(),
                               kExtensibleFloatGuid.size()) == 0) {
          format = 3;
        } else {
          return DecodedAudioStatus::UnsupportedFormat;
        }
        // Reduced valid-bit containers are MSB-aligned and need a distinct
        // conversion path. Accept only the canonical representation decoded
        // identically to ordinary PCM/float.
        if (validBits != bitsPerSample)
          return DecodedAudioStatus::UnsupportedFormat;
      }
      haveFormat = true;
      continue;
    }
    if (!dataChunk) {
      if (fseeko(file, static_cast<int64_t>(paddedEnd), SEEK_SET) != 0)
        return DecodedAudioStatus::IoError;
      continue;
    }
    if (!haveFormat || channels == 0 ||
        sampleRate < kMinimumSupportedSampleRate ||
        sampleRate > kMaximumSupportedSampleRate)
      return DecodedAudioStatus::MalformedData;
    const bool floatingPoint = format == 3 && bitsPerSample == 32;
    const bool integerPcm = format == 1 &&
        (bitsPerSample == 16 || bitsPerSample == 24 || bitsPerSample == 32);
    if (!floatingPoint && !integerPcm)
      return DecodedAudioStatus::UnsupportedFormat;
    const uint64_t bytesPerSample = bitsPerSample / 8;
    const uint64_t bytesPerFrame = bytesPerSample * channels;
    if (bytesPerFrame == 0 || bytesPerFrame > UINT16_MAX ||
        blockAlign != bytesPerFrame ||
        sampleRate > std::numeric_limits<uint32_t>::max() / bytesPerFrame ||
        byteRate != sampleRate * bytesPerFrame ||
        static_cast<uint64_t>(size) % bytesPerFrame != 0) {
      return DecodedAudioStatus::MalformedData;
    }
    const uint64_t stated = size;
    const uint64_t frames = stated / bytesPerFrame;
    if (!withinLimits(channels, frames, options))
      return DecodedAudioStatus::LimitExceeded;

    WorkingAudio candidate;
    candidate.sampleRate = sampleRate;
    candidate.frameCount = frames;
    candidate.channels.resize(channels);
    for (auto& channel : candidate.channels)
      channel.reserve(static_cast<size_t>(frames));
    const uint64_t chunkFrames = std::min<uint64_t>(kDecodeChunkFrames,
                                                     frames == 0 ? 1 : frames);
    std::vector<unsigned char> bytes(
        static_cast<size_t>(chunkFrames * bytesPerFrame));
    uint64_t cursor = 0;
    while (cursor < frames) {
      if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
      const uint64_t count = std::min<uint64_t>(chunkFrames, frames - cursor);
      const size_t wanted = static_cast<size_t>(count * bytesPerFrame);
      if (std::fread(bytes.data(), 1, wanted, file) != wanted)
        return DecodedAudioStatus::IoError;
      // Reserve above may spend time in the allocator, but initialization and
      // sample conversion are capped at one kDecodeChunkFrames slice between
      // cancellation polls. Partial channel growth stays local to candidate.
      for (auto& channel : candidate.channels)
        channel.resize(static_cast<size_t>(cursor + count));
      for (uint64_t frame = 0; frame < count; ++frame) {
        for (uint32_t channel = 0; channel < channels; ++channel) {
          const unsigned char* sample = bytes.data() + frame * bytesPerFrame +
              static_cast<uint64_t>(channel) * bytesPerSample;
          float value = 0.0f;
          if (floatingPoint) {
            std::memcpy(&value, sample, sizeof(value));
            if (!std::isfinite(value))
              return DecodedAudioStatus::MalformedData;
          } else if (bitsPerSample == 16) {
            value = static_cast<float>(static_cast<int16_t>(little16(sample)) /
                                       32768.0);
          } else if (bitsPerSample == 24) {
            const int32_t integer = static_cast<int32_t>(
                (static_cast<uint32_t>(sample[0]) << 8) |
                (static_cast<uint32_t>(sample[1]) << 16) |
                (static_cast<uint32_t>(sample[2]) << 24)) >> 8;
            value = static_cast<float>(integer / 8388608.0);
          } else {
            value = static_cast<float>(static_cast<int32_t>(little32(sample)) /
                                       2147483648.0);
          }
          candidate.channels[channel][static_cast<size_t>(cursor + frame)] = value;
        }
      }
      cursor += count;
    }
    if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
    *output = std::move(candidate);
    return DecodedAudioStatus::Ok;
  }
}

struct FlacDecodeContext {
  std::FILE* file = nullptr;
  const DecodedAudioPrepareOptions* options = nullptr;
  DecodeCancellation cancellation{};
  WorkingAudio candidate;
  DecodedAudioStatus status = DecodedAudioStatus::Ok;
  uint32_t bitsPerSample = 0;
  uint32_t streamInfoSampleRate = 0;
  uint64_t declaredFrames = 0;
  bool sawStreamInfo = false;
};

void onFlacMetadata(const FLAC__StreamDecoder*,
                    const FLAC__StreamMetadata* metadata,
                    void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (metadata->type != FLAC__METADATA_TYPE_STREAMINFO ||
      context->status != DecodedAudioStatus::Ok)
    return;
  // Check before trusting total_samples enough to reserve the declared full
  // buffer. A later read callback will abort the decoder after this callback
  // records cancellation.
  if (context->cancellation.isRequested()) {
    context->status = DecodedAudioStatus::Cancelled;
    return;
  }
  const auto& info = metadata->data.stream_info;
  if (info.sample_rate < kMinimumSupportedSampleRate ||
      info.sample_rate > kMaximumSupportedSampleRate ||
      info.channels == 0 || info.bits_per_sample == 0 ||
      info.bits_per_sample > 32) {
    context->status = DecodedAudioStatus::UnsupportedFormat;
    return;
  }
  const uint64_t frames = info.total_samples;
  if (!withinLimits(info.channels, frames, *context->options)) {
    context->status = DecodedAudioStatus::LimitExceeded;
    return;
  }
  try {
    context->candidate.sampleRate = info.sample_rate;
    context->candidate.channels.resize(info.channels);
    if (frames != 0) {
      for (auto& channel : context->candidate.channels)
        channel.reserve(static_cast<size_t>(frames));
    }
    context->bitsPerSample = info.bits_per_sample;
    context->streamInfoSampleRate = info.sample_rate;
    context->declaredFrames = frames;
    context->sawStreamInfo = true;
  } catch (...) {
    context->status = DecodedAudioStatus::ResourceExhausted;
  }
}

FLAC__StreamDecoderReadStatus onFlacRead(
    const FLAC__StreamDecoder*, FLAC__byte buffer[], size_t* bytes,
    void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (bytes == nullptr || *bytes == 0 || buffer == nullptr) {
    if (context->status == DecodedAudioStatus::Ok)
      context->status = DecodedAudioStatus::MalformedData;
    if (bytes != nullptr) *bytes = 0;
    return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
  }
  if (context->status != DecodedAudioStatus::Ok) {
    *bytes = 0;
    return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
  }
  // libFLAC bounds every request with *bytes. Cancellation is sampled before
  // every such read, including long metadata/corrupt streams that never reach
  // the PCM write callback.
  if (context->cancellation.isRequested()) {
    context->status = DecodedAudioStatus::Cancelled;
    *bytes = 0;
    return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
  }
  const size_t read = std::fread(buffer, 1, *bytes, context->file);
  *bytes = read;
  if (std::ferror(context->file) != 0) {
    context->status = DecodedAudioStatus::IoError;
    *bytes = 0;
    return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
  }
  return read == 0 ? FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM
                   : FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
}

FLAC__StreamDecoderSeekStatus onFlacSeek(
    const FLAC__StreamDecoder*, FLAC__uint64 offset, void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (context->status != DecodedAudioStatus::Ok)
    return FLAC__STREAM_DECODER_SEEK_STATUS_ERROR;
  if (offset > static_cast<FLAC__uint64>(
                   std::numeric_limits<int64_t>::max()) ||
      fseeko(context->file, static_cast<int64_t>(offset), SEEK_SET) != 0) {
    context->status = DecodedAudioStatus::IoError;
    return FLAC__STREAM_DECODER_SEEK_STATUS_ERROR;
  }
  return FLAC__STREAM_DECODER_SEEK_STATUS_OK;
}

FLAC__StreamDecoderTellStatus onFlacTell(
    const FLAC__StreamDecoder*, FLAC__uint64* offset, void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (context->status != DecodedAudioStatus::Ok || offset == nullptr)
    return FLAC__STREAM_DECODER_TELL_STATUS_ERROR;
  const auto position = ftello(context->file);
  if (position < 0) {
    context->status = DecodedAudioStatus::IoError;
    return FLAC__STREAM_DECODER_TELL_STATUS_ERROR;
  }
  *offset = static_cast<FLAC__uint64>(position);
  return FLAC__STREAM_DECODER_TELL_STATUS_OK;
}

FLAC__StreamDecoderLengthStatus onFlacLength(
    const FLAC__StreamDecoder*, FLAC__uint64* length, void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (context->status != DecodedAudioStatus::Ok || length == nullptr)
    return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
  const auto position = ftello(context->file);
  if (position < 0 || fseeko(context->file, 0, SEEK_END) != 0) {
    context->status = DecodedAudioStatus::IoError;
    return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
  }
  const auto end = ftello(context->file);
  if (end < 0) {
    (void)fseeko(context->file, position, SEEK_SET);
    context->status = DecodedAudioStatus::IoError;
    return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
  }
  if (fseeko(context->file, position, SEEK_SET) != 0) {
    context->status = DecodedAudioStatus::IoError;
    return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
  }
  *length = static_cast<FLAC__uint64>(end);
  return FLAC__STREAM_DECODER_LENGTH_STATUS_OK;
}

FLAC__bool onFlacEof(const FLAC__StreamDecoder*, void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (context->status != DecodedAudioStatus::Ok) return true;
  if (std::ferror(context->file) != 0) {
    context->status = DecodedAudioStatus::IoError;
    return true;
  }
  return std::feof(context->file) != 0;
}

FLAC__StreamDecoderWriteStatus onFlacWrite(
    const FLAC__StreamDecoder*, const FLAC__Frame* frame,
    const FLAC__int32* const buffers[], void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (context->status != DecodedAudioStatus::Ok)
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  if (context->cancellation.isRequested()) {
    context->status = DecodedAudioStatus::Cancelled;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }
  const uint32_t channels = frame->header.channels;
  const uint64_t oldFrames = context->candidate.frameCount;
  const uint64_t newFrames = oldFrames + frame->header.blocksize;
  if (!context->sawStreamInfo ||
      channels != context->candidate.channels.size() ||
      frame->header.bits_per_sample != context->bitsPerSample ||
      frame->header.sample_rate != context->streamInfoSampleRate) {
    context->status = DecodedAudioStatus::MalformedData;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }
  if (newFrames < oldFrames ||
      (context->declaredFrames != 0 &&
       newFrames > context->declaredFrames)) {
    context->status = DecodedAudioStatus::MalformedData;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }
  if (!withinLimits(channels, newFrames, *context->options)) {
    context->status = DecodedAudioStatus::LimitExceeded;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }
  const double scale = std::ldexp(1.0, static_cast<int>(context->bitsPerSample) - 1);
  try {
    for (uint32_t channel = 0; channel < channels; ++channel) {
      auto& destination = context->candidate.channels[channel];
      destination.resize(static_cast<size_t>(newFrames));
      for (uint32_t sample = 0; sample < frame->header.blocksize; ++sample) {
        destination[static_cast<size_t>(oldFrames + sample)] =
            static_cast<float>(static_cast<double>(buffers[channel][sample]) / scale);
      }
    }
    context->candidate.frameCount = newFrames;
  } catch (...) {
    context->status = DecodedAudioStatus::ResourceExhausted;
    return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
  }
  return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}

void onFlacError(const FLAC__StreamDecoder*, FLAC__StreamDecoderErrorStatus,
                 void* opaque) noexcept {
  auto* context = static_cast<FlacDecodeContext*>(opaque);
  if (context->status == DecodedAudioStatus::Ok)
    context->status = DecodedAudioStatus::MalformedData;
}

DecodedAudioStatus decodeFlac(FileOwner* owner,
                              const DecodedAudioPrepareOptions& options,
                              DecodeCancellation cancellation,
                              WorkingAudio* output) {
  FLAC__StreamDecoder* decoder = FLAC__stream_decoder_new();
  if (decoder == nullptr) return DecodedAudioStatus::ResourceExhausted;
  FlacDecodeContext context;
  context.file = owner->file;
  context.options = &options;
  context.cancellation = cancellation;
  const FLAC__StreamDecoderInitStatus initialized =
      FLAC__stream_decoder_init_stream(
          decoder, onFlacRead, onFlacSeek, onFlacTell, onFlacLength,
          onFlacEof, onFlacWrite, onFlacMetadata, onFlacError, &context);
  if (initialized != FLAC__STREAM_DECODER_INIT_STATUS_OK) {
    FLAC__stream_decoder_delete(decoder);
    // init_stream never adopts or closes context.file; FileOwner keeps the
    // consumed descriptor on every initialization and processing outcome.
    return initialized == FLAC__STREAM_DECODER_INIT_STATUS_MEMORY_ALLOCATION_ERROR
        ? DecodedAudioStatus::ResourceExhausted
        : DecodedAudioStatus::MalformedData;
  }
  const bool decoded = FLAC__stream_decoder_process_until_end_of_stream(decoder);
  const FLAC__StreamDecoderState decoderState =
      FLAC__stream_decoder_get_state(decoder);
  const bool finished = FLAC__stream_decoder_finish(decoder);
  FLAC__stream_decoder_delete(decoder);
  if (decoderState == FLAC__STREAM_DECODER_MEMORY_ALLOCATION_ERROR)
    return DecodedAudioStatus::ResourceExhausted;
  if (context.status != DecodedAudioStatus::Ok) return context.status;
  if (!decoded || !finished || !context.sawStreamInfo ||
      context.candidate.sampleRate == 0 || context.candidate.channels.empty() ||
      (context.declaredFrames != 0 &&
       context.candidate.frameCount != context.declaredFrames))
    return DecodedAudioStatus::MalformedData;
  if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
  *output = std::move(context.candidate);
  return DecodedAudioStatus::Ok;
}

bool exactOutputFrames(uint64_t inputFrames, uint32_t inputRate,
                       uint32_t outputRate, uint64_t* result) noexcept {
  const uint64_t whole = inputFrames / inputRate;
  const uint64_t remainder = inputFrames % inputRate;
  if (whole > std::numeric_limits<uint64_t>::max() / outputRate) return false;
  const uint64_t base = whole * outputRate;
  const uint64_t partial = (remainder * outputRate + inputRate / 2) / inputRate;
  if (base > std::numeric_limits<uint64_t>::max() - partial) return false;
  *result = base + partial;
  return true;
}

bool checkedAdd(uint64_t value, uint64_t* total) noexcept {
  if (*total > std::numeric_limits<uint64_t>::max() - value) return false;
  *total += value;
  return true;
}

bool checkedMultiply(uint64_t left, uint64_t right,
                     uint64_t* result) noexcept {
  if (left != 0 && right > std::numeric_limits<uint64_t>::max() / left)
    return false;
  *result = left * right;
  return true;
}

bool ceilScaled(uint64_t frames, uint32_t numerator, uint32_t denominator,
                uint64_t* result) noexcept {
  const uint64_t whole = frames / denominator;
  const uint64_t remainder = frames % denominator;
  uint64_t base = 0;
  if (!checkedMultiply(whole, numerator, &base)) return false;
  const uint64_t partial =
      (remainder * static_cast<uint64_t>(numerator) + denominator - 1) /
      denominator;
  if (base > std::numeric_limits<uint64_t>::max() - partial) return false;
  *result = base + partial;
  return true;
}

DecodedAudioStatus resample(WorkingAudio* audio, uint32_t requiredSampleRate,
                            const DecodedAudioPrepareOptions& options,
                            DecodeCancellation cancellation) {
  const uint32_t channelCount = static_cast<uint32_t>(audio->channels.size());
  uint64_t publishedSamples = 0;
  if (!checkedMultiply(audio->frameCount, channelCount, &publishedSamples) ||
      publishedSamples > std::numeric_limits<uint64_t>::max() / sizeof(float) ||
      publishedSamples * sizeof(float) > options.maximumWorkingBytes)
    return DecodedAudioStatus::LimitExceeded;
  if (requiredSampleRate == 0 || requiredSampleRate == audio->sampleRate)
    return DecodedAudioStatus::Ok;
  if (audio->frameCount == 0) {
    audio->sampleRate = requiredSampleRate;
    return cancellation.isRequested() ? DecodedAudioStatus::Cancelled
                                      : DecodedAudioStatus::Ok;
  }
  uint64_t outputFrames = 0;
  if (!exactOutputFrames(audio->frameCount, audio->sampleRate,
                         requiredSampleRate, &outputFrames) ||
      !withinLimits(static_cast<uint32_t>(audio->channels.size()), outputFrames,
                    options) ||
      audio->frameCount > static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))
    return DecodedAudioStatus::LimitExceeded;
  if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;

  const uint32_t common = std::gcd(audio->sampleRate, requiredSampleRate);
  const uint32_t up = requiredSampleRate / common;
  const uint32_t down = audio->sampleRate / common;
  if (up > options.maximumReducedRateFactor ||
      down > options.maximumReducedRateFactor)
    return DecodedAudioStatus::LimitExceeded;
  const uint64_t netDown = down / up;
  const uint64_t taps = netDown >= 2 ? 32 * netDown + 1 : 24;
  uint64_t filterSamples = 0;
  if (!checkedMultiply(taps, up, &filterSamples))
    return DecodedAudioStatus::LimitExceeded;
  uint64_t paddedInputFrames = 0;
  if (!checkedAdd(taps, &paddedInputFrames) ||
      !checkedAdd(taps, &paddedInputFrames) ||
      !checkedAdd(audio->frameCount, &paddedInputFrames))
    return DecodedAudioStatus::LimitExceeded;
  uint64_t generatedUpperFrames = 0;
  if (!ceilScaled(paddedInputFrames, up, down, &generatedUpperFrames) ||
      !checkedAdd(2, &generatedUpperFrames))
    return DecodedAudioStatus::LimitExceeded;

  uint64_t operations = filterSamples;
  uint64_t generatedSamples = 0;
  uint64_t sampleOperations = 0;
  if (!checkedMultiply(generatedUpperFrames, channelCount, &generatedSamples) ||
      !checkedMultiply(generatedSamples, taps, &sampleOperations) ||
      !checkedAdd(sampleOperations, &operations) ||
      operations > options.maximumResampleOperations)
    return DecodedAudioStatus::LimitExceeded;

  uint64_t workPerOutputFrame = 0;
  if (!checkedMultiply(taps, channelCount, &workPerOutputFrame) ||
      workPerOutputFrame == 0 ||
      workPerOutputFrame > options.maximumResampleOperationsPerPoll)
    return DecodedAudioStatus::LimitExceeded;

  // The first process() call starts at phase zero and therefore convolves
  // the primed (taps-1)-frame history as well as its input. Its exact output
  // upper bound is ceil(((taps-1)+input)*up/down). After process normalizes
  // phase by the consumed input, phase lies in
  // [history*up, history*up+down), so every later source/tail call emits no
  // more than ceil(input*up/down). Binary-search the largest input slice that
  // satisfies both bounds; reject before constructing Resampler if even one
  // input frame cannot fit the caller's per-poll MAC budget.
  const auto invocationWork = [&](uint64_t inputFrames, bool first,
                                  uint64_t* work) noexcept {
    uint64_t frames = inputFrames;
    if (first && !checkedAdd(taps - 1, &frames)) return false;
    uint64_t outputCount = 0;
    return ceilScaled(frames, up, down, &outputCount) &&
        checkedMultiply(outputCount, workPerOutputFrame, work);
  };
  uint64_t low = 1;
  uint64_t high = kDecodeChunkFrames;
  uint64_t sliceFrames = 0;
  while (low <= high) {
    const uint64_t candidate = low + (high - low) / 2;
    uint64_t firstWork = 0;
    uint64_t laterWork = 0;
    const bool fits = invocationWork(candidate, true, &firstWork) &&
        invocationWork(candidate, false, &laterWork) &&
        firstWork <= options.maximumResampleOperationsPerPoll &&
        laterWork <= options.maximumResampleOperationsPerPoll;
    if (fits) {
      sliceFrames = candidate;
      low = candidate + 1;
    } else {
      high = candidate - 1;
    }
  }
  if (sliceFrames == 0) return DecodedAudioStatus::LimitExceeded;

  uint64_t inputSamples = 0;
  uint64_t outputSamples64 = 0;
  uint64_t historySamples = 0;
  uint64_t blockSamples = 0;
  uint64_t resamplerWorkBlockSamples = 0;
  uint64_t workSamples = 0;
  uint64_t workingSamples = 0;
  if (!checkedMultiply(audio->frameCount, channelCount, &inputSamples) ||
      !checkedMultiply(outputFrames, channelCount, &outputSamples64) ||
      !checkedMultiply(taps - 1, channelCount, &historySamples) ||
      !checkedMultiply(sliceFrames, channelCount, &blockSamples) ||
      !checkedAdd(historySamples, &workSamples) ||
      !checkedMultiply(sliceFrames, channelCount,
                       &resamplerWorkBlockSamples) ||
      !checkedAdd(resamplerWorkBlockSamples, &workSamples) ||
      !checkedAdd(inputSamples, &workingSamples) ||
      !checkedAdd(outputSamples64, &workingSamples) ||
      !checkedAdd(generatedSamples, &workingSamples) ||
      !checkedAdd(filterSamples, &workingSamples) ||
      !checkedAdd(historySamples, &workingSamples) ||
      !checkedAdd(blockSamples, &workingSamples) ||
      !checkedAdd(workSamples, &workingSamples) ||
      workingSamples > std::numeric_limits<uint64_t>::max() / sizeof(float) ||
      workingSamples * sizeof(float) > options.maximumWorkingBytes)
    return DecodedAudioStatus::LimitExceeded;

  Resampler converter(static_cast<int>(audio->sampleRate),
                      static_cast<int>(requiredSampleRate),
                      static_cast<int>(channelCount));
  std::vector<float> interleavedOutput;
  if (outputFrames != 0 &&
      outputFrames > std::numeric_limits<size_t>::max() / channelCount)
    return DecodedAudioStatus::LimitExceeded;
  if (generatedSamples > std::numeric_limits<size_t>::max())
    return DecodedAudioStatus::LimitExceeded;
  interleavedOutput.reserve(static_cast<size_t>(generatedSamples));
  std::vector<float> inputBlock(
      static_cast<size_t>(sliceFrames * channelCount));
  uint64_t cursor = 0;
  while (cursor < audio->frameCount) {
    if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
    const uint64_t count = std::min<uint64_t>(sliceFrames,
                                              audio->frameCount - cursor);
    for (uint64_t frame = 0; frame < count; ++frame) {
      for (uint32_t channel = 0; channel < channelCount; ++channel) {
        inputBlock[static_cast<size_t>(frame * channelCount + channel)] =
            audio->channels[channel][static_cast<size_t>(cursor + frame)];
      }
    }
    converter.process(inputBlock.data(), static_cast<int64_t>(count),
                      interleavedOutput);
    cursor += count;
  }
  // Resampler::flush feeds taps zero frames in one call. Feed the identical
  // zero tail through the streaming API instead, reusing the bounded source
  // block so extreme upsampling cannot hide a long convolution between
  // cancellation polls. Streaming partitioning is bit-exact for Resampler.
  std::fill(inputBlock.begin(), inputBlock.end(), 0.0f);
  uint64_t tailCursor = 0;
  while (tailCursor < taps) {
    if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
    const uint64_t count = std::min<uint64_t>(sliceFrames, taps - tailCursor);
    converter.process(inputBlock.data(), static_cast<int64_t>(count),
                      interleavedOutput);
    tailCursor += count;
  }
  const uint64_t generatedFrames = interleavedOutput.size() / channelCount;
  const uint64_t latency = static_cast<uint64_t>(converter.latencyOutFrames());
  if (latency > generatedFrames || outputFrames > generatedFrames - latency)
    return DecodedAudioStatus::MalformedData;

  WorkingAudio converted;
  converted.sampleRate = requiredSampleRate;
  converted.frameCount = outputFrames;
  converted.channels.resize(channelCount);
  for (auto& channel : converted.channels)
    channel.reserve(static_cast<size_t>(outputFrames));
  uint64_t outputCursor = 0;
  while (outputCursor < outputFrames) {
    if (cancellation.isRequested()) return DecodedAudioStatus::Cancelled;
    const uint64_t count = std::min<uint64_t>(kDecodeChunkFrames,
                                              outputFrames - outputCursor);
    for (auto& channel : converted.channels)
      channel.resize(static_cast<size_t>(outputCursor + count));
    for (uint64_t relativeFrame = 0; relativeFrame < count; ++relativeFrame) {
      const uint64_t frame = outputCursor + relativeFrame;
      const size_t source =
          static_cast<size_t>((latency + frame) * channelCount);
      for (uint32_t channel = 0; channel < channelCount; ++channel)
        converted.channels[channel][static_cast<size_t>(frame)] =
            interleavedOutput[source + channel];
    }
    outputCursor += count;
  }
  *audio = std::move(converted);
  return DecodedAudioStatus::Ok;
}

}  // namespace

OwnedFileDescriptor::OwnedFileDescriptor(int descriptor) noexcept
    : descriptor_(descriptor) {}

OwnedFileDescriptor::~OwnedFileDescriptor() { reset(); }

OwnedFileDescriptor::OwnedFileDescriptor(OwnedFileDescriptor&& other) noexcept
    : descriptor_(other.release()) {}

OwnedFileDescriptor& OwnedFileDescriptor::operator=(
    OwnedFileDescriptor&& other) noexcept {
  if (this != &other) reset(other.release());
  return *this;
}

bool OwnedFileDescriptor::valid() const noexcept { return descriptor_ >= 0; }
int OwnedFileDescriptor::get() const noexcept { return descriptor_; }
int OwnedFileDescriptor::release() noexcept {
  const int result = descriptor_;
  descriptor_ = -1;
  return result;
}
void OwnedFileDescriptor::reset(int descriptor) noexcept {
  if (descriptor_ == descriptor) return;
  closeDescriptor(descriptor_);
  descriptor_ = descriptor;
}

DecodedAudio::DecodedAudio(uint32_t sampleRate, uint64_t frameCount,
                           std::vector<std::vector<float>> channels) noexcept
    : sampleRate_(sampleRate), frameCount_(frameCount),
      channels_(std::move(channels)) {}

const float* DecodedAudio::channelData(uint32_t channel) const noexcept {
  return channel < channels_.size() ? channels_[channel].data() : nullptr;
}

DecodedAudioResult prepareDecodedAudio(
    OwnedFileDescriptor descriptor, const DecodedAudioPrepareOptions& options,
    DecodeCancellation cancellation) noexcept {
  DecodedAudioResult result;
  if (!descriptor.valid() || !validOptions(options)) return result;
  if (cancellation.isRequested()) {
    result.status = DecodedAudioStatus::Cancelled;
    return result;
  }
  try {
    FileOwner owner{consumeAsFile(&descriptor)};
    if (owner.file == nullptr) {
      result.status = DecodedAudioStatus::IoError;
      return result;
    }
    // Ownership transfer is independent of the descriptor's current offset.
    // A non-seekable authority is not a supported prepared source.
    if (fseeko(owner.file, 0, SEEK_SET) != 0) {
      result.status = DecodedAudioStatus::IoError;
      return result;
    }
    unsigned char magic[4]{};
    const size_t magicBytes = std::fread(magic, 1, sizeof(magic), owner.file);
    if (magicBytes != sizeof(magic)) {
      result.status = std::ferror(owner.file) != 0
          ? DecodedAudioStatus::IoError
          : DecodedAudioStatus::MalformedData;
      return result;
    }
    if (fseeko(owner.file, 0, SEEK_SET) != 0) {
      result.status = DecodedAudioStatus::IoError;
      return result;
    }
    WorkingAudio decoded;
    DecodedAudioStatus status = DecodedAudioStatus::UnsupportedFormat;
    if (std::memcmp(magic, "RIFF", 4) == 0)
      status = decodeWav(owner.file, options, cancellation, &decoded);
    else if (std::memcmp(magic, "fLaC", 4) == 0)
      status = decodeFlac(&owner, options, cancellation, &decoded);
    if (status != DecodedAudioStatus::Ok) {
      result.status = status;
      return result;
    }
    status = resample(&decoded, options.requiredSampleRate, options,
                      cancellation);
    if (status != DecodedAudioStatus::Ok) {
      result.status = status;
      return result;
    }
    if (cancellation.isRequested()) {
      result.status = DecodedAudioStatus::Cancelled;
      return result;
    }
    result.audio = std::shared_ptr<const DecodedAudio>(new DecodedAudio(
        decoded.sampleRate, decoded.frameCount, std::move(decoded.channels)));
    result.status = DecodedAudioStatus::Ok;
    return result;
  } catch (const std::bad_alloc&) {
    result.audio.reset();
    result.status = DecodedAudioStatus::ResourceExhausted;
    return result;
  } catch (...) {
    result.audio.reset();
    result.status = DecodedAudioStatus::MalformedData;
    return result;
  }
}

const char* decodedAudioCapabilityTag() noexcept { return kCapabilityTag; }

}  // namespace singz
