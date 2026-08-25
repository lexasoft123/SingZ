#include "audio_input_android_policy.h"

namespace singz {

std::string androidAudioInputPresetMetadata(int32_t preset, bool verified,
                                            bool explicitlyRequested) {
  const char* name = "unknown";
  switch (static_cast<AndroidAudioInputPreset>(preset)) {
    case AndroidAudioInputPreset::Generic: name = "generic"; break;
    case AndroidAudioInputPreset::Camcorder: name = "camcorder"; break;
    case AndroidAudioInputPreset::VoiceRecognition: name = "voice-recognition"; break;
    case AndroidAudioInputPreset::VoiceCommunication: name = "voice-communication"; break;
    case AndroidAudioInputPreset::Unprocessed: name = "unprocessed"; break;
    case AndroidAudioInputPreset::VoicePerformance: name = "voice-performance"; break;
  }
  std::string result(name);
  if (verified) return result + "-verified";
  return result + (explicitlyRequested
                       ? "-requested-unverified"
                       : "-default-unverified");
}

}  // namespace singz
