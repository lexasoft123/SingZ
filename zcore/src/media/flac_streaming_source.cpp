// A StreamingAudioSource over libFLAC — a moving window onto a FLAC file
// instead of the whole song decoded up front.
//
// See docs/FLAC-STREAMING-RESEARCH.md for why: the decode is ~980x realtime on
// one thread, so six lanes in realtime cost well under 1% of a core. Decoding
// the WHOLE song is what costs ~1.3 s of every phone open and ~141 MB resident.
//
// NOT WIRED INTO THE GRAPH. This is the source plus its tests and a benchmark;
// the realtime node that consumes it is the next step, and the interface
// header says what that node may and may not do (never on the audio callback).
//
// One thing libFLAC makes the caller's problem, and one it does NOT — the
// second measured rather than assumed, because the first version of this file
// assumed wrong:
//
//   1. Frames arrive whole. A `read()` for fewer frames than a block leaves a
//      remainder that the next `read()` must consume before decoding more.
//   2. Seeking is ALREADY sample-exact. This file was written expecting
//      `seek_absolute` to land on the frame CONTAINING the target, leaving the
//      caller to drop up to a block of run-in (4096 frames, 92.9 ms here) — the
//      standard hazard. It does not: after a seek libFLAC hands over a
//      SHORTENED frame whose header reports the target itself. Instrumented
//      across seven targets deliberately off block boundaries (1, 4095, 4096,
//      4097, 10000, 123457, last), the run-in was zero every time.
//
//      The drop logic that assumed otherwise is gone. What caught it was a
//      negative control: breaking the drop changed nothing, which meant either
//      the tests missed it or the code was dead. It was dead. The seek cases in
//      `flac_streaming_source_tests.cpp` compare against a full decode, so if a
//      future libFLAC ever does leave the run-in, they fail rather than drift.
#include <zcore/media/streaming_audio_source.h>

#include <zcore/base/file_compat.h>

#include <FLAC/stream_decoder.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <vector>

#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <unistd.h>
#endif

namespace singz {
namespace {

// The same descriptor handover `decoded_audio.cpp` performs, and for the same
// reason: the media layer never takes a path, and the descriptor must be
// closed on every failure path rather than leaked into a half-open decoder.
std::FILE* consumeAsFile(OwnedFileDescriptor* descriptor) noexcept {
  if (descriptor == nullptr || !descriptor->valid()) return nullptr;
  const int raw = descriptor->release();
#if defined(_WIN32)
  if (_setmode(raw, _O_BINARY) == -1) {
    _close(raw);
    return nullptr;
  }
  std::FILE* file = _fdopen(raw, "rb");
  if (file == nullptr) _close(raw);
#else
  std::FILE* file = fdopen(raw, "rb");
  if (file == nullptr) close(raw);
#endif
  return file;
}

// Interleaved-by-channel staging for frames libFLAC has handed over but the
// caller has not taken yet.
struct Staging {
  std::vector<std::vector<float>> channels;
  size_t begin = 0;  // first unread frame
  size_t end = 0;    // one past the last written frame

  [[nodiscard]] size_t available() const noexcept { return end - begin; }
  void clear() noexcept { begin = end = 0; }
  void reserve(size_t channelCount, size_t frames) {
    channels.assign(channelCount, std::vector<float>(frames, 0.0F));
  }
};

class FlacStreamingSource final : public StreamingAudioSource {
 public:
  FlacStreamingSource() = default;
  ~FlacStreamingSource() override {
    if (decoder_ != nullptr) {
      FLAC__stream_decoder_finish(decoder_);
      FLAC__stream_decoder_delete(decoder_);
    }
    if (file_ != nullptr) std::fclose(file_);
  }

  FlacStreamingSource(const FlacStreamingSource&) = delete;
  FlacStreamingSource& operator=(const FlacStreamingSource&) = delete;

