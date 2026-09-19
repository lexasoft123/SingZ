// WAV, streamed: a StreamingAudioSource over a RIFF/WAVE file, and the one
// definition of how this core reads a WAV at all.
//
// Why it exists: every song split since 0.23.0 keeps its lead and backing
// vocals as 32-bit float WAV — lead is the input minus the backing, and the
// 16-bit FLAC encoder would clip the residual peaks the subtraction pushes
// past full scale. The streaming path read FLAC only and streams all lanes or
// none, so ONE such lane sent the whole song back to a full decode: 115 MB
// held against 20 MB on a phone for a 40-second test song, ~650 MB for four
// minutes, and on the desktop an open that decoded both vocal lanes in the
// renderer (2.9 s for a five-minute song against 0.5 s for its six-FLAC
// neighbour).
//
// WAV is the easy case the interface was designed to admit
// (streaming_audio_source.h): no encoder delay, every frame independently
// addressable, so a seek is arithmetic and `seekCost` is Indexed from the
// start. What is NOT easy is agreeing with the whole-file decoder about which
// files are acceptable and what their samples are, which is why the header
// walk and the sample conversion below are also what `prepareDecodedAudio`
// uses. A lane the desktop measures through this source is checked against a
// decode of the same file, and a phone streams exactly the lanes it would
// otherwise have decoded; two parsers would eventually be two answers.
#include "decoded_audio_internal.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <limits>
#include <vector>

