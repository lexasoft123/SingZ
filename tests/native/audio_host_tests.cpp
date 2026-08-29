#include <zcore/device/audio_host.h>
#include <zcore/device/audio_host_callback.h>
#include <zcore/device/audio_host_fake.h>

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cmath>
#include <cstdlib>
#include <limits>
#include <memory>
#include <new>
#include <thread>
#include <vector>

#include "tools/native/audio_host_cli.h"
#include "tools/native/json_string.h"
#include "zcore/src/device/audio_host_fifo.h"
#include "zcore/platform/macos/audio_host_macos_helpers.h"

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
}

void* operator new(std::size_t size) {
  if (trackAllocations.load(std::memory_order_relaxed)) {
    allocations.fetch_add(1, std::memory_order_relaxed);
  }
  if (void* memory = std::malloc(size)) return memory;
  throw std::bad_alloc();
}
void operator delete(void* memory) noexcept { std::free(memory); }
void operator delete(void* memory, std::size_t) noexcept { std::free(memory); }

namespace {

struct Observation {
  std::atomic<uint32_t> calls{0};
  std::atomic<bool> release{true};
  std::atomic<bool> entered{false};
  uint32_t sizes[16]{};
  uint64_t sequences[16]{};
  uint64_t sourceFrames[16]{};
  uint64_t expectedSource{0};
  bool expectInput{true};
  bool producedOutput{false};
  bool valid{true};
  bool fail{false};
};

class StopCountingBackend final : public singz::AudioHostBackend {
 public:
  explicit StopCountingBackend(uint32_t* stops) : stops_(stops) {}
  singz::AudioHostInventory enumerate() const override { return {}; }
  singz::AudioHostResult open(const singz::AudioHostConfig&,
                              singz::AudioHostRender, void*) override {
    return {};
  }
  singz::AudioHostResult start() override { return {}; }
  void stop() noexcept override { ++*stops_; }
  singz::AudioHostStatus status() const noexcept override { return {}; }

 private:
  uint32_t* stops_;
};

bool observe(void* context, const singz::AudioHostRenderBlock& block) noexcept {
  auto* value = static_cast<Observation*>(context);
  value->entered.store(true, std::memory_order_release);
  while (!value->release.load(std::memory_order_acquire)) std::this_thread::yield();
  const uint32_t index = value->calls.fetch_add(1, std::memory_order_relaxed);
  if (index < 16) {
    value->sizes[index] = block.frames;
    value->sequences[index] = block.callbackSequence;
    value->sourceFrames[index] = block.inputSourceFrame;
  }
  value->valid = value->valid && block.outputClockMaster && block.clockDomain != 0 &&
                 block.routeGeneration != 0 && block.streamGeneration != 0 &&
                 block.outputHostTimeNs == block.callbackHostTimeNs &&
                 (value->expectInput
                      ? (block.input != nullptr && block.inputChannels != 0 &&
                         block.inputTimestampValid &&
                         !block.inputTimestampHardware &&
                         block.inputSourceFrame == value->expectedSource)
                      : (block.input == nullptr && block.inputChannels == 0 &&
                         !block.inputTimestampValid &&
                         !block.inputTimestampHardware &&
                         block.inputSourceFrame == 0));
  if (value->expectInput) value->expectedSource += block.frames;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      const float sample = value->expectInput
                               ? (channel < block.inputChannels
                                      ? block.input[channel][frame]
                                      : 0.0F)
                               : static_cast<float>((channel + 1) * 100 + frame);
      block.output[channel][frame] = sample;
      value->producedOutput = value->producedOutput || sample != 0.0F;
      value->valid = value->valid && block.output[channel][frame] == sample;
    }
  }
  return !value->fail;
}

singz::AudioHostConfig config() {
  return {"singz:fake-duplex", "singz:fake-duplex", {2, 0}, {1, 3}, 48000.0,
          128, 1024};
}

void waitForStop(singz::AudioHost& host) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(2);
  while (host.status().state == singz::AudioHostState::Running &&
         std::chrono::steady_clock::now() < deadline) {
    std::this_thread::yield();
  }
  CHECK(std::chrono::steady_clock::now() < deadline);
}