  [[nodiscard]] DecodedAudioStatus open(OwnedFileDescriptor descriptor,
                                        const StreamingAudioOpenOptions& options) {
    // Resampling is NOT implemented here. The graph asks for the output
    // device's rate today, so a caller that needs one will have to resample
    // outside or this source will have to grow one — and it must be a refusal
    // rather than silently wrong-rate audio, which would drift one stem
    // against the other five.
    if (options.requiredSampleRate != 0) return DecodedAudioStatus::InvalidArgument;
    if (!descriptor.valid()) return DecodedAudioStatus::InvalidArgument;

    file_ = consumeAsFile(&descriptor);
    if (file_ == nullptr) return DecodedAudioStatus::IoError;

    decoder_ = FLAC__stream_decoder_new();
    if (decoder_ == nullptr) return DecodedAudioStatus::ResourceExhausted;
    // The metadata we want is STREAMINFO, and only that: responding to
    // everything means paying to parse pictures a stem will never carry.
    FLAC__stream_decoder_set_metadata_ignore_all(decoder_);
    FLAC__stream_decoder_set_metadata_respond(decoder_, FLAC__METADATA_TYPE_STREAMINFO);
    FLAC__stream_decoder_set_metadata_respond(decoder_, FLAC__METADATA_TYPE_SEEKTABLE);

    if (FLAC__stream_decoder_init_stream(decoder_, readCb, seekCb, tellCb, lengthCb, eofCb,
                                         writeCb, metaCb, errorCb,
                                         this) != FLAC__STREAM_DECODER_INIT_STATUS_OK) {
      return DecodedAudioStatus::UnsupportedFormat;
    }
    if (!FLAC__stream_decoder_process_until_end_of_metadata(decoder_) || failed_) {
      return DecodedAudioStatus::MalformedData;
    }
    if (info_.sampleRate == 0 || info_.channels == 0) return DecodedAudioStatus::MalformedData;

    info_.seekCost = sawSeekTable_ ? SeekCost::Indexed : SeekCost::Search;
    info_.frameCountIsExact = info_.frameCount > 0;
    // One block of headroom is the floor: frames arrive whole, so a read of
    // any size can leave up to a full block staged.
    staging_.reserve(info_.channels, std::max<size_t>(info_.seekGranularityFrames, 4096));
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] const StreamingAudioInfo& info() const noexcept override { return info_; }

  [[nodiscard]] uint64_t position() const noexcept override { return position_; }

  [[nodiscard]] DecodedAudioStatus seek(uint64_t frame) override {
    if (decoder_ == nullptr) return DecodedAudioStatus::InvalidArgument;
    const uint64_t target = info_.frameCount > 0 ? std::min(frame, info_.frameCount) : frame;
    staging_.clear();
    failed_ = false;
    if (target == info_.frameCount && info_.frameCount > 0) {
      // Positioning at the end is legal and reads zero; libFLAC would refuse
      // to seek past the last sample.
      atEnd_ = true;
      position_ = target;
      return DecodedAudioStatus::Ok;
    }
    if (!FLAC__stream_decoder_seek_absolute(decoder_, target)) {
      // A failed seek leaves the decoder in the SEEK_ERROR state and it must
      // be flushed before it will decode again — otherwise every later read
      // fails and the lane goes silent for the rest of the song.
      FLAC__stream_decoder_flush(decoder_);
      return DecodedAudioStatus::IoError;
    }
    atEnd_ = false;
    position_ = target;
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] DecodedAudioStatus read(float* const* channels, size_t frames,
                                        size_t* framesRead) override {
    if (framesRead == nullptr) return DecodedAudioStatus::InvalidArgument;
    *framesRead = 0;
    if (decoder_ == nullptr || channels == nullptr) return DecodedAudioStatus::InvalidArgument;

    size_t written = 0;
    while (written < frames) {
      if (staging_.available() == 0) {
        if (atEnd_) break;
        if (!decodeOneFrame()) {
          if (failed_) return DecodedAudioStatus::MalformedData;
          break;  // end of stream
        }
        continue;
      }
      const size_t take = std::min(frames - written, staging_.available());
      for (uint16_t c = 0; c < info_.channels; c++) {
        const float* src = staging_.channels[c].data() + staging_.begin;
        std::memcpy(channels[c] + written, src, take * sizeof(float));
      }
      staging_.begin += take;
      written += take;
    }
    position_ += written;
    *framesRead = written;
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] DecodedAudioStatus buildSeekIndex(const DecodeCancellation&) override {
    // Not implemented. Building a real index means a pass over the frame
    // headers — the same work as writing a SEEKTABLE, and the same reason it
    // is not urgent: libFLAC's interpolating binary search is correct without
    // one, only slower per seek, and nothing scrubs a streamed lane yet.
    // Reporting Ok while leaving `seekCost` at Search is the honest answer:
    // the caller asked for an index and did not get one, and `info()` still
    // says so.
    return DecodedAudioStatus::Ok;
  }

 private:
  bool decodeOneFrame() {
    staging_.clear();
    if (FLAC__stream_decoder_get_state(decoder_) == FLAC__STREAM_DECODER_END_OF_STREAM) {
      atEnd_ = true;
      return false;
    }
    if (!FLAC__stream_decoder_process_single(decoder_)) {
      failed_ = true;
      return false;
    }
    if (FLAC__stream_decoder_get_state(decoder_) == FLAC__STREAM_DECODER_END_OF_STREAM &&
        staging_.available() == 0) {
      atEnd_ = true;
      return false;
    }
    return staging_.available() > 0;
  }

  // ---- libFLAC callbacks ---------------------------------------------------

  static FLAC__StreamDecoderReadStatus readCb(const FLAC__StreamDecoder*, FLAC__byte buffer[],
                                              size_t* bytes, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    if (*bytes == 0) return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    const size_t got = std::fread(buffer, 1, *bytes, self->file_);
    *bytes = got;
    if (got == 0) {
      return std::feof(self->file_) ? FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM
                                    : FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    }
    return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
  }

