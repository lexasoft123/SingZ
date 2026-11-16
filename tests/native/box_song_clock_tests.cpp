#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <loopz/audio_history.hpp>
#include <loopz/audio_resampler.hpp>
#include <loopz/monitor.hpp>
#include <loopz/render_schedule.hpp>
#include <loopz/sample_clock.hpp>
#include <loopz/timeline.hpp>
#include <numbers>

// No device, wall-clock waits or audio output. Run every clock publication for
// 48 hours and inspect clock mappings every period after warm-up. Exercise
// actual PCM through AudioScene + MonitorBus + MonitorProgram at 0/24/48 hours.
// PCM windows are NOT a continuous 48-hour audio soak: only clock state is.
// The bias is an explicit fault injection AFTER the output timestamp estimator,
// not a claim that production truncates its period or a field-bug reproducer.
#define CHECK(v)                                                               \
  do {                                                                         \
    if (!(v)) {                                                                \
      std::fprintf(stderr, "failed %d: %s\n", __LINE__, #v);                   \
      std::exit(1);                                                            \
    }                                                                          \
  } while (false)
namespace {
using namespace loopz;
constexpr uint32_t rate = 48000, block = 256, sceneDelay = 1024,
                   monitorDelay = 1792;
constexpr uint64_t origin = 1000000000, hours = 48,
                   durationNs = hours * 3600 * 1000000000ULL;
constexpr uint32_t queue = 1024;
constexpr double headroomTolerance = block;

double position(const SampleClockMapping &map) {
  CHECK(map.valid);
  return static_cast<double>(map.frame) + static_cast<double>(map.offset);
}
struct Range {
  double minimum{1e30}, maximum{-1e30};
  void add(double value) {
    minimum = std::min(minimum, value);
    maximum = std::max(maximum, value);
  }
  double span() const { return maximum - minimum; }
};
struct ClockResult {
  Range songHeadroom, busHeadroom;
  double biasFrames{};
  uint64_t periods{};
  HistoryReadSnapshot songRead{}, busRead{};
};

ClockResult clocks(double ppm, bool biased, bool wideBounds = false) {
  // Exactly SourceBackend's normal absolute rational schedule. It does NOT
  // add a truncated period. The 5 us phase offset forces fractional reads.
  const uint64_t songOrigin = origin + 5000;
  uint64_t songFrame = 0, busEnd = 0, sceneWake = origin;
  SampleClockHistory songClock(512), busClock(512);
  RenderSchedule scene({rate, block, block, 4096});
  HistoryReadObservation songRead, busRead;
  songRead.bounds(sceneDelay + monitorDelay - queue - block,
                  sceneDelay + monitorDelay - queue + 3 * block, block);
  busRead.bounds(monitorDelay - queue, monitorDelay - queue + 3 * block, block);
  if (wideBounds) {
    // Negative control: capacity-only bounds hide the injected drift again.
    songRead.bounds(0, AudioHistory::kDefaultCapacityFrames);
    busRead.bounds(0, AudioHistory::kDefaultCapacityFrames);
  }
  ClockResult result;
  const long double deviceRate =
      rate * (1 + static_cast<long double>(ppm) / 1e6L);
  const uint64_t periods =
      static_cast<uint64_t>(durationNs * deviceRate / (1e9L * block));
  for (uint64_t period = 0; period <= periods; ++period) {
    // The callback wakes on the physical clock. Observer jitter is bounded
    // and deterministic; it cannot change the authoritative frame counter.
    const uint64_t elapsed =
        static_cast<uint64_t>(period * block * 1e9L / deviceRate);
    const uint64_t now = origin + elapsed;
    while (songOrigin + songFrame * 1000000000ULL / rate <= now) {
      CHECK(songClock.append(songFrame,
                             songOrigin + songFrame * 1000000000ULL / rate,
                             songFrame != 0));
      songFrame += block;
    }
    while (sceneWake <= now) {
      const auto scheduled = scene.step(sceneWake);
      CHECK(scheduled.valid && !scheduled.reanchored &&
            scheduled.skippedFrames == 0);
      for (uint32_t index = 0; index < scheduled.blocks; ++index) {
        const auto frame = scheduled.firstFrame + uint64_t(index) * block;
        CHECK(busClock.append(frame, frameNs(frame, rate), busEnd != 0));
        busEnd = frame + block;
      }
      CHECK(scheduled.nextWakeNs > sceneWake);
      sceneWake = scheduled.nextWakeNs;
    }
    if (period < 1024)
      continue;
    const int64_t jitterNs = (static_cast<int64_t>(period % 17) - 8) * 1000;
    // 1/3 ns per period -> 259.2 frames/day. Use rational accumulated
    // fault state so this does not depend on floating-point rounding.
    const uint64_t biasNs = biased ? period / 3 : 0;
    const uint64_t presentation =
        now + frameNs(queue, rate) + jitterNs + biasNs;
    const uint64_t busReadNs = presentation - frameNs(monitorDelay, rate);
    const auto bus =
        busClock.locate(busClock.snapshot(), busReadNs, 0, rate, rate);
    const auto busPosition = position(bus);
    result.busHeadroom.add(static_cast<double>(busEnd) - busPosition);
    busRead.observe(1, busReadNs, busEnd, bus.frame, bus.offset, block, bus.rate,
                    static_cast<double>(deviceRate), AudioHistory::kDefaultCapacityFrames, block);
    const uint64_t songReadNs = busReadNs - frameNs(sceneDelay, rate);
    const auto song =
        songClock.locate(songClock.snapshot(), songReadNs, 0, rate, rate);
    result.songHeadroom.add(static_cast<double>(songFrame) - position(song));
    songRead.observe(1, songReadNs, songFrame, song.frame, song.offset, block, song.rate,
                     static_cast<double>(deviceRate), AudioHistory::kDefaultCapacityFrames, block);
  }
  result.periods = periods;
  result.songRead = songRead.snapshot(); result.busRead = busRead.snapshot();
  std::printf("history faults: song=%llu bus=%llu acquisitions=%llu/%llu ratio=%.9f/%.9f\n",
      static_cast<unsigned long long>(result.songRead.bandExits), static_cast<unsigned long long>(result.busRead.bandExits),
      static_cast<unsigned long long>(result.songRead.reanchors), static_cast<unsigned long long>(result.busRead.reanchors),
      result.songRead.ratio, result.busRead.ratio);
  result.biasFrames =
      biased ? static_cast<double>(periods / 3) * rate / 1e9 : 0;
  std::printf("48h clocks ppm=%+.0f bias=%d periods=%llu song headroom=[%.3f, "
              "%.3f] bus=[%.3f, %.3f] injected=%.3f frames\n",
              ppm, biased, static_cast<unsigned long long>(periods),
              result.songHeadroom.minimum, result.songHeadroom.maximum,
              result.busHeadroom.minimum, result.busHeadroom.maximum,
              result.biasFrames);
  return result;
}

float signal(long double frame, uint32_t channel) {
  const auto phase = frame / rate;
  // Incommensurate low/high tones distinguish a wrong period from direct
  // content, and expose treble attenuation from either resampling stage.
  return static_cast<float>(
      .15L * std::sin(2 * std::numbers::pi_v<long double> *
                      (997 + channel * 74) * phase) +
      .15L * std::sin(2 * std::numbers::pi_v<long double> *
                      (11003 + channel * 138) * phase));
}
class Sink final : public AudioSink {
public:
  std::shared_ptr<MonitorBus> bus = std::make_shared<MonitorBus>(2, rate);
  uint32_t channels() const noexcept override { return 2; }
  bool requested() const noexcept override { return true; }
  bool publish(uint64_t first, uint32_t hz, RoutingInput input,
               uint32_t frames) noexcept override {
    return bus->publish(first, hz, input, frames);
  }
  void idle() noexcept override { bus->idle(); }
};
struct PcmResult {
  double rms{}, maxError{};
  uint64_t frames{}, missing{};
};
PcmResult pcmWindow(uint32_t hour, double ppm, uint64_t biasNs,
                    uint32_t stalePeriods = 0) {
  auto history =
      std::make_shared<AudioHistory>(2, AudioHistory::kDefaultCapacityFrames,
                                     ResamplingFilter::LinearPhase, true);
  auto sink = std::make_shared<Sink>();
  VirtualDeviceDefinition device;
  device.id = "song";
  device.name = "Song";
  device.routing.outputChannels = 2;
  device.routing.safetyLimiter = false;
  SourceRouting source;
  source.id = "native";
  source.channels = 2;
  source.connections = {{0, 0, 1}, {1, 1, 1}};
  device.routing.sources.push_back(source);
  device.bindings.push_back(
      {"native", SourceKind::Application, "native:singz", true});
  MonitorDefinition monitor;
  monitor.id = "main";
  monitor.channels = 2;
  monitor.connections = {{0, 0, 1}, {1, 1, 1}};
  monitor.deviceSelector = "fixture:output";
  device.monitors.push_back(monitor);
  RouteDocument document;
  document.devices.push_back(device);
  AudioScene scene(
      document, {rate, block, sceneDelay, 128},
      [&](const auto &, const auto &, const auto &) {
        return ResolvedAudioSource{history,
                                   std::make_shared<AudioReadCursor>()};
      },
      [&](const auto &) { return sink; });
  scene.activate();
  MonitorProgram output(device, monitor, sink->bus->source(),
                        {rate, rate, monitorDelay});
  std::array<float, block> left{}, right{}, a{}, b{};
  const std::array<const float *, 2> input{left.data(), right.data()};
  const std::array<float *, 2> planes{a.data(), b.data()};
  const uint64_t startNs =
      origin + 2000000000ULL + uint64_t(hour) * 3600 * 1000000000ULL;
  const uint64_t startFrame = hostFrame(startNs, rate) / block * block;
  const uint64_t songOrigin = origin + 5000;
  uint64_t songFrame =
      (hostFrame(startNs - songOrigin, rate) / block - 16) * block;
  PcmResult result;
  long double squaredError = 0;
  const double deviceRate = rate * (1 + ppm / 1e6);
  uint64_t nextOutput = 0;
  // Warm 32 blocks then measure 48 blocks. Both histories use the production
  // PCM/resampler code. Global uptime/bias is preserved in their timestamps.
  for (uint32_t index = 0; index < 80; ++index) {
    const auto frame = startFrame + uint64_t(index) * block;
    const auto now = frameNs(frame, rate);
    while (songOrigin + frameNs(songFrame, rate) <= now) {
      for (uint32_t ch = 0; ch < 2; ++ch)
        for (uint32_t f = 0; f < block; ++f)
          (ch ? right : left)[f] = signal(songFrame + f, ch);
      CHECK(history->append({input, block}, block,
                            songOrigin + frameNs(songFrame, rate), rate,
                            double(songFrame), true));
      songFrame += block;
    }
    const auto rendered = scene.render(frame, block);
    CHECK(rendered.validBlock && !rendered.failedGraphs &&
          !rendered.failedSinks);
    while (startNs + frameNs(nextOutput, deviceRate) <= now) {
      const auto physical =
          startNs + frameNs(nextOutput, deviceRate) + frameNs(queue, rate);
      if (index >= 32) {
        const auto read = output.render(
            physical + biasNs - frameNs(uint64_t(stalePeriods) * block, rate),
            rate, {planes, block}, block, nextOutput, deviceRate);
        CHECK(read.validBlock && read.sourceOnline && !read.failedChunks);
        result.missing += read.missingFrames;
        for (uint32_t ch = 0; ch < 2; ++ch)
          for (uint32_t f = 0; f < block; ++f) {
            // Compare with the unbiased, directly evaluated source
            // at the intended presentation time, not biased read time.
            const long double sourceFrame =
                (static_cast<long double>(physical) - songOrigin) * rate /
                    1e9L -
                monitorDelay - sceneDelay +
                static_cast<long double>(f) * rate / deviceRate;
            const double error = (ch ? b : a)[f] - signal(sourceFrame, ch);
            squaredError += error * error;
            result.maxError = std::max(result.maxError, std::abs(error));
          }
        result.frames += block;
      }
      nextOutput += block;
    }
  }
  CHECK(result.frames > 0 && !result.missing);
  result.rms =
      std::sqrt(static_cast<double>(squaredError / (result.frames * 2)));
  const auto diagnostics = history->readDiagnostics();
  CHECK(!diagnostics.expiredSampleReads && !diagnostics.racingSampleReads &&
        !diagnostics.absentSampleReads);
  std::printf("PCM hour=%u ppm=%+.0f bias=%llu ns stale=%u periods frames=%llu "
              "rms=%.7f max=%.7f\n",
              hour, ppm, static_cast<unsigned long long>(biasNs), stalePeriods,
              static_cast<unsigned long long>(result.frames), result.rms,
              result.maxError);
  return result;
}
} // namespace
int main(int argc, char **argv) {
  const bool requireBounded =
      argc == 2 && std::strcmp(argv[1], "--require-bounded-bias") == 0;
  const bool wideBounds = argc == 2 && std::strcmp(argv[1], "--wide-bounds-negative-control") == 0;
  CHECK(argc == 1 || requireBounded || wideBounds);
  bool unboundedBias = false;
  for (const double ppm : {-50., 50.}) {
    const auto clean = clocks(ppm, false, wideBounds);
    CHECK(clean.songHeadroom.span() < headroomTolerance + 1);
    CHECK(clean.busHeadroom.span() < headroomTolerance + 1);
    CHECK(clean.songRead.valid && clean.busRead.valid);
    CHECK(clean.songRead.bandExits == 0 && clean.busRead.bandExits == 0);
    const auto biased = clocks(ppm, true, wideBounds);
    CHECK(biased.biasFrames > 518 && biased.biasFrames < 519);
    CHECK(biased.songRead.bandExits > 0 && biased.busRead.bandExits > 0);
    CHECK(biased.songRead.outsideBand && biased.busRead.outsideBand);
    CHECK(biased.busHeadroom.span() > clean.busHeadroom.span() + 500);
    CHECK(biased.songHeadroom.span() > clean.songHeadroom.span() + 500);
    unboundedBias |= biased.busHeadroom.minimum <
                     clean.busHeadroom.minimum - headroomTolerance;
    for (uint32_t hour : {0u, 24u, 48u}) {
      const auto pcm = pcmWindow(hour, ppm, 0);
      CHECK(pcm.rms < 0.0001 && pcm.maxError < 0.001);
      if (hour) {
        const auto periods = static_cast<uint64_t>(hour * 3600.L * rate *
                                                   (1 + ppm / 1e6) / block);
        const auto bad = pcmWindow(hour, ppm, periods / 3);
        CHECK(bad.rms > 0.05);
      }
    }
  }
  // Deliberate wrong-slot negative controls: the PCM oracle must reject a
  // whole device-period delay (and its multiples), independently of drift.
  for (uint32_t stale : {1u, 2u, 3u})
    CHECK(pcmWindow(48, 50, 0, stale).rms > 0.05);
  CHECK(unboundedBias);
  if (requireBounded) {
    std::fprintf(stderr,
                 "FAIL: existing two-history path does not bound injected "
                 "timestamp bias; >256 frames of headroom drift\n");
    return 1;
  }
  std::puts(
      "PASS: unbiased clocks remain bounded; injected bias and 1/2/3-period "
      "stale-read controls detected and surfaced as history faults. Fallback control unchanged; field failure NOT reproduced.");
}
