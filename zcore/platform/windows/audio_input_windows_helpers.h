#pragma once

#include <cstdint>

namespace singz::detail {

enum class WasapiCaptureSetupFailure : uint32_t {
  None,
  Activate,
  SetProperties,
  GetMixFormat,
};

// Type-erased so deterministic Windows tests exercise the same ordered
// operation that owns the real COM setup path, without implementing COM
// endpoint mocks. A successful operation transfers one client reference and
// one CoTaskMem-format allocation to the caller.
struct WasapiCaptureSetupOperations {
  void* context{nullptr};
  int32_t (*activate)(void* context, void** client) noexcept{nullptr};
  int32_t (*setProperties)(void* context, void* client) noexcept{nullptr};
  int32_t (*getMixFormat)(void* context, void* client,
                          void** format) noexcept{nullptr};
  void (*releaseClient)(void* context, void* client) noexcept{nullptr};
  void (*releaseFormat)(void* context, void* format) noexcept{nullptr};
};

int32_t runWasapiCaptureSetup(
    const WasapiCaptureSetupOperations& operations, void** client,
    void** format, WasapiCaptureSetupFailure* failure) noexcept;

// Real Windows operation used by inventory and both low-period and legacy
// capture initialization attempts. `device` is IMMDevice*, `client` receives
// IAudioClient*, and `format` receives WAVEFORMATEX*.
int32_t setupWasapiCaptureClient(
    void* device, void** client, void** format,
    WasapiCaptureSetupFailure* failure) noexcept;

}  // namespace singz::detail
