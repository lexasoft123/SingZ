#include <zcore/device/audio_host.h>
#include <zcore/device/audio_host_fake.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>
#include <vector>

#include "audio_host_cli.h"
#include "json_string.h"

namespace {

void printInventory(const singz::AudioHostInventory& inventory) {
  std::cout << "{\"defaultInputUid\":" << singz::tools::jsonString(inventory.defaultInputUid)
            << ",\"defaultOutputUid\":" << singz::tools::jsonString(inventory.defaultOutputUid)
            << ",\"devices\":[";
  for (size_t index = 0; index < inventory.devices.size(); ++index) {
    const auto& device = inventory.devices[index];
    if (index != 0) std::cout << ',';
    std::cout << "{\"uid\":" << singz::tools::jsonString(device.uid) << ",\"label\":"
              << singz::tools::jsonString(device.label) << ",\"defaultInput\":"
              << (device.defaultInput ? "true" : "false")
              << ",\"defaultOutput\":" << (device.defaultOutput ? "true" : "false")
              << ",\"inputChannels\":" << device.inputChannels
              << ",\"outputChannels\":" << device.outputChannels
              << ",\"sampleRate\":" << device.nominalSampleRate
              << ",\"direction\":"
              << singz::tools::jsonString(
                     singz::tools::audioHostDirectionName(device.direction))
              << ",\"accessMode\":"
              << singz::tools::jsonString(
                     singz::tools::audioHostAccessModeName(device.accessMode))
              << ",\"sampleRateRanges\":[";
    for (size_t range = 0; range < device.sampleRateRanges.size(); ++range) {
      if (range != 0) std::cout << ',';
      std::cout << "{\"minimumHz\":"
                << device.sampleRateRanges[range].minimumHz
                << ",\"maximumHz\":"
                << device.sampleRateRanges[range].maximumHz << '}';
    }
    std::cout << ']'
              << ",\"bufferMin\":" << device.bufferFrames.minimumFrames
              << ",\"bufferMax\":" << device.bufferFrames.maximumFrames
              << ",\"bufferPreferred\":" << device.bufferFrames.preferredFrames
              << ",\"bufferFundamental\":"
              << device.bufferFrames.fundamentalFrames << '}';
  }
  std::cout << "]}\n";
}

struct Probe {
  std::atomic<uint64_t> frames{0};
  std::atomic<uint32_t> callbacks{0};
  std::atomic<uint32_t> varying{0};
  std::atomic<uint32_t> maximum{0};
  std::atomic<uint32_t> peakMilli{0};
  uint32_t previousFrames{0};
  bool loopback{false};
};

bool render(void* context, const singz::AudioHostRenderBlock& block) noexcept {
  auto* probe = static_cast<Probe*>(context);
  if (probe == nullptr) return false;
  probe->callbacks.fetch_add(1, std::memory_order_relaxed);
  probe->frames.fetch_add(block.frames, std::memory_order_relaxed);
  if (probe->previousFrames != 0 && probe->previousFrames != block.frames) {
    probe->varying.store(1, std::memory_order_relaxed);
  }
  probe->previousFrames = block.frames;
  uint32_t maximum = probe->maximum.load(std::memory_order_relaxed);
  while (maximum < block.frames &&
         !probe->maximum.compare_exchange_weak(maximum, block.frames,
                                               std::memory_order_relaxed)) {
  }
  float peak = 0.0F;
  for (uint32_t channel = 0; channel < block.inputChannels; ++channel) {
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      peak = std::max(peak, std::fabs(block.input[channel][frame]));
    }
  }
  const uint32_t peakMilli = static_cast<uint32_t>(std::min(peak, 4294967.0F) * 1000.0F);
  uint32_t oldPeak = probe->peakMilli.load(std::memory_order_relaxed);
  while (oldPeak < peakMilli &&
         !probe->peakMilli.compare_exchange_weak(oldPeak, peakMilli,
                                                 std::memory_order_relaxed)) {
  }
  for (uint32_t channel = 0; channel < block.outputChannels; ++channel) {
    for (uint32_t frame = 0; frame < block.frames; ++frame) {
      block.output[channel][frame] = probe->loopback && channel < block.inputChannels
                                         ? block.input[channel][frame]
                                         : 0.0F;
    }
  }
  return true;
}