namespace singz::media_internal {
namespace {

// Frames converted per positioned read. A chunk is bounded work between
// cancellation polls, and the staging it needs is reserved once at open.
constexpr uint64_t kChunkFrames = 4096;

constexpr std::array<unsigned char, 16> kExtensiblePcmGuid{
    0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};
constexpr std::array<unsigned char, 16> kExtensibleFloatGuid{
    0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10, 0x00,
    0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71};

uint16_t le16(const unsigned char* value) noexcept {
  return static_cast<uint16_t>(value[0]) |
      static_cast<uint16_t>(static_cast<uint16_t>(value[1]) << 8);
}

uint32_t le32(const unsigned char* value) noexcept {
  return static_cast<uint32_t>(value[0]) |
      (static_cast<uint32_t>(value[1]) << 8) |
      (static_cast<uint32_t>(value[2]) << 16) |
      (static_cast<uint32_t>(value[3]) << 24);
}

// Keeps reading until `bytes` arrived, the file ended, or it failed — a
// positioned read may legally return short. Bytes read, or -1.
int64_t readFully(const WavByteSource& source, uint64_t offset,
                  unsigned char* buffer, size_t bytes) noexcept {
  size_t got = 0;
  while (got < bytes) {
    const int64_t n = source.readAt(source.context, offset + got, buffer + got,
                                    bytes - got);
    if (n < 0) return -1;
    if (n == 0) break;
    got += static_cast<size_t>(n);
  }
  return static_cast<int64_t>(got);
}

}  // namespace

DecodedAudioStatus parseWavLayout(const WavByteSource& source,
                                  const DecodeCancellation& cancel,
                                  WavLayout* layout) noexcept {
  if (source.readAt == nullptr || layout == nullptr)
    return DecodedAudioStatus::InvalidArgument;

  unsigned char riff[12]{};
  const int64_t head = readFully(source, 0, riff, sizeof(riff));
  if (head < 0) return DecodedAudioStatus::IoError;
  if (head != static_cast<int64_t>(sizeof(riff)) ||
      std::memcmp(riff, "RIFF", 4) != 0 || std::memcmp(riff + 8, "WAVE", 4) != 0)
    return DecodedAudioStatus::MalformedData;
  const uint32_t riffSize = le32(riff + 4);
  // RF64 and "streaming" writers put the all-ones sentinel here and the real
  // size in a ds64 chunk this code does not parse.
  if (riffSize == std::numeric_limits<uint32_t>::max())
    return DecodedAudioStatus::UnsupportedFormat;
  if (riffSize < 4) return DecodedAudioStatus::MalformedData;
  const uint64_t containerEnd = uint64_t{8} + riffSize;
  if (containerEnd > source.length) return DecodedAudioStatus::MalformedData;

  bool haveFormat = false;
  uint16_t format = 0;
  uint16_t channels = 0;
  uint16_t bitsPerSample = 0;
  uint16_t blockAlign = 0;
  uint32_t sampleRate = 0;
  uint32_t byteRate = 0;
  uint64_t chunkStart = 12;
  for (;;) {
    if (cancel.isRequested()) return DecodedAudioStatus::Cancelled;
    if (chunkStart > containerEnd || containerEnd - chunkStart < 8)
      return DecodedAudioStatus::MalformedData;
    unsigned char chunk[8]{};
    const int64_t chunkHead = readFully(source, chunkStart, chunk, sizeof(chunk));
    if (chunkHead < 0) return DecodedAudioStatus::IoError;
    if (chunkHead != static_cast<int64_t>(sizeof(chunk)))
      return DecodedAudioStatus::MalformedData;
    const uint32_t size = le32(chunk + 4);
    const bool dataChunk = std::memcmp(chunk, "data", 4) == 0;
    if (dataChunk && size == std::numeric_limits<uint32_t>::max())
      return DecodedAudioStatus::UnsupportedFormat;
    const uint64_t payloadStart = chunkStart + 8;
    const uint64_t payloadEnd = payloadStart + size;
    // RIFF pads odd chunks to an even length, and the pad byte is not audio.
    const uint64_t paddedEnd = payloadEnd + (size & 1u);
    if (payloadEnd < payloadStart || paddedEnd < payloadEnd ||
        paddedEnd > containerEnd)
      return DecodedAudioStatus::MalformedData;

    if (std::memcmp(chunk, "fmt ", 4) == 0) {
      if (size < 16) return DecodedAudioStatus::MalformedData;
      std::array<unsigned char, 40> fields{};
      const size_t captured = std::min<size_t>(size, fields.size());
      const int64_t got = readFully(source, payloadStart, fields.data(), captured);
      if (got < 0) return DecodedAudioStatus::IoError;
      if (got != static_cast<int64_t>(captured)) return DecodedAudioStatus::MalformedData;
      format = le16(fields.data());
      channels = le16(fields.data() + 2);
      sampleRate = le32(fields.data() + 4);
      byteRate = le32(fields.data() + 8);
      blockAlign = le16(fields.data() + 12);
      bitsPerSample = le16(fields.data() + 14);
      if (format == 0xfffe) {
        if (size < 40) return DecodedAudioStatus::MalformedData;
        const uint16_t extensionSize = le16(fields.data() + 16);
        const uint16_t validBits = le16(fields.data() + 18);
        if (extensionSize < 22 || static_cast<uint64_t>(18) + extensionSize > size)
          return DecodedAudioStatus::MalformedData;
        if (std::memcmp(fields.data() + 24, kExtensiblePcmGuid.data(),
                        kExtensiblePcmGuid.size()) == 0) {
          format = 1;
        } else if (std::memcmp(fields.data() + 24, kExtensibleFloatGuid.data(),
                               kExtensibleFloatGuid.size()) == 0) {
          format = 3;
        } else {
          return DecodedAudioStatus::UnsupportedFormat;
        }
        // Reduced valid-bit containers are MSB-aligned and need a distinct
        // conversion path. Accept only the canonical representation decoded
        // identically to ordinary PCM/float.
        if (validBits != bitsPerSample) return DecodedAudioStatus::UnsupportedFormat;
      }
      haveFormat = true;
      chunkStart = paddedEnd;
      continue;
    }
    if (!dataChunk) {
      chunkStart = paddedEnd;
      continue;
    }

    if (!haveFormat || channels == 0 || sampleRate < kMinimumSupportedSampleRate ||
        sampleRate > kMaximumSupportedSampleRate)
      return DecodedAudioStatus::MalformedData;
    const bool floatingPoint = format == 3 && bitsPerSample == 32;
    const bool integerPcm = format == 1 &&
        (bitsPerSample == 16 || bitsPerSample == 24 || bitsPerSample == 32);
    if (!floatingPoint && !integerPcm) return DecodedAudioStatus::UnsupportedFormat;
    const uint64_t bytesPerSample = bitsPerSample / 8;
    const uint64_t bytesPerFrame = bytesPerSample * channels;
    if (bytesPerFrame == 0 || bytesPerFrame > UINT16_MAX ||
        blockAlign != bytesPerFrame ||
        sampleRate > std::numeric_limits<uint32_t>::max() / bytesPerFrame ||
        byteRate != sampleRate * bytesPerFrame ||
        static_cast<uint64_t>(size) % bytesPerFrame != 0) {
      return DecodedAudioStatus::MalformedData;
    }
    layout->sampleRate = sampleRate;
    layout->channels = channels;
    layout->bitsPerSample = bitsPerSample;
    layout->floatingPoint = floatingPoint;
    layout->bytesPerFrame = static_cast<uint32_t>(bytesPerFrame);
    layout->dataOffset = payloadStart;
    layout->frames = static_cast<uint64_t>(size) / bytesPerFrame;
    return DecodedAudioStatus::Ok;
  }
}

DecodedAudioStatus convertWavFrames(const unsigned char* bytes, uint64_t frames,
                                    const WavLayout& layout, float* const* planar,
                                    size_t offset, uint64_t* converted) noexcept {
  if (converted != nullptr) *converted = 0;
  if (bytes == nullptr || planar == nullptr || converted == nullptr ||
      layout.bytesPerFrame == 0)
    return DecodedAudioStatus::InvalidArgument;
  const uint64_t bytesPerSample = layout.bitsPerSample / 8;
  for (uint64_t frame = 0; frame < frames; ++frame) {
    for (uint32_t channel = 0; channel < layout.channels; ++channel) {
      const unsigned char* sample = bytes + frame * layout.bytesPerFrame +
          static_cast<uint64_t>(channel) * bytesPerSample;
      float value = 0.0f;
      if (layout.floatingPoint) {
        std::memcpy(&value, sample, sizeof(value));
        if (!std::isfinite(value)) {
          *converted = frame;
          return DecodedAudioStatus::MalformedData;
        }
      } else if (layout.bitsPerSample == 16) {
        value = static_cast<float>(static_cast<int16_t>(le16(sample)) / 32768.0);
      } else if (layout.bitsPerSample == 24) {
        const int32_t integer = static_cast<int32_t>(
            (static_cast<uint32_t>(sample[0]) << 8) |
            (static_cast<uint32_t>(sample[1]) << 16) |
            (static_cast<uint32_t>(sample[2]) << 24)) >> 8;
        value = static_cast<float>(integer / 8388608.0);
      } else {
        value = static_cast<float>(static_cast<int32_t>(le32(sample)) / 2147483648.0);
      }
      planar[channel][offset + static_cast<size_t>(frame)] = value;
    }
  }
  *converted = frames;
  return DecodedAudioStatus::Ok;
}

namespace {

class WavStreamingSource final : public StreamingAudioSource {
 public:
  explicit WavStreamingSource(int fd) noexcept : fd_(fd) {}
  ~WavStreamingSource() override { closeRawDescriptor(fd_); }

