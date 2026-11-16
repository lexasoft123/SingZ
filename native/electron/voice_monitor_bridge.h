#pragma once
#include <node_api.h>
namespace singz {
class NativeAudioOwnership;
void defineVoiceMonitorExports(napi_env env, napi_value exports, NativeAudioOwnership* ownership);
// Returns true only for the last environment: shared addon cleanup may proceed.
bool cleanupVoiceMonitor() noexcept;
}