void testFakeLifecycle() {
  singz::AudioHost host(singz::createFakeAudioHostBackend({6, true, 3, 4}));
  const auto inventory = host.enumerate();
  CHECK(inventory.devices.size() == 1);
  CHECK(inventory.devices[0].inputChannels == 8);
  CHECK(inventory.devices[0].sampleRateRanges.size() == 3);
  CHECK(inventory.devices[0].sampleRateRanges[1].minimumHz == 48000.0);
  CHECK(inventory.devices[0].bufferFrames.fundamentalFrames == 1);
  CHECK(inventory.devices[0].direction ==
        singz::AudioHostEndpointDirection::Duplex);
  CHECK(inventory.devices[0].transport == singz::AudioHostTransport::Usb);
  CHECK(inventory.devices[0].monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::LowLatency);
  CHECK(host.status().state == singz::AudioHostState::Closed);
  Observation observation;
  const auto opened = host.open(config(), observe, &observation);
  CHECK(opened.ok);
  CHECK(opened.format.accessMode == singz::AudioHostAccessMode::Shared);
  CHECK(opened.latency.inputDeviceFrames == 128);
  CHECK(opened.latency.outputDeviceFrames == 128);
  CHECK(opened.latency.bufferFrames == 128);
  CHECK(opened.latency.externalRouteFrames == 0);
  const uint64_t route = host.status().routeGeneration;
  const uint64_t stream = host.status().streamGeneration;
  CHECK(host.start().ok);
  waitForStop(host);
  host.stop();
  const auto status = host.status();
  CHECK(status.callbacks == 6);
  CHECK(status.xruns == 1);
  CHECK(status.deadlineMisses == 1);
  CHECK(status.discontinuities == 2);
  CHECK(status.renderFailures == 0);
  CHECK(observation.valid);
  CHECK(observation.sizes[0] == 1);
  CHECK(observation.sizes[1] == 128);
  CHECK(observation.sizes[2] == 1024);
  for (uint32_t index = 1; index < 6; ++index) {
    CHECK(observation.sequences[index] == observation.sequences[index - 1] + 1);
    CHECK(observation.sourceFrames[index] ==
          observation.sourceFrames[index - 1] + observation.sizes[index - 1]);
  }
  const auto restart = host.start();
  CHECK(!restart.ok);
  CHECK(restart.error == singz::AudioHostError::InvalidState);
  CHECK(restart.state == singz::AudioHostState::Stopped);
  CHECK(host.open(config(), observe, &observation).ok);
  CHECK(host.status().routeGeneration == route + 1);
  CHECK(host.status().streamGeneration == stream + 1);
}

void testFakeOutputOnlyLifecycle() {
  singz::AudioHost host(singz::createFakeAudioHostBackend({4, false, 0, 0}));
  Observation observation;
  observation.expectInput = false;
  auto outputOnly = config();
  outputOnly.inputDeviceUid.clear();
  outputOnly.inputChannels.clear();
  // The fake proves the provider/callback contract, not CoreAudio's
  // destination-sized channel-map semantics. The macOS helper is tested with
  // both sequential and non-sequential physical selections below.
  outputOnly.outputChannels = {0, 1};
  const auto opened = host.open(outputOnly, observe, &observation);
  CHECK(opened.ok);
  CHECK(opened.format.inputChannels == 0);
  CHECK(opened.format.outputChannels == 2);
  CHECK(opened.format.float32Planar);
  CHECK(opened.format.outputClockMaster);
  CHECK(opened.latency.inputDeviceFrames == 0);
  CHECK(opened.latency.outputDeviceFrames == 128);
  CHECK(opened.latency.bufferFrames == 128);
  CHECK(opened.latency.externalRouteFrames == 0);
  const auto openedStatus = host.status();
  CHECK(openedStatus.routeGeneration != 0);
  CHECK(openedStatus.streamGeneration != 0);
  CHECK(host.start().ok);
  waitForStop(host);
  host.stop();
  CHECK(host.status().callbacks == 4);
  CHECK(host.status().renderedFrames == 512);
  CHECK(observation.calls.load() == 4);
  CHECK(observation.valid);
  CHECK(observation.producedOutput);
  CHECK(!singz::detail::shouldPullMacAudioHostInput(
      opened.format.inputChannels));
  CHECK(singz::detail::shouldPullMacAudioHostInput(1));
  CHECK(!singz::detail::macAudioHostInputTimestampValid(0));
  CHECK(!singz::detail::macAudioHostInputTimestampHardware(0, true));
  CHECK(singz::detail::macAudioHostInputTimestampValid(1));
  CHECK(!singz::detail::macAudioHostInputTimestampHardware(1, false));
  CHECK(singz::detail::macAudioHostInputTimestampHardware(1, true));

  auto inconsistent = outputOnly;
  inconsistent.inputChannels = {0};
  CHECK(!host.open(inconsistent, observe, &observation).ok);
  inconsistent = outputOnly;
  inconsistent.inputDeviceUid = "singz:fake-duplex";
  CHECK(!host.open(inconsistent, observe, &observation).ok);
  inconsistent = outputOnly;
  inconsistent.outputChannels = {1, 1};
  CHECK(!host.open(inconsistent, observe, &observation).ok);
}

