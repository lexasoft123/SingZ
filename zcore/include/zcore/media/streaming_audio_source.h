#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

#include <zcore/media/decoded_audio.h>

// A format-agnostic window onto an encoded audio file.
//
// INTERFACE ONLY — nothing implements this yet. It exists so the streaming
// work (docs/FLAC-STREAMING-RESEARCH.md) is designed against a shape that MP3,
// AAC and WAV can meet, rather than against FLAC's conveniences. Writing it
// first is cheap; discovering after a FLAC implementation that the interface
// assumed independently-decodable frames is not.
//
// The premise: today `DecodedBufferSource` reads a view over the WHOLE decoded
// song, which costs ~1.3 s of every phone open and ~141 MB per song resident.
// A streaming source reads a moving window instead. What follows is what a
// decoder thread needs to keep that window filled, and nothing more.
//
// WHERE THIS RUNS, and it is not negotiable: on an ordinary worker thread that
// fills a ring buffer. Never on the audio callback. Every method here may
// allocate, block on I/O, and take milliseconds; the callback reads only from
// the ring. An implementation that is fast enough to tempt someone into
// calling `read()` from the callback is still forbidden from it, because the
// next format's implementation will not be.
namespace singz {

// What a caller must know to decide HOW to drive a source, without knowing
// which format it is.
enum class SeekCost : uint8_t {
  // The container or an index maps sample -> byte directly. A scrub can seek
  // every frame it likes. FLAC WITH a seektable, WAV, AAC in MP4.
  Indexed,
  // Seeking means searching the file — libFLAC's interpolating binary search
  // over frame headers when no SEEKTABLE is present, which is what SingZ's own
  // stems currently force (they carry STREAMINFO and a comment, nothing else).
  // Correct, but the wrong cost to pay per frame of a drag: a scrubbing UI
  // should coalesce seeks, or the source should be asked to build an index.
  Search,
  // The format cannot land on an exact sample without decoding from an earlier
  // point — MP3's bit reservoir means frames are not independently decodable,
  // so the adapter decodes a short run-up and discards it. Sample-exactness is
  // still GUARANTEED (see below); only the cost differs.
  RunUp,
};

// Everything the graph needs about a source.
//
// Read at open, and again after `buildSeekIndex()` — which is the one thing
// that can change it, by turning `seekCost` from Search into Indexed. Read on
// the same thread that drives `read()` and `seek()`; nothing here is atomic.
struct StreamingAudioInfo {
  uint32_t sampleRate{0};
  uint16_t channels{0};
  // Frames of REAL audio, with any encoder delay and padding already excluded
  // (see the exactness contract below). Zero when the container does not say
  // and the source has not been asked to find out.
  uint64_t frameCount{0};
  bool frameCountIsExact{false};
  // The granularity a seek lands on before the adapter decodes forward to the
  // requested sample. FLAC's is its block size — 4096 samples, 92.9 ms at
  // 44.1 kHz, for every stem this app writes. Informational: `seek()` is
  // sample-exact regardless, and this only says what it costs.
  uint32_t seekGranularityFrames{0};
  SeekCost seekCost{SeekCost::Search};
};

// THE EXACTNESS CONTRACT, and the reason this interface exists at all.
//
// Frame N means the same audio in every implementation. The caller does
// arithmetic on frame numbers — the positioned-source mapping, A-B loops,
// count-in pre-roll at NEGATIVE project frames — and must never learn that one
// format numbers its samples differently from another.
//
// So each adapter absorbs its own format's dishonesty:
//   - MP3 carries encoder delay and end padding (LAME/Xing `Info`). The
//     adapter subtracts both; frame 0 is the first sample the singer recorded,
//     not the first sample the decoder emits.
//   - MP3 frames depend on the previous ones through the bit reservoir, so a
//     seek decodes a run-up and discards it. That is the adapter's business.
//   - AAC has its own priming; the container's edit list is authoritative.
//   - FLAC has neither problem, which is exactly why designing against FLAC
//     alone would have produced an interface the others cannot meet.
//
// An adapter that cannot honour this must fail to open rather than return
// audio that is a few milliseconds out. A stem a few milliseconds out is a
// stem that drifts against the other five, and nothing downstream can detect
// it.
class StreamingAudioSource {
 public:
  virtual ~StreamingAudioSource() = default;

  [[nodiscard]] virtual const StreamingAudioInfo& info() const noexcept = 0;