const char* value(int argc, char** argv, const char* name) {
  for (int index = 1; index + 1 < argc; ++index) {
    if (std::string(argv[index]) == name) return argv[index + 1];
  }
  return nullptr;
}

bool has(int argc, char** argv, const char* name) {
  for (int index = 1; index < argc; ++index) {
    if (std::string(argv[index]) == name) return true;
  }
  return false;
}

bool number(int argc, char** argv, const char* name, uint32_t fallback,
            uint32_t* result) {
  const char* text = nullptr;
  bool present = false;
  for (int index = 1; index < argc; ++index) {
    if (std::string(argv[index]) != name) continue;
    if (present || index + 1 >= argc) {
      std::cerr << "Invalid value for " << name
                << ": provide exactly one decimal integer\n";
      return false;
    }
    present = true;
    text = argv[index + 1];
  }
  if (singz::tools::parseAudioHostUint32(present ? text : nullptr, fallback,
                                         result)) {
    return true;
  }
  std::cerr << "Invalid value for " << name
            << ": expected a decimal integer from 0 to 4294967295\n";
  return false;
}

bool channelList(int argc, char** argv, const char* name,
                 std::vector<uint32_t>* result) {
  const char* text = "0";
  bool present = false;
  for (int index = 1; index < argc; ++index) {
    if (std::string(argv[index]) != name) continue;
    if (present || index + 1 >= argc) {
      std::cerr << "Invalid value for " << name
                << ": provide exactly one comma-separated channel list\n";
      return false;
    }
    present = true;
    text = argv[index + 1];
  }
  if (singz::tools::parseAudioHostChannelList(text, result)) return true;
  std::cerr << "Invalid value for " << name
            << ": expected comma-separated decimal integers from 0 to 4294967295\n";
  return false;
}

uint64_t saturatedAdd(uint64_t left, uint64_t right) noexcept {
  return right > UINT64_MAX - left ? UINT64_MAX : left + right;
}

void accumulateStatus(singz::AudioHostStatus* aggregate,
                      const singz::AudioHostStatus& cycle,
                      bool first) noexcept {
  if (first) {
    *aggregate = cycle;
    return;
  }
  aggregate->state = aggregate->state == singz::AudioHostState::Stopped
                         ? cycle.state
                         : aggregate->state;
  aggregate->format = cycle.format;
  aggregate->latency = cycle.latency;
  aggregate->routeGeneration = cycle.routeGeneration;
  aggregate->streamGeneration = cycle.streamGeneration;
  aggregate->callbacks = saturatedAdd(aggregate->callbacks, cycle.callbacks);
  aggregate->renderedFrames =
      saturatedAdd(aggregate->renderedFrames, cycle.renderedFrames);
  aggregate->xruns = saturatedAdd(aggregate->xruns, cycle.xruns);
  aggregate->deadlineMisses =
      saturatedAdd(aggregate->deadlineMisses, cycle.deadlineMisses);
  aggregate->discontinuities =
      saturatedAdd(aggregate->discontinuities, cycle.discontinuities);
  aggregate->invalidCallbacks =
      saturatedAdd(aggregate->invalidCallbacks, cycle.invalidCallbacks);
  aggregate->renderFailures =
      saturatedAdd(aggregate->renderFailures, cycle.renderFailures);
  auto& output = aggregate->diagnostics;
  const auto& input = cycle.diagnostics;
  output.inputStreamLatency100ns = input.inputStreamLatency100ns;
  output.outputStreamLatency100ns = input.outputStreamLatency100ns;
  output.inputPeriodFrames = input.inputPeriodFrames;
  output.outputPeriodFrames = input.outputPeriodFrames;
  output.inputBufferFrames = input.inputBufferFrames;
  output.outputBufferFrames = input.outputBufferFrames;
  output.fifoCapacityFrames = input.fifoCapacityFrames;
  output.fifoCurrentFrames = input.fifoCurrentFrames;
  output.fifoMinimumFrames =
      std::min(output.fifoMinimumFrames, input.fifoMinimumFrames);
  output.fifoMaximumFrames =
      std::max(output.fifoMaximumFrames, input.fifoMaximumFrames);
  output.fifoUnderflows =
      saturatedAdd(output.fifoUnderflows, input.fifoUnderflows);
  output.fifoOverflows =
      saturatedAdd(output.fifoOverflows, input.fifoOverflows);
  output.startupInputZeroFrames = saturatedAdd(
      output.startupInputZeroFrames, input.startupInputZeroFrames);
  const int64_t delta = input.acceptedCaptureMinusRenderedFrames;
  if (delta > 0 &&
      aggregate->diagnostics.acceptedCaptureMinusRenderedFrames >
          INT64_MAX - delta) {
    output.acceptedCaptureMinusRenderedFrames = INT64_MAX;
  } else if (delta < 0 &&
             aggregate->diagnostics.acceptedCaptureMinusRenderedFrames <
                 INT64_MIN - delta) {
    output.acceptedCaptureMinusRenderedFrames = INT64_MIN;
  } else {
    output.acceptedCaptureMinusRenderedFrames += delta;
  }
}

}  // namespace