void testExclusiveProviderContract() {
  singz::AudioHost fake(singz::createFakeAudioHostBackend({1, false, 0, 0}));
  auto exclusive = config();
  exclusive.exclusive = true;
  Observation observation;
  const auto emulated = fake.open(exclusive, observe, &observation);
  CHECK(emulated.ok);
  CHECK(emulated.format.accessMode == singz::AudioHostAccessMode::Exclusive);
  CHECK(fake.status().format.accessMode ==
        singz::AudioHostAccessMode::Exclusive);
  fake.stop();
#if defined(__APPLE__)
  singz::AudioHost platform;
  exclusive.inputDeviceUid = "singz:test-exclusive";
  exclusive.outputDeviceUid = exclusive.inputDeviceUid;
  const auto rejected = platform.open(exclusive, observe, &observation);
  CHECK(!rejected.ok);
  CHECK(rejected.error == singz::AudioHostError::Unsupported);
  CHECK(rejected.state == singz::AudioHostState::Unsupported);
  CHECK(platform.status().state == rejected.state);
#endif
}

void testMacOutputOnlyDiagnostics() {
#if defined(__APPLE__)
  Observation observation;
  singz::AudioHost platform;
  auto missingOutput = config();
  missingOutput.outputDeviceUid.clear();
  const auto missing = platform.open(missingOutput, observe, &observation);
  CHECK(!missing.ok);
  CHECK(missing.error == singz::AudioHostError::InvalidConfiguration);
  CHECK(missing.message == "AudioHost output device UID must not be empty");

  auto inconsistentInput = config();
  inconsistentInput.inputDeviceUid.clear();
  const auto inconsistent =
      platform.open(inconsistentInput, observe, &observation);
  CHECK(!inconsistent.ok);
  CHECK(inconsistent.error == singz::AudioHostError::InvalidConfiguration);
  CHECK(inconsistent.message ==
        "AudioHost input device UID and channel map must both be empty or both be non-empty");
#endif
}

void testMoveAssignmentStopsDestination() {
  uint32_t destinationStops = 0;
  uint32_t sourceStops = 0;
  singz::AudioHost destination(
      std::make_unique<StopCountingBackend>(&destinationStops));
  singz::AudioHost source(std::make_unique<StopCountingBackend>(&sourceStops));
  destination = std::move(source);
  CHECK(destinationStops == 1);
  CHECK(sourceStops == 0);
  singz::AudioHost* alias = &destination;
  destination = std::move(*alias);
  CHECK(sourceStops == 0);
  destination.stop();
  CHECK(sourceStops == 1);
}

