// MP3, natively: the frame index, the gapless arithmetic and the sample-exact
// seek, over dr_mp3's frame decoder (third_party/native/dr_mp3).
//
// Why it exists: zcore's only MP3 path was the FFmpeg one, compiled only under
// a product selection no shipped phone build has made. So every MP3 lane — an
// unsplit phone-added `song.mp3`, a custom track — sent the whole song to the
// legacy engine, which decodes a six-minute song into 137 MB of float PCM on
// every open. This file is MP3 for every build, FFmpeg or not.
//
// What it has to get RIGHT is the exactness contract in
// streaming_audio_source.h: frame N is the same audio whether it came from a
// whole-file decode, a streaming read from the start, or a seek. MP3 makes
// that the adapter's problem three ways, and each is answered here:
//
//   1. Encoder delay and padding. A LAME/Lavc `Info`/`Xing` frame states how
//      many samples the encoder added at the front and the back. They are
//      removed with FFmpeg's arithmetic (skip delay + 529, end at
//      frames*spf - padding + 529), because FFmpeg is what every reference in
//      the MP3 suite was decoded with and what the codec target proof pins.
//      Without such a header nothing is trimmed — again as FFmpeg does.
//   2. Length. A file with no Xing/VBRI header (the field file that started
//      this: 320 kbps CBR, no header, 1008 bytes of 0xFF on the end) does not
//      say how long it is, and an estimate from the bitrate is a few frames
//      out. So open walks every frame header once and KNOWS: the index is the
//      length, exactly, for CBR and VBR alike.
//   3. The bit reservoir. A Layer III frame's audio data may start up to 511
//      bytes back, inside earlier frames, and its output overlaps the previous
//      granule's. So a seek decodes a RUN-UP and throws it away: enough frames
//      before the target that the reservoir holds 511 bytes of real main data
//      when the frames just before the target are decoded — one granule pair
//      of them (one MPEG-1 frame, two MPEG-2 frames), fully decoded, is all
//      the decoder state the target depends on (its IMDCT overlap and the
//      synthesis filterbank history are both refilled within one granule
//      pair). The suite checks every seek sample for sample
//      against the whole-file decode, so a decoder that ever needed more would
//      fail there rather than drift.
//
// Everything reads POSITIONALLY (`MediaByteSource`, media_io.cpp): playback
// and the waveform pass open the same file twice, and a seek-then-read on a
// shared descriptor position is the Windows race media_io.cpp records.
//
// Reached through `openStreamingAudioSource` (streaming_audio_source.cpp) for
// a stream, and through `prepareDecodedAudio` for a whole-file decode; the
// format detector both use (media_format.cpp) routes MP3 here.
//
// Only Layer III is accepted. Free-format streams (bitrate index 0) and
// streams whose channel count changes part way are refused as
// UnsupportedFormat rather than half-read — a refusal sends one lane to the
// legacy engine, which is a slower song, never a wrong one.
#include "decoded_audio_internal.h"
#include "mp3_dr.h"

#include <algorithm>
#include <cstring>
#include <limits>
#include <new>
#include <utility>

