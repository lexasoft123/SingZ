#pragma once
#include <array>
#include <atomic>
#include <cstdint>
#include <span>

namespace monitor_spike {
// One callback writer per instance. Control reads only after that writer joins.
// Fixed storage is supplied before start; overflow is explicit, never hidden.
enum DiagnosticFlag : uint32_t {
  Sample = 1, AnchorJump = 2, IntervalRejected = 4, HistoryReset = 8,
  AnchorCorrection = 16, MissingRead = 32, OutputDiscontinuity = 64, AppendFailure = 128, ArrivalJump = 256
};
struct DiagnosticRow {
  uint64_t ns{}, frame{}, expectedNs{}, historyDiscontinuities{}, callbackNs{};
  int64_t deltaNs{}, callbackDeltaNs{};
  uint32_t flags{}, expectedFrames{}, gotFrames{}, timestampQuality{};
  int64_t correctionNs{};
  double nominalHz{}, estimatedHz{}, queueBeforeMs{}, queueAfterMs{};
  // Read-reason counters are per-call deltas, not cumulative totals.
  uint64_t clockMissing{}, supportMissing{}, unpublished{}, expired{}, racing{};
};
struct Diagnostics {
  std::span<DiagnosticRow> rows;
  std::atomic<uint64_t>* outputTargetNs{};
  size_t used{};
  uint64_t dropped{}, previousNs{}, previousFrame{}, nextSampleNs{}, previousCallbackNs{};
  uint32_t previousFrames{};
  // Delta / previous nominal period: buckets of 1/64 period, [0,4),
  // bucket 256 >=4 periods, bucket 257 non-monotonic host time.
  std::array<uint64_t, 258> deltaHistogram{};
  void record(DiagnosticRow row, bool force = false) noexcept;
  void arrival(DiagnosticRow& row, uint64_t callbackNs, uint32_t quality) noexcept;
  DiagnosticRow interval(uint64_t ns, uint64_t frame, uint32_t frames, double rate) noexcept;
};
} // namespace monitor_spike
