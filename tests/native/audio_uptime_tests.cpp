#include <zcore/routing/audio_history.h>
#include <zcore/routing/audio_resampler.h>
#include <zcore/routing/sample_clock.h>

#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>

#define CHECK(value)                                                           \
  do {                                                                         \
    if (!(value)) {                                                            \
      std::fprintf(stderr, "CHECK %s:%d: %s\n", __FILE__, __LINE__, #value);   \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {
using namespace zcore::routing;
constexpr uint32_t block = 256;
constexpr uint64_t baseNs = 1000000000;
uint64_t ns(uint64_t frames) { return frames * 1000000000ULL / 48000; }
struct Signal {
  uint64_t origin;
  static ResampleFrame read(const void *opaque, uint64_t frame,
                            std::span<float> values) noexcept {
    const auto &self = *static_cast<const Signal *>(opaque);
    // The integer subtraction precedes conversion: the reference signal must
    // not itself lose phase as the deliberately large frame origin increases.
    if (frame < self.origin || frame - self.origin >= 16384)
      return {false, 0};
    const double local = double(frame - self.origin);
    for (size_t channel = 0; channel < values.size(); ++channel)
      values[channel] = float(.2 * std::sin(local * (.173 + channel * .037)));
    return {true, uint32_t(values.size())};
  }
};
enum class PositionEncoding { Native, Float32, Uint32 };
std::vector<float>
mappedRender(uint64_t origin, uint64_t timeOrigin, double sourceRate,
             double outputRate, ResamplingFilter filter,
             uint64_t phaseNs = 1723,
             PositionEncoding encoding = PositionEncoding::Native) {
  SampleClockHistory clock(32);
  // Clock timestamps depend only on the local block: adding uptime translates
  // the domain without changing its nanosecond quantization pattern.
  for (uint32_t index = 0; index < 24; ++index)
    CHECK(clock.append(origin + index * block, timeOrigin + ns(index * block),
                       true, 48000, 48000));
  AudioResampler resampler(filter);
  Signal signal{origin};
  std::array<float, block> left{}, right{};
  const std::array<float *, 2> output{left.data(), right.data()};
  std::vector<float> result;
  for (uint32_t index = 4; index < 20; ++index) {
    const auto stamp = timeOrigin + ns(index * block) + phaseNs;
    const auto point =
        clock.locate(clock.snapshot(), stamp, .25L, 48000, 48000);
    CHECK(point.valid && point.frame >= origin);
    // Include exact unity, fractional unity (FFT), drifting clocks (cached
    // phase-table FIR), and the causal/minimum-phase path.
    ResamplePosition position{point.frame, point.offset, sourceRate,
                              outputRate};
    // Deliberate negative controls: model the proposed precision loss and
    // truncation at the actual clock-to-resampler boundary. They must produce
    // different audio under the same oracle used for the unmodified path.
    if (encoding == PositionEncoding::Float32)
      position.offset =
          static_cast<long double>(static_cast<float>(
              static_cast<long double>(position.anchor) + position.offset)) -
          static_cast<long double>(position.anchor);
    if (encoding == PositionEncoding::Uint32)
      position.anchor = static_cast<uint32_t>(position.anchor);
    const auto missing =
        resampler.read(position, {output, block}, block, Signal::read, &signal);
    if (encoding == PositionEncoding::Native)
      CHECK(missing == 0);
    result.insert(result.end(), left.begin(), left.end());
    result.insert(result.end(), right.begin(), right.end());
  }
  return result;
}
std::vector<float> timestampedHistory(uint64_t sourceOrigin,
                                      uint64_t timeOrigin) {
  AudioHistory history(2);
  std::array<float, block> left{}, right{}, outLeft{}, outRight{};
  const std::array<const float *, 2> input{left.data(), right.data()};
  const std::array<float *, 2> output{outLeft.data(), outRight.data()};
  Signal signal{0};
  AudioReadCursor cursor;
  std::vector<float> result;
  for (uint32_t index = 0; index < 240; ++index) {
    for (uint32_t frame = 0; frame < block; ++frame) {
      // Repeat a local waveform to cover ring reuse without huge allocation.
      std::array<float, 2> sample{};
      CHECK(
          Signal::read(&signal, (index * block + frame) % 16384, sample).valid);
      left[frame] = sample[0];
      right[frame] = sample[1];
    }
    CHECK(history.append({input, block}, block, timeOrigin + ns(index * block),
                         48000, double(sourceOrigin + index * block), true));
    if (index >= 8) {
      const auto read =
          history.read(timeOrigin + ns((index - 4) * block) + 1723, 48000.1,
                       {output, block}, block, cursor);
      CHECK(read.online && read.missingFrames == 0);
      result.insert(result.end(), outLeft.begin(), outLeft.end());
      result.insert(result.end(), outRight.begin(), outRight.end());
    }
  }
  CHECK(history.status().discontinuities == 0);
  CHECK(std::abs(history.status().measuredRate - 48000) < .001);
  return result;
}
} // namespace
int main() {
  constexpr std::array<uint64_t, 5> origins{
      3000000000ULL, 4071732224ULL, (uint64_t{1} << 32) - 2048,
      (uint64_t{1} << 32) + 257, uint64_t{1} << 40};
  uint32_t comparisons = 0;
  for (auto filter :
       {ResamplingFilter::LinearPhase, ResamplingFilter::MinimumPhase})
    for (auto rate : {48000., 48000.1, 44100.}) {
      const auto reference = mappedRender(0, baseNs, rate, 48000, filter);
      for (const auto origin : origins) {
        CHECK(mappedRender(origin, baseNs + ns(origin), rate, 48000, filter) ==
              reference);
        ++comparisons;
      }
    }
  const auto direct =
      mappedRender(0, baseNs, 48000, 48000, ResamplingFilter::LinearPhase, 0);
  for (const auto origin : origins) {
    CHECK(mappedRender(origin, baseNs + ns(origin), 48000, 48000,
                       ResamplingFilter::LinearPhase, 0) == direct);
    ++comparisons;
  }
  const auto fractional =
      mappedRender(0, baseNs, 48000, 48000, ResamplingFilter::LinearPhase);
  CHECK(mappedRender(4071732224ULL, baseNs, 48000, 48000,
                     ResamplingFilter::LinearPhase, 1723,
                     PositionEncoding::Float32) != fractional);
  CHECK(mappedRender((uint64_t{1} << 32) - 2048, baseNs, 48000, 48000,
                     ResamplingFilter::LinearPhase, 1723,
                     PositionEncoding::Uint32) != fractional);
  const auto reference = timestampedHistory(0, baseNs);
  for (const auto origin : origins) {
    CHECK(timestampedHistory(origin, baseNs + ns(origin)) == reference);
    ++comparisons;
  }
  std::printf("Uptime clocks/resamplers/history: %u comparisons, bit-identical "
              "stereo; float32/uint32 negative controls rejected\n",
              comparisons);
}