void testBoundaryHelpers() {
  const std::string utf8 = std::string("\xd0\x97") + "en\n\"\\" + '\x01';
  const std::string encoded = singz::tools::jsonString(utf8);
  CHECK(encoded.front() == '"');
  CHECK(encoded.back() == '"');
  CHECK(encoded.find(std::string("\xd0\x97")) != std::string::npos);
  CHECK(encoded.find("\\n") != std::string::npos);
  CHECK(encoded.find("\\\"") != std::string::npos);
  CHECK(encoded.find("\\\\") != std::string::npos);
  CHECK(encoded.find("\\u0001") != std::string::npos);
  CHECK(encoded.find('\n') == std::string::npos);

  uint32_t minimum = 0;
  uint32_t maximum = 0;
  CHECK(singz::detail::checkedAudioHostBufferRange(32.0, 1024.0, &minimum,
                                                   &maximum));
  CHECK(minimum == 32);
  CHECK(maximum == 1024);
  CHECK(!singz::detail::checkedAudioHostBufferRange(
      std::numeric_limits<double>::quiet_NaN(), 1024.0, &minimum, &maximum));
  CHECK(!singz::detail::checkedAudioHostBufferRange(-1.0, 1024.0, &minimum,
                                                    &maximum));
  CHECK(!singz::detail::checkedAudioHostBufferRange(32.5, 1024.0, &minimum,
                                                    &maximum));
  CHECK(!singz::detail::checkedAudioHostBufferRange(1024.0, 32.0, &minimum,
                                                    &maximum));
  CHECK(!singz::detail::checkedAudioHostBufferRange(
      0.0,
      static_cast<double>(std::numeric_limits<uint32_t>::max()) + 1.0,
      &minimum, &maximum));
  CHECK(!singz::detail::checkedAudioHostBufferRange(32.0, 1024.0, nullptr,
                                                    &maximum));
  CHECK(!singz::detail::checkedAudioHostBufferRange(32.0, 1024.0, &minimum,
                                                    nullptr));

  singz::AudioHostStatus terminal;
  terminal.callbacks = 1;
  terminal.state = singz::AudioHostState::Stopped;
  CHECK(singz::tools::audioHostRunExitCode(terminal) == 0);
  CHECK(std::string(singz::tools::audioHostStateName(terminal.state)) ==
        "stopped");
  terminal.callbacks = 0;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.callbacks = 1;
  terminal.renderFailures = 1;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.renderFailures = 0;
  terminal.xruns = 1;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.xruns = 0;
  terminal.deadlineMisses = 1;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.deadlineMisses = 0;
  terminal.invalidCallbacks = 1;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.invalidCallbacks = 0;
  terminal.diagnostics.fifoUnderflows = 1;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.diagnostics.fifoUnderflows = 0;
  terminal.diagnostics.fifoOverflows = 1;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.diagnostics.fifoOverflows = 0;
  terminal.diagnostics.startupInputZeroFrames = 1;
  CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
  terminal.diagnostics.startupInputZeroFrames = 0;
  const singz::AudioHostState failures[] = {
      singz::AudioHostState::Closed,     singz::AudioHostState::Open,
      singz::AudioHostState::Running,    singz::AudioHostState::DeviceLost,
      singz::AudioHostState::Error,      singz::AudioHostState::Unsupported};
  const char* names[] = {"closed", "open", "running", "device-lost",
                         "error", "unsupported"};
  for (size_t index = 0; index < std::size(failures); ++index) {
    terminal.state = failures[index];
    CHECK(singz::tools::audioHostRunExitCode(terminal) != 0);
    CHECK(std::string(singz::tools::audioHostStateName(terminal.state)) ==
          names[index]);
  }

  uint32_t parsed = 0;
  CHECK(singz::tools::parseAudioHostUint32(nullptr, 123, &parsed));
  CHECK(parsed == 123);
  CHECK(singz::tools::parseAudioHostUint32("0", 123, &parsed));
  CHECK(parsed == 0);
  CHECK(singz::tools::parseAudioHostUint32("4294967295", 0, &parsed));
  CHECK(parsed == std::numeric_limits<uint32_t>::max());
  CHECK(!singz::tools::parseAudioHostUint32("4294967297", 0, &parsed));
  CHECK(!singz::tools::parseAudioHostUint32("-1", 0, &parsed));
  CHECK(!singz::tools::parseAudioHostUint32("12junk", 0, &parsed));
  CHECK(!singz::tools::parseAudioHostUint32(
      "999999999999999999999999999999999999", 0, &parsed));
  CHECK(!singz::tools::parseAudioHostUint32("", 0, &parsed));
  CHECK(!singz::tools::parseAudioHostUint32("1", 0, nullptr));
  std::vector<uint32_t> parsedChannels;
  CHECK(singz::tools::parseAudioHostChannelList("0,3,4294967295",
                                                &parsedChannels));
  CHECK(parsedChannels ==
        std::vector<uint32_t>({0, 3, std::numeric_limits<uint32_t>::max()}));
  CHECK(!singz::tools::parseAudioHostChannelList(" 0", &parsedChannels));
  CHECK(!singz::tools::parseAudioHostChannelList("0, 1", &parsedChannels));
  CHECK(!singz::tools::parseAudioHostChannelList("-1", &parsedChannels));
  CHECK(!singz::tools::parseAudioHostChannelList("4294967296",
                                                 &parsedChannels));
  CHECK(!singz::tools::parseAudioHostChannelList("0,", &parsedChannels));
  CHECK(!singz::tools::parseAudioHostChannelList(",0", &parsedChannels));
  CHECK(!singz::tools::parseAudioHostChannelList("", &parsedChannels));
  CHECK(!singz::tools::parseAudioHostChannelList("0", nullptr));

  CHECK(singz::detail::saturatedAudioHostLatency(100, 28) == 128);
  CHECK(singz::detail::saturatedAudioHostLatency(
            std::numeric_limits<uint32_t>::max(), 1) ==
        std::numeric_limits<uint32_t>::max());
  CHECK(singz::detail::saturatedAudioHostLatency(
            std::numeric_limits<uint32_t>::max() - 4, 4) ==
        std::numeric_limits<uint32_t>::max());
  const auto usb = singz::detail::classifyMacAudioHostTransport(
      singz::detail::audioHostFourCc('u', 's', 'b', ' '));
  CHECK(usb.transport == singz::AudioHostTransport::Usb &&
        usb.monitoringSuitability ==
            singz::AudioHostMonitoringSuitability::LowLatency);
  const auto bluetooth = singz::detail::classifyMacAudioHostTransport(
      singz::detail::audioHostFourCc('b', 'l', 'u', 'e'));
  CHECK(bluetooth.transport == singz::AudioHostTransport::Bluetooth &&
        bluetooth.monitoringSuitability ==
            singz::AudioHostMonitoringSuitability::HighLatency);
  const auto airPlay = singz::detail::classifyMacAudioHostTransport(
      singz::detail::audioHostFourCc('a', 'i', 'r', 'p'));
  CHECK(airPlay.transport == singz::AudioHostTransport::AirPlay &&
        airPlay.monitoringSuitability ==
            singz::AudioHostMonitoringSuitability::HighLatency);
  CHECK(singz::detail::classifyMacAudioHostTransport(0)
            .monitoringSuitability ==
        singz::AudioHostMonitoringSuitability::Unknown);

  std::vector<int32_t> outputMap;
  CHECK(singz::detail::buildMacAudioHostOutputChannelMap(
      {0, 1}, 4, &outputMap));
  CHECK(outputMap == std::vector<int32_t>({0, 1, -1, -1}));
  CHECK(singz::detail::buildMacAudioHostOutputChannelMap(
      {7, 1}, 8, &outputMap));
  CHECK(outputMap ==
        std::vector<int32_t>({-1, 1, -1, -1, -1, -1, -1, 0}));
  CHECK(!singz::detail::buildMacAudioHostOutputChannelMap(
      {}, 8, &outputMap));
  CHECK(outputMap.empty());
  CHECK(!singz::detail::buildMacAudioHostOutputChannelMap(
      {1, 1}, 8, &outputMap));
  CHECK(outputMap.empty());
  CHECK(!singz::detail::buildMacAudioHostOutputChannelMap(
      {8}, 8, &outputMap));
  CHECK(outputMap.empty());
  CHECK(!singz::detail::buildMacAudioHostOutputChannelMap(
      {0}, 0, &outputMap));
  CHECK(!singz::detail::buildMacAudioHostOutputChannelMap(
      {0}, singz::kAudioHostMaxChannels + 1, &outputMap));
  CHECK(!singz::detail::buildMacAudioHostOutputChannelMap(
      {0}, 1, nullptr));
}

