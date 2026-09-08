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
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace singz {
namespace {

// The same descriptor handover `decoded_audio.cpp` performs, and for the same
// reason: the media layer never takes a path, and the descriptor must be
// closed on every failure path rather than leaked into a half-open decoder.
//
// Kept as a DESCRIPTOR with this source's own cursor, rather than as a FILE*
// walking the descriptor's shared one. Two sources over one file is the
// ordinary case here — playback seeks around a stem while the waveform pass
// reads it straight through — and `dup` shares an open file description, so a
// FILE* per source has them dragging each other's position about. Measured
// before this changed: the second source could not even open, because the
// first one's read had already carried the shared cursor past the signature.
int consumeAsDescriptor(OwnedFileDescriptor* descriptor) noexcept {
  if (descriptor == nullptr || !descriptor->valid()) return -1;
  const int raw = descriptor->release();
#if defined(_WIN32)
  if (_setmode(raw, _O_BINARY) == -1) {
    _close(raw);
    return -1;
  }
#endif
  return raw;
}

// One positioned read. Every read in this file goes through it, so the file
// position the kernel holds is never consulted and never moved.
//
// Windows has no pread and its _dup shares a position too; it seeks and reads,
// which is correct for ONE source and no worse than what it had. Nothing on
// Windows streams today, and a second source there would need overlapped IO.
int64_t readAt(int fd, void* buffer, size_t bytes, int64_t offset) noexcept {
  if (fd < 0) return -1;
#if defined(_WIN32)
  if (_lseeki64(fd, offset, SEEK_SET) < 0) return -1;
  return _read(fd, buffer, static_cast<unsigned int>(bytes));
#else
  return ::pread(fd, buffer, bytes, static_cast<off_t>(offset));
#endif
}

int64_t fileLength(int fd) noexcept {
  if (fd < 0) return -1;
#if defined(_WIN32)
  const int64_t at = _lseeki64(fd, 0, SEEK_CUR);
  const int64_t end = _lseeki64(fd, 0, SEEK_END);
  if (at >= 0) (void)_lseeki64(fd, at, SEEK_SET);
  return end;
#else
  struct stat info {};
  if (::fstat(fd, &info) != 0) return -1;
  return static_cast<int64_t>(info.st_size);
#endif
}

// Cheap signature check before libFLAC is handed the file, so an input that is
// simply another format is refused as such rather than coming back as damaged
// FLAC. The header promises the status says which, and a caller choosing
// between adapters acts on that difference. An ID3 tag before the magic is
// legal and common enough to skip.
bool looksLikeFlac(int fd, int64_t* start) {
  unsigned char head[10] = {0};
  if (readAt(fd, head, sizeof(head), 0) != static_cast<int64_t>(sizeof(head))) return false;
  int64_t at = 0;
  if (std::memcmp(head, "ID3", 3) == 0) {
    const int64_t tag = 10 + ((static_cast<int64_t>(head[6] & 0x7F) << 21) |
                              (static_cast<int64_t>(head[7] & 0x7F) << 14) |
                              (static_cast<int64_t>(head[8] & 0x7F) << 7) |
                              static_cast<int64_t>(head[9] & 0x7F));
    unsigned char magic[4] = {0};
    if (readAt(fd, magic, 4, tag) != 4 || std::memcmp(magic, "fLaC", 4) != 0) return false;
    at = tag;
  } else if (std::memcmp(head, "fLaC", 4) != 0) {
    return false;
  }
  if (start != nullptr) *start = at;
  return true;
}

// Frames libFLAC has handed over but the caller has not taken yet.
//
// APPEND, not overwrite, and that distinction is a bug this file shipped with:
// `FLAC__stream_decoder_process_single` can call the write callback MORE THAN
// ONCE. When libFLAC detects missing frames it synthesises silence to keep the
// stream sample-aligned (stream_decoder.c, "Check whether frames are missing")
// and delivers those writes before the real frame. A staging buffer that reset
// itself on every write kept only the LAST one, so a damaged file played back
// shifted by a whole block — 4096 frames, 92.9 ms — with `read()` still
// returning Ok. That is precisely the silent drift the interface's exactness
// contract exists to prevent.
struct Staging {
  std::vector<std::vector<float>> channels;
  size_t begin = 0;  // first unread frame
  size_t end = 0;    // one past the last written frame

  [[nodiscard]] size_t available() const noexcept { return end - begin; }
  void clear() noexcept { begin = end = 0; }
  void reserve(size_t channelCount, size_t frames) {
    channels.assign(channelCount, std::vector<float>(frames, 0.0F));
  }
  // Room for `extra` more frames after `end`, keeping what is unread.
  void grow(size_t channelCount, size_t extra) {
    if (channels.size() < channelCount) channels.resize(channelCount);
    const size_t need = end + extra;
    for (auto& plane : channels)
      if (plane.size() < need) plane.resize(need, 0.0F);
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
    if (fd_ >= 0) {
#if defined(_WIN32)
      _close(fd_);
#else
      ::close(fd_);
#endif
    }
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
    if (options.sourceFormat != DecodedAudioSourceFormat::Auto &&
        options.sourceFormat != DecodedAudioSourceFormat::Flac) {
      return DecodedAudioStatus::UnsupportedFormat;
    }
    if (!descriptor.valid()) return DecodedAudioStatus::InvalidArgument;

    fd_ = consumeAsDescriptor(&descriptor);
    if (fd_ < 0) return DecodedAudioStatus::IoError;
    if (!looksLikeFlac(fd_, &offset_)) return DecodedAudioStatus::UnsupportedFormat;
    length_ = fileLength(fd_);
    if (length_ < 0) return DecodedAudioStatus::IoError;

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
    if (!FLAC__stream_decoder_process_until_end_of_metadata(decoder_) || sawError_) {
      return DecodedAudioStatus::MalformedData;
    }
    if (info_.sampleRate == 0 || info_.channels == 0) return DecodedAudioStatus::MalformedData;

    info_.seekCost = sawSeekTable_ ? SeekCost::Indexed : SeekCost::Search;
    info_.frameCountFromContainer = info_.frameCount > 0;
    // One block is the floor — frames arrive whole, so a read of any size can
    // leave up to a full block staged — and the caller's window is taken when
    // it asks for more, so a filling thread does not grow buffers mid-song.
    const size_t floor = std::max<size_t>(info_.seekGranularityFrames, 4096);
    staging_.reserve(info_.channels, std::max<size_t>(floor, options.windowFrames));
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] const StreamingAudioInfo& info() const noexcept override { return info_; }

  [[nodiscard]] uint64_t position() const noexcept override { return position_; }

  [[nodiscard]] DecodedAudioStatus seek(uint64_t frame) override {
    if (decoder_ == nullptr) return DecodedAudioStatus::InvalidArgument;
    const uint64_t target = info_.frameCount > 0 ? std::min(frame, info_.frameCount) : frame;
    staging_.clear();
    sawError_ = false;
    pendingError_ = false;
    // libFLAC refuses to seek from ABORTED or SEEK_ERROR, so a source that has
    // hit either would fail its NEXT seek spuriously and only recover on the
    // one after. Flush first and the first seek works.
    const FLAC__StreamDecoderState state = FLAC__stream_decoder_get_state(decoder_);
    if (state == FLAC__STREAM_DECODER_ABORTED || state == FLAC__STREAM_DECODER_SEEK_ERROR) {
      FLAC__stream_decoder_flush(decoder_);
    }
    if (target == info_.frameCount && info_.frameCount > 0) {
      // Positioning at the end is legal and reads zero; libFLAC would refuse
      // to seek past the last sample.
      atEnd_ = true;
      broken_ = false;
      position_ = target;
      return DecodedAudioStatus::Ok;
    }
    if (!FLAC__stream_decoder_seek_absolute(decoder_, target)) {
      // Flushed so the decoder can be used again, but the file offset the
      // binary search stopped at is arbitrary — so the source is BROKEN until
      // a seek succeeds, rather than quietly readable from nowhere in
      // particular. `position_` is left alone: it is no longer true of the
      // decoder, and pretending otherwise is the drift this guards.
      FLAC__stream_decoder_flush(decoder_);
      broken_ = true;
      return DecodedAudioStatus::IoError;
    }
    atEnd_ = false;
    broken_ = false;
    position_ = target;
    return DecodedAudioStatus::Ok;
  }

  [[nodiscard]] DecodedAudioStatus read(float* const* channels, size_t frames,
                                        size_t* framesRead) override {
    if (framesRead == nullptr) return DecodedAudioStatus::InvalidArgument;
    *framesRead = 0;
    if (decoder_ == nullptr || channels == nullptr) return DecodedAudioStatus::InvalidArgument;

    // A source whose seek failed does not know where it is. Reading from it
    // would return plausible audio from an unknown offset while `position()`
    // reported the old one — a stem drifting against the other five, which
    // nothing downstream can detect. It stays broken until a seek succeeds.
    if (broken_) return DecodedAudioStatus::IoError;

    size_t written = 0;
    bool errored = false;
    while (written < frames) {
      if (staging_.available() == 0) {
        if (atEnd_) break;
        // Between blocks, not inside one: a decoded frame is bounded work and
        // abandoning it half way would leave the decoder mid-stream for the
        // next call. This is what lets a ring-fill thread stop when the singer
        // leaves the song rather than when the read finishes.
        if (cancel_.isRequested()) break;
        const bool got = decodeOneFrame();
        // Checked whether or not the decode "succeeded": libFLAC's
        // process_single loops past a bad frame and returns TRUE with the next
        // good one, so an error callback is the only evidence that something
        // was skipped. Consulting it only on failure is how this returned Ok
        // for three and a half seconds of shifted audio.
        if (sawError_) {
          errored = true;
          break;
        }
        if (!got) break;  // end of stream
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
    // ALWAYS, including on the error path: frames handed to the caller are
    // frames consumed, and a position that under-reports them drifts for the
    // rest of the song.
    position_ += written;
    *framesRead = written;
    // Partial data now, the error on the next call — the contract the
    // interface states, and the only shape that can report "here is what I
    // had, and then it went wrong" without throwing the good frames away.
    if (errored && written == 0) return DecodedAudioStatus::MalformedData;
    if (errored) pendingError_ = true;
    if (pendingError_ && written == 0) {
      pendingError_ = false;
      return DecodedAudioStatus::MalformedData;
    }
    return DecodedAudioStatus::Ok;
  }

  void setCancellation(const DecodeCancellation& cancel) override { cancel_ = cancel; }

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
  // Called only with staging drained, so compacting to zero keeps nothing —
  // it just stops `end` walking off the end of a long song.
  bool decodeOneFrame() {
    staging_.clear();
    if (FLAC__stream_decoder_get_state(decoder_) == FLAC__STREAM_DECODER_END_OF_STREAM) {
      atEnd_ = true;
      return false;
    }
    sawError_ = false;
    if (!FLAC__stream_decoder_process_single(decoder_)) {
      sawError_ = true;
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
    const int64_t got = readAt(self->fd_, buffer, *bytes, self->offset_);
    if (got < 0) {
      *bytes = 0;
      return FLAC__STREAM_DECODER_READ_STATUS_ABORT;
    }
    self->offset_ += got;
    *bytes = static_cast<size_t>(got);
    if (got == 0)
      return FLAC__STREAM_DECODER_READ_STATUS_END_OF_STREAM;
    return FLAC__STREAM_DECODER_READ_STATUS_CONTINUE;
  }

  static FLAC__StreamDecoderSeekStatus seekCb(const FLAC__StreamDecoder*,
                                              FLAC__uint64 offset, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    self->offset_ = static_cast<int64_t>(offset);
    return FLAC__STREAM_DECODER_SEEK_STATUS_OK;
  }

  static FLAC__StreamDecoderTellStatus tellCb(const FLAC__StreamDecoder*,
                                              FLAC__uint64* offset, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    *offset = static_cast<FLAC__uint64>(self->offset_);
    return FLAC__STREAM_DECODER_TELL_STATUS_OK;
  }

  static FLAC__StreamDecoderLengthStatus lengthCb(const FLAC__StreamDecoder*,
                                                  FLAC__uint64* length, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    if (self->length_ < 0) return FLAC__STREAM_DECODER_LENGTH_STATUS_ERROR;
    *length = static_cast<FLAC__uint64>(self->length_);
    return FLAC__STREAM_DECODER_LENGTH_STATUS_OK;
  }

  static FLAC__bool eofCb(const FLAC__StreamDecoder*, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    return self->length_ >= 0 && self->offset_ >= self->length_ ? 1 : 0;
  }

  static FLAC__StreamDecoderWriteStatus writeCb(const FLAC__StreamDecoder*,
                                                const FLAC__Frame* frame,
                                                const FLAC__int32* const buffer[], void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    const unsigned channels = frame->header.channels;
    const unsigned blocksize = frame->header.blocksize;
    if (channels != self->info_.channels) {
      self->sawError_ = true;
      return FLAC__STREAM_DECODER_WRITE_STATUS_ABORT;
    }
    // Whole after a straight read, SHORTER after a seek — libFLAC delivers the
    // tail of the containing frame starting at the requested sample. Either
    // way the block size is whatever the header says, never assumed.
    //
    // APPENDED after whatever is already staged, because one `process_single`
    // can produce several of these (see Staging).
    self->staging_.grow(channels, blocksize);
    // 2^(bps-1): the same scale the WAV reader and readFlacMono apply.
    const float scale = 1.0F / static_cast<float>(1u << (frame->header.bits_per_sample - 1));
    for (unsigned c = 0; c < channels; c++) {
      float* dst = self->staging_.channels[c].data() + self->staging_.end;
      const FLAC__int32* src = buffer[c];
      for (unsigned i = 0; i < blocksize; i++) dst[i] = static_cast<float>(src[i]) * scale;
    }
    self->staging_.end += blocksize;
    return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
  }

  static void metaCb(const FLAC__StreamDecoder*, const FLAC__StreamMetadata* meta, void* client) {
    auto* self = static_cast<FlacStreamingSource*>(client);
    if (meta->type == FLAC__METADATA_TYPE_SEEKTABLE) {
      // PLACEHOLDER points do not count. A table may legally be padded with
      // points whose sample number is all-ones, reserved for an encoder that
      // will fill them in later; a source that counted those would report
      // Indexed and then seek like Search, which is worse than admitting
      // Search — a caller reads this to decide whether to coalesce scrubs.
      self->sawSeekTable_ = false;
      for (unsigned i = 0; i < meta->data.seek_table.num_points; i++) {
        if (meta->data.seek_table.points[i].sample_number != ~FLAC__uint64{0}) {
          self->sawSeekTable_ = true;
          break;
        }
      }
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
    static_cast<FlacStreamingSource*>(client)->sawError_ = true;
  }

  // This source's OWN position in the file. Never the descriptor's: two
  // sources routinely share one, and the kernel holds only one cursor for it.
  int fd_ = -1;
  int64_t offset_ = 0;
  int64_t length_ = -1;
  FLAC__StreamDecoder* decoder_ = nullptr;
  StreamingAudioInfo info_{};
  Staging staging_{};
  uint64_t position_ = 0;
  // Set by the error callback during one decode, read straight after it.
  bool sawError_ = false;
  // An error already reported partial data; the next empty read returns it.
  bool pendingError_ = false;
  // A seek failed and the decoder's position is unknown. Reads refuse.
  bool broken_ = false;
  bool atEnd_ = false;
  DecodeCancellation cancel_{};
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
