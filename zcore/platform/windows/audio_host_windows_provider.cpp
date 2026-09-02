#include "audio_host_windows_provider.h"

#include "audio_host_asio.h"

namespace singz {

WindowsAudioHostProviderStatus probeWindowsAudioHostProvider(
    WindowsAudioHostProvider provider) {
  if (provider == WindowsAudioHostProvider::Wasapi) {
    return {provider, true, true, WindowsAudioHostProviderError::None,
            "Native Windows WASAPI AudioHost"};
  }
  const AsioProviderStatus asio = AsioAudioHostProvider::probe();
  return {provider,
          asio.compiled,
          asio.available,
          asio.error == AsioProviderAvailabilityError::SdkAdapterNotCompiled
              ? WindowsAudioHostProviderError::NotCompiled
              : asio.error == AsioProviderAvailabilityError::RuntimeUnavailable
                    ? WindowsAudioHostProviderError::RuntimeUnavailable
                    : WindowsAudioHostProviderError::None,
          asio.detail};
}

std::unique_ptr<AudioHostBackend> createWindowsAudioHostBackend(
    WindowsAudioHostProvider provider) {
  switch (provider) {
    case WindowsAudioHostProvider::Wasapi:
      return createWasapiAudioHostBackend();
    case WindowsAudioHostProvider::Asio:
      return AsioAudioHostProvider::create();
  }
  return AsioAudioHostProvider::create();
}

std::unique_ptr<AudioHostBackend> createPlatformAudioHostBackend() {
  return createWindowsAudioHostBackend(WindowsAudioHostProvider::Wasapi);
}

}  // namespace singz
