#include "zcore/platform/windows/audio_host_asio.h"
#include "zcore/platform/windows/audio_host_windows_provider.h"

#include <array>
#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <new>
#include <string>
#include <utility>

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

namespace {

std::atomic<bool> trackAllocations{false};
std::atomic<uint32_t> allocations{0};

}  // namespace

void *operator new(std::size_t size) {
  if (trackAllocations.load(std::memory_order_relaxed))
    allocations.fetch_add(1, std::memory_order_relaxed);
  if (void *memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}

void operator delete(void *memory) noexcept { std::free(memory); }
void operator delete(void *memory, std::size_t) noexcept { std::free(memory); }

namespace {

class FakeAsioDriver final : public singz::AsioDriverApi {
 public:
  singz::AsioDriverProbe probe() const override {
    return {runtimeAvailable,
            runtimeAvailable ? "Fake ASIO runtime ready"
                             : "No fake ASIO drivers are installed"};
  }

  singz::AsioDriverInventory enumerate() const override {
    singz::AsioDriverDevice device;
    device.uid = "asio:test-driver";
    device.label = "SingZ fake ASIO";
    device.inputChannels = 4;
    device.outputChannels = 4;
    device.inputChannelLabels = {"Mic 1", "Mic 2", "Mic 3", "Mic 4"};
    device.outputChannelLabels = {"Out 1", "Out 2", "Out 3", "Out 4"};
    device.sampleRates = {44100.0, 48000.0};
    device.bufferFrames = {64, 256, 128, 64};
    device.inputLatencyFrames = 32;
    device.outputLatencyFrames = 48;
    return {{std::move(device)}, "asio:test-driver"};
  }

  singz::AsioDriverOpenResult open(
      const singz::AsioDriverOpenConfig &request,
      singz::AsioDriverCallbacks supplied) override {
    ++openCalls;
    config = request;
    callbacks = supplied;
    if (openFailure != singz::AsioDriverError::None) {
      state = openFailure == singz::AsioDriverError::DeviceNotFound ||
                      openFailure == singz::AsioDriverError::DeviceLost
                  ? singz::AsioDriverState::DeviceLost
                  : singz::AsioDriverState::Error;
      return {false, openFailure, state, 0, 0, 0, 0, 0, 0, 0, false,
              "Injected ASIO open failure"};
    }
    state = singz::AsioDriverState::Open;
    const uint32_t openedBufferFrames =
        reportedBufferFrames == 0 ? request.bufferFrames
                                  : reportedBufferFrames;
    const uint32_t openedMaximumFrames =
        reportedMaximumFrames == 0 ? request.maximumFrames
                                   : reportedMaximumFrames;
    return {true,
            singz::AsioDriverError::None,
            state,
            request.sampleRate,
            openedBufferFrames,
            openedMaximumFrames,
            static_cast<uint32_t>(request.inputChannels.size()),
            static_cast<uint32_t>(request.outputChannels.size()),
            32,
            48,
            float32Planar,
            {}};
  }

  singz::AsioDriverResult start() override {
    ++startCalls;
    if (startFailure != singz::AsioDriverError::None) {
      state = startFailure == singz::AsioDriverError::DeviceLost
                  ? singz::AsioDriverState::DeviceLost
                  : singz::AsioDriverState::Error;
      return {false, startFailure, state, "Injected ASIO start failure"};
    }
    state = singz::AsioDriverState::Running;
    return {true, singz::AsioDriverError::None, state, {}};
  }

  void stop() noexcept override {
    ++stopCalls;
    state = singz::AsioDriverState::Stopped;
  }

  singz::AsioDriverStatus status() const noexcept override {
    return {state, singz::AsioDriverError::None};
  }

  bool emit(uint32_t frames, uint64_t samplePosition, bool xrun = false,
            bool deadline = false, uint32_t outputChannels = 2) noexcept {
    for (uint32_t frame = 0; frame < frames && frame < 256; ++frame)
      inputStorage[frame] = static_cast<float>(frame + 1) / 256.0F;
    const float *inputs[] = {inputStorage.data()};
    float *outputs[] = {outputLeft.data(), outputRight.data()};
    singz::AsioDriverProcessBlock block;
    block.input = inputs;
    block.output = outputs;
    block.inputChannels = 1;
    block.outputChannels = outputChannels;
    block.frames = frames;
    block.samplePosition = samplePosition;
    block.systemTimeNs = 10'000 + samplePosition;
    block.samplePositionValid = true;
    block.systemTimeValid = true;
    block.xrun = xrun;
    block.deadlineMiss = deadline;
    return callbacks.process && callbacks.process(callbacks.context, block);
  }

  void terminate(singz::AsioDriverError error) noexcept {
    if (callbacks.terminal) callbacks.terminal(callbacks.context, error);
  }

  bool runtimeAvailable{true};
  bool float32Planar{true};
  uint32_t reportedBufferFrames{0};
  uint32_t reportedMaximumFrames{0};
  singz::AsioDriverError openFailure{singz::AsioDriverError::None};
  singz::AsioDriverError startFailure{singz::AsioDriverError::None};
  singz::AsioDriverState state{singz::AsioDriverState::Closed};
  singz::AsioDriverOpenConfig config{};
  singz::AsioDriverCallbacks callbacks{};
  uint32_t openCalls{0};
  uint32_t startCalls{0};
  uint32_t stopCalls{0};
  std::array<float, 256> inputStorage{};
  std::array<float, 256> outputLeft{};
  std::array<float, 256> outputRight{};
};

struct RenderObservation {
  uint32_t calls{0};
  uint32_t discontinuities[4]{};
  bool valid{true};
};

bool render(void *context, const singz::AudioHostRenderBlock &block) noexcept {
  auto *observation = static_cast<RenderObservation *>(context);
  const uint32_t index = observation->calls++;
  if (index < 4) observation->discontinuities[index] = block.discontinuity;
  observation->valid =
      observation->valid && block.sampleRate == 48000.0 &&
      block.maximumFrames == 256 && block.inputChannels == 1 &&
      block.outputChannels == 2 && block.outputClockMaster &&
      block.outputTimestampValid && block.outputTimestampHardware &&
      block.inputTimestampValid && block.inputTimestampHardware &&
      block.clockDomain != 0 && block.routeGeneration != 0 &&
      block.streamGeneration != 0;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    for (uint32_t frame = 0; frame < block.frames; ++frame)
      block.output[channel][frame] = block.input[0][frame];
  }
  return true;
}

singz::AudioHostConfig config() {
  singz::AudioHostConfig result;
  result.inputDeviceUid = "asio:test-driver";
  result.outputDeviceUid = "asio:test-driver";
  result.inputChannels = {2};
  result.outputChannels = {1, 3};
  result.requestedSampleRate = 48000.0;
  result.requestedBufferFrames = 128;
  result.maximumFrames = 256;
  result.exclusive = true;
  return result;
}

void providerSelectionNeverFallsBack() {
  const auto wasapi = singz::probeWindowsAudioHostProvider(
      singz::WindowsAudioHostProvider::Wasapi);
  CHECK(wasapi.compiled);
  CHECK(wasapi.available);
  CHECK(wasapi.error == singz::WindowsAudioHostProviderError::None);

  const auto asio = singz::probeWindowsAudioHostProvider(
      singz::WindowsAudioHostProvider::Asio);
  CHECK(!asio.compiled);
  CHECK(!asio.available);
  CHECK(asio.error == singz::WindowsAudioHostProviderError::NotCompiled);
  CHECK(asio.detail == singz::kAsioSdkUnavailableReason);

  singz::AudioHost selected(singz::createWindowsAudioHostBackend(
      singz::WindowsAudioHostProvider::Asio));
  RenderObservation observation;
  const auto opened = selected.open(config(), render, &observation);
  CHECK(!opened.ok);
  CHECK(opened.error == singz::AudioHostError::Unsupported);
  CHECK(opened.state == singz::AudioHostState::Unsupported);
  CHECK(opened.message == singz::kAsioSdkUnavailableReason);
  CHECK(selected.status().state == singz::AudioHostState::Unsupported);
}

void providerProbeSeparatesBuildAndRuntime() {
  FakeAsioDriver driver;
  driver.runtimeAvailable = false;
  const auto absent = singz::AsioAudioHostProvider::probe(driver);
  CHECK(absent.compiled);
  CHECK(!absent.available);
  CHECK(absent.error ==
        singz::AsioProviderAvailabilityError::RuntimeUnavailable);
  driver.runtimeAvailable = true;
  const auto ready = singz::AsioAudioHostProvider::probe(driver);
  CHECK(ready.compiled);
  CHECK(ready.available);
  CHECK(ready.error == singz::AsioProviderAvailabilityError::None);
}

void fakeDriverLifecycleAndRealtimeCallback() {
  auto owned = std::make_unique<FakeAsioDriver>();
  FakeAsioDriver *driver = owned.get();
  singz::AudioHost host(
      singz::AsioAudioHostProvider::create(std::move(owned)));
  const auto inventory = host.enumerate();
  CHECK(inventory.devices.size() == 1);
  CHECK(inventory.defaultInputUid == "asio:test-driver");
  CHECK(inventory.defaultOutputUid == "asio:test-driver");
  CHECK(inventory.devices[0].direction ==
        singz::AudioHostEndpointDirection::Duplex);
  CHECK(inventory.devices[0].accessMode ==
        singz::AudioHostAccessMode::Exclusive);
  CHECK(inventory.devices[0].monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::LowLatency);
  CHECK(inventory.devices[0].inputChannelLabels[2] == "Mic 3");
  CHECK(inventory.devices[0].outputChannelLabels[3] == "Out 4");

  RenderObservation observation;
  const auto opened = host.open(config(), render, &observation);
  CHECK(opened.ok);
  CHECK(driver->openCalls == 1);
  CHECK(driver->config.inputChannels == std::vector<uint32_t>{2});
  CHECK(driver->config.outputChannels == (std::vector<uint32_t>{1, 3}));
  CHECK(opened.format.float32Planar);
  CHECK(opened.format.accessMode == singz::AudioHostAccessMode::Exclusive);
  CHECK(opened.latency.inputDeviceFrames == 32);
  CHECK(opened.latency.outputDeviceFrames == 48);
  CHECK(opened.latency.bufferFrames == 128);
  CHECK(host.start().ok);
  CHECK(driver->startCalls == 1);

  allocations.store(0, std::memory_order_relaxed);
  trackAllocations.store(true, std::memory_order_release);
  CHECK(driver->emit(64, 0, true, true));
  CHECK(driver->emit(96, 100));
  trackAllocations.store(false, std::memory_order_release);
  CHECK(allocations.load(std::memory_order_relaxed) == 0);
  CHECK(observation.calls == 2);
  CHECK(observation.valid);
  CHECK(driver->outputLeft[63] == driver->inputStorage[63]);
  CHECK((observation.discontinuities[0] &
         singz::AudioHostDiscontinuityStart) != 0);
  CHECK((observation.discontinuities[0] &
         singz::AudioHostDiscontinuityXRun) != 0);
  CHECK((observation.discontinuities[1] &
         singz::AudioHostDiscontinuitySequenceGap) != 0);

  const auto running = host.status();
  CHECK(running.state == singz::AudioHostState::Running);
  CHECK(running.callbacks == 2);
  CHECK(running.renderedFrames == 160);
  CHECK(running.xruns == 1);
  CHECK(running.deadlineMisses == 1);
  CHECK(running.discontinuities == 2);
  CHECK(running.invalidCallbacks == 0);
  CHECK(running.renderFailures == 0);
  host.stop();
  CHECK(driver->stopCalls == 1);
  CHECK(host.status().state == singz::AudioHostState::Stopped);
}

void fakeDriverFailuresAndContainment() {
  {
    auto owned = std::make_unique<FakeAsioDriver>();
    FakeAsioDriver *driver = owned.get();
    driver->openFailure = singz::AsioDriverError::DeviceNotFound;
    singz::AudioHost host(
        singz::AsioAudioHostProvider::create(std::move(owned)));
    RenderObservation observation;
    const auto opened = host.open(config(), render, &observation);
    CHECK(!opened.ok);
    CHECK(opened.error == singz::AudioHostError::DeviceNotFound);
    CHECK(opened.state == singz::AudioHostState::DeviceLost);
    CHECK(driver->stopCalls == 0);
  }
  {
    auto owned = std::make_unique<FakeAsioDriver>();
    FakeAsioDriver *driver = owned.get();
    driver->float32Planar = false;
    singz::AudioHost host(
        singz::AsioAudioHostProvider::create(std::move(owned)));
    RenderObservation observation;
    const auto opened = host.open(config(), render, &observation);
    CHECK(!opened.ok);
    CHECK(opened.error == singz::AudioHostError::ProviderFailure);
    CHECK(opened.state == singz::AudioHostState::Error);
    CHECK(driver->stopCalls == 1);
  }
  {
    auto owned = std::make_unique<FakeAsioDriver>();
    FakeAsioDriver *driver = owned.get();
    // A nominal 128-frame callback cannot fit inside a driver-advertised
    // 64-frame maximum. Accepting this would make every legal nominal callback
    // violate AudioHost's callback bound before rendering starts.
    driver->reportedBufferFrames = 128;
    driver->reportedMaximumFrames = 64;
    singz::AudioHost host(
        singz::AsioAudioHostProvider::create(std::move(owned)));
    RenderObservation observation;
    const auto opened = host.open(config(), render, &observation);
    CHECK(!opened.ok);
    CHECK(opened.error == singz::AudioHostError::ProviderFailure);
    CHECK(opened.state == singz::AudioHostState::Error);
    CHECK(opened.message ==
          "The ASIO driver returned a mismatched callback format");
    CHECK(driver->stopCalls == 1);
    CHECK(host.status().callbacks == 0);
  }
  {
    auto owned = std::make_unique<FakeAsioDriver>();
    FakeAsioDriver *driver = owned.get();
    driver->startFailure = singz::AsioDriverError::DeviceLost;
    singz::AudioHost host(
        singz::AsioAudioHostProvider::create(std::move(owned)));
    RenderObservation observation;
    CHECK(host.open(config(), render, &observation).ok);
    const auto started = host.start();
    CHECK(!started.ok);
    CHECK(started.error == singz::AudioHostError::DeviceNotFound);
    CHECK(started.state == singz::AudioHostState::DeviceLost);
    CHECK(host.status().terminalReason ==
          singz::AudioHostTerminalReason::DeviceLost);
  }
  {
    auto owned = std::make_unique<FakeAsioDriver>();
    FakeAsioDriver *driver = owned.get();
    singz::AudioHost host(
        singz::AsioAudioHostProvider::create(std::move(owned)));
    RenderObservation observation;
    CHECK(host.open(config(), render, &observation).ok);
    CHECK(host.start().ok);
    CHECK(!driver->emit(64, 0, false, false, 1));
    CHECK(observation.calls == 0);
    CHECK(host.status().invalidCallbacks == 1);
    driver->terminate(singz::AsioDriverError::DeviceLost);
    const auto lost = host.status();
    CHECK(lost.state == singz::AudioHostState::DeviceLost);
    CHECK(lost.terminalReason == singz::AudioHostTerminalReason::DeviceLost);
    CHECK(lost.terminalOrdinal != 0);
    CHECK(!driver->emit(64, 64));
    CHECK(host.status().invalidCallbacks == 2);
  }
}

void invalidProfilesFailBeforeDriverOpen() {
  auto owned = std::make_unique<FakeAsioDriver>();
  FakeAsioDriver *driver = owned.get();
  singz::AudioHost host(
      singz::AsioAudioHostProvider::create(std::move(owned)));
  RenderObservation observation;
  auto shared = config();
  shared.exclusive = false;
  CHECK(host.open(shared, render, &observation).error ==
        singz::AudioHostError::InvalidConfiguration);
  auto duplicate = config();
  duplicate.outputChannels = {1, 1};
  CHECK(host.open(duplicate, render, &observation).error ==
        singz::AudioHostError::InvalidConfiguration);
  auto wrongRate = config();
  wrongRate.requestedSampleRate = 96000.0;
  CHECK(host.open(wrongRate, render, &observation).error ==
        singz::AudioHostError::InvalidConfiguration);
  CHECK(driver->openCalls == 0);
}

}  // namespace

int main() {
  providerSelectionNeverFallsBack();
  providerProbeSeparatesBuildAndRuntime();
  fakeDriverLifecycleAndRealtimeCallback();
  fakeDriverFailuresAndContainment();
  invalidProfilesFailBeforeDriverOpen();
  std::puts("audio_host_asio_tests passed");
  return 0;
}