  static FLAC__StreamDecoderSeekStatus seekCb(const FLAC__StreamDecoder*,
                                              FLAC__uint64 offset, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    return fseeko(self->file_, static_cast<int64_t>(offset), SEEK_SET) == 0
               ? FLAC__STREAM_DECODER_SEEK_STATUS_OK
               : FLAC__STREAM_DECODER_SEEK_STATUS_ERROR;
  }

  static FLAC__StreamDecoderTellStatus tellCb(const FLAC__StreamDecoder*,
                                              FLAC__uint64* offset, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    const int64_t at = ftello(self->file_);
    if (at < 0) return FLAC__STREAM_DECODER_TELL_STATUS_ERROR;
    *offset = static_cast<FLAC__uint64>(at);
    return FLAC__STREAM_DECODER_TELL_STATUS_OK;
  }

  static FLAC__StreamDecoderLengthStatus lengthCb(const FLAC__StreamDecoder*,
                                                  FLAC__uint64* length, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    const int64_t at = ftello(self->file_);
    if (at < 0 || fseeko(self->file_, 0, SEEK_END) != 0)
      return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
    const int64_t size = ftello(self->file_);
    if (size < 0 || fseeko(self->file_, at, SEEK_SET) != 0)
      return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
    *length = static_cast<FLAC__uint64>(size);
    return FLAC__STREAM_DECODER_LENGTH_STATUS_OK;
  }

  static FLAC__bool eofCb(const FLAC__StreamDecoder*, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    return std::feof(self->file_) ? 1 : 0;
  }

  static FLAC__StreamDecoderWriteStatus writeCb(const FLAC__StreamDecoder*,
                                                const FLAC__Frame* frame,
                                                const FLAC__int32* const buffer[], void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    const unsigned channels = frame->header.channels;
    const unsigned blocksize = frame->header.blocksize;
    if (channels != self->info_.channels) {
      self->failed_ = true;
      return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    // Whole after a straight read, SHORTER after a seek — libFLAC delivers the
    // tail of the containing frame starting at the requested sample. Either
    // way the block size is whatever the header says, never assumed.
    const unsigned keep = blocksize;
    if (self->staging_.channels.size() < channels ||
        self->staging_.channels[0].size() < keep) {
      for (auto& plane : self->staging_.channels) plane.assign(keep, 0.0F);
      if (self->staging_.channels.size() < channels)
        self->staging_.channels.resize(channels, std::vector<float>(keep, 0.0F));
    }
    // 2^(bps-1): the same scale the WAV reader and readFlacMono apply.
    const float scale = 1.0F / static_cast<float>(1u << (frame->header.bits_per_sample - 1));
    for (unsigned c = 0; c < channels; c++) {
      float* dst = self->staging_.channels[c].data();
      const FLAC__int32* src = buffer[c];
      for (unsigned i = 0; i < keep; i++) dst[i] = static_cast<float>(src[i]) * scale;
    }
    self->staging_.begin = 0;
    self->staging_.end = keep;
    return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
  }

  static void metaCb(const FLAC__StreamDecoder*, const FLAC__StreamMetadata* meta, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    if (meta->type == FLAC__METADATA_TYPE_SEEKTABLE) {
      self->sawSeekTable_ = meta->data.seek_table.num_points > 0;
      return;
    }
    if (meta->type != FLAC__METADATA_TYPE_STREAMINFO) return;
    const auto& si = meta->data.stream_info;
    self->info_.sampleRate = si.sample_rate;
    self->info_.channels = static_cast<uint16_t>(si.channels);
    self->info_.frameCount = si.total_samples;
    self->info_.seekGranularityFrames = si.max_blocksize;
  }

  static void errorCb(const FLAC__StreamDecoder*, FLAC__StreamDecoderErrorStatus, void* client) {
    static_cast<FlacStreamingSource*>(client)->failed_ = true;
  }

  std::FILE* file_ = nullptr;
  FLAC__StreamDecoder* decoder_ = nullptr;
  StreamingAudioInfo info_{};
  Staging staging_{};
  uint64_t position_ = 0;
  bool failed_ = false;
  bool atEnd_ = false;
  bool sawSeekTable_ = false;
};

}  // namespace

std::unique_ptr<StreamingAudioSource> openStreamingAudioSource(
    OwnedFileDescriptor descriptor, const StreamingAudioOpenOptions& options,
    DecodedAudioStatus* status) {
  auto set = [status](DecodedAudioStatus s) {
    if (status != nullptr) *status = s;
  };
  auto source = std::make_unique<FlacStreamingSource>();
  const DecodedAudioStatus opened = source->open(std::move(descriptor), options);
  if (opened != DecodedAudioStatus::Ok) {
    set(opened);
    return nullptr;
  }
  set(DecodedAudioStatus::Ok);
  return source;
}

}  // namespace singz