void testRejectedConfig() {
  singz::AudioHost host(singz::createFakeAudioHostBackend());
  Observation observation;
  auto invalid = config();
  invalid.inputChannels = {8};
  auto rejected = host.open(invalid, observe, &observation);
  CHECK(!rejected.ok);
  CHECK(host.status().state == rejected.state);
  invalid = config();
  invalid.inputDeviceUid = "another";
  rejected = host.open(invalid, observe, &observation);
  CHECK(!rejected.ok);
  CHECK(host.status().state == rejected.state);
  invalid = config();
  invalid.maximumFrames = 64;
  rejected = host.open(invalid, observe, &observation);
  CHECK(!rejected.ok);
  CHECK(host.status().state == rejected.state);
}

void testQuiescentStop() {
  singz::AudioHost host(singz::createFakeAudioHostBackend({100, false, 0, 0}));
  Observation observation;
  observation.release.store(false);
  CHECK(host.open(config(), observe, &observation).ok);
  CHECK(host.start().ok);
  while (!observation.entered.load(std::memory_order_acquire)) std::this_thread::yield();
  std::atomic<bool> stopped{false};
  std::thread stopper([&] {
    host.stop();
    stopped.store(true, std::memory_order_release);
  });
  std::this_thread::yield();
  CHECK(!stopped.load(std::memory_order_acquire));
  observation.release.store(true, std::memory_order_release);
  stopper.join();
  CHECK(stopped.load(std::memory_order_acquire));
  const uint32_t calls = observation.calls.load();
  std::this_thread::yield();
  CHECK(observation.calls.load() == calls);
}

