#include "native/playback/shared_audio_service.h"
#include <cstdio>
#include <cstdlib>
#include <memory>

#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "failed line %d: %s\n", __LINE__, #value); std::abort(); } } while (false)
using namespace singz;

class TestBackend final : public AudioHostBackend {
 public:
  mutable unsigned enumerations{0};
  unsigned opens{0}, starts{0}, stops{0};
  AudioHostRender callback{nullptr};
  void* context{nullptr};
  AudioHostStatus current;
  AudioHostConfig lastConfig;
  bool preferredPresent = true;
  std::string defaultUid = "selected";
  AudioHostInventory enumerate() const override {
    ++enumerations;
    AudioHostDeviceInfo device;
    device.uid = "selected"; device.defaultInput = true;
    device.defaultOutput = true; device.inputChannels = 1;
    device.outputChannels = 2; device.nominalSampleRate = 48000;
    AudioHostDeviceInfo alternate = device;
    alternate.uid = "alternate"; alternate.inputChannels = 0; alternate.defaultInput = false;
    alternate.nominalSampleRate = 44100;
    alternate.defaultOutput = defaultUid == alternate.uid;
    device.defaultOutput = defaultUid == device.uid;
    std::vector<AudioHostDeviceInfo> rows{alternate};
    if (preferredPresent) rows.push_back(device);
    return {rows, device.uid, defaultUid};
  }
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender render, void* object) override {
    CHECK(config.inputDeviceUid.empty()); CHECK(config.inputChannels.empty());
    ++opens; callback = render; context = object; lastConfig = config;
    current.state = AudioHostState::Open;
    current.format = {config.requestedSampleRate ? config.requestedSampleRate : 48000, config.maximumFrames, 512, 0, 2};
    return {true, AudioHostError::None, current.state, current.format, {}, {}};
  }
  AudioHostResult start() override {
    ++starts; current.state = AudioHostState::Running;
    return {true, AudioHostError::None, current.state, current.format, {}, {}};
  }
  void stop() noexcept override { ++stops; current.state = AudioHostState::Stopped; }
  AudioHostStatus status() const noexcept override { return current; }
  void render(float expected) {
    float left[4]{}, right[4]{}; float* out[]{left, right};
    AudioHostRenderBlock block;
    block.output = out; block.outputChannels = 2; block.frames = 4;
    block.maximumFrames = kAudioHostMaxFrames; block.sampleRate = 48000;
    CHECK(callback(context, block));
    for (unsigned frame = 0; frame < 4; ++frame) CHECK(left[frame] == expected && right[frame] == expected);
  }
};
bool song(void*, const AudioHostRenderBlock& block) noexcept {
  for (unsigned ch = 0; ch < block.outputChannels; ++ch)
    for (unsigned frame = 0; frame < block.frames; ++frame) block.output[ch][frame] = 0.25F;
  return true;
}
bool cue(void*, const AudioHostRenderBlock& block) noexcept {
  for (unsigned ch = 0; ch < block.outputChannels; ++ch)
    for (unsigned frame = 0; frame < block.frames; ++frame) block.output[ch][frame] += 0.5F;
  return true;
}
int main() {
  auto owned = std::make_unique<TestBackend>(); auto* backend = owned.get();
  SharedAudioService service(std::move(owned));
  CHECK(service.initialize().ok);
  CHECK(service.ensureOutput().ok);
  CHECK(service.inputDevices().size() == 1);
  CHECK(service.inputDevices().size() == 1);
  CHECK(backend->enumerations == 1 && service.enumerationCount() == 1);
  CHECK(backend->opens == 1 && backend->starts == 1);
  backend->render(0);
  auto client = service.playbackBackend(std::make_unique<TestBackend>(), "");
  AudioHostConfig config; config.outputDeviceUid = "selected";
  config.outputChannels = {0, 1}; config.requestedSampleRate = 48000;
  CHECK(client->open(config, song, nullptr).ok);
  CHECK(client->start().ok);
  service.setTrainingRenderer(cue, nullptr);
  backend->render(0.75F);
  CHECK(client->status().callbacks == 1 && client->status().renderedFrames == 4);
  CHECK(client->suspend().ok);
  backend->render(0.5F);
  CHECK(client->status().renderedFrames == 4);
  CHECK(client->resume().ok);
  backend->render(0.75F);
  client->stop();
  backend->render(0.5F);
  service.clearTrainingRenderer(); backend->render(0);
  CHECK(backend->opens == 1 && backend->starts == 1);
  CHECK(service.initialize().ok && backend->opens == 1);
  CHECK(service.enumerationCount() == 1);
  service.refreshInventory(); CHECK(service.enumerationCount() == 2);
  CHECK(service.inventoryRevision() == 2);
  CHECK(service.configureOutput("selected").ok);
  backend->preferredPresent = false; backend->defaultUid = "alternate";
  service.refreshInventory();
  CHECK(service.ensureOutput().ok && backend->lastConfig.outputDeviceUid == "alternate");
  CHECK(backend->lastConfig.requestedSampleRate == 44100);
  backend->preferredPresent = true; service.refreshInventory();
  CHECK(service.ensureOutput().ok && backend->lastConfig.outputDeviceUid == "selected");
  CHECK(service.configureOutput("").ok && backend->lastConfig.outputDeviceUid == "alternate");
  backend->defaultUid = "selected"; service.refreshInventory();
  CHECK(service.ensureOutput().ok && backend->lastConfig.outputDeviceUid == "selected");
  CHECK(!service.configureOutput("missing").ok);
  // A suspended song restores its own prepared format after training changes output.
  CHECK(client->open(config,song,nullptr).ok);
  CHECK(client->start().ok); CHECK(client->suspend().ok);
  CHECK(service.configureOutput("alternate").ok);
  CHECK(client->resume().ok);
  CHECK(backend->lastConfig.outputDeviceUid == "selected" && backend->lastConfig.requestedSampleRate == 48000);
  client->stop();
  // A pinned device stays pinned even if it was the default when attached.
  backend->defaultUid = "selected";
  service.refreshInventory();
  CHECK(service.configureOutput("selected").ok);
  CHECK(client->open(config, song, nullptr).ok);
  CHECK(client->start().ok);
  backend->defaultUid = "alternate";
  service.refreshInventory();
  CHECK(service.ensureOutput().ok);
  CHECK(backend->lastConfig.outputDeviceUid == "selected");
  CHECK(client->status().state == AudioHostState::Running);
  client->stop();
  // Training must retain a song's explicit non-default endpoint.
  backend->defaultUid = "alternate";
  service.refreshInventory();
  CHECK(client->open(config, song, nullptr).ok);
  CHECK(client->start().ok);
  CHECK(service.ensureOutput().ok);
  CHECK(backend->lastConfig.outputDeviceUid == "selected");
  CHECK(client->status().state == AudioHostState::Running);
  service.refreshInventory();
  CHECK(service.ensureOutput().ok);
  CHECK(backend->lastConfig.outputDeviceUid == "selected");
  client->stop();
  client.reset();
  service.shutdown();
}
