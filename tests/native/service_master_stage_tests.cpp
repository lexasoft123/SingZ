#include "native/playback/shared_audio_service.h"
#include "allocation_trap.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <thread>

#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "failed line %d: %s\n", __LINE__, #x); std::exit(1); } } while (false)
using namespace singz;

class MasterBackend final : public AudioHostBackend {
 public:
  AudioHostRender callback{};
  void* context{};
  AudioHostStatus current{};
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo device;
    device.uid = "fake"; device.outputChannels = 2;
    device.nominalSampleRate = 48000;
    return {{device}, {}, device.uid};
  }
  AudioHostResult open(const AudioHostConfig&, AudioHostRender render, void* object) override {
    callback = render; context = object;
    current.state = AudioHostState::Open;
    current.format = {48000, 512, 64, 0, 2};
    current.latency = {0, 64, 11, 7};
    return {true, AudioHostError::None, current.state, current.format, current.latency, {}};
  }
  AudioHostResult start() override {
    current.state = AudioHostState::Running;
    return {true, AudioHostError::None, current.state, current.format, current.latency, {}};
  }
  void stop() noexcept override { current.state = AudioHostState::Stopped; }
  AudioHostStatus status() const noexcept override { return current; }
};

struct Source {
  float value;
  unsigned calls{0};
  static bool render(void* opaque, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<Source*>(opaque);
    // The final stage must not rewrite the presentation/capture anchors.
    if (block.callbackHostTimeNs != 1234567 || block.outputHostTimeNs != 7654321 ||
        block.outputFrame != 999)
      std::abort();
    ++self.calls;
    for (uint32_t ch = 0; ch < block.outputChannels; ++ch)
      for (uint32_t f = 0; f < block.frames; ++f) block.output[ch][f] += self.value;
    return true;
  }
};

int main() {
  auto backend = std::make_unique<MasterBackend>();
  auto* physical = backend.get();
  SharedAudioService service(std::move(backend));
  auto song = service.playbackBackend(std::make_unique<MasterBackend>(), "");
  AudioHostConfig config;
  config.outputDeviceUid = "fake"; config.outputChannels = {0, 1};
  config.requestedSampleRate = 48000; config.maximumFrames = 512;
  Source music{0.125F}, cue{0.0625F}, mic{0.03125F};
  CHECK(song->open(config, Source::render, &music).ok && song->start().ok);
  service.setTrainingRenderer(Source::render, &cue);
  service.setMicrophoneRenderer(Source::render, &mic);
  std::array<float, 512> left{}, right{};
  float* outputs[]{left.data(), right.data()};
  AudioHostRenderBlock block;
  block.output = outputs; block.outputChannels = 2; block.frames = 512;
  block.maximumFrames = 512; block.sampleRate = 48000;
  block.callbackHostTimeNs = 1234567; block.outputHostTimeNs = 7654321;
  block.outputFrame = 999;
  // An initial mute is effective on sample zero, before any ramp can run.
  ServiceMasterStage mutedStart;
  mutedStart.target.store(0);
  left.fill(0.5F); right.fill(-0.5F);
  mutedStart.process(block);
  for (unsigned f = 0; f < 512; ++f) CHECK(left[f] == 0 && right[f] == 0);
  auto render = [&] {
    const uint64_t before = zdsp::test::trappedAllocationCount();
    zdsp::test::setAllocationTrapEnabled(true);
    const bool ok = physical->callback(physical->context, block);
    zdsp::test::setAllocationTrapEnabled(false);
    CHECK(ok && zdsp::test::trappedAllocationCount() == before);
  };
  render();
  for (float v : left) CHECK(v == 0.21875F); // bit-identical old additive sum
  for (float gain : {0.25F, 1.0F, 2.0F, 0.0F}) {
    CHECK(service.setMasterGain(gain)); render();
    const auto timing = song->status();
    CHECK(timing.latency.outputDeviceFrames == 64 && timing.latency.bufferFrames == 11 &&
          timing.latency.externalRouteFrames == 7);
    for (unsigned f = 128; f < 512; ++f) {
      CHECK(left[f] == 0.21875F * gain && right[f] == left[f]);
    }
  }
  // Each client independently sits under master, including idle cues/voice.
  CHECK(service.setMasterGain(0.25F));
  for (Source* source : {&music, &cue, &mic}) {
    music.value = cue.value = mic.value = 0;
    source->value = 0.5F; render();
    CHECK(left[511] == 0.125F && right[511] == 0.125F);
  }
  song->stop(); render(); CHECK(left[511] == 0.125F);
  service.clearTrainingRenderer();
  // +36 dB input and every legal master must stay under the common ceiling.
  for (float gain : {0.25F, 1.0F, 4.0F}) {
    CHECK(service.setMasterGain(gain));
    for (float sign : {-1.0F, 1.0F}) {
      mic.value = sign * std::pow(10.0F, 36.0F / 20.0F); render();
      for (float v : left) CHECK(std::isfinite(v) && std::abs(v) <= kServiceMasterCeiling);
      CHECK(left[511] == sign * kServiceMasterCeiling);
    }
  }
  mic.value = 0.125F;
  CHECK(service.setMasterGain(0)); render();
  CHECK(service.setMasterGain(4));
  // Uneven periods must not restart the 128-frame ramp at each callback.
  float previous = 0;
  for (unsigned count = 0; count < 20; ++count) {
    block.frames = 7; render();
    for (unsigned f = 0; f < 7; ++f) {
      CHECK(left[f] >= previous && left[f] - previous <= 0.125F * 4 / 128 + 1e-7F);
      previous = left[f];
    }
  }
  CHECK(previous == 0.5F);
  CHECK(!service.setMasterGain(-1) && !service.setMasterGain(5));
  CHECK(!service.setMasterGain(std::numeric_limits<float>::quiet_NaN()));
  CHECK(!service.setMasterGain(std::numeric_limits<float>::infinity()));
  render(); CHECK(left[6] == 0.5F);
  // Concurrent control publication/callback consumption is covered by TSan.
  std::thread control([&] { for (unsigned i = 0; i < 10000; ++i) CHECK(service.setMasterGain((i % 5) * 0.25F)); });
  std::thread observer([&] {
    uint64_t clips = 0, callbacks = 0;
    for (unsigned i = 0; i < 10000; ++i) {
      const auto meter = service.outputMeter();
      CHECK(std::isfinite(meter.peak) && meter.peak <= kServiceMasterCeiling);
      CHECK(std::isfinite(meter.rms) && meter.rms <= kServiceMasterCeiling);
      CHECK(meter.clippedBlocks >= clips && meter.callbacks >= callbacks);
      clips = meter.clippedBlocks; callbacks = meter.callbacks;
    }
  });
  for (unsigned i = 0; i < 10000; ++i) render();
  control.join(); observer.join();
  service.clearMicrophoneRenderer();
  std::puts("service master stage tests: ok");
}
