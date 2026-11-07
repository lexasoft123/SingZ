#pragma once
#include <node_api.h>

namespace singz {
class NativeAudioOwnership;
void defineMicrophoneMixExports(napi_env env, napi_value exports,
                                NativeAudioOwnership* ownership);
void cleanupMicrophoneMix() noexcept;
bool microphoneMixActive() noexcept;
} // namespace singz
