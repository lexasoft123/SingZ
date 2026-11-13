#pragma once
#include <node_api.h>
#include "playback_addon_bridge.h"
#include "../playback/presentation_history.h"
namespace singz {
class NativeAudioOwnership;
void defineTrainingAudioExports(napi_env env, napi_value exports, NativeAudioOwnership* ownership, DesktopPlaybackBackendFactory backendFactory);
void cleanupTrainingAudio() noexcept;
// Process-lifetime RT-safe lookup, called after the shared song renderer.
void setTakePresentationProvider(TakePresentationProvider provider) noexcept;
}