namespace singz::media_internal {
namespace {

constexpr size_t kHeaderBytes = 4;
constexpr uint32_t kMaximumFrameBytes = 2881;  // MPEG-1 L3 320 kbps at 32 kHz, padded, with margin
// FFmpeg's start/end skip: the MP3 synthesis filterbank's own delay.
constexpr uint64_t kDecoderDelay = 529;
// How much of the file is searched for the first frame after the ID3v2 tag.
// Generous — some files carry a large unsynchronised cover picture outside
// the tag — but bounded so a file that is simply not MP3 is refused promptly.
constexpr uint64_t kFirstFrameSearchBytes = 1u << 20;
// The reservoir: a frame's main data may begin this far back.
constexpr uint64_t kReservoirBytes = 511;
constexpr size_t kReadChunkBytes = 64 * 1024;

uint32_t be32(const unsigned char* b) noexcept {
  return (static_cast<uint32_t>(b[0]) << 24) | (static_cast<uint32_t>(b[1]) << 16) |
      (static_cast<uint32_t>(b[2]) << 8) | static_cast<uint32_t>(b[3]);
}

uint32_t le32(const unsigned char* b) noexcept {
  return static_cast<uint32_t>(b[0]) | (static_cast<uint32_t>(b[1]) << 8) |
      (static_cast<uint32_t>(b[2]) << 16) | (static_cast<uint32_t>(b[3]) << 24);
}

// One decoded MPEG audio frame header, Layer III only.
struct FrameHeader {
  uint8_t version = 0;  // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
  bool crc = false;
  uint32_t sampleRate = 0;
  uint16_t channels = 0;
  uint32_t bytes = 0;
  uint32_t samplesPerFrame = 0;
  uint32_t sideInfoBytes = 0;
};

// Layer III only, like FFmpeg's and minimp3's own validity checks (sync,
// layer, bitrate != 15, rate index != 3) with free format refused on top.
bool parseHeader(const unsigned char* h, FrameHeader* out) noexcept {
  if (h[0] != 0xFF || (h[1] & 0xE0) != 0xE0) return false;
  const uint8_t version = (h[1] >> 3) & 3;
  const uint8_t layer = (h[1] >> 1) & 3;
  const uint8_t bitrateIndex = h[2] >> 4;
  const uint8_t rateIndex = (h[2] >> 2) & 3;
  if (version == 1 || layer != 1 || bitrateIndex == 0 || bitrateIndex == 15 || rateIndex == 3)
    return false;
  static constexpr uint16_t kMpeg1Kbps[15] = {0,   32,  40,  48,  56,  64,  80, 96,
                                               112, 128, 160, 192, 224, 256, 320};
  static constexpr uint16_t kMpeg2Kbps[15] = {0,  8,  16, 24,  32,  40,  48, 56,
                                               64, 80, 96, 112, 128, 144, 160};
  static constexpr uint32_t kRates[3] = {44100, 48000, 32000};
  const bool mpeg1 = version == 3;
  const uint32_t kbps = mpeg1 ? kMpeg1Kbps[bitrateIndex] : kMpeg2Kbps[bitrateIndex];
  uint32_t rate = kRates[rateIndex];
  if (version == 2) rate /= 2;
  if (version == 0) rate /= 4;
  const bool mono = (h[3] >> 6) == 3;
  const uint32_t padding = (h[2] >> 1) & 1;
  out->version = version;
  out->crc = (h[1] & 1) == 0;
  out->sampleRate = rate;
  out->channels = mono ? 1 : 2;
  out->samplesPerFrame = mpeg1 ? 1152 : 576;
  out->bytes = (mpeg1 ? 144u : 72u) * kbps * 1000u / rate + padding;
  out->sideInfoBytes = mpeg1 ? (mono ? 17 : 32) : (mono ? 9 : 17);
  return out->bytes > kHeaderBytes + (out->crc ? 2 : 0) + out->sideInfoBytes;
}

// Same stream as `reference`: what minimp3 itself compares frame to frame
// (version, layer, rate; every frame here is already Layer III). A channel
// count that changes part way is a different matter — planar output cannot
// follow it — and parseMp3Layout refuses that file outright.
bool sameStream(const FrameHeader& a, const FrameHeader& b) noexcept {
  return a.version == b.version && a.sampleRate == b.sampleRate;
}

// A window over the file for the header walk and the frame decoder: one
// positioned read per 64 KiB instead of one per frame, and never a shared
// file position.
class ByteWindow {
 public:
  explicit ByteWindow(const MediaByteSource& source) : source_(source) {
    buffer_.resize(kReadChunkBytes);
  }

