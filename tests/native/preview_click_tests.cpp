#include "native/playback/shared_audio_service.h"
#include "native/electron/training_route_latency.h"
#include "allocation_trap.h"
#include "native/playback/playback_cue_plan.h"
#include <algorithm>
#include <array>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <thread>

#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "line %d: %s\n", __LINE__, #x); std::exit(1); } } while (false)
using namespace singz;
class Backend final : public AudioHostBackend {
 public:
  AudioHostStatus current;
  AudioHostConfig config;
  AudioHostRender callback{}; void* context{};
  unsigned opens{}, starts{}, stops{}; bool reject{};
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo device; device.uid = "test"; device.outputChannels = 2;
    device.defaultOutput = true; device.nominalSampleRate = 48000;
    return {{device}, {}, "test"};
  }
  AudioHostResult open(const AudioHostConfig& c, AudioHostRender r, void* p) override {
    ++opens; config = c; callback = r; context = p;
    if (reject) return {false, AudioHostError::DeviceNotFound, AudioHostState::Error, {}, {}, "missing device"};
    current.state = AudioHostState::Open;
    current.format = {48000, c.maximumFrames, 256, 0, 2};
    current.latency.bufferFrames = 256;
    return {true, AudioHostError::None, current.state, current.format, current.latency, {}};
  }
  AudioHostResult start() override {
    ++starts; current.state = AudioHostState::Running;
    return {true, AudioHostError::None, current.state, current.format, current.latency, {}};
  }
  void stop() noexcept override { ++stops; current.state = AudioHostState::Stopped; }
  AudioHostStatus status() const noexcept override { return current; }
  std::array<float, 4096> render(uint32_t frames = 4096) {
    std::array<float, 4096> left{}, right{}; float* output[]{left.data(), right.data()};
    AudioHostRenderBlock b; b.output = output; b.outputChannels = 2;
    b.frames = frames; b.maximumFrames = 4096; b.sampleRate = 48000;
    zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
    CHECK(callback && callback(context, b));
    zdsp::test::setAllocationTrapEnabled(false); CHECK(zdsp::test::trappedAllocationCount() == 0);
    CHECK(left == right); return left;
  }
};
bool silentSong(void*, const AudioHostRenderBlock&) noexcept { return true; }
int main() {
  PlaybackCuePlanRequest request; request.sampleRate = 48000; request.durationSeconds = 1;
  const auto canonical = preparePlaybackCuePlan(request); CHECK(canonical.ok());
  for (bool paused : {false, true}) for (bool accent : {false, true}) {
    auto owned = std::make_unique<Backend>(); auto* host = owned.get();
    const std::string provider = paused ? "coreaudio" : "test";
    SharedAudioService service(std::move(owned), provider);
    std::unique_ptr<AudioHostBackend> song;
    if (paused) {
      song = service.playbackBackend(std::make_unique<Backend>(), provider);
      CHECK(song->open({}, silentSong, nullptr).ok); CHECK(song->start().ok); CHECK(song->suspend().ok);
    }
    const auto opens = host->opens, starts = host->starts, stops = host->stops;
    CHECK(service.setMasterGain(.5F));
    CHECK(service.previewClick(accent, .3F).ok);
    const auto pcm = host->render();
    const auto& reference = accent ? canonical.plan->accentClickPcm : canonical.plan->ordinaryClickPcm;
    for (uint32_t f = 0; f < pcm.size(); ++f)
      CHECK(std::abs(pcm[f] - (f < reference.size() ? reference[f] * .3F * .5F : 0)) < 1e-6F);
    CHECK(service.previewClickStatus().completed == 1);
    CHECK(service.previewClickStatus().pending == 0);
    if (paused) {
      CHECK(host->config.holdSharedDeviceBuffer);
      CHECK(host->opens == opens && host->starts == starts && host->stops == stops);
      CHECK(song->status().renderedFrames == 0); // Preview cannot advance the parked song.
    } else CHECK(host->opens == 1 && host->starts == 1);
    CHECK(service.previewClick(!accent, .3F).ok); host->render();
    CHECK(host->opens == (paused ? opens : 1)); // Idle repeats retain the same host/period.
    CHECK(host->config.requestedBufferFrames == 0);
    CHECK(service.status().format.nominalBufferFrames == 256);
  }
  {
    auto owned = std::make_unique<Backend>(); auto* host = owned.get();
    SharedAudioService service(std::move(owned), "test");
    CHECK(service.setMasterGain(0)); CHECK(service.previewClick(true, 1).ok);
    const auto pcm = host->render(); CHECK(std::all_of(pcm.begin(), pcm.end(), [](float v) { return v == 0; }));
    CHECK(service.previewClickStatus().completed == 1);
    for (unsigned i = 0; i < PreviewClickMixer::capacity; ++i) CHECK(service.previewClick(i % 2, 4).ok);
    CHECK(service.previewClick(false, 1).error == SharedAudioService::PreviewClickError::QueueFull);
    host->render(); CHECK(service.previewClickStatus().pending == 0);
    CHECK(!service.previewClick(false, std::numeric_limits<float>::quiet_NaN()).ok);
    CHECK(!service.previewClick(false, -1).ok); CHECK(!service.previewClick(false, 5).ok);
  }
  {
    auto owned = std::make_unique<Backend>(); owned->reject = true;
    SharedAudioService service(std::move(owned), "test");
    CHECK(service.previewClick(false, 1).error == SharedAudioService::PreviewClickError::OutputUnavailable);
    CHECK(service.previewClickStatus().pending == 0);
  }
  {
    auto owned = std::make_unique<Backend>(); auto* host = owned.get();
    SharedAudioService service(std::move(owned), "test");
    for (unsigned i = 0; i < PreviewClickMixer::capacity; ++i) CHECK(service.previewClick(true, 4).ok);
    const auto pcm = host->render();
    for (auto value : pcm) CHECK(std::abs(value) <= kServiceMasterCeiling);
    CHECK(service.outputMeter().clippedBlocks == 1);
    CHECK(service.previewClickStatus().completed == PreviewClickMixer::capacity);
  }
  // Exact output frame lengths on all common routes, including callback tails.
  for (double rate : {44100., 48000., 96000., 384000.}) {
    PreviewClickMixer mixer; CHECK(mixer.enqueue(false, 1));
    std::array<float, 127> pcm{}; float* output[]{pcm.data()};
    AudioHostRenderBlock b; b.output = output; b.outputChannels = 1; b.frames = 127; b.sampleRate = rate;
    uint32_t frames = 0; const auto duration = static_cast<uint32_t>(std::llround(rate * .055));
    while (frames < duration) {
      std::fill(pcm.begin(), pcm.end(), 0); mixer.render(b);
      for (uint32_t f = 0; f < b.frames; ++f) if (frames + f >= duration) CHECK(pcm[f] == 0);
      frames += b.frames;
      CHECK(mixer.status().pending == (frames < duration ? 1U : 0U));
    }
    CHECK(mixer.status().completed == 1);
  }
  // Native snapshot uses the ADR's composition and excludes capture latency.
  {
    AudioHostStatus host; host.state = AudioHostState::Running; host.routeGeneration = 42;
    host.format.sampleRate = 48000; host.latency = {9999, 144, 96, 240};
    const auto route = trainingRouteLatency(host, 12345); CHECK(route);
    CHECK(route->snapshot.routeGeneration.value == 42 && route->snapshot.measuredAt.value == 12345);
    CHECK(route->composed.graphToAudible.value == 10000000);
    CHECK(route->snapshot.automaticPresentation.value == route->composed.graphToAudible.value);
    host.state = AudioHostState::Closed; CHECK(!trainingRouteLatency(host, 0));
  }
  // SPSC pressure: control and callback run concurrently (TSan gate).
  {
    PreviewClickMixer mixer; std::atomic<bool> done{false};
    std::thread render([&] {
      std::array<float, 256> pcm{}; float* out[]{pcm.data()};
      AudioHostRenderBlock b; b.output = out; b.outputChannels = 1; b.frames = 256; b.sampleRate = 48000;
      while (!done.load(std::memory_order_acquire) || mixer.status().pending) {
        pcm.fill(0); mixer.render(b);
        for (auto value : pcm) CHECK(std::isfinite(value));
      }
    });
    for (unsigned n = 0; n < 2000; ++n) while (!mixer.enqueue(n % 2, .1F)) std::this_thread::yield();
    done.store(true, std::memory_order_release); render.join();
    CHECK(mixer.status().enqueued == 2000 && mixer.status().completed == 2000);
  }
  std::puts("preview_click_tests: 4 idle/paused/timbre cases, mute, capacity, failures, 4 rates, route snapshot, 2000 concurrent clicks passed");
}
