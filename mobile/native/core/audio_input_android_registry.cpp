#include "audio_input_android_registry.h"

#if defined(__ANDROID__)

#include <algorithm>
#include <mutex>
#include <utility>

namespace singz {
namespace {

std::mutex registryMutex;
std::vector<AudioInputDevice> registry;

}  // namespace

void replaceAndroidAudioInputDevices(std::vector<AudioInputDevice> devices) {
  // The Java boundary already bounds every field. Defensively remove duplicate
  // or malformed IDs here so validation has exactly one answer per endpoint.
  devices.erase(std::remove_if(devices.begin(), devices.end(),
                               [](const AudioInputDevice& device) {
                                 return device.uid.rfind("android:", 0) != 0 ||
                                        device.uid.size() > 128 || device.channels == 0 ||
                                        device.channels > 256 || device.sampleRate <= 0;
                               }),
                devices.end());
  std::sort(devices.begin(), devices.end(),
            [](const AudioInputDevice& a, const AudioInputDevice& b) {
              return a.uid < b.uid;
            });
  devices.erase(std::unique(devices.begin(), devices.end(),
                            [](const AudioInputDevice& a, const AudioInputDevice& b) {
                              return a.uid == b.uid;
                            }),
                devices.end());
  std::lock_guard<std::mutex> lock(registryMutex);
  registry = std::move(devices);
}

std::vector<AudioInputDevice> androidAudioInputDevices() {
  std::lock_guard<std::mutex> lock(registryMutex);
  return registry;
}

}  // namespace singz

#endif