  // Up to `want` bytes at `offset`; `*got` says how many exist (short at the
  // end of the file). False on an I/O error.
  bool at(uint64_t offset, size_t want, const unsigned char** bytes, size_t* got) noexcept {
    *bytes = nullptr;
    *got = 0;
    if (offset >= source_.length) return true;
    want = static_cast<size_t>(std::min<uint64_t>(want, source_.length - offset));
    if (!(valid_ && offset >= start_ && offset + want <= start_ + size_)) {
      if (!fill(offset)) return false;
    }
    *bytes = buffer_.data() + (offset - start_);
    *got = static_cast<size_t>(std::min<uint64_t>(want, start_ + size_ - offset));
    return true;
  }

 private:
  bool fill(uint64_t offset) noexcept {
    valid_ = false;
    const size_t wanted = static_cast<size_t>(
        std::min<uint64_t>(buffer_.size(), source_.length - offset));
    size_t have = 0;
    while (have < wanted) {
      const int64_t n = source_.readAt(source_.context, offset + have, buffer_.data() + have,
                                       wanted - have);
      if (n < 0) return false;
      if (n == 0) break;
      have += static_cast<size_t>(n);
    }
    start_ = offset;
    size_ = have;
    valid_ = true;
    return true;
  }

  MediaByteSource source_;
  std::vector<unsigned char> buffer_;
  uint64_t start_ = 0;
  size_t size_ = 0;
  bool valid_ = false;
};

enum class Probe { Frame, NotFrame, IoError };

// A valid Layer III frame at `offset` that fits before `end` (and, given a
// reference, belongs to the same stream).
Probe frameAt(ByteWindow& window, uint64_t offset, uint64_t end, const FrameHeader* reference,
              FrameHeader* header) noexcept {
  if (offset + kHeaderBytes > end) return Probe::NotFrame;
  const unsigned char* bytes = nullptr;
  size_t got = 0;
  if (!window.at(offset, kHeaderBytes, &bytes, &got)) return Probe::IoError;
  if (got < kHeaderBytes || !parseHeader(bytes, header)) return Probe::NotFrame;
  if (reference != nullptr && !sameStream(*reference, *header)) return Probe::NotFrame;
  if (offset + header->bytes > end) return Probe::NotFrame;
  return Probe::Frame;
}

// A frame at `offset` followed by `more` frames of the same stream, each
// starting where the last ended — or by the end of the audio exactly. This is
// what separates a real frame from a sync pattern inside tag or junk bytes.
Probe chainAt(ByteWindow& window, uint64_t offset, uint64_t end, const FrameHeader* reference,
              int more, FrameHeader* header) noexcept {
  const Probe first = frameAt(window, offset, end, reference, header);
  if (first != Probe::Frame) return first;
  uint64_t next = offset + header->bytes;
  for (int i = 0; i < more; ++i) {
    if (next == end) return Probe::Frame;
    FrameHeader following;
    const Probe p = frameAt(window, next, end, header, &following);
    if (p != Probe::Frame) return p;
    next += following.bytes;
  }
  return Probe::Frame;
}

// Where the audio ends: tags at the tail are not frames. ID3v1 (128 bytes,
// "TAG"), APEv2 (footer "APETAGEX", optionally with a header), and Lyrics3v2
// ("LYRICS200" after a six-digit size) may appear in any order, so peel until
// nothing more comes off.
bool trimTailTags(ByteWindow& window, uint64_t begin, uint64_t* end) noexcept {
  for (;;) {
    const uint64_t before = *end;
    const unsigned char* b = nullptr;
    size_t got = 0;
    if (*end >= begin + 128) {
      if (!window.at(*end - 128, 3, &b, &got)) return false;
      if (got == 3 && std::memcmp(b, "TAG", 3) == 0) *end -= 128;
    }
    if (*end >= begin + 32) {
      if (!window.at(*end - 32, 32, &b, &got)) return false;
      if (got == 32 && std::memcmp(b, "APETAGEX", 8) == 0) {
        const uint64_t size = le32(b + 12);  // items + footer, not the header
        const bool hasHeader = (le32(b + 20) & 0x80000000u) != 0;
        const uint64_t total = size + (hasHeader ? 32 : 0);
        if (size >= 32 && total <= *end - begin) *end -= total;
      }
    }
    if (*end >= begin + 15) {
      if (!window.at(*end - 15, 15, &b, &got)) return false;
      if (got == 15 && std::memcmp(b + 6, "LYRICS200", 9) == 0) {
        uint64_t size = 0;
        bool digits = true;
        for (int i = 0; i < 6; ++i) {
          if (b[i] < '0' || b[i] > '9') digits = false;
          size = size * 10 + static_cast<uint64_t>(b[i] - '0');
        }
        // The size covers the tag from "LYRICSBEGIN" up to the size field.
        if (digits && size + 15 <= *end - begin) *end -= size + 15;
      }
    }
    if (*end == before) return true;
  }
}

struct VbrHeader {
  bool present = false;       // a Xing/Info or VBRI header was found in the first frame
  bool skipFrame = false;     // that frame is a header, not audio (FFmpeg's rule)
  uint64_t frames = 0;        // audio frames it states, 0 if it does not
  bool gapless = false;       // LAME/Lavf/Lavc delay and padding apply
  uint32_t delay = 0;
  uint32_t padding = 0;
};

// FFmpeg's mp3_parse_info_tag and mp3_parse_vbri_tag, field for field, so a
// file trims to the same samples here as in every reference.
bool readVbrHeader(ByteWindow& window, uint64_t offset, uint64_t fileLength,
                   const FrameHeader& header, VbrHeader* out) noexcept {
  const unsigned char* b = nullptr;
  size_t got = 0;
  if (!window.at(offset, header.bytes, &b, &got)) return false;
  if (got < header.bytes) return true;
  const size_t xing = kHeaderBytes + header.sideInfoBytes;  // FFmpeg ignores the CRC here too
  uint64_t statedBytes = 0;
  if (xing + 8 <= got && (std::memcmp(b + xing, "Xing", 4) == 0 ||
                          std::memcmp(b + xing, "Info", 4) == 0)) {
    out->present = true;
    const uint32_t flags = be32(b + xing + 4);
    size_t at = xing + 8;
    if ((flags & 1u) != 0) {
      if (at + 4 > got) return true;
      out->frames = be32(b + at);
      at += 4;
    }
    if ((flags & 2u) != 0) {
      if (at + 4 > got) return true;
      statedBytes = be32(b + at);
      at += 4;
    }
    // A stated size far below the file's is a concatenated file: FFmpeg then
    // drops the frame count (and with it the end trim) rather than cut the
    // second half off.
    const uint64_t remaining = fileLength > offset + kHeaderBytes
        ? fileLength - (offset + kHeaderBytes) : 0;
    if (remaining != 0 && statedBytes != 0 && remaining > statedBytes &&
        remaining - statedBytes > (statedBytes >> 4))
      out->frames = 0;
    if ((flags & 4u) != 0) at += 100;
    if ((flags & 8u) != 0) at += 4;
    // LAME extension: 9-byte encoder string, 12 bytes of fields, then the
    // 24-bit delay/padding pair.
    if (at + 24 <= got) {
      const unsigned char* version = b + at;
      if (std::memcmp(version, "LAME", 4) == 0 || std::memcmp(version, "Lavf", 4) == 0 ||
          std::memcmp(version, "Lavc", 4) == 0) {
        const unsigned char* pair = b + at + 21;
        const uint32_t v = (static_cast<uint32_t>(pair[0]) << 16) |
            (static_cast<uint32_t>(pair[1]) << 8) | static_cast<uint32_t>(pair[2]);
        out->gapless = true;
        out->delay = v >> 12;
        out->padding = v & 4095u;
      }
    }
  }
  // VBRI: always 32 bytes after the header, version 1.
  const size_t vbri = kHeaderBytes + 32;
  if (vbri + 18 <= got && std::memcmp(b + vbri, "VBRI", 4) == 0 &&
      b[vbri + 4] == 0 && b[vbri + 5] == 1) {
    out->present = true;
    statedBytes = be32(b + vbri + 10);
    out->frames = be32(b + vbri + 14);
  }
  out->skipFrame = out->present && (out->frames != 0 || statedBytes != 0);
  return true;
}

}  // namespace

DecodedAudioStatus parseMp3Layout(const MediaByteSource& source, const DecodeCancellation& cancel,
                                  Mp3Layout* layout) noexcept {
  if (source.readAt == nullptr || layout == nullptr) return DecodedAudioStatus::InvalidArgument;
  try {
    ByteWindow window(source);
    uint64_t begin = 0;
    uint64_t end = source.length;
    if (!skipId3v2Tags(source, &begin)) return DecodedAudioStatus::IoError;
    if (!trimTailTags(window, begin, &end)) return DecodedAudioStatus::IoError;

    // The first frame: a chain of four, searched for a bounded distance.
    FrameHeader first;
    uint64_t at = begin;
    const uint64_t searchEnd = std::min(end, begin + kFirstFrameSearchBytes);
    for (;; ++at) {
      if (at >= searchEnd) return DecodedAudioStatus::UnsupportedFormat;
      if ((at & 0xFFFF) == 0 && cancel.isRequested()) return DecodedAudioStatus::Cancelled;
      const Probe p = chainAt(window, at, end, nullptr, 3, &first);
      if (p == Probe::IoError) return DecodedAudioStatus::IoError;
      if (p == Probe::Frame) break;
    }
    if (first.sampleRate < kMinimumSupportedSampleRate) return DecodedAudioStatus::UnsupportedFormat;

    VbrHeader vbr;
    if (!readVbrHeader(window, at, source.length, first, &vbr)) return DecodedAudioStatus::IoError;

    Mp3Layout result;
    result.sampleRate = first.sampleRate;
    result.channels = first.channels;
    result.samplesPerFrame = first.samplesPerFrame;
    // A 320 kbps song is ~1044 bytes a frame; reserve for that and let VBR grow.
    result.frames.reserve(static_cast<size_t>((end - at) / 400 + 16));
    if (vbr.skipFrame) at += first.bytes;

    FrameHeader header;
    uint64_t walked = 0;
    while (at < end) {
      if ((++walked & 1023) == 0 && cancel.isRequested()) return DecodedAudioStatus::Cancelled;
      Probe p = frameAt(window, at, end, &first, &header);
      if (p == Probe::IoError) return DecodedAudioStatus::IoError;
      if (p != Probe::Frame) {
        // Junk between frames: resynchronise on the next chain of three, or
        // on a single frame that ends the audio exactly. Nothing found means
        // the audio is over — a torn last frame, 0xFF padding, garbage.
        uint64_t probe = at + 1;
        for (;; ++probe) {
          if (probe + kHeaderBytes > end) {
            p = Probe::NotFrame;
            break;
          }
          if ((probe & 0xFFFF) == 0 && cancel.isRequested()) return DecodedAudioStatus::Cancelled;
          p = chainAt(window, probe, end, &first, 2, &header);
          if (p != Probe::NotFrame) break;
        }
        if (p == Probe::IoError) return DecodedAudioStatus::IoError;
        if (p != Probe::Frame) break;
        at = probe;
      }
      if (header.channels != first.channels) return DecodedAudioStatus::UnsupportedFormat;
      result.frames.push_back(Mp3Frame{at, header.bytes});
      at += header.bytes;
    }
    if (result.frames.empty()) return DecodedAudioStatus::MalformedData;

    const uint64_t spf = result.samplesPerFrame;
    const uint64_t decoded = static_cast<uint64_t>(result.frames.size()) * spf;
    uint64_t skip = 0;
    uint64_t stop = decoded;
    if (vbr.gapless) {
      skip = vbr.delay + kDecoderDelay;
      if (vbr.frames != 0) {
        const uint64_t stated = vbr.frames * spf + kDecoderDelay;
        if (stated >= vbr.padding) stop = std::min(decoded, stated - vbr.padding);
      }
    }
    result.skipFront = std::min(skip, stop);
    result.frameCount = stop - result.skipFront;
    result.frameCountFromContainer = false;  // counted off the frames, not stated
    *layout = std::move(result);
    return DecodedAudioStatus::Ok;
  } catch (const std::bad_alloc&) {
    return DecodedAudioStatus::ResourceExhausted;
  }
}

uint64_t mp3RunUpStart(const Mp3Layout& layout, uint64_t frameIndex) noexcept {
  // The decoder state a frame starts from — the IMDCT overlap and the
  // synthesis filterbank's history — is rebuilt by ONE granule pair decoded
  // exactly: one MPEG-1 frame, but two MPEG-2/2.5 frames, which carry a single
  // granule each. (Measured: one MPEG-2 frame leaves seeks a few bits out.)
  // Each of those must itself decode exactly, so its reservoir needs 511
  // bytes of main data from the frames before it.
  const bool mpeg1 = layout.samplesPerFrame == 1152;
  const uint64_t exact = mpeg1 ? 1 : 2;
  if (frameIndex <= exact) return 0;
  uint64_t start = frameIndex - exact;
  uint64_t mainData = 0;
  const uint64_t overhead = kHeaderBytes + 2 +
      (mpeg1 ? (layout.channels == 1 ? 17 : 32) : (layout.channels == 1 ? 9 : 17));
  while (start > 0 && mainData < kReservoirBytes) {
    --start;
    const uint32_t bytes = layout.frames[static_cast<size_t>(start)].bytes;
    mainData += bytes > overhead ? bytes - overhead : 0;
  }
  return start;
}

struct Mp3FrameDecoder::State {
  explicit State(const MediaByteSource& source) : window(source) {}
  drmp3dec decoder{};
  ByteWindow window;
  bool primed = false;
};

Mp3FrameDecoder::Mp3FrameDecoder(const MediaByteSource& source)
    : state_(std::make_unique<State>(source)) {}

Mp3FrameDecoder::~Mp3FrameDecoder() = default;

void Mp3FrameDecoder::reset() noexcept { state_->primed = false; }

DecodedAudioStatus Mp3FrameDecoder::decode(const Mp3Frame& frame, const Mp3Layout& layout,
                                           float* interleaved) noexcept {
  const unsigned char* bytes = nullptr;
  size_t got = 0;
  if (frame.bytes > kMaximumFrameBytes) return DecodedAudioStatus::MalformedData;
  if (!state_->window.at(frame.offset, frame.bytes, &bytes, &got))
    return DecodedAudioStatus::IoError;
  // Indexed at open, so a short read is a file that shrank since.
  if (got != frame.bytes) return DecodedAudioStatus::IoError;
  drmp3dec& decoder = state_->decoder;
  // dr_mp3 resynchronises by SEARCHING when it has no previous header, which
  // needs several frames of lookahead. Every frame here is already known to
  // be one, so a fresh decoder is handed its header instead: zeroed state
  // (what dr_mp3's own resync does) and the header it will compare against.
  // Also taken after a frame dr_mp3 rejected, which clears its header.
  if (!state_->primed || decoder.header[0] != 0xFF) {
    std::memset(&decoder, 0, sizeof(decoder));
    std::memcpy(decoder.header, bytes, kHeaderBytes);
    state_->primed = true;
  }
  drmp3dec_frame_info info{};
  const int samples = drmp3dec_decode_frame(&decoder, bytes, static_cast<int>(frame.bytes),
                                            interleaved, &info);
  const size_t total = static_cast<size_t>(layout.samplesPerFrame) * layout.channels;
  if (samples != static_cast<int>(layout.samplesPerFrame) || info.channels != layout.channels) {
    // A frame whose reservoir is missing (the first after a cut) decodes to
    // nothing; it still occupies its place in time, as it does in FFmpeg.
    std::fill(interleaved, interleaved + total, 0.0F);
  }
  return DecodedAudioStatus::Ok;
}

namespace {

class Mp3StreamingSource final : public StreamingAudioSource {
 public:
  explicit Mp3StreamingSource(int fd) noexcept : fd_(fd) {}
  ~Mp3StreamingSource() override { closeRawDescriptor(fd_); }