void testCallbackContainmentAndPolicy() {
  CHECK(singz::audioHostFinalActionFlags(0, 4, true) == 4);
  CHECK(singz::audioHostFinalActionFlags(7, 4, false) == 3);
  CHECK(!singz::audioHostInputPullFailed(0, 0, 8));
  CHECK(singz::audioHostInputPullFailed(-1, 0, 8));
  CHECK(singz::audioHostInputPullFailed(0, 8, 8));

  singz::AudioHostOutputTimeline timeline;
  auto resolved = singz::resolveAudioHostOutputTimeline(
      &timeline, true, 100, true, 16, 0);
  CHECK(resolved.outputFrame == 100);
  CHECK(resolved.discontinuity == singz::AudioHostDiscontinuityNone);
  resolved = singz::resolveAudioHostOutputTimeline(
      &timeline, true, 116, true, 16, 0);
  CHECK(resolved.discontinuity == singz::AudioHostDiscontinuityNone);
  resolved = singz::resolveAudioHostOutputTimeline(
      &timeline, false, 0, false, 16, 132);
  CHECK(resolved.outputFrame == 132);
  CHECK((resolved.discontinuity &
         singz::AudioHostDiscontinuityTimestampQualityChanged) != 0);
  resolved = singz::resolveAudioHostOutputTimeline(
      &timeline, false, 0, false, 16, 148);
  CHECK(resolved.discontinuity == singz::AudioHostDiscontinuityNone);
  resolved = singz::resolveAudioHostOutputTimeline(
      &timeline, true, 164, false, 16, 0);
  CHECK((resolved.discontinuity &
         singz::AudioHostDiscontinuityTimestampQualityChanged) != 0);
  resolved = singz::resolveAudioHostOutputTimeline(
      &timeline, true, 180, true, 16, 0);
  CHECK((resolved.discontinuity &
         singz::AudioHostDiscontinuityTimestampQualityChanged) != 0);
  resolved = singz::resolveAudioHostOutputTimeline(
      &timeline, true, 212, true, 16, 0);
  CHECK((resolved.discontinuity &
         singz::AudioHostDiscontinuitySequenceGap) != 0);

  CHECK(singz::advanceAudioHostFrame(UINT64_MAX - 2, 8) == UINT64_MAX);
  CHECK(singz::advanceAudioHostFrame(10, 8) == 18);
  CHECK(!singz::validAudioHostSampleFrame(
      std::numeric_limits<double>::quiet_NaN(), 8));
  CHECK(!singz::validAudioHostSampleFrame(
      std::numeric_limits<double>::infinity(), 8));
  CHECK(!singz::validAudioHostSampleFrame(18446744073709551616.0, 8));
  CHECK(singz::validAudioHostSampleFrame(
      std::nextafter(18446744073709551616.0, 0.0), 8));
  CHECK(singz::validAudioHostSampleFrame(1024.0, 8));
  float outputSamples[8];
  float* output[] = {outputSamples};
  float inputSamples[8]{};
  const float* input[] = {inputSamples};
  singz::AudioHostRenderBlock block{input, output, 1, 1, 8, 8, 48000.0,
                                    1, 1, 1, 0, 0, 0, true, false,
                                    0, 1, 1, singz::AudioHostDiscontinuityNone, true};
  singz::AudioHostCallbackEndpoint endpoint;
  for (float& sample : outputSamples) sample = 1.0F;
  CHECK(!singz::invokeAudioHostCallback(&endpoint, block));
  for (float sample : outputSamples) CHECK(sample == 0.0F);
  Observation observation;
  singz::prepareAudioHostCallback(&endpoint, observe, &observation);
  singz::activateAudioHostCallback(&endpoint);
  block.sampleRate = std::numeric_limits<double>::quiet_NaN();
  CHECK(!singz::invokeAudioHostCallback(&endpoint, block));
  block.sampleRate = 48000.0;
  observation.fail = true;
  for (float& sample : outputSamples) sample = 1.0F;
  allocations.store(0);
  trackAllocations.store(true);
  CHECK(!singz::invokeAudioHostCallback(&endpoint, block));
  trackAllocations.store(false);
  CHECK(allocations.load() == 0);
  for (float sample : outputSamples) CHECK(sample == 0.0F);
  endpoint.xruns.store(std::numeric_limits<uint32_t>::max());
  singz::recordAudioHostXRun(&endpoint);
  CHECK(endpoint.xruns.load() == std::numeric_limits<uint32_t>::max());
}

