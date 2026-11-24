#include "native/playback/shared_audio_service.h"
#include "third_party/zcore/zcore/platform/macos/audio_device_macos_buffer.h"
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <chrono>
#include <mutex>
#include <thread>

#define CHECK(value) do { if (!(value)) { std::fprintf(stderr, "failed line %d: %s\n", __LINE__, #value); std::abort(); } } while (false)
using namespace singz;

struct BufferAccess {
  std::string uid{"selected"}; uint32_t frames{512};
  const std::string& deviceUid() const { return uid; }
  uint64_t deviceIdentity() const { return 7; }
  bool identityMatches() const { return true; }
  bool isSettable() const { return true; }
  bool readFrames(uint32_t& value) const { value = frames; return true; }
  bool readRange(uint32_t& minimum, uint32_t& maximum) const { minimum = 16; maximum = 4096; return true; }
  bool writeFrames(uint32_t value) { frames = value; return true; }
};

class TestBackend final : public AudioHostBackend {
 public:
  mutable unsigned enumerations{0};
  unsigned opens{0}, starts{0}, stops{0};
  AudioHostRender callback{nullptr};
  void* context{nullptr};
  AudioHostStatus current;
  AudioHostConfig lastConfig;
  bool preferredPresent = true;
  bool useLedger = false;
  BufferAccess access;
  detail::MacAudioBufferLedger ledger;
  detail::MacAudioBufferOwnership lease;
  uint32_t selectedChannels = 2;
  std::string defaultUid = "selected";
  AudioHostInventory enumerate() const override {
    ++enumerations;
    AudioHostDeviceInfo device;
    device.uid = "selected"; device.defaultInput = true;
    device.defaultOutput = true; device.inputChannels = 1;
    device.outputChannels = selectedChannels; device.nominalSampleRate = 48000;
    device.bufferFrames = {16, 4096, 512, 1};
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
    if (useLedger) {
      access.uid = config.outputDeviceUid;
      const auto result = detail::requestMacAudioBuffer(access, config.requestedBufferFrames,
          config.maximumFrames, lease, 0, ledger);
      CHECK(result.ok());
    }
    for (uint32_t channel : config.outputChannels)
      if (config.outputDeviceUid == "selected" && channel >= selectedChannels)
        return {false, AudioHostError::InvalidConfiguration, AudioHostState::Error,
                {}, {}, "Output channel map exceeds active route"};
    current.state = AudioHostState::Open;
    current.terminalReason = AudioHostTerminalReason::None;
    current.terminalOrdinal = 0;
    current.xruns = 0;
    current.format = {config.requestedSampleRate ? config.requestedSampleRate : 48000, config.maximumFrames,
        useLedger ? access.frames : 512, 0, static_cast<uint32_t>(config.outputChannels.size())};
    if (useLedger) current.latency.bufferFrames = access.frames;
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

// HAL delivers buffer notifications asynchronously, often after initialize()
// has returned and several cue activations have already reused the host.
struct ObservedDevice {
  std::atomic<uint32_t> frames{512};
  std::atomic<double> sampleRate{48000};
  std::atomic<bool> present{true}, readable{true};
  std::atomic<unsigned> opens{0}, bufferReads{0};
};
class TestObserver final : public SharedAudioService::InventoryObserver {
 public:
  explicit TestObserver(ObservedDevice& device) : device(device) {}
  void watch(const AudioHostInventory&, std::shared_ptr<std::atomic<bool>> inventory,
             std::shared_ptr<std::atomic<bool>> buffer) override {
    std::lock_guard lock(mutex);
    inventorySignal = std::move(inventory); bufferSignal = std::move(buffer);
  }
  std::optional<uint32_t> bufferFrames(const std::string& uid) const override {
    device.bufferReads.fetch_add(1);
    if (!device.readable.load()) return std::nullopt;
    return uid == "selected" ? device.frames.load() : 512;
  }
  void changed(bool bufferOnly) {
    std::lock_guard lock(mutex);
    (bufferOnly ? bufferSignal : inventorySignal)->store(true, std::memory_order_release);
  }
 private:
  ObservedDevice& device;
  std::mutex mutex;
  std::shared_ptr<std::atomic<bool>> inventorySignal, bufferSignal;
};
class ObservedBackend final : public AudioHostBackend {
 public:
  ObservedBackend(ObservedDevice& device, TestObserver& observer) : device(device), observer(observer) {}
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo selected;
    selected.uid = "selected"; selected.outputChannels = 2;
    selected.nominalSampleRate = device.sampleRate.load();
    selected.bufferFrames = {16, 4096, device.frames.load(), 1};
    auto alternate = selected; alternate.uid = "alternate";
    alternate.bufferFrames.preferredFrames = 512;
    AudioHostInventory inventory;
    inventory.devices.push_back(alternate);
    if (device.present.load()) inventory.devices.push_back(selected);
    inventory.defaultOutputUid = device.present.load() ? selected.uid : alternate.uid;
    return inventory;
  }
  AudioHostResult open(const AudioHostConfig& config, AudioHostRender, void*) override {
    device.opens.fetch_add(1);
    uint32_t frames = 512;
    if (config.outputDeviceUid == "selected") {
      frames = config.requestedBufferFrames;
      if (device.frames.exchange(frames) != frames) observer.changed(true);
    }
    current.state = AudioHostState::Open;
    current.format = {config.requestedSampleRate, config.maximumFrames, frames, 0, 2};
    return {true, AudioHostError::None, current.state, current.format, {}, {}};
  }
  AudioHostResult start() override {
    current.state = AudioHostState::Running;
    return {true, AudioHostError::None, current.state, current.format, {}, {}};
  }
  void stop() noexcept override { current.state = AudioHostState::Stopped; }
  AudioHostStatus status() const noexcept override { return current; }
 private:
  ObservedDevice& device;
  TestObserver& observer;
  AudioHostStatus current;
};
template<class Predicate> void awaitObservation(Predicate predicate) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!predicate() && std::chrono::steady_clock::now() < deadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  CHECK(predicate());
}
void inventoryNotificationRegression() {
  ObservedDevice device;
  auto observer = std::make_unique<TestObserver>(device); auto* listener = observer.get();
  auto backend = std::make_unique<ObservedBackend>(device, *listener);
  SharedAudioService service(std::move(backend), "coreaudio", std::move(observer));
  CHECK(service.initialize().ok);
  service.setTrainingRenderer(cue, nullptr);
  CHECK(device.frames.load() == 128);
  CHECK(service.inventory().devices.back().bufferFrames.preferredFrames == 128);
  const auto before = service.enumerationCount();
  const auto revision = service.inventoryRevision();
  for (unsigned activation = 0; activation < 40; ++activation) {
    CHECK(service.ensureOutput().ok);
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    if (service.enumerationCount() != before)
      std::fprintf(stderr, "activation %u: inventory %llu -> %llu, opens %u\n", activation,
          static_cast<unsigned long long>(before),
          static_cast<unsigned long long>(service.enumerationCount()), device.opens.load());
    CHECK(service.enumerationCount() == before);
  }
  CHECK(device.bufferReads.load() > 0); // The actual watcher consumed the fake HAL event.
  CHECK(device.opens.load() == 1); // No reopen or ledger request on activation.
  CHECK(service.inventoryRevision() == revision);

  const auto readsBeforeApply = device.bufferReads.load();
  CHECK(service.applyBufferPreferences({{"selected", 64}}).ok);
  CHECK(service.inventory().devices.back().bufferFrames.preferredFrames == 64);
  CHECK(device.opens.load() == 2);
  awaitObservation([&] { return device.bufferReads.load() > readsBeforeApply; });
  // Join the poller's control lock after it has read the property.
  CHECK(service.inventory().devices.back().bufferFrames.preferredFrames == 64);
  CHECK(service.enumerationCount() == before);

  device.frames.store(256); listener->changed(true);
  awaitObservation([&] { return service.enumerationCount() == before + 1; });
  CHECK(service.inventory().devices.back().bufferFrames.preferredFrames == 256);
  CHECK(device.opens.load() == 2); // External period updates do not force a reopen.
  device.sampleRate.store(44100); listener->changed(false);
  awaitObservation([&] { return service.enumerationCount() == before + 2; });
  CHECK(service.inventory().devices.back().nominalSampleRate == 44100);
  CHECK(service.status().format.sampleRate == 44100);
  // A coalesced self buffer event cannot hide a device/default change.
  device.present.store(false); listener->changed(true); listener->changed(false);
  awaitObservation([&] { return service.enumerationCount() == before + 3; });
  CHECK(service.activeOutputUid() == "alternate");
  CHECK(service.inventory().devices.size() == 1);
  // Failed property reads are conservative, rather than suppressing a change.
  device.readable.store(false); listener->changed(true);
  awaitObservation([&] { return service.enumerationCount() == before + 4; });
  service.shutdown();
}
int main() {
  inventoryNotificationRegression();
  {
    auto owned = std::make_unique<TestBackend>(); auto* backend = owned.get();
    backend->useLedger = true;
    SharedAudioService service(std::move(owned), "coreaudio");
    CHECK(service.initialize().ok);
    CHECK(backend->lastConfig.requestedBufferFrames == 128);
    CHECK(backend->access.frames == 128); // Real zCore ledger writes the host's request.
    CHECK(backend->lastConfig.allowSharedDeviceBufferChange);
    AudioInputConfig input; input.deviceUid = "selected";
    CHECK(service.inputBufferConfig(input).requestedBufferFrames == 128);
    CHECK(service.inputBufferConfig(input).allowSharedDeviceBufferChange);
    detail::MacAudioBufferOwnership inputLease;
    const auto inputRequest = service.inputBufferConfig(input);
    CHECK(detail::requestMacAudioBuffer(backend->access, inputRequest.requestedBufferFrames,
        16384, inputLease, inputRequest.maximumAcceptableBufferFrames, backend->ledger, false).ok());
    CHECK(backend->access.frames == 128 && service.status().latency.bufferFrames == 128);
    CHECK(service.applyBufferPreferences({{"selected", 64}}).ok);
    CHECK(service.ensureOutput().ok);
    CHECK(backend->lastConfig.requestedBufferFrames == 64);
    CHECK(backend->access.frames == 64);
    CHECK(service.inputBufferConfig(input).requestedBufferFrames == 64);
    auto songClient = service.playbackBackend(std::make_unique<TestBackend>(), "coreaudio");
    AudioHostConfig songConfig; songConfig.requestedBufferFrames = 512;
    CHECK(songClient->open(songConfig, song, nullptr).ok);
    CHECK(backend->lastConfig.requestedBufferFrames == 64); // Never inherit the caller's 512.
    CHECK(service.applyBufferPreferences({{"selected", 32}}).ok);
    songClient->stop();
    CHECK(service.applyBufferPreferences({{"selected", 32}, {"alternate", 256}}).ok);
    CHECK(service.ensureOutput().ok);
    CHECK(backend->lastConfig.requestedBufferFrames == 32);
    backend->useLedger = false; // The next route has a different physical device.
    CHECK(service.configureOutput("alternate").ok);
    CHECK(backend->lastConfig.requestedBufferFrames == 256);
    CHECK(service.configureOutput("selected").ok);
    CHECK(backend->lastConfig.requestedBufferFrames == 32); // Reconnected route reapplies UID preference.
  }
  // A terminal physical stream does not prevent proving song callback
  // quiescence, and does not force retirement of a training owner's stream.
  for (auto failedState : {AudioHostState::Error, AudioHostState::DeviceLost}) {
    auto failedOwned = std::make_unique<TestBackend>();
    auto* failedBackend = failedOwned.get();
    SharedAudioService failedService(std::move(failedOwned));
    auto failedClient = failedService.playbackBackend(std::make_unique<TestBackend>(), "");
    AudioHostConfig failedConfig;
    failedConfig.outputDeviceUid = "selected";
    failedConfig.outputChannels = {0, 1};
    failedConfig.requestedSampleRate = 48000;
    CHECK(failedClient->open(failedConfig, song, nullptr).ok);
    CHECK(failedClient->start().ok);
    failedService.setTrainingRenderer(cue, nullptr);
    failedBackend->current.state = failedState;
    failedBackend->current.terminalReason = AudioHostTerminalReason::ProviderFailure;
    failedBackend->current.terminalOrdinal = 42;
    failedBackend->current.xruns = 1;
    CHECK(failedClient->status().state == failedState);
    const auto physicalStops = failedBackend->stops;
    failedClient->stop();
    const auto retired = failedClient->status();
    CHECK(retired.state == AudioHostState::Stopped);
    CHECK(retired.terminalReason == AudioHostTerminalReason::ProviderFailure);
    CHECK(retired.terminalOrdinal == 42 && retired.xruns == 1);
    CHECK(failedBackend->current.state == failedState);
    CHECK(failedBackend->stops == physicalStops);
    failedBackend->render(0.5F); // late shared callback cannot call the retired song
    const auto opens = failedBackend->opens;
    CHECK(failedClient->open(failedConfig, song, nullptr).ok);
    CHECK(failedClient->start().ok);
    CHECK(failedBackend->opens > opens);
    CHECK(failedClient->status().state == AudioHostState::Running);
    CHECK(failedClient->status().terminalReason == AudioHostTerminalReason::None);
    failedClient->stop();
    failedService.clearTrainingRenderer();
  }
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
  // Starting capture can reduce a stereo car route to mono under the same UID.
  const auto routeBeforePark = service.outputRouteGeneration();
  const auto stopsBeforePark = backend->stops;
  service.parkOutput();
  CHECK(service.outputRouteGeneration() == routeBeforePark + 1);
  CHECK(backend->stops == stopsBeforePark + 1);
  CHECK(service.status().state == AudioHostState::Stopped);
  backend->selectedChannels = 1;
  service.refreshInventory();
  CHECK(service.ensureOutput().ok);
  CHECK(backend->lastConfig.outputDeviceUid == "selected");
  CHECK(backend->lastConfig.outputChannels == std::vector<uint32_t>{0});
  CHECK(service.status().format.outputChannels == 1);
  const auto monoOpens = backend->opens;
  CHECK(service.ensureOutput().ok && backend->opens == monoOpens);
  // A mono selection remains valid when the route becomes stereo again.
  backend->selectedChannels = 2;
  service.refreshInventory();
  CHECK(service.ensureOutput().ok);
  CHECK(backend->lastConfig.outputChannels == std::vector<uint32_t>{0});
  client.reset();
  service.shutdown();
}