  Mp3StreamingSource(const Mp3StreamingSource&) = delete;
  Mp3StreamingSource& operator=(const Mp3StreamingSource&) = delete;

  [[nodiscard]] DecodedAudioStatus open(const StreamingAudioOpenOptions& options) {
    // The FLAC and WAV sources' refusal, for their reason: another rate must
    // be a refusal, never audio at the wrong one.
    if (options.requiredSampleRate != 0) return DecodedAudioStatus::InvalidArgument;
    if (options.sourceFormat != DecodedAudioSourceFormat::Auto &&
        options.sourceFormat != DecodedAudioSourceFormat::Mp3)
      return DecodedAudioStatus::UnsupportedFormat;
    if (fd_ < 0) return DecodedAudioStatus::IoError;
    const int64_t length = fileLength(fd_);
    if (length < 0) return DecodedAudioStatus::IoError;
    bytes_ = descriptorByteSource(&fd_, static_cast<uint64_t>(length));
    const DecodedAudioStatus parsed = parseMp3Layout(bytes_, DecodeCancellation{}, &layout_);
    if (parsed != DecodedAudioStatus::Ok) return parsed;
    if (layout_.frameCount == 0) return DecodedAudioStatus::MalformedData;

    info_.sampleRate = layout_.sampleRate;
    info_.channels = layout_.channels;
    info_.frameCount = layout_.frameCount;
    info_.frameCountFromContainer = layout_.frameCountFromContainer;
    info_.seekGranularityFrames = layout_.samplesPerFrame;
    info_.seekCost = SeekCost::RunUp;
    // Reserved here so a playing song never grows anything (the header's
    // rule): one frame staged, one frame of run-up scratch.
    const size_t frameSamples = static_cast<size_t>(layout_.samplesPerFrame) * layout_.channels;
    staged_.assign(frameSamples, 0.0F);
    decoder_ = std::make_unique<Mp3FrameDecoder>(bytes_);
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] const StreamingAudioInfo& info() const noexcept override { return info_; }

