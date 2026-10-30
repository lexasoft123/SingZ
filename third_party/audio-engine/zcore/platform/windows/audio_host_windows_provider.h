#pragma once

#include <cstdint>
#include <memory>
#include <string>

namespace singz {

class AudioHostBackend;

enum class WindowsAudioHostProvider : uint32_t {
  Wasapi,
  Asio,
};

enum class WindowsAudioHostProviderError : uint32_t {
  None,
  NotCompiled,
  RuntimeUnavailable,
};

struct WindowsAudioHostProviderStatus {
  WindowsAudioHostProvider provider{WindowsAudioHostProvider::Wasapi};
  bool compiled{false};
  bool available{false};
  WindowsAudioHostProviderError error{
      WindowsAudioHostProviderError::NotCompiled};
  std::string detail;
};

// Selection is explicit. In particular, Asio never falls through to Wasapi:
// an unavailable ASIO build returns the typed unsupported backend carrying the
// licensing reason.
[[nodiscard]] WindowsAudioHostProviderStatus probeWindowsAudioHostProvider(
    WindowsAudioHostProvider provider);
[[nodiscard]] std::unique_ptr<AudioHostBackend>
createWindowsAudioHostBackend(WindowsAudioHostProvider provider);

// Implemented by the WASAPI provider translation unit; exposed only to the
// Windows selector so provider code remains in separate per-provider files.
[[nodiscard]] std::unique_ptr<AudioHostBackend>
createWasapiAudioHostBackend();

}  // namespace singz