void testPreparedCaptureFifo() {
  singz::detail::AudioHostPlanarFifo fifo;
  CHECK(!fifo.prepare(0, 8));
  CHECK(fifo.prepare(2, 8));
  const uint32_t map[] = {2, 0};
  const float interleaved[] = {
      10, 11, 12, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52};
  singz::detail::AudioHostCaptureSpan span;
  span.sourceFrame = 100;
  span.sampleHostTimeNs = 1000000;
  span.timestampValid = true;
  span.timestampHardware = true;
  span.discontinuity = singz::AudioHostDiscontinuityStart;
  allocations.store(0);
  trackAllocations.store(true);
  CHECK(fifo.writeInterleavedFloat(interleaved, 3, map, 5, span, false));
  float first0[3]{}, first1[3]{};
  float* first[] = {first0, first1};
  auto read = fifo.read(first, 3, 48000.0);
  trackAllocations.store(false);
  CHECK(allocations.load() == 0);
  CHECK(read.framesRead == 3);
  CHECK(read.sourceFrame == 100);
  CHECK(read.sampleHostTimeNs == 1000000);
  CHECK(read.timestampHardware);
  CHECK(read.discontinuity == singz::AudioHostDiscontinuityStart);
  CHECK(first0[0] == 12 && first0[1] == 22 && first0[2] == 32);
  CHECK(first1[0] == 10 && first1[1] == 20 && first1[2] == 30);

  float second0[4]{9, 9, 9, 9}, second1[4]{9, 9, 9, 9};
  float* second[] = {second0, second1};
  read = fifo.read(second, 4, 48000.0);
  CHECK(read.framesRead == 2);
  CHECK(read.sourceFrame == 103);
  CHECK(read.sampleHostTimeNs == 1062500);
  CHECK((read.discontinuity & singz::AudioHostDiscontinuityXRun) != 0);
  CHECK(second0[0] == 42 && second0[1] == 52 && second0[2] == 0);
  CHECK(second1[0] == 40 && second1[1] == 50 && second1[3] == 0);
  CHECK(fifo.underflows() == 1);
  CHECK(fifo.currentFrames() == 0);
  CHECK(fifo.maximumFrames() == 5);

  float priming0[2]{9, 9}, priming1[2]{9, 9};
  float* priming[] = {priming0, priming1};
  read = fifo.read(priming, 2, 48000.0, false);
  CHECK(read.framesRead == 0);
  CHECK(read.discontinuity == singz::AudioHostDiscontinuityNone);
  CHECK(fifo.underflows() == 1);
  CHECK(priming0[0] == 0 && priming0[1] == 0);
  CHECK(priming1[0] == 0 && priming1[1] == 0);

  CHECK(fifo.writeInterleavedFloat(interleaved, 3, map, 5, span, true));
  CHECK(!fifo.writeInterleavedFloat(interleaved, 3, map, 5, span, false));
  CHECK(fifo.overflows() == 1);
  float silent0[5]{1, 1, 1, 1, 1}, silent1[5]{1, 1, 1, 1, 1};
  float* silent[] = {silent0, silent1};
  read = fifo.read(silent, 5, 48000.0);
  CHECK(read.framesRead == 5);
  for (float sample : silent0) CHECK(sample == 0);
  for (float sample : silent1) CHECK(sample == 0);
  CHECK(fifo.writeInterleavedFloat(interleaved, 3, map, 1, span, false));
  float final0[1]{}, final1[1]{};
  float* final[] = {final0, final1};
  read = fifo.read(final, 1, 48000.0);
  CHECK((read.discontinuity & singz::AudioHostDiscontinuityXRun) != 0);

  fifo.reset();
  CHECK(fifo.writeInterleavedFloat(interleaved, 3, map, 5, span, false));
  float split0[2]{}, split1[2]{};
  float* split[] = {split0, split1};
  read = fifo.read(split, 2, 48000.0);
  CHECK(read.framesRead == 2);
  CHECK(read.discontinuity == singz::AudioHostDiscontinuityStart);
  read = fifo.read(split, 2, 48000.0);
  CHECK(read.framesRead == 2);
  CHECK(read.discontinuity == singz::AudioHostDiscontinuityNone);

  singz::detail::AudioHostPlanarFifo rollover;
  CHECK(rollover.prepare(1, 7));
  CHECK(rollover.capacityFrames() == 8);
  rollover.seedEmptyCursorsForTest(UINT32_MAX - 2, UINT32_MAX);
  const uint32_t monoMap[] = {0};
  const float mono[] = {1, 2, 3, 4, 5};
  singz::detail::AudioHostCaptureSpan rolloverSpan;
  rolloverSpan.sourceFrame = 900;
  CHECK(rollover.writeInterleavedFloat(mono, 1, monoMap, 5,
                                       rolloverSpan, false));
  CHECK(rollover.currentFrames() == 5);
  float rolloverFirst[3]{}, rolloverSecond[3]{};
  float* rolloverFirstOut[] = {rolloverFirst};
  float* rolloverSecondOut[] = {rolloverSecond};
  read = rollover.read(rolloverFirstOut, 3, 48000.0, false);
  CHECK(read.framesRead == 3);
  CHECK(read.sourceFrame == 900);
  CHECK(rolloverFirst[0] == 1 && rolloverFirst[2] == 3);
  read = rollover.read(rolloverSecondOut, 3, 48000.0, false);
  CHECK(read.framesRead == 2);
  CHECK(read.sourceFrame == 903);
  CHECK(rolloverSecond[0] == 4 && rolloverSecond[1] == 5 &&
        rolloverSecond[2] == 0);
  CHECK(rollover.currentFrames() == 0);
}