  // Position the next `read()` at an exact frame. Frames beyond the end
  // position at the end; `read()` then returns zero.
  //
  // WHEN THE END IS NOT KNOWN — `frameCount == 0`, which is an MP3 without a
  // Xing or VBRI header — "beyond the end" cannot be detected up front. Such a
  // source positions at the last frame it can reach and lets `read()` discover
  // the end, rather than refusing a seek it cannot judge.
  [[nodiscard]] virtual DecodedAudioStatus seek(uint64_t frame) = 0;

  // Fill up to `frames` of PLANAR float, one pointer per channel, and report
  // how many were written. A short read means the end of the source, never a
  // hiccup: a source that needs to wait for I/O waits.
  //
  // PARTIAL DATA THEN AN ERROR is reported across two calls, and this is not a
  // stylistic choice. A read that hits damage part way has real frames in hand
  // and a problem to report; returning the error immediately throws those
  // frames away, and returning them with `Ok` hides the problem. So: this call
  // returns `Ok` with what it has, and the NEXT call returns the error with
  // `framesRead == 0`. A caller that stops at the first non-Ok status
  // therefore loses nothing.
  //
  // `framesRead` counts frames the caller may keep, and `position()` advances
  // by exactly that, on every path including the error one. A position that
  // under-reports what it handed over drifts for the rest of the song.
  //
  // Planar because that is what the graph's source node consumes, and
  // converting once here is cheaper than converting per callback.
  //
  // The caller owns the memory. An implementation must not FAIL on allocation
  // part way through a song — reserve in `open` — but "never allocates" is the
  // wrong requirement to write down: an ffmpeg or mpg123 adapter has packet
  // and resampler state of its own, and the rule that matters is that a song
  // already playing cannot run out.
  [[nodiscard]] virtual DecodedAudioStatus read(float* const* channels,
                                                size_t frames,
                                                size_t* framesRead) = 0;

  // Where the next read begins. Same thread as `read()` and `seek()` — not
  // published for a UI to poll, and not atomic.
  //
  // After a FAILED seek this is not meaningful and the source says so by
  // refusing to read: a decoder left wherever a binary search stopped would
  // otherwise hand back plausible audio from an unknown offset while this
  // still reported the old position, which is one stem drifting against the
  // other five with nothing downstream able to see it.
  [[nodiscard]] virtual uint64_t position() const noexcept = 0;

  // Build whatever index makes `seekCost` Indexed, if this source can. Costs
  // one pass over the file and is worth it for a song about to be scrubbed;
  // pointless for one about to be played once through. Sources that are
  // already Indexed return Ok and do nothing. Cancellable, because on a phone
  // this may be running while the singer changes their mind.
  //
  // This is how a FLAC without a SEEKTABLE stops being expensive to scrub
  // WITHOUT rewriting the file — which matters because every stem this app has
  // already written lacks one.
  [[nodiscard]] virtual DecodedAudioStatus buildSeekIndex(
      const DecodeCancellation& cancel) = 0;
};

// What a caller asks for, independent of format.
struct StreamingAudioOpenOptions {
  // What the caller already knows the container to be. `Auto` sniffs content,
  // which is right for a trusted stem and wrong in general: MP3 has no
  // reliable magic — an ID3 tag is optional and a frame sync matches inside
  // arbitrary data — so an adapter for it needs to be told. Matches the hint
  // `prepareDecodedAudio` already takes, and for the same reason.
  DecodedAudioSourceFormat sourceFormat{DecodedAudioSourceFormat::Auto};
  // Zero keeps the source's own rate. Non-zero resamples inside the adapter,
  // so the caller sees one rate across six lanes whatever the files hold.
  // (Measured before this was written: a resample costs ~60% on top of the
  // decode at soxr quality and nothing at swr quality, against a decode that
  // runs at ~980x realtime. It is not the reason anything is slow.)
  uint32_t requiredSampleRate{0};
  // Reserve for a window this long. The floor is not the audio callback's
  // block but the TIME-STRETCHER's lookahead, which consumes ahead of the
  // playhead — the ring must stay ahead of the stretcher, not of the callback.
  uint32_t windowFrames{0};
  bool buildSeekIndexOnOpen{false};
};

// Opens by sniffing content, not by file extension — this codebase has been
// bitten by a FLAC named `.wav` answering plausibly and wrongly
// (`zcore/media/flac_io.h`). Null on an unsupported or unreadable source; the
// status says which.
//
// Takes the descriptor the way `prepareDecodedAudio` does, so authorization
// stays where it already is and no new path-opening appears in the core.
[[nodiscard]] std::unique_ptr<StreamingAudioSource> openStreamingAudioSource(
    OwnedFileDescriptor descriptor, const StreamingAudioOpenOptions& options,
    DecodedAudioStatus* status);

}  // namespace singz
