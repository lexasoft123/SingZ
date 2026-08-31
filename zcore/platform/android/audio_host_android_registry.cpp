#include "audio_host_android_registry.h"

#if defined(__ANDROID__)

#include <algorithm>
#include <cmath>
#include <mutex>
#include <utility>

namespace singz::detail {
namespace {

std::mutex registryMutex;
std::vector<AndroidAudioHostDevice> registry;
std::atomic<uint32_t> routeGeneration{1};

bool sameDevice(const AndroidAudioHostDevice& left,
                const AndroidAudioHostDevice& right) noexcept {
  return left.deviceId == right.deviceId && left.uid == right.uid &&
         left.label == right.label && left.input == right.input &&
         left.output == right.output && left.channels == right.channels &&
         left.nominalSampleRate == right.nominalSampleRate &&
         left.sampleRates == right.sampleRates &&
         left.transport == right.transport &&
         left.monitoringSuitability == right.monitoringSuitability;
}

bool sameInventory(const std::vector<AndroidAudioHostDevice>& left,
                   const std::vector<AndroidAudioHostDevice>& right) noexcept {
  return left.size() == right.size() &&
         std::equal(left.begin(), left.end(), right.begin(), sameDevice);
}

}  // namespace

void replaceAndroidAudioHostDevices(
    std::vector<AndroidAudioHostDevice> devices) {
  devices.erase(
      std::remove_if(devices.begin(), devices.end(), [](const auto& device) {
        return device.deviceId <= 0 || device.uid.rfind("android:", 0) != 0 ||
               device.uid.size() > 128 || device.label.size() > 256 ||
               (!device.input && !device.output) || device.channels == 0 ||
               device.channels > 256 ||
               !std::isfinite(device.nominalSampleRate) ||
               device.nominalSampleRate < 0.0;
      }),
      devices.end());
  for (auto& device : devices) {
    device.sampleRates.erase(
        std::remove_if(device.sampleRates.begin(), device.sampleRates.end(),
                       [](double rate) {
                         return !std::isfinite(rate) || rate < 8000.0 ||
                                rate > 384000.0;
                       }),
        device.sampleRates.end());
    std::sort(device.sampleRates.begin(), device.sampleRates.end());
    device.sampleRates.erase(
        std::unique(device.sampleRates.begin(), device.sampleRates.end()),
        device.sampleRates.end());
  }
  std::sort(devices.begin(), devices.end(), [](const auto& left,
                                                const auto& right) {
    if (left.uid != right.uid) return left.uid < right.uid;
    if (left.input != right.input) return left.input < right.input;
    return left.output < right.output;
  });
  devices.erase(std::unique(devices.begin(), devices.end(),
                            [](const auto& left, const auto& right) {
                              return left.uid == right.uid &&
                                     left.input == right.input &&
                                     left.output == right.output;
                            }),
                devices.end());
  {
    std::lock_guard<std::mutex> lock(registryMutex);
    if (sameInventory(registry, devices)) return;
    registry = std::move(devices);
    routeGeneration.fetch_add(1, std::memory_order_release);
  }
}

AndroidAudioHostInventorySnapshot androidAudioHostInventorySnapshot() {
  AndroidAudioHostInventorySnapshot snapshot;
  std::lock_guard<std::mutex> lock(registryMutex);
  snapshot.devices = registry;
  snapshot.routeGeneration = routeGeneration.load(std::memory_order_acquire);
  return snapshot;
}

const std::atomic<uint32_t>* androidAudioHostRouteGenerationSignal() noexcept {
  return &routeGeneration;
}

}  // namespace singz::detail

#endif