void testCaptureFifoSpscStress() {
  singz::detail::AudioHostPlanarFifo fifo;
  CHECK(fifo.prepare(1, 1024));
  constexpr uint32_t packetFrames = 16;
  constexpr uint32_t packets = 2000;
  const uint32_t map[] = {0};
  std::atomic<bool> producerDone{false};
  std::atomic<bool> samplesValid{true};
  std::atomic<bool> snapshotValid{true};
  std::thread producer([&] {
    float packet[packetFrames];
    for (uint32_t index = 0; index < packets; ++index) {
      for (float& sample : packet) sample = static_cast<float>(index);
      singz::detail::AudioHostCaptureSpan span;
      span.sourceFrame = static_cast<uint64_t>(index) * packetFrames;
      while (!fifo.writeInterleavedFloat(packet, 1, map, packetFrames, span,
                                         false)) {
        if (fifo.currentFrames() > fifo.capacityFrames())
          snapshotValid.store(false, std::memory_order_relaxed);
        std::this_thread::yield();
      }
      if (fifo.currentFrames() > fifo.capacityFrames())
        snapshotValid.store(false, std::memory_order_relaxed);
    }
    producerDone.store(true, std::memory_order_release);
  });
  std::thread consumer([&] {
    uint32_t consumedPackets = 0;
    while (consumedPackets < packets) {
      float packet[packetFrames]{};
      float* output[] = {packet};
      const auto read = fifo.read(output, packetFrames, 48000.0, false);
      if (fifo.currentFrames() > fifo.capacityFrames())
        snapshotValid.store(false, std::memory_order_relaxed);
      if (read.framesRead != packetFrames) {
        std::this_thread::yield();
        continue;
      }
      for (float sample : packet) {
        if (sample != static_cast<float>(consumedPackets))
          samplesValid.store(false, std::memory_order_relaxed);
      }
      ++consumedPackets;
    }
  });
  producer.join();
  consumer.join();
  CHECK(producerDone.load(std::memory_order_acquire));
  CHECK(samplesValid.load(std::memory_order_relaxed));
  CHECK(snapshotValid.load(std::memory_order_relaxed));
  CHECK(fifo.currentFrames() == 0);
}

}  // namespace

int main() {
  testFakeLifecycle();
  testFakeOutputOnlyLifecycle();
  testExclusiveProviderContract();
  testMacOutputOnlyDiagnostics();
  testRejectedConfig();
  testQuiescentStop();
  testCallbackContainmentAndPolicy();
  testMoveAssignmentStopsDestination();
  testBoundaryHelpers();
  testPreparedCaptureFifo();
  testCaptureFifoSpscStress();
  return 0;
}