  WavStreamingSource(const WavStreamingSource&) = delete;
  WavStreamingSource& operator=(const WavStreamingSource&) = delete;

  [[nodiscard]] DecodedAudioStatus open(const StreamingAudioOpenOptions& options) {
    // Same refusal as the FLAC source, for the same reason: a caller asking
    // for another rate must get a refusal, never audio at the wrong one.
    if (options.requiredSampleRate != 0) return DecodedAudioStatus::InvalidArgument;
    if (options.sourceFormat != DecodedAudioSourceFormat::Auto &&
        options.sourceFormat != DecodedAudioSourceFormat::Wav)
      return DecodedAudioStatus::UnsupportedFormat;
    if (fd_ < 0) return DecodedAudioStatus::IoError;
    const int64_t length = fileLength(fd_);
    if (length < 0) return DecodedAudioStatus::IoError;

    const WavByteSource bytes{this, &WavStreamingSource::readBytes,
                              static_cast<uint64_t>(length)};
    const DecodedAudioStatus parsed = parseWavLayout(bytes, DecodeCancellation{}, &layout_);
    if (parsed != DecodedAudioStatus::Ok) return parsed;
    if (layout_.channels > kMaximumSupportedChannels) return DecodedAudioStatus::LimitExceeded;

    info_.sampleRate = layout_.sampleRate;
    info_.channels = layout_.channels;
    info_.frameCount = layout_.frames;
    // Stated by the data chunk and checked against the file at open. A file
    // that shrinks afterwards is found by reading, as the interface says.
    info_.frameCountFromContainer = true;
    // Every frame is addressable: a seek is a multiplication.
    info_.seekGranularityFrames = 1;
    info_.seekCost = SeekCost::Indexed;
    // Reserved here so a playing song never grows it (the header's rule).
    staging_.resize(static_cast<size_t>(kChunkFrames) * layout_.bytesPerFrame);
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] const StreamingAudioInfo& info() const noexcept override { return info_; }

  [[nodiscard]] uint64_t position() const noexcept override { return position_; }

