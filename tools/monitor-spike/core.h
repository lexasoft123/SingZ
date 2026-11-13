#pragma once
#include <zcore/routing/audio_history.h>
#include <zcore/device/audio_host_render.h>
#include <zcore/audio/capture_block.h>
#include <array>
#include <span>

namespace monitor_spike {
constexpr uint32_t capacity = 32768, maximum = singz::kAudioHostMaxFrames;
uint64_t frameNs(uint64_t frames, double rate) noexcept;
// LoopZ monitor_outputs.cpp: max(lookback, ceil(2*period*source/output)+256).
uint32_t queueFloor(double sourceRate, double outputRate, uint32_t period,
                    uint32_t lookback, uint32_t quantum = 256) noexcept;
// Port of LoopZ OutputClock, overlapping 25–50ms observations, +/-0.5% bounds.
class OutputClock {
 public:
  double observe(uint64_t frame, uint64_t ns, uint32_t frames, double nominal,
                 bool discontinuity = false) noexcept;
  void reset() noexcept;
 private:
  uint64_t previousFrame_{}, previousNs_{}, originFrame_{}, originNs_{}, recentFrame_{}, recentNs_{};
  uint32_t previousFrames_{};
  double nominalRate_{};
};
struct Moments {
  uint64_t n{};
  double mean{}, m2{}, minimum{}, maximum{};
  void add(double x) noexcept;
  double deviation() const noexcept;
};
struct Anchor {
  uint64_t previous{}, jumps{}, inferredMissing{};
  uint32_t frames{};
  void observe(uint64_t ns, uint32_t count, double rate, bool measured) noexcept;
};
struct Point { uint64_t ns{}; float value{}; uint32_t blockFrames{}; };
// Prepared spans: one serial writer, inspected only after it has joined.
struct Recording {
  std::span<Point> points;
  size_t used{};
  uint64_t begin{}, end{};
  bool hardwareTimestamps{true};
  void append(const float* samples, uint32_t frames, uint64_t ns, double rate) noexcept;
};
struct Capture {
  zcore::routing::AudioHistory* history{};
  Recording* recording{};
  double rate{};
  uint64_t measureBegin{}, measureEnd{}, frame{}, unknown{}, estimated{}, callbacks{}, appendFailures{}, invalid{};
  bool virtualSource{};
  Anchor anchor;
  std::array<float, maximum> scratch{};
  static bool push(void*, const float*, uint32_t, uint64_t, uint64_t,
                   singz::AudioInputTimestampQuality) noexcept;
};
struct Renderer {
  zcore::routing::AudioHistory* history{};
  Recording* reference{};
  uint64_t measureBegin{}, measureEnd{}, queueNs{}, unmuteBegin{};
  bool direct{}, virtualSource{}, mute{true}, bed{}, calibrationHardware{true};
  float gain{0.05f};
  // Measurement-only OS thread CPU clock. Null means unavailable.
  uint64_t (*cpuTime)() noexcept{};
  OutputClock clock;
  Anchor anchor;
  zcore::routing::AudioReadCursor cursor;
  std::array<float, 256> scratch{};
  uint64_t callbacks{}, missing{}, invalid{}, discontinuities{}, timestampEstimates{}, cpuFailures{};
  uint64_t virtualFrame{}, previousCallbackNs{}, measuredFrames{}, firstMeasuredNs{}, lastMeasuredEndNs{};
  uint32_t smallestPeriod{UINT32_MAX}, largestPeriod{};
  Moments occupancyMs, timestampLatencyMs, callbackJitterMs, cpuPercent, outputRateHz;
  static bool render(void*, const singz::AudioHostRenderBlock&) noexcept;
};
float testSignal(uint64_t frame, double rate) noexcept;
enum class Verdict { Pass, Fail, NotMeasured };
const char* name(Verdict) noexcept;
struct Gates {
  double requiredSeconds{600}, maxLatencyMs{10};
  uint64_t allowedMissing{};
};
Verdict continuity(const Gates&, double seconds, uint64_t callbacks, uint64_t missing,
                   uint64_t timestampErrors, uint64_t xruns, bool bed, bool complete) noexcept;
Verdict latency(const Gates&, double milliseconds, bool measured, bool eligible) noexcept;
// Virtual direct begins at the render callback, unlike history's capture
// first-sample origin. It cannot enter the cross-mode comparison gate.
Verdict pathComparison(const Gates&, double milliseconds, bool measured, bool sameDevice,
                       uint32_t period, bool direct, bool virtualSource) noexcept;
} // namespace monitor_spike
