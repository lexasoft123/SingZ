#include "native/playback/loopz_source_backend.h"
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <loopz/audio_resampler.hpp>
#include <loopz/runtime/audio_runtime.hpp>
#include <thread>

#define CHECK(v)                                                               \
  do {                                                                         \
    if (!(v)) {                                                                \
      std::fprintf(stderr, "failed %d: %s\n", __LINE__, #v);                   \
      std::abort();                                                            \
    }                                                                          \
  } while (false)
using namespace singz;
using namespace loopz;
struct Probe {
  AudioHostRender callback{};
  void *context{};
  bool failOpen{};
};
class Host final : public AudioHostBackend {
public:
  explicit Host(std::shared_ptr<Probe> probe) : probe_(std::move(probe)) {}
  AudioHostInventory enumerate() const override { return {}; }
  AudioHostResult open(const AudioHostConfig &, AudioHostRender callback,
                       void *context) override {
    if (probe_->failOpen)
      return {false, AudioHostError::ProviderFailure, AudioHostState::Error, {},
              {},    "injected open failure"};
    probe_->callback = callback;
    probe_->context = context;
    status_.state = AudioHostState::Open;
    status_.format = {48000, 8192, 256, 0, 2};
    status_.latency.bufferFrames = status_.diagnostics.outputBufferFrames =
        1024;
    status_.diagnostics.outputPeriodFrames = 256;
    return {true,           AudioHostError::None, status_.state,
            status_.format, status_.latency,      {}};
  }
  AudioHostResult start() override {
    status_.state = AudioHostState::Running;
    return {true,           AudioHostError::None, status_.state,
            status_.format, status_.latency,      {}};
  }
  void stop() noexcept override { status_.state = AudioHostState::Stopped; }
  AudioHostStatus status() const noexcept override { return status_; }

private:
  std::shared_ptr<Probe> probe_;
  AudioHostStatus status_;
};
float marker(uint64_t position, uint32_t channel) {
  const auto bits =
      static_cast<uint32_t>((position * 1103515245ULL + channel * 7919) >> 8);
  return (static_cast<int32_t>(bits % 1024) - 512) / 4096.f;
}
struct Renderer {
  std::atomic<uint64_t> position{0}, calls{0}, directCalls{0};
  std::atomic<bool> paused{false}, hold{false}, entered{false}, release{false};
  std::atomic_flag rendering = ATOMIC_FLAG_INIT;
  static bool render(void *context,
                     const AudioHostRenderBlock &block) noexcept {
    auto &self = *static_cast<Renderer *>(context);
    CHECK(!self.rendering.test_and_set());
    if (block.outputClockMaster) {
      CHECK(block.clockDomain == 777 && block.outputTimestampValid);
      self.directCalls.fetch_add(1);
    } else
      CHECK(!block.outputTimestampValid);
    CHECK(block.frames <= 256 && block.maximumFrames == 256 &&
          block.outputChannels == 2);
    if (self.hold.exchange(false)) {
      self.entered.store(true);
      while (!self.release.load())
        std::this_thread::yield();
    }
    const auto first = self.position.load();
    for (uint32_t c = 0; c < 2; ++c)
      for (uint32_t f = 0; f < block.frames; ++f)
        block.output[c][f] = self.paused.load() ? 0 : marker(first + f, c);
    if (!self.paused.load())
      self.position.fetch_add(block.frames);
    self.calls.fetch_add(1);
    self.rendering.clear();
    return true;
  }
};
template <class Predicate> void waitFor(Predicate predicate) {
  const auto deadline =
      std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!predicate()) {
    CHECK(std::chrono::steady_clock::now() < deadline);
    std::this_thread::yield();
  }
}
RouteDocument document() {
  VirtualDeviceDefinition device;
  device.id = "song";
  device.name = "Song";
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
  monitor.deviceSelector = "output";
  monitor.connections = {{0, 0, 1}, {1, 1, 1}};
  device.monitors.push_back(monitor);
  RouteDocument result;
  result.devices.push_back(device);
  return result;
}
int main() {
  auto probe = std::make_shared<Probe>();
  runtime::AudioRuntime runtime(
      [probe] { return std::make_unique<Host>(probe); });
  auto source = std::make_shared<LoopZSongSource>();
  source->history =
      std::make_shared<AudioHistory>(2, AudioHistory::kDefaultCapacityFrames,
                                     ResamplingFilter::LinearPhase, true);
  runtime.bindNativeSource("native:singz", source);
  auto route = document();
  runtime.commit(runtime.prepare(route));
  CHECK(source->deviceClocked());
  auto backend = createLoopZSourceBackend(source);
  Renderer renderer;
  AudioHostConfig config;
  config.requestedSampleRate = 48000;
  CHECK(backend->open(config, Renderer::render, &renderer).ok);
  CHECK(backend->start().ok);
  CHECK(backend->status().format.outputClockMaster);
  std::array<float, 8192> left{}, right{};
  std::array<float *, 2> planes{left.data(), right.data()};
  AudioHostRenderBlock physical;
  physical.output = planes.data();
  physical.outputChannels = 2;
  physical.sampleRate = 48000;
  physical.maximumFrames = 8192;
  physical.clockDomain = 777;
  physical.routeGeneration = physical.streamGeneration = 1;
  physical.outputTimestampValid = true;
  physical.outputClockMaster = true;
  uint64_t physicalFrame = 0;
  auto emit = [&](uint32_t frames, uint64_t uptimeNs, float gain = 1.f,
                  bool swap = false) {
    const auto before = renderer.position.load();
    const auto calls = renderer.calls.load();
    physical.frames = frames;
    physical.outputFrame = physicalFrame;
    physical.callbackHostTimeNs = 1000000000ULL + uptimeNs;
    physical.outputHostTimeNs = physical.callbackHostTimeNs + 21333333;
    CHECK(probe->callback(probe->context, physical));
    CHECK(renderer.calls.load() == calls + (frames + 255) / 256);
    for (uint32_t c = 0; c < 2; ++c)
      for (uint32_t f = 0; f < frames; ++f)
        CHECK((c ? right : left)[f] ==
              (renderer.paused.load()
                   ? 0
                   : marker(before + f, swap ? 1 - c : c) * gain));
    physicalFrame += frames;
    CHECK(source->history->status().lastHostNs ==
          physical.outputHostTimeNs +
              uint64_t((frames - 1) / 256 * 256) * 1000000000ULL / 48000);
  };
  for (uint32_t hour : {0u, 24u, 48u}) {
    for (double ppm : {-50., 50.})
      for (uint32_t i = 0; i < 64; ++i)
        emit(256, uint64_t(hour) * 3600 * 1000000000ULL +
                      uint64_t(i * 256 * 1e9 / (48000 * (1 + ppm / 1e6))) +
                      i / 3);
    renderer.position.store(15000); // Destructive upstream seek seam.
    emit(128, uint64_t(hour) * 3600 * 1000000000ULL + 400000000);
    renderer.paused.store(true);
    emit(512, uint64_t(hour) * 3600 * 1000000000ULL + 500000000);
    renderer.paused.store(false);
    emit(8192, uint64_t(hour) * 3600 * 1000000000ULL + 600000000);
  }
  const auto beforeStaleOwner = renderer.calls.load();
  const int staleOwner = 0;
  physical.frames = 256;
  CHECK(!source->renderClocked(&staleOwner, physical));
  CHECK(!source->renderClocked(nullptr, physical));
  CHECK(renderer.calls.load() == beforeStaleOwner);
  AudioReadCursor staleScene;
  left.fill(1);
  right.fill(1);
  const auto staleRead = source->read(source->history->status().lastHostNs,
                                      48000, {planes, 8192}, 256, staleScene);
  CHECK(!staleRead.online && staleRead.missingFrames == 256);
  for (uint32_t f = 0; f < 256; ++f)
    CHECK(left[f] == 0 && right[f] == 0);
  left.fill(1);
  right.fill(1);
  const auto staleFiltered = source->readWithFilter(
      source->history->status().lastHostNs, 48000, {planes, 8192}, 256,
      staleScene, ResamplingFilter::LinearPhase);
  CHECK(!staleFiltered.online && staleFiltered.missingFrames == 256);
  for (uint32_t f = 0; f < 256; ++f)
    CHECK(left[f] == 0 && right[f] == 0);
  CHECK(source->history->readDiagnostics().reads ==
        0); // Neither bridge is audible.
  auto state = runtime.status();
  CHECK(state.monitors.size() == 1 && state.monitors[0].deviceClocked);
  CHECK(state.monitors[0].historyDelayFrames == 0 &&
        state.monitors[0].filterFutureFrames == 0);
  CHECK(state.devices[0].active && state.devices[0].sources[0].status.online);
  CHECK(state.monitors[0].meter.frames && state.devices[0].meter.frames &&
        state.devices[0].sources[0].meter.frames);
  route.devices[0].routing.sources[0].gain = .5f;
  route.devices[0].routing.gain = .5f;
  route.devices[0].monitors[0].gain = .5f;
  route.devices[0].monitors[0].connections = {{0, 1, 1}, {1, 0, 1}};
  runtime.commit(runtime.prepare(route));
  // Routing gain envelopes settle; compare identity after 32 callbacks.
  for (unsigned i = 0; i < 32; ++i) {
    physical.frames = 256;
    physical.outputFrame = physicalFrame;
    physicalFrame += 256;
    physical.callbackHostTimeNs += 5333333;
    physical.outputHostTimeNs += 5333333;
    CHECK(probe->callback(probe->context, physical));
  }
  emit(256, 48 * 3600 * 1000000000ULL + 2000000000ULL, .125f, true);
  // Source and monitor gains/maps survive the direct program, as do invalid
  // block guards. Invalid callbacks must not advance the song.
  const auto beforeInvalid = renderer.calls.load();
  physical.frames = 8193;
  CHECK(!probe->callback(probe->context, physical));
  CHECK(renderer.calls.load() == beforeInvalid);
  physical.frames = 256;
  auto fallback = route;
  SourceRouting other;
  other.id = "software";
  other.channels = 2;
  other.connections = {{0, 0, 1}, {1, 1, 1}};
  fallback.devices[0].routing.sources.push_back(other);
  fallback.devices[0].bindings.push_back(
      {"software", SourceKind::Application, "native:other", true});
  auto preparedFallback = runtime.prepare(fallback);
  renderer.hold.store(true);
  std::thread audio([&] { CHECK(probe->callback(probe->context, physical)); });
  waitFor([&] { return renderer.entered.load(); });
  std::atomic<bool> committed{false};
  std::thread control([&] {
    runtime.commit(preparedFallback);
    committed.store(true);
  });
  CHECK(!committed.load());
  renderer.release.store(true);
  audio.join();
  control.join();
  CHECK(!source->deviceClocked());
  const auto fallbackCalls = renderer.calls.load();
  waitFor([&] { return renderer.calls.load() > fallbackCalls; });
  runtime.commit(runtime.prepare(route));
  CHECK(source->deviceClocked());
  const auto directCalls = renderer.calls.load();
  // The CPU worker is now parked and cannot consume the destructive source.
  std::this_thread::sleep_for(std::chrono::milliseconds(20));
  CHECK(renderer.calls.load() == directCalls);
  backend->stop();
  physical.frames = 256;
  CHECK(probe->callback(probe->context, physical));
  CHECK(renderer.calls.load() == directCalls);
  for (uint32_t f = 0; f < 256; ++f)
    CHECK(left[f] == 0 && right[f] == 0);
  std::puts("Real Box backend + LoopZ output pull: identity, route controls, "
            "meters, 48h timestamps, drained owner switch, stop passed");
}
