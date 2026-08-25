#pragma once

#if defined(__ANDROID__)

#include <string>
#include <vector>

#include "audio_input.h"

namespace singz {

// Android's AudioManager is the public source of device inventory. JNI
// replaces this snapshot before enumeration/start; the AAudio backend then
// resolves the same android:<AudioDeviceInfo.id> UID without owning a Java VM
// or changing the process audio route.
void replaceAndroidAudioInputDevices(std::vector<AudioInputDevice> devices);
std::vector<AudioInputDevice> androidAudioInputDevices();

}  // namespace singz

#endif
