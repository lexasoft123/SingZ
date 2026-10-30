#include "audio_input_windows_helpers.h"

#include <windows.h>
#include <audioclient.h>
#include <mmdeviceapi.h>

namespace singz::detail {
namespace {

int32_t activate(void* context, void** client) noexcept {
  if (!context || !client) return E_POINTER;
  *client = nullptr;
  return static_cast<IMMDevice*>(context)->Activate(
      __uuidof(IAudioClient), CLSCTX_ALL, nullptr, client);
}

int32_t setProperties(void*, void* rawClient) noexcept {
  if (!rawClient) return E_POINTER;
  auto* client = static_cast<IAudioClient*>(rawClient);
  IAudioClient2* client2 = nullptr;
  HRESULT result = client->QueryInterface(
      __uuidof(IAudioClient2), reinterpret_cast<void**>(&client2));
  if (FAILED(result)) return result;
  AudioClientProperties properties{};
  properties.cbSize = sizeof(properties);
  properties.eCategory = AudioCategory_Other;
  properties.Options = AUDCLNT_STREAMOPTIONS_NONE;
  result = client2->SetClientProperties(&properties);
  client2->Release();
  return result;
}

int32_t getMixFormat(void*, void* rawClient, void** format) noexcept {
  if (!rawClient || !format) return E_POINTER;
  *format = nullptr;
  return static_cast<IAudioClient*>(rawClient)->GetMixFormat(
      reinterpret_cast<WAVEFORMATEX**>(format));
}

void releaseClient(void*, void* client) noexcept {
  if (client) static_cast<IAudioClient*>(client)->Release();
}

void releaseFormat(void*, void* format) noexcept {
  if (format) CoTaskMemFree(format);
}

}  // namespace

int32_t runWasapiCaptureSetup(
    const WasapiCaptureSetupOperations& operations, void** client,
    void** format, WasapiCaptureSetupFailure* failure) noexcept {
  if (client) *client = nullptr;
  if (format) *format = nullptr;
  if (failure) *failure = WasapiCaptureSetupFailure::Activate;
  if (!client || !format || !operations.activate ||
      !operations.setProperties || !operations.getMixFormat ||
      !operations.releaseClient || !operations.releaseFormat)
    return E_POINTER;

  void* preparedClient = nullptr;
  void* preparedFormat = nullptr;
  int32_t result = operations.activate(operations.context, &preparedClient);
  if (result < 0 || !preparedClient) {
    if (result >= 0) result = E_UNEXPECTED;
    if (preparedClient)
      operations.releaseClient(operations.context, preparedClient);
    return result;
  }
  if (failure) *failure = WasapiCaptureSetupFailure::SetProperties;
  result = operations.setProperties(operations.context, preparedClient);
  if (result < 0) {
    operations.releaseClient(operations.context, preparedClient);
    return result;
  }
  if (failure) *failure = WasapiCaptureSetupFailure::GetMixFormat;
  result = operations.getMixFormat(operations.context, preparedClient,
                                   &preparedFormat);
  if (result < 0 || !preparedFormat) {
    if (result >= 0) result = E_UNEXPECTED;
    if (preparedFormat)
      operations.releaseFormat(operations.context, preparedFormat);
    operations.releaseClient(operations.context, preparedClient);
    return result;
  }
  *client = preparedClient;
  *format = preparedFormat;
  if (failure) *failure = WasapiCaptureSetupFailure::None;
  return S_OK;
}

int32_t setupWasapiCaptureClient(
    void* device, void** client, void** format,
    WasapiCaptureSetupFailure* failure) noexcept {
  WasapiCaptureSetupOperations operations;
  operations.context = device;
  operations.activate = activate;
  operations.setProperties = setProperties;
  operations.getMixFormat = getMixFormat;
  operations.releaseClient = releaseClient;
  operations.releaseFormat = releaseFormat;
  return runWasapiCaptureSetup(operations, client, format, failure);
}

}  // namespace singz::detail
