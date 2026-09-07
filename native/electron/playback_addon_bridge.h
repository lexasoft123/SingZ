#pragma once

#include <node_api.h>

#include <memory>
#include <string>

namespace singz {

class NativeAudioOwnership;
class AudioHostBackend;

using DesktopPlaybackBackendFactory = std::unique_ptr<AudioHostBackend> (*)(
    const std::string& provider, std::string* unavailableReason);

// Installs the desktop NativePlaybackSession bridge into the stable Electron
// addon. The caller owns the process-wide capture/monitor/playback arbiter.
void definePlaybackExports(napi_env env, napi_value exports,
                           NativeAudioOwnership *ownership,
                           DesktopPlaybackBackendFactory backendFactory);
void cleanupPlaybackBridge() noexcept;

} // namespace singz
