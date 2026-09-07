#pragma once

#include <atomic>
#include <cstdint>
#include <string>
#include <vector>

#include "audio_host_android_policy.h"

namespace singz::detail {

void replaceAndroidAudioHostDevices(std::vector<AndroidAudioHostDevice> devices,
                                    std::string defaultOutputUid = {});
AndroidAudioHostInventorySnapshot androidAudioHostInventorySnapshot();
const std::atomic<uint32_t>* androidAudioHostRouteGenerationSignal() noexcept;

}  // namespace singz::detail
