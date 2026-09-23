#pragma once

// What the desktop's open needs from a lane, measured off the FILE.
//
// Until this existed the desktop decoded every lane through Chromium before a
// song was on screen, for exactly three things: the lane's length, the
// picture of it, and whether a guitar/piano lane was silent — then handed the
// samples to a native graph that had already read the same file itself, and
// let them go a few seconds after Play. Six lanes of a five-minute song is
// ~750 MB of PCM decoded for a duration and a drawing.
//
// This reads the lane ONCE through the same streaming source the graph plays
// from, in blocks, and keeps three statistics and the header:
//
//   - `peaks`: the desktop's lane waveform — per-bucket max |x| over the first
//     two channels, the bucket count the renderer's `bucketsFor` would choose
//     for this length, UNNORMALIZED (`computePeaks` in
//     src/renderer/src/audio/peaks.ts scales; that is a drawing decision).
//     The partition is computePeaks' own, floor(b * frames / buckets), so the
//     two pictures agree bucket for bucket.
//   - `envelope`: the phones' seek-bar statistic, 96 buckets of RMS over every
//     channel, `summarizeLanePeaks`' partition. It travels: the desktop writes
//     it into project.json so a phone draws its bar without decoding.
//   - `rms`: the whole lane's RMS over every channel and every frame. The open
//     hides a guitar or piano lane whose RMS is under a threshold; it used to
//     measure a strided sample of channel 0 of the decoded buffer, and a
//     silent lane is silent either way.
//
// Nothing here is retained past the return: the samples go through a block
// buffer and out. A lane the streaming source cannot open (today: anything
// that is not FLAC, WAV or MP3) comes back `ok == false` with the status, and the caller
// decodes that one lane the old way — a refusal degrades one lane, never the
// song.

#include <zcore/media/decoded_audio.h>

#include <array>
#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

namespace singz {

// Matches kNativePlaybackLaneSummaryBuckets; a static_assert in
// lane_measure.cpp keeps the two honest without this header depending on
// the session.
inline constexpr size_t kLaneMeasureEnvelopeBuckets = 96;

// Upper bound on the lanes one call measures — the graph's own lane bound.
inline constexpr size_t kLaneMeasureMaximumLanes = 16;

// `bucketsFor` from peaks.ts, expressed as numbers the caller passes rather
// than constants compiled in here: the renderer owns how fine its waveform is.
//   buckets = clamp(round(durationSeconds * peaksPerSecond), minimumPeaks, maximumPeaks)
struct LaneMeasurePolicy {
  uint32_t peaksPerSecond{1000};
  uint32_t minimumPeaks{2400};
  uint32_t maximumPeaks{400000};
};

struct LaneMeasureRequest {
  std::string id;
  OwnedFileDescriptor descriptor;
  LaneMeasurePolicy policy;
};

struct LaneMeasure {
  std::string id;
  bool ok{false};
  DecodedAudioStatus status{DecodedAudioStatus::InvalidArgument};
  uint32_t sampleRate{0};
  uint32_t channels{0};
  // The container's frame count (STREAMINFO for FLAC). A truncated file
  // declares its original length there; the statistics cover what could be
  // read and the rest of the buckets stay zero.
  uint64_t frameCount{0};
  double durationSeconds{0.0};
  float rms{0.0F};
  std::vector<float> peaks;
  std::array<float, kLaneMeasureEnvelopeBuckets> envelope{};
};

// The bucket count computePeaks would choose for this length under `policy`.
[[nodiscard]] uint32_t laneMeasurePeakBuckets(
    double durationSeconds, const LaneMeasurePolicy& policy) noexcept;

// One lane, on the calling thread. `cancel` is polled between blocks; a
// cancelled lane reports DecodedAudioStatus::Cancelled and nothing else.
[[nodiscard]] LaneMeasure measureLane(LaneMeasureRequest request,
                                      const DecodeCancellation& cancel) noexcept;

// Every lane, each on a thread of its own (the decode dominates and the
// files are independent), results in request order. A thread that cannot be
// created measures its lane on the calling thread instead — slower, never
// wrong.
[[nodiscard]] std::vector<LaneMeasure> measureLanes(
    std::vector<LaneMeasureRequest> requests,
    const DecodeCancellation& cancel) noexcept;

}  // namespace singz