  [[nodiscard]] uint64_t position() const noexcept override { return position_; }

  [[nodiscard]] DecodedAudioStatus seek(uint64_t frame) override {
    if (decoder_ == nullptr) return DecodedAudioStatus::InvalidArgument;
    // Lazy: the run-up happens on the next read, which is cancellable and
    // reports I/O the way a read does. Beyond the end positions AT the end.
    position_ = std::min(frame, layout_.frameCount);
    needsRunUp_ = true;
    stagedBegin_ = stagedEnd_ = 0;
    pendingError_ = DecodedAudioStatus::Ok;
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] DecodedAudioStatus read(float* const* channels, size_t frames,
                                        size_t* framesRead) override {
    if (framesRead == nullptr) return DecodedAudioStatus::InvalidArgument;
    *framesRead = 0;
    if (channels == nullptr || decoder_ == nullptr) return DecodedAudioStatus::InvalidArgument;
    if (pendingError_ != DecodedAudioStatus::Ok) {
      const DecodedAudioStatus pending = pendingError_;
      pendingError_ = DecodedAudioStatus::Ok;
      return pending;
    }
    size_t written = 0;
    DecodedAudioStatus failure = DecodedAudioStatus::Ok;
    const uint16_t channelCount = layout_.channels;
    while (written < frames && position_ < layout_.frameCount) {
      if (stagedBegin_ == stagedEnd_) {
        if (cancel_.isRequested()) break;
        const DecodedAudioStatus status = refill();
        if (status == DecodedAudioStatus::Cancelled) break;
        if (status != DecodedAudioStatus::Ok) {
          failure = status;
          break;
        }
        continue;
      }
      const size_t take = static_cast<size_t>(std::min<uint64_t>(
          {static_cast<uint64_t>(stagedEnd_ - stagedBegin_), static_cast<uint64_t>(frames - written),
           layout_.frameCount - position_}));
      const float* src = staged_.data() + stagedBegin_ * channelCount;
      for (size_t i = 0; i < take; ++i)
        for (uint16_t c = 0; c < channelCount; ++c)
          channels[c][written + i] = src[i * channelCount + c];
      stagedBegin_ += take;
      written += take;
      position_ += take;
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
    // The frame index was built at open; the run-up is what a seek costs,
    // and no index can remove it.
    return DecodedAudioStatus::Ok;
  }

 private:
  // Stages the frame holding `position_`. After a seek (or at open) that
  // first decodes the run-up, discarding it, then drops the target frame's
  // leading samples.
  DecodedAudioStatus refill() {
    const uint64_t spf = layout_.samplesPerFrame;
    const uint64_t decodedAt = position_ + layout_.skipFront;
    const uint64_t target = decodedAt / spf;
    if (needsRunUp_) {
      const uint64_t start = mp3RunUpStart(layout_, target);
      decoder_->reset();
      for (uint64_t f = start; f < target; ++f) {
        if (cancel_.isRequested()) return DecodedAudioStatus::Cancelled;
        const DecodedAudioStatus s =
            decoder_->decode(layout_.frames[static_cast<size_t>(f)], layout_, staged_.data());
        if (s != DecodedAudioStatus::Ok) return s;
      }
      needsRunUp_ = false;
    }
    if (target >= layout_.frames.size()) return DecodedAudioStatus::MalformedData;
    const DecodedAudioStatus s =
        decoder_->decode(layout_.frames[static_cast<size_t>(target)], layout_, staged_.data());
    if (s != DecodedAudioStatus::Ok) {
      // The decoder's state no longer follows the file: the next read after
      // this error re-runs the run-up rather than decode from a gap.
      needsRunUp_ = true;
      return s;
    }
    stagedBegin_ = static_cast<size_t>(decodedAt % spf);
    stagedEnd_ = static_cast<size_t>(spf);
    return DecodedAudioStatus::Ok;
  }

  int fd_ = -1;
  MediaByteSource bytes_{};
  Mp3Layout layout_{};
  StreamingAudioInfo info_{};
  std::unique_ptr<Mp3FrameDecoder> decoder_;
  std::vector<float> staged_;  // one frame, interleaved
  size_t stagedBegin_ = 0;
  size_t stagedEnd_ = 0;
  uint64_t position_ = 0;
  bool needsRunUp_ = true;
  DecodedAudioStatus pendingError_ = DecodedAudioStatus::Ok;
  DecodeCancellation cancel_{};
};

}  // namespace

std::unique_ptr<StreamingAudioSource> openMp3StreamingSource(
    int fd, const StreamingAudioOpenOptions& options, DecodedAudioStatus* status) {
  auto set = [status](DecodedAudioStatus s) {
    if (status != nullptr) *status = s;
  };
  try {
    // Owns the descriptor from here: the destructor closes it on every refusal.
    auto source = std::make_unique<Mp3StreamingSource>(fd);
    const DecodedAudioStatus opened = source->open(options);
    if (opened != DecodedAudioStatus::Ok) {
      set(opened);
      return nullptr;
    }
    set(DecodedAudioStatus::Ok);
    return source;
  } catch (const std::bad_alloc&) {
    set(DecodedAudioStatus::ResourceExhausted);
    return nullptr;
  }
}

}  // namespace singz::media_internal