int main(int argc, char** argv) {
  uint32_t blocks = 0;
  uint32_t rate = 0;
  uint32_t buffer = 0;
  uint32_t maximumFrames = 0;
  uint32_t milliseconds = 0;
  uint32_t cycles = 0;
  if (!number(argc, argv, "--blocks", 8, &blocks) ||
      !number(argc, argv, "--rate", 0, &rate) ||
      !number(argc, argv, "--buffer", 0, &buffer) ||
      !number(argc, argv, "--maximum-frames", 8192, &maximumFrames) ||
      !number(argc, argv, "--milliseconds", 500, &milliseconds) ||
      !number(argc, argv, "--cycles", 1, &cycles) || cycles == 0) {
    return 1;
  }
  const bool fake = has(argc, argv, "--fake");
  const bool fakeFaults = has(argc, argv, "--fake-faults");
  singz::AudioHost host(fake ? singz::createFakeAudioHostBackend(
                                  {blocks, true, fakeFaults ? 3u : 0u,
                                   fakeFaults ? 4u : 0u})
                             : singz::createPlatformAudioHostBackend());
  if (!has(argc, argv, "--run") && !fake) {
    printInventory(host.enumerate());
    return 0;
  }
  const char* commonUid = value(argc, argv, "--device-uid");
  const char* selectedInput = value(argc, argv, "--input-device-uid");
  const char* selectedOutput = value(argc, argv, "--output-device-uid");
  const std::string inputUid = fake ? "singz:fake-duplex"
      : (selectedInput ? selectedInput : (commonUid ? commonUid : ""));
  const std::string outputUid = fake ? "singz:fake-duplex"
      : (selectedOutput ? selectedOutput : (commonUid ? commonUid : ""));
  std::vector<uint32_t> input;
  std::vector<uint32_t> output;
  if (!channelList(argc, argv, "--input-channels", &input) ||
      !channelList(argc, argv, "--output-channels", &output)) {
    return 1;
  }
  singz::AudioHostConfig config{inputUid, outputUid, input, output,
                                static_cast<double>(rate), buffer,
                                maximumFrames, has(argc, argv, "--exclusive")};
  Probe probe;
  probe.loopback = fake;
  singz::AudioHostStatus status;
  bool haveStatus = false;
  uint32_t cyclesCompleted = 0;
  int lifecycleExit = 0;
  for (uint32_t cycle = 0; cycle < cycles; ++cycle) {
    const auto opened = host.open(config, render, &probe);
    if (!opened.ok) {
      std::cerr << opened.message << '\n';
      const auto failed = host.status();
      if (!haveStatus) {
        status = failed;
      } else {
        status.state = failed.state;
        status.routeGeneration = failed.routeGeneration;
        status.streamGeneration = failed.streamGeneration;
      }
      haveStatus = true;
      lifecycleExit = 2;
      break;
    }
    const auto started = host.start();
    if (!started.ok) {
      std::cerr << started.message << '\n';
      host.stop();
      const auto failed = host.status();
      accumulateStatus(&status, failed, !haveStatus);
      haveStatus = true;
      lifecycleExit = 3;
      break;
    }
    const auto timeout = std::chrono::steady_clock::now() +
                         std::chrono::milliseconds(milliseconds);
    while (std::chrono::steady_clock::now() < timeout &&
           host.status().state == singz::AudioHostState::Running) {
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    host.stop();
    const auto completed = host.status();
    accumulateStatus(&status, completed, !haveStatus);
    haveStatus = true;
    ++cyclesCompleted;
    // Validate each completed cycle immediately. A later reopen must never
    // erase an earlier xrun, deadline miss, priming gap, or invalid callback.
    if (singz::tools::audioHostRunExitCode(completed) != 0) break;
  }
  if (!haveStatus) status = host.status();
  std::cout << "{\"callbacks\":" << status.callbacks << ",\"frames\":"
            << status.renderedFrames << ",\"xruns\":" << status.xruns
            << ",\"deadlineMisses\":" << status.deadlineMisses
            << ",\"discontinuities\":" << status.discontinuities
            << ",\"invalidCallbacks\":" << status.invalidCallbacks
            << ",\"renderFailures\":" << status.renderFailures
            << ",\"inputDeviceLatencyFrames\":"
            << status.latency.inputDeviceFrames
            << ",\"outputDeviceLatencyFrames\":"
            << status.latency.outputDeviceFrames
            << ",\"bufferFrames\":" << status.latency.bufferFrames
            << ",\"externalRouteLatencyFrames\":"
            << status.latency.externalRouteFrames
            << ",\"accessMode\":"
            << singz::tools::jsonString(
                   singz::tools::audioHostAccessModeName(
                       status.format.accessMode))
            << ",\"inputStreamLatency100ns\":"
            << status.diagnostics.inputStreamLatency100ns
            << ",\"outputStreamLatency100ns\":"
            << status.diagnostics.outputStreamLatency100ns
            << ",\"inputPeriodFrames\":"
            << status.diagnostics.inputPeriodFrames
            << ",\"outputPeriodFrames\":"
            << status.diagnostics.outputPeriodFrames
            << ",\"inputBufferFrames\":"
            << status.diagnostics.inputBufferFrames
            << ",\"outputBufferFrames\":"
            << status.diagnostics.outputBufferFrames
            << ",\"fifoCapacityFrames\":"
            << status.diagnostics.fifoCapacityFrames
            << ",\"fifoCurrentFrames\":"
            << status.diagnostics.fifoCurrentFrames
            << ",\"fifoMinimumFrames\":"
            << status.diagnostics.fifoMinimumFrames
            << ",\"fifoMaximumFrames\":"
            << status.diagnostics.fifoMaximumFrames
            << ",\"fifoUnderflows\":"
            << status.diagnostics.fifoUnderflows
            << ",\"fifoOverflows\":"
            << status.diagnostics.fifoOverflows
            << ",\"startupInputZeroFrames\":"
            << status.diagnostics.startupInputZeroFrames
            << ",\"acceptedCaptureMinusRenderedFrames\":"
            << status.diagnostics.acceptedCaptureMinusRenderedFrames
            << ",\"probeCallbacks\":" << probe.callbacks.load()
            << ",\"probeFrames\":" << probe.frames.load()
            << ",\"varying\":" << probe.varying.load()
            << ",\"maximumSeen\":" << probe.maximum.load()
            << ",\"inputPeakMilli\":" << probe.peakMilli.load()
            << ",\"cyclesRequested\":" << cycles
            << ",\"cyclesCompleted\":" << cyclesCompleted
            << ",\"state\":"
            << singz::tools::jsonString(
                   singz::tools::audioHostStateName(status.state))
            << "}\n";
  return lifecycleExit != 0 ? lifecycleExit
                            : singz::tools::audioHostRunExitCode(status);
}
