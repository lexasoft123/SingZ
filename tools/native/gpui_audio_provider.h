#pragma once
// Control-domain projection for the standalone native helper. No provider is
// opened by capability probing, and the Windows identity projection never
// changes the shared DSP or independent microphone backend.
#include <zcore/device/audio_host.h>
#if defined(_WIN32)
#include <zcore/platform/windows/audio_host_windows_provider.h>
#endif
#include "json_string.h"
#include <memory>
#include <ostream>
#include <string>
#include <utility>
#include <vector>

namespace singz::tools {
struct GpuiAudioProviderInfo {
  std::string id, label;
  bool compiled{false}, available{false};
  std::string detail, errorCode;
};
inline const char* gpuiAudioPlatform() noexcept {
#if defined(_WIN32)
  return "win32";
#elif defined(__APPLE__)
  return "darwin";
#elif defined(__linux__)
  return "linux";
#else
  return "other";
#endif
}
inline const char* gpuiDefaultAudioProvider() noexcept {
#if defined(_WIN32)
  return "wasapi";
#elif defined(__APPLE__)
  return "coreaudio";
#elif defined(__linux__)
  return "alsa";
#else
  return "unsupported";
#endif
}
inline std::vector<GpuiAudioProviderInfo> gpuiAudioProviders() {
  std::vector<GpuiAudioProviderInfo> rows{
    {"coreaudio","CoreAudio",false,false,"CoreAudio is available only on macOS","wrong-platform"},
    {"wasapi","WASAPI",false,false,"WASAPI is available only on Windows","wrong-platform"},
    {"asio","ASIO",false,false,"ASIO is available only on Windows","wrong-platform"},
    {"alsa","ALSA",false,false,"ALSA is available only on Linux","wrong-platform"},
  };
#if defined(_WIN32)
  const auto wasapi=probeWindowsAudioHostProvider(WindowsAudioHostProvider::Wasapi);
  rows[1]={"wasapi","WASAPI",wasapi.compiled,wasapi.available,wasapi.detail,
    wasapi.available?"none":wasapi.compiled?"runtime-unavailable":"not-compiled"};
  const auto asio=probeWindowsAudioHostProvider(WindowsAudioHostProvider::Asio);
  rows[2]={"asio","ASIO",asio.compiled,asio.available,asio.detail,
    asio.available?"none":asio.compiled?"runtime-unavailable":"not-compiled"};
#elif defined(__APPLE__)
  rows[0]={"coreaudio","CoreAudio",true,true,"Native macOS CoreAudio output","none"};
#elif defined(__linux__)
  // The desktop Linux target requires ALSA at configure/link time. Endpoint
  // availability remains a separate inventory/route fact, not a probe promise.
  rows[3]={"alsa","ALSA",true,true,"Native Linux ALSA output","none"};
#endif
  return rows;
}
inline void writeGpuiAudioProviders(std::ostream& out) {
  out << "{\"protocol\":1,\"ok\":true,\"platform\":" << jsonString(gpuiAudioPlatform())
      << ",\"defaultProvider\":" << jsonString(gpuiDefaultAudioProvider()) << ",\"providers\":[";
  bool first=true;
  for(const auto& row:gpuiAudioProviders()) {
    if(!first)out<<',';first=false;
    out << "{\"id\":" << jsonString(row.id) << ",\"label\":" << jsonString(row.label)
        << ",\"compiled\":" << (row.compiled?"true":"false")
        << ",\"available\":" << (row.available?"true":"false")
        << ",\"detail\":" << jsonString(row.detail) << ",\"errorCode\":" << jsonString(row.errorCode) << '}';
  }
  out << "]}";
}
struct GpuiAudioProviderSelection {
  std::string id{gpuiDefaultAudioProvider()};
  bool fixture{false};
  const char* backendProvider() const noexcept {return fixture?"fake":id.c_str();}
  bool scopedOutputs() const noexcept {
#if defined(_WIN32)
    return true;
#else
    return false;
#endif
  }
  bool validOutputUid(const std::string& uid) const {
    return !scopedOutputs() || uid.empty() || (uid.starts_with(id+":") && uid.size()>id.size()+1);
  }
};
inline bool selectGpuiAudioProvider(const std::string& requested,bool explicitProvider,bool fixture,
    GpuiAudioProviderSelection& selection,GpuiAudioProviderInfo& failure) {
  selection.id=explicitProvider?requested:gpuiDefaultAudioProvider();selection.fixture=fixture;
  if(explicitProvider && requested!="wasapi" && requested!="asio") {
    failure={requested,requested,false,false,"Only wasapi or asio may be explicitly selected","invalid-provider"};return false;
  }
  for(const auto& row:gpuiAudioProviders()) if(row.id==selection.id) {
    if(row.available)return true;
    failure=row;return false;
  }
  failure={selection.id,selection.id,false,false,"No native audio provider is available on this platform","wrong-platform"};return false;
}
inline void writeGpuiAudioProviderIdentity(std::ostream& out,const GpuiAudioProviderSelection& selection) {
  out << ",\"provider\":" << jsonString(selection.id)
      << ",\"backendProvider\":" << jsonString(selection.backendProvider())
      << ",\"fixture\":" << (selection.fixture?"true":"false");
}
inline std::unique_ptr<AudioHostBackend> createGpuiPlatformAudioProvider(const GpuiAudioProviderSelection& selection) {
#if defined(_WIN32)
  if(selection.id=="wasapi")return createWindowsAudioHostBackend(WindowsAudioHostProvider::Wasapi);
  if(selection.id=="asio")return createWindowsAudioHostBackend(WindowsAudioHostProvider::Asio);
  return nullptr;
#else
  if(selection.id!=gpuiDefaultAudioProvider())return nullptr;
  return createPlatformAudioHostBackend();
#endif
}

// Windows output UIDs belong to the selected provider; raw input UIDs remain
// compatible with the independent AudioInput/monitor helper. In a duplex
// inventory these are deliberately separate rows rather than one ambiguous UID.
class GpuiOutputScopeBackend final : public AudioHostBackend {
 public:
  GpuiOutputScopeBackend(std::unique_ptr<AudioHostBackend> backend,std::string provider)
      :backend_(std::move(backend)),prefix_(std::move(provider)+":") {}
  AudioHostInventory enumerate() const override {
    const auto raw=backend_->enumerate();AudioHostInventory out;
    out.defaultInputUid=raw.defaultInputUid;out.defaultOutputUid=scope(raw.defaultOutputUid);
    for(const auto& device:raw.devices) {
      if(device.inputChannels>0) {
        auto input=device;input.outputChannels=0;input.outputChannelLabels.clear();input.defaultOutput=false;
        input.direction=AudioHostEndpointDirection::Input;out.devices.push_back(std::move(input));
      }
      if(device.outputChannels>0) {
        auto output=device;output.uid=scope(device.uid);output.inputChannels=0;output.inputChannelLabels.clear();output.defaultInput=false;
        output.direction=AudioHostEndpointDirection::Output;out.devices.push_back(std::move(output));
      }
      if(device.inputChannels==0 && device.outputChannels==0)out.devices.push_back(device);
    }
    return out;
  }
  std::optional<AudioHostDeviceInfo> describeOutputDevice(const std::string& uid) const override {
    std::string raw;if(!consume(uid,raw)||raw.empty())return std::nullopt;
    auto info=backend_->describeOutputDevice(raw);if(!info)return std::nullopt;
    info->uid=scope(info->uid);info->inputChannels=0;info->inputChannelLabels.clear();info->defaultInput=false;
    info->direction=AudioHostEndpointDirection::Output;return info;
  }
  AudioHostResult open(const AudioHostConfig& config,AudioHostRender render,void* context) override {
    auto raw=config;
    if(!consume(config.outputDeviceUid,raw.outputDeviceUid))
      return {false,AudioHostError::InvalidConfiguration,AudioHostState::Closed,{},{},"Output device identity does not match the selected provider"};
    return backend_->open(raw,render,context);
  }
  AudioHostResult start() override {return backend_->start();}
  void stop() noexcept override {backend_->stop();}
  // AudioHostFormat carries scalar format facts, not device identities. The
  // helper's accepted output UID is projected from enumerate/route admission.
  AudioHostStatus status() const noexcept override {return backend_->status();}
  AudioHostResult suspend() override {return backend_->suspend();}
  AudioHostResult resume() override {return backend_->resume();}
 private:
  std::string scope(const std::string& uid) const {return uid.empty()?uid:prefix_+uid;}
  bool consume(const std::string& uid,std::string& raw) const {
    if(uid.empty()){raw.clear();return true;}
    if(!uid.starts_with(prefix_)||uid.size()==prefix_.size())return false;
    raw=uid.substr(prefix_.size());return true;
  }
  std::unique_ptr<AudioHostBackend> backend_;
  std::string prefix_;
};
inline std::unique_ptr<AudioHostBackend> scopeGpuiOutputProvider(std::unique_ptr<AudioHostBackend> backend,
    const GpuiAudioProviderSelection& selection) {
  if(!backend)return nullptr;
  if(selection.scopedOutputs())return std::make_unique<GpuiOutputScopeBackend>(std::move(backend),selection.id);
  return backend;
}
} // namespace singz::tools
