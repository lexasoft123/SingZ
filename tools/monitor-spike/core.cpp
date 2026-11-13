// Local measurement prototype. Clock/floor/split-reader ideas ported from LoopZ
// native/core/output_clock.cpp and monitor.cpp, native/platform/macos/monitor_outputs.cpp.
#include "core.h"
#include <algorithm>
#include <cmath>

namespace monitor_spike {
uint64_t frameNs(uint64_t frames, double rate) noexcept {
  return static_cast<uint64_t>(static_cast<long double>(frames) * 1e9L / rate);
}
uint32_t queueFloor(double src, double dst, uint32_t period, uint32_t lookback, uint32_t quantum) noexcept {
  if (!std::isfinite(src) || !std::isfinite(dst) || src < 8000 || src > 192000 ||
      dst < 8000 || dst > 192000 || !period || period > maximum || quantum > capacity / 2)
    return 0;
  const auto floor = std::ceil(2.0 * period * src / dst) + quantum;
  if (floor > capacity / 2 || lookback > capacity / 2) return 0;
  return std::max(lookback, static_cast<uint32_t>(floor));
}
void OutputClock::reset() noexcept { *this = {}; }
double OutputClock::observe(uint64_t frame, uint64_t hostNs, uint32_t frames,
                            double nominalRate, bool discontinuity) noexcept {
  if (!frames || frame > UINT64_MAX - frames || !hostNs || !std::isfinite(nominalRate) ||
      nominalRate < 8000 || nominalRate > 192000) { reset(); return 0; }
  if (previousNs_) {
    const auto expected = static_cast<long double>(previousFrames_) * 1e9L / nominalRate;
    const auto elapsed = static_cast<long double>(hostNs) - previousNs_;
    discontinuity = discontinuity || nominalRate != nominalRate_ ||
      frame != previousFrame_ + previousFrames_ || hostNs <= previousNs_ ||
      std::abs(elapsed - expected) > std::max(2000000.0L, expected * 0.005L + 1000);
  }
  if (discontinuity) reset();
  if (!originNs_) { originNs_ = recentNs_ = hostNs; originFrame_ = recentFrame_ = frame; }
  constexpr uint64_t window = 25000000;
  if (hostNs - recentNs_ >= window) {
    if (recentNs_ != originNs_) { originNs_ = recentNs_; originFrame_ = recentFrame_; }
    recentNs_ = hostNs; recentFrame_ = frame;
  }
  double rate = nominalRate;
  if (hostNs - originNs_ >= window) {
    rate = static_cast<double>(static_cast<long double>(frame - originFrame_) * 1e9L /
                               (hostNs - originNs_));
    if (rate < nominalRate * 0.995 || rate > nominalRate * 1.005) {
      originNs_ = recentNs_ = hostNs; originFrame_ = recentFrame_ = frame; rate = nominalRate;
    }
  }
  previousNs_ = hostNs; previousFrame_ = frame; previousFrames_ = frames; nominalRate_ = nominalRate;
  return rate;
}
void Moments::add(double x) noexcept {
  if (!n) minimum = maximum = x;
  minimum = std::min(minimum, x); maximum = std::max(maximum, x);
  const auto delta = x - mean; ++n; mean += delta / static_cast<double>(n); m2 += delta * (x - mean);
}
double Moments::deviation() const noexcept { return n > 1 ? std::sqrt(m2 / (n - 1)) : 0; }
void Anchor::observe(uint64_t ns, uint32_t count, double rate, bool measured) noexcept {
  if (previous && measured) {
    const double expected = static_cast<double>(frames) * 1e9 / rate;
    const double residual = static_cast<double>(static_cast<long double>(ns) - previous) - expected;
    if (!ns || ns <= previous || std::abs(residual) > std::max(2e9 / rate, expected * .005 + 1000)) {
      ++jumps;
      if (residual > 0) inferredMissing += static_cast<uint64_t>(std::llround(residual * rate / 1e9));
    }
  }
  previous = ns; frames = count;
}
void Recording::append(const float* samples, uint32_t frames, uint64_t ns, double rate) noexcept {
  if (!samples || !ns) return;
  for (uint32_t i = 0; i < frames; ++i) {
    const auto t = ns + frameNs(i, rate);
    if (t >= begin && t < end && used < points.size()) points[used++] = {t, samples[i], i == 0 ? frames : 0};
  }
}
float testSignal(uint64_t frame, double rate) noexcept {
  // Quiet repeated chirps, unequal intervals avoid a periodic-lag ambiguity.
  const double t = static_cast<double>(frame) / rate;
  const double phase = std::fmod(t, 1.013);
  if (phase >= .08) return 0;
  constexpr double pi = 3.14159265358979323846;
  return static_cast<float>(.5 * std::sin(pi * phase / .08) *
                            std::sin(2 * pi * (300 * phase + 5000 * phase * phase)));
}
bool Capture::push(void* context, const float* input, uint32_t count, uint64_t ns,
                   uint64_t, singz::AudioInputTimestampQuality quality) noexcept {
  auto& s = *static_cast<Capture*>(context);
  const bool active = ns >= s.measureBegin && ns < s.measureEnd;
  if (!input || !count || count > maximum || !ns || s.rate < 8000) {
    if (active) ++s.invalid;
    return false;
  }
  s.anchor.observe(ns, count, s.rate, active);
  if (active) {
    ++s.callbacks;
    if (quality == singz::AudioInputTimestampQuality::Unknown) ++s.unknown;
    if (quality == singz::AudioInputTimestampQuality::CallbackEstimate) ++s.estimated;
  }
  if (s.virtualSource) {
    for (uint32_t i = 0; i < count; ++i) s.scratch[i] = testSignal(s.frame + i, s.rate);
    input = s.scratch.data();
  }
  // The mono backend has no authoritative hardware frame counter. Do not invent
  // one from callback counts: that would hide dropped hardware frames in history.
  const float* planes[]{input};
  if (s.history && !s.history->append({planes, count}, count, ns, s.rate) && active) ++s.appendFailures;
  if (s.recording) {
    if (ns >= s.recording->begin && ns < s.recording->end &&
        quality != singz::AudioInputTimestampQuality::Hardware) s.recording->hardwareTimestamps = false;
    s.recording->append(input, count, ns, s.rate);
  }
  s.frame += count;
  return true;
}
bool Renderer::render(void* context, const singz::AudioHostRenderBlock& b) noexcept {
  auto& s = *static_cast<Renderer*>(context);
  const auto cpuBegin = s.cpuTime ? s.cpuTime() : 0;
  const bool active = b.outputHostTimeNs >= s.measureBegin && b.outputHostTimeNs < s.measureEnd;
  const bool valid = b.output && b.frames && b.frames <= maximum && b.frames <= b.maximumFrames && b.outputChannels &&
    b.outputChannels <= singz::kAudioHostMaxChannels &&
    std::all_of(b.output, b.output + b.outputChannels, [](const float* p) { return p != nullptr; }) && b.outputTimestampValid &&
    b.outputHostTimeNs > s.queueNs && b.sampleRate >= 8000 && b.sampleRate <= 192000;
  if (b.output) for (uint32_t c = 0; c < std::min(b.outputChannels, singz::kAudioHostMaxChannels); ++c)
    if (b.output[c]) std::fill_n(b.output[c], std::min(b.frames, b.maximumFrames), 0.f);
  if (!valid) { if (active) ++s.invalid; s.calibrationHardware = false; return false; }
  if (!b.outputTimestampHardware) s.calibrationHardware = false;
  const auto rate = s.clock.observe(b.outputFrame, b.outputHostTimeNs, b.frames, b.sampleRate,
                                    b.discontinuity != 0);
  if (!rate) { if (active) ++s.invalid; return false; }
  s.anchor.observe(b.outputHostTimeNs, b.frames, b.sampleRate, active);
  if (active) {
    ++s.callbacks;
    s.outputRateHz.add(rate);
    s.measuredFrames += b.frames;
    if (!s.firstMeasuredNs) s.firstMeasuredNs = b.outputHostTimeNs;
    s.lastMeasuredEndNs = b.outputHostTimeNs + frameNs(b.frames, b.sampleRate);
    s.smallestPeriod = std::min(s.smallestPeriod, b.frames);
    s.largestPeriod = std::max(s.largestPeriod, b.frames);
    if (!b.outputTimestampHardware) ++s.timestampEstimates;
    if (b.discontinuity) ++s.discontinuities;
    if (s.previousCallbackNs && b.callbackHostTimeNs > s.previousCallbackNs)
      s.callbackJitterMs.add((static_cast<double>(b.callbackHostTimeNs - s.previousCallbackNs) -
                              static_cast<double>(b.frames) * 1e9 / b.sampleRate) / 1e6);
    if (s.history) {
      const auto end = s.history->publishedBlockEndHostNs();
      if (end) s.occupancyMs.add(static_cast<double>(static_cast<long double>(end) -
                                  (b.outputHostTimeNs - s.queueNs)) / 1e6);
    }
  }
  s.previousCallbackNs = b.callbackHostTimeNs;
  bool timestampSupported = true;
  for (uint32_t offset = 0; offset < b.frames; offset += 256) {
    const auto count = std::min(256u, b.frames - offset);
    const auto target = b.outputHostTimeNs - s.queueNs + frameNs(offset, rate);
    float* plane[]{s.scratch.data()};
    if (s.direct) {
      const bool ready = b.input && b.inputChannels && b.input[0] && b.inputTimestampValid;
      for (uint32_t i = 0; i < count; ++i)
        s.scratch[i] = s.virtualSource ? testSignal(s.virtualFrame + offset + i, b.sampleRate) :
                         ready ? b.input[0][offset + i] : 0;
      if (!ready) { timestampSupported = false; if (active) s.missing += count; }
      if (s.reference && ready) {
        if (!b.inputTimestampHardware) s.reference->hardwareTimestamps = false;
        s.reference->append(s.scratch.data(), count,
          b.inputSampleHostTimeNs + frameNs(offset, rate), rate);
      }
    } else {
      const auto result = s.history->read(target, rate, {plane, 256}, count, s.cursor);
      if (!result.online || result.missingFrames) timestampSupported = false;
      if (active) s.missing += result.online ? std::min(count, result.missingFrames) : count;
    }
    for (uint32_t i = 0; i < count; ++i) {
      float voice = s.scratch[i];
      if (!std::isfinite(voice)) { voice = 0; if (active) ++s.invalid; }
      const auto f = offset + i;
      // Two steady tones plus amplitude modulation; continuity load, not a song graph.
      const double t = static_cast<double>(b.outputFrame + f) / b.sampleRate;
      const float bed = s.bed && active ? static_cast<float>(.02 * (std::sin(1382.30076758 * t) +
                                    .5 * std::sin(2073.45115137 * t)) * (.8 + .2 * std::sin(6.28 * t))) : 0;
      const float out = (s.mute || b.outputHostTimeNs < s.unmuteBegin) ? 0 : std::clamp(s.gain * voice + bed, -.5f, .5f);
      for (uint32_t c = 0; c < b.outputChannels; ++c) if (b.output[c]) b.output[c][f] = out;
    }
  }
  if (active) {
    if (s.direct && b.inputTimestampValid && timestampSupported) {
      s.timestampLatencyMs.add(static_cast<double>(static_cast<long double>(b.outputHostTimeNs) -
                                                  b.inputSampleHostTimeNs) / 1e6);
      if (!b.inputTimestampHardware) ++s.timestampEstimates;
    } else if (!s.direct && timestampSupported) s.timestampLatencyMs.add(static_cast<double>(s.queueNs) / 1e6);
    const auto end = s.cpuTime ? s.cpuTime() : 0;
    if (cpuBegin && end >= cpuBegin)
      s.cpuPercent.add(static_cast<double>(end - cpuBegin) / (1e9 * b.frames / b.sampleRate) * 100);
    else ++s.cpuFailures;
  }
  s.virtualFrame += b.frames;
  return true;
}
const char* name(Verdict v) noexcept {
  return v == Verdict::Pass ? "PASS" : v == Verdict::Fail ? "FAIL" : "NOT MEASURED";
}
Verdict continuity(const Gates& g, double seconds, uint64_t callbacks, uint64_t missing,
                   uint64_t errors, uint64_t xruns, bool bed, bool complete) noexcept {
  if (missing > g.allowedMissing || errors || xruns) return Verdict::Fail;
  if (!complete || !callbacks || !bed || seconds + .001 < g.requiredSeconds) return Verdict::NotMeasured;
  return Verdict::Pass;
}
Verdict latency(const Gates& g, double ms, bool measured, bool eligible) noexcept {
  if (!measured || !eligible || !std::isfinite(ms) || ms < 0) return Verdict::NotMeasured;
  return ms <= g.maxLatencyMs ? Verdict::Pass : Verdict::Fail;
}
} // namespace monitor_spike
