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
                 block.inputTimestampValid && !block.inputTimestampHardware &&
                 block.inputSourceFrame == value->expectedSource;
  value->expectedSource += block.frames;
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      const float sample = channel < block.inputChannels
                               ? block.input[channel][frame]
                               : 0.0F;
      block.output[channel][frame] = sample;
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
  CHECK(host.status().state == singz::AudioHostState::Closed);
  Observation observation;
  const auto opened = host.open(config(), observe, &observation);
  CHECK(opened.ok);
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

  CHECK(singz::detail::saturatedAudioHostLatency(100, 28) == 128);
  CHECK(singz::detail::saturatedAudioHostLatency(
            std::numeric_limits<uint32_t>::max(), 1) ==
        std::numeric_limits<uint32_t>::max());
  CHECK(singz::detail::saturatedAudioHostLatency(
            std::numeric_limits<uint32_t>::max() - 4, 4) ==
        std::numeric_limits<uint32_t>::max());
}

void testRejectedConfig() {
  singz::AudioHost host(singz::createFakeAudioHostBackend());
  Observation observation;
  auto invalid = config();
  invalid.inputChannels = {8};
  CHECK(!host.open(invalid, observe, &observation).ok);
  invalid = config();
  invalid.inputDeviceUid = "another";
  CHECK(!host.open(invalid, observe, &observation).ok);
  invalid = config();
  invalid.maximumFrames = 64;
  CHECK(!host.open(invalid, observe, &observation).ok);
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

}  // namespace

int main() {
  testFakeLifecycle();
  testRejectedConfig();
  testQuiescentStop();
  testCallbackContainmentAndPolicy();
  testMoveAssignmentStopsDestination();
  testBoundaryHelpers();
  return 0;
}