  [[nodiscard]] DecodedAudioStatus seek(uint64_t frame) override {
    if (layout_.bytesPerFrame == 0) return DecodedAudioStatus::InvalidArgument;
    // Beyond the end positions AT the end, and the next read returns zero.
    position_ = std::min(frame, layout_.frames);
    // A seek abandons whatever the last read had pending: the damage it was
    // about to report was at the old position, not this one.
    pendingError_ = DecodedAudioStatus::Ok;
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] DecodedAudioStatus read(float* const* channels, size_t frames,
                                        size_t* framesRead) override {
    if (framesRead == nullptr) return DecodedAudioStatus::InvalidArgument;
    *framesRead = 0;
    if (channels == nullptr || layout_.bytesPerFrame == 0)
      return DecodedAudioStatus::InvalidArgument;
    // Partial data then the error, across two calls — the interface's rule.
    if (pendingError_ != DecodedAudioStatus::Ok) {
      const DecodedAudioStatus pending = pendingError_;
      pendingError_ = DecodedAudioStatus::Ok;
      return pending;
    }

    size_t written = 0;
    DecodedAudioStatus failure = DecodedAudioStatus::Ok;
    while (written < frames && position_ < layout_.frames) {
      // Between chunks: a chunk is bounded work, and a ring-fill thread has to
      // be stoppable when the singer leaves the song.
      if (cancel_.isRequested()) break;
      const uint64_t count = std::min<uint64_t>(
          {kChunkFrames, static_cast<uint64_t>(frames - written),
           layout_.frames - position_});
      const size_t wanted = static_cast<size_t>(count * layout_.bytesPerFrame);
      const uint64_t offset = layout_.dataOffset + position_ * layout_.bytesPerFrame;
      const int64_t got = readFullyAt(offset, wanted);
      if (got < 0) {
        failure = DecodedAudioStatus::IoError;
        break;
      }
      // Only whole frames are audio; a torn tail frame is the file ending.
      const uint64_t whole = static_cast<uint64_t>(got) / layout_.bytesPerFrame;
      uint64_t converted = 0;
      const DecodedAudioStatus status =
          convertWavFrames(staging_.data(), whole, layout_, channels, written, &converted);
      // ALWAYS advanced by what was handed over, on every path: a position
      // that under-reports frames the caller kept drifts for the rest of the
      // song.
      written += static_cast<size_t>(converted);
      position_ += converted;
      if (status != DecodedAudioStatus::Ok) {
        failure = status;
        break;
      }
      if (whole < count) {
        // The data chunk promised more than the file now holds — it was
        // checked at open, so the file shrank under us. Same status the
        // decoder returns for a short read.
        failure = DecodedAudioStatus::IoError;
        break;
      }
    }
    *framesRead = written;
    if (failure != DecodedAudioStatus::Ok) {
      if (written == 0) return failure;
      pendingError_ = failure;
    }
    return DecodedAudioStatus::Ok;
  }

  void setCancellation(const DecodeCancellation& cancel) override { cancel_ = cancel; }

  [[nodiscard]] DecodedAudioStatus buildSeekIndex(const DecodeCancellation&) override {
    // Already Indexed: there is nothing to build.
    return DecodedAudioStatus::Ok;
  }

 private:
  static int64_t readBytes(void* context, uint64_t offset, unsigned char* buffer,
                           size_t bytes) noexcept {
    auto* self = static_cast<WavStreamingSource*>(context);
    return readAt(self->fd_, buffer, bytes, static_cast<int64_t>(offset));
  }

  int64_t readFullyAt(uint64_t offset, size_t bytes) noexcept {
    size_t got = 0;
    while (got < bytes) {
      const int64_t n = readAt(fd_, staging_.data() + got, bytes - got,
                               static_cast<int64_t>(offset + got));
      if (n < 0) return -1;
      if (n == 0) break;
      got += static_cast<size_t>(n);
    }
    return static_cast<int64_t>(got);
  }

  // This source's own descriptor and its own offsets — positioned reads only,
  // for the reason flac_streaming_source.cpp gives: playback and the waveform
  // pass open the same file twice, and a shared cursor drags both about.
  int fd_ = -1;
  WavLayout layout_{};
  StreamingAudioInfo info_{};
  std::vector<unsigned char> staging_;
  uint64_t position_ = 0;
  DecodedAudioStatus pendingError_ = DecodedAudioStatus::Ok;
  DecodeCancellation cancel_{};
};

}  // namespace

std::unique_ptr<StreamingAudioSource> openWavStreamingSource(
    int fd, const StreamingAudioOpenOptions& options, DecodedAudioStatus* status) {
  auto set = [status](DecodedAudioStatus s) {
    if (status != nullptr) *status = s;
  };
  // Owns the descriptor from here: the destructor closes it on every refusal.
  auto source = std::make_unique<WavStreamingSource>(fd);
  const DecodedAudioStatus opened = source->open(options);
  if (opened != DecodedAudioStatus::Ok) {
    set(opened);
    return nullptr;
  }
  set(DecodedAudioStatus::Ok);
  return source;
}

}  // namespace singz::media_internal
