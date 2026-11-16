#pragma once
#include <node_api.h>
#include "playback_addon_bridge.h"
namespace singz {
void prepareTrainingCuesForBufferResume(uint64_t elapsedNs, uint64_t expectedCallbackNs);
class NativeAudioOwnership;
void defineTrainingAudioExports(napi_env env, napi_value exports, NativeAudioOwnership* ownership, DesktopPlaybackBackendFactory backendFactory);
void cleanupTrainingAudio() noexcept;
}
