#pragma once

#include <cstdint>
#include <string>

namespace singz {

// Android MediaRecorder.AudioSource / AAudio input-preset values. Kept free
// of Android headers so the metadata policy is covered by every host build.
enum class AndroidAudioInputPreset : int32_t {
  Generic = 1,
  Camcorder = 5,
  VoiceRecognition = 6,
  VoiceCommunication = 7,
  Unprocessed = 9,
  VoicePerformance = 10,
};

// `verified` means AAudioStream_getInputPreset returned the value from the
// opened stream. Otherwise the label says whether SingZ merely requested it
// or relied on AAudio's platform default.
std::string androidAudioInputPresetMetadata(int32_t preset, bool verified,
                                            bool explicitlyRequested);

}  // namespace singz
