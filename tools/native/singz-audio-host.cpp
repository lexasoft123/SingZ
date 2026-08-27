#include <zcore/device/audio_host.h>
#include <zcore/device/audio_host_fake.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <sstream>
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
              << ",\"bufferPreferred\":" << device.bufferFrames.preferredFrames << '}';
  }
  std::cout << "]}\n";
}

std::vector<uint32_t> channels(const std::string& text) {
  std::vector<uint32_t> result;
  std::stringstream stream(text);
  std::string item;
  while (std::getline(stream, item, ',')) {
    if (item.empty()) return {};
    char* end = nullptr;
    const unsigned long value = std::strtoul(item.c_str(), &end, 10);
    if (end == nullptr || *end != '\0' || value > UINT32_MAX) return {};
    result.push_back(static_cast<uint32_t>(value));
  }
  return result;
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

}  // namespace

int main(int argc, char** argv) {
  uint32_t blocks = 0;
  uint32_t rate = 0;
  uint32_t buffer = 0;
  uint32_t maximumFrames = 0;
  uint32_t milliseconds = 0;
  if (!number(argc, argv, "--blocks", 8, &blocks) ||
      !number(argc, argv, "--rate", 48000, &rate) ||
      !number(argc, argv, "--buffer", 128, &buffer) ||
      !number(argc, argv, "--maximum-frames", 1024, &maximumFrames) ||
      !number(argc, argv, "--milliseconds", 500, &milliseconds)) {
    return 1;
  }
  const bool fake = has(argc, argv, "--fake");
  singz::AudioHost host(fake ? singz::createFakeAudioHostBackend(
                                  {blocks, true, 3, 4})
                             : singz::createPlatformAudioHostBackend());
  if (!has(argc, argv, "--run") && !fake) {
    printInventory(host.enumerate());
    return 0;
  }
  const std::string uid = fake ? "singz:fake-duplex"
                               : (value(argc, argv, "--device-uid") != nullptr
                                      ? value(argc, argv, "--device-uid")
                                      : "");
  const auto input = channels(value(argc, argv, "--input-channels") != nullptr
                                  ? value(argc, argv, "--input-channels")
                                  : "0");
  const auto output = channels(value(argc, argv, "--output-channels") != nullptr
                                   ? value(argc, argv, "--output-channels")
                                   : "0");
  singz::AudioHostConfig config{uid, uid, input, output,
                                static_cast<double>(rate), buffer,
                                maximumFrames};
  Probe probe;
  probe.loopback = fake;
  const auto opened = host.open(config, render, &probe);
  if (!opened.ok) {
    std::cerr << opened.message << '\n';
    return 2;
  }
  const auto started = host.start();
  if (!started.ok) {
    std::cerr << started.message << '\n';
    return 3;
  }
  const auto timeout = std::chrono::steady_clock::now() +
                       std::chrono::milliseconds(milliseconds);
  while (std::chrono::steady_clock::now() < timeout &&
         host.status().state == singz::AudioHostState::Running) {
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  }
  host.stop();
  const auto status = host.status();
  std::cout << "{\"callbacks\":" << status.callbacks << ",\"frames\":"
            << status.renderedFrames << ",\"xruns\":" << status.xruns
            << ",\"deadlineMisses\":" << status.deadlineMisses
            << ",\"discontinuities\":" << status.discontinuities
            << ",\"renderFailures\":" << status.renderFailures
            << ",\"inputDeviceLatencyFrames\":"
            << status.latency.inputDeviceFrames
            << ",\"outputDeviceLatencyFrames\":"
            << status.latency.outputDeviceFrames
            << ",\"bufferFrames\":" << status.latency.bufferFrames
            << ",\"externalRouteLatencyFrames\":"
            << status.latency.externalRouteFrames
            << ",\"probeCallbacks\":" << probe.callbacks.load()
            << ",\"probeFrames\":" << probe.frames.load()
            << ",\"varying\":" << probe.varying.load()
            << ",\"maximumSeen\":" << probe.maximum.load()
            << ",\"inputPeakMilli\":" << probe.peakMilli.load()
            << ",\"state\":"
            << singz::tools::jsonString(
                   singz::tools::audioHostStateName(status.state))
            << "}\n";
  return singz::tools::audioHostRunExitCode(status);
}
