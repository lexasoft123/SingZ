#include "voice_monitor.h"
#include <chrono>
#include <cstddef>
#include <thread>
#include <utility>
#if defined(__APPLE__)
#include <TargetConditionals.h>
#endif
namespace singz {
VoiceMonitorAvailability classifyVoiceMonitorRoute(const AudioHostInventory& inventory,
    const std::string& uid, uint32_t channel, const std::string& output, bool native, bool permission, bool macOS) {
  VoiceMonitorAvailability result;
  auto refuse = [&](const char* reason, const char* detail) { result.reason=reason; result.detail=detail; return result; };
  if (!macOS) return refuse("platform", "Live monitoring is available on macOS");
  if (!native || output.empty()) return refuse("output-not-native", "The song needs a native output");
  const AudioHostDeviceInfo* input=nullptr;
  for (const auto& device : inventory.devices) if (device.uid==uid) { input=&device; break; }
  if (!input || channel>=input->inputChannels) return refuse("no-input", "Select an available microphone channel");
  if (uid!=output) return refuse("route-separate-devices", "Input and output must use the same physical device");
  if (input->direction!=AudioHostEndpointDirection::Duplex || !input->outputChannels ||
      input->inputChannels>kAudioHostMaxChannels || input->outputChannels>kAudioHostMaxChannels)
    return refuse("platform", "The device does not expose a supported duplex profile");
  if (input->monitoringSuitability==AudioHostMonitoringSuitability::Unsupported)
    return refuse("platform", "This device does not support live monitoring");
  if (input->monitoringSuitability==AudioHostMonitoringSuitability::HighLatency)
    return refuse("route-latency", "This device reports excessive monitoring latency");
  switch (input->transport) {
    case AudioHostTransport::Bluetooth: case AudioHostTransport::BluetoothLowEnergy:
      return refuse("route-bluetooth", "Bluetooth cannot provide this monitoring route");
    case AudioHostTransport::AirPlay: case AudioHostTransport::ContinuityWireless:
      return refuse("route-wireless", "Wireless routes cannot provide this monitoring route");
    case AudioHostTransport::BuiltIn: case AudioHostTransport::Pci: case AudioHostTransport::Usb:
    case AudioHostTransport::FireWire: case AudioHostTransport::Hdmi: case AudioHostTransport::DisplayPort:
    case AudioHostTransport::Thunderbolt: case AudioHostTransport::ContinuityWired: break;
    default: return refuse("platform", "The device transport does not establish a physical shared clock");
  }
  result.deviceUid=uid;
  result.minBufferFrames=input->bufferFrames.minimumFrames;
  result.maxBufferFrames=input->bufferFrames.maximumFrames;
  if (!result.minBufferFrames || result.maxBufferFrames<result.minBufferFrames)
    return refuse("error", "The device buffer range is unknown");
  if (!chooseMonitorBufferFrames(input->bufferFrames,input->bufferFrames,32,256))
    return refuse("route-latency", "The device cannot provide a buffer within 256 frames");
  if (!permission) return refuse("permission", "Microphone permission must already be granted");
  result.available=true;
  return result;
}
namespace {
std::vector<std::string> warnings(uint32_t flags) {
  std::vector<std::string> result;
  if (flags & AudioBufferWarningExternalChange) result.emplace_back("Audio buffer changed externally; saved size was not restored");
  if (flags & AudioBufferWarningRestoreFailed) result.emplace_back("Audio buffer could not be restored");
  if (flags & AudioBufferWarningReadFailed) result.emplace_back("Audio buffer metadata could not be read");
  return result;
}
VoiceMonitorLatency latencyOf(const AudioHostStatus& status, uint32_t requested) {
  VoiceMonitorLatency result;
  result.sampleRate=status.format.sampleRate; result.requestedFrames=requested;
  result.bufferFrames=status.latency.bufferFrames;
  result.inputDeviceFrames=status.latency.inputDeviceFrames;
  result.outputDeviceFrames=status.latency.outputDeviceFrames;
  result.roundTripFrames=uint64_t(result.bufferFrames)*2+result.inputDeviceFrames+result.outputDeviceFrames;
  result.roundTripMs=result.sampleRate>0 ? result.roundTripFrames*1000.0/result.sampleRate : 0;
  return result;
}
}
struct VoiceMonitorHost::Impl {
  Impl(std::unique_ptr<AudioHostBackend> backend, bool platform):host(std::move(backend)),macOS(platform){}
  // Members die in reverse order: the backend and any final callback must
  // disappear before their render context, even after a failed driver drain.
  VoiceMonitorRender render;
  AudioHost host;
  ~Impl() { static_assert(offsetof(Impl, render) < offsetof(Impl, host)); }
  bool macOS, running{false}, lost{false};
  uint64_t generation{0}, route{0}, stream{0};
  uint32_t requested{32}, warningFlags{0};
  VoiceMonitorLatency latency;
  std::string reason;
  void stop(bool ramp) noexcept {
    const auto before = render.callbacks.load(std::memory_order_acquire);
    render.target.store(0,std::memory_order_release);
    if (running && ramp) {
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(kVoiceMonitorMuteWaitMs);
      while ((!render.silent.load(std::memory_order_acquire) ||
              render.callbacks.load(std::memory_order_acquire)-before<2) && std::chrono::steady_clock::now()<deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    host.stop(); // zCore owns lease restoration and drains its callback.
    warningFlags |= host.status().bufferWarnings;
    running=false;
  }
};
VoiceMonitorHost::VoiceMonitorHost():VoiceMonitorHost(createPlatformAudioHostBackend(),
#if defined(__APPLE__) && TARGET_OS_OSX
true
#else
false
#endif
){}
VoiceMonitorHost::VoiceMonitorHost(std::unique_ptr<AudioHostBackend> backend, bool macOS)
    :impl_(std::make_unique<Impl>(std::move(backend),macOS)){}
VoiceMonitorHost::~VoiceMonitorHost(){close();}
VoiceMonitorAvailability VoiceMonitorHost::availability(const std::string& uid,uint32_t channel,
    const std::string& output,bool native,bool permission) const {
  if (!impl_->macOS || !native || output.empty())
    return classifyVoiceMonitorRoute({},uid,channel,output,native,permission,impl_->macOS);
  return classifyVoiceMonitorRoute(impl_->host.enumerate(),uid,channel,output,native,permission,impl_->macOS);
}
VoiceMonitorResult VoiceMonitorHost::begin(const std::string& uid,uint32_t channel,const std::string& output,
    bool native,bool permission,float gain,uint32_t target,uint32_t maximum,uint64_t generation) {
  auto& self=*impl_;
  VoiceMonitorResult result;
  if (!generation || generation<=self.generation) {result.reason="error";result.error="Stale monitor generation";return result;}
  if (!std::isfinite(gain) || target!=32 || maximum!=256) {result.reason="error";result.error="Invalid monitor configuration";return result;}
  const auto inventory=self.macOS && native && !output.empty() ? self.host.enumerate() : AudioHostInventory{};
  const auto route=classifyVoiceMonitorRoute(inventory,uid,channel,output,native,permission,self.macOS);
  if (!route.available) {result.reason=route.reason;result.error=route.detail;return result;}
  self.stop(true); self.generation=generation; self.lost=false; self.warningFlags=0; self.reason.clear();
  const auto device=std::find_if(inventory.devices.begin(),inventory.devices.end(),[&](const auto& d){return d.uid==uid;});
  if (device==inventory.devices.end()) {result.reason="device-lost";result.error="Device disappeared";return result;}
  const uint32_t outputs=std::min(device->outputChannels,2u);
  self.render.current=self.render.destination=self.render.step=0; self.render.remaining=0;
  self.render.target.store(0); self.render.silent.store(1); self.render.outputs=outputs;
  for (uint32_t frames=target;frames<=maximum;frames*=2) {
    AudioHostConfig config;
    config.inputDeviceUid=config.outputDeviceUid=uid;
    config.inputChannels={channel}; config.outputChannels={0};
    if (outputs>1) config.outputChannels.push_back(1);
    config.requestedSampleRate=device->nominalSampleRate;
    config.requestedBufferFrames=frames; config.maximumFrames=kAudioHostMaxFrames;
    config.allowSharedDeviceBufferChange=true; config.maximumAcceptableBufferFrames=maximum;
    auto opened=self.host.open(config,VoiceMonitorRender::render,&self.render);
    auto status=self.host.status(); self.warningFlags |= status.bufferWarnings;
    const auto& format=opened.format;
    const bool valid=opened.ok && format.outputClockMaster && format.float32Planar &&
        format.accessMode==AudioHostAccessMode::Shared && format.inputChannels==1 && format.outputChannels==outputs &&
        std::isfinite(format.sampleRate) && format.sampleRate>0 && format.maximumFrames>0 &&
        format.maximumFrames<=kAudioHostMaxFrames && format.nominalBufferFrames>0 &&
        format.nominalBufferFrames<=maximum && format.nominalBufferFrames<=format.maximumFrames &&
        opened.latency.bufferFrames==format.nominalBufferFrames;
    AudioHostResult started;
    if (valid) started=self.host.start();
    if (valid && started.ok) {
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(kVoiceMonitorSettleWaitMs);
      do {
        status=self.host.status(); self.warningFlags |= status.bufferWarnings;
        if (status.state!=AudioHostState::Running || status.observedCallbackFrames) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      } while (std::chrono::steady_clock::now()<deadline);
      if (status.state==AudioHostState::Running && status.observedCallbackFrames &&
          status.observedCallbackFrames==status.latency.bufferFrames && status.observedCallbackFrames<=maximum &&
          status.format.nominalBufferFrames==status.latency.bufferFrames && !status.bufferExceedsMaximum) {
        self.running=true; self.route=status.routeGeneration; self.stream=status.streamGeneration;
        self.requested=frames; self.latency=latencyOf(status,frames);
        setGain(gain);
        result.ok=true; result.latency=self.latency; result.warnings=warnings(self.warningFlags);return result;
      }
    }
    self.host.stop(); self.warningFlags |= self.host.status().bufferWarnings;
    if (opened.error==AudioHostError::DeviceNotFound || status.state==AudioHostState::DeviceLost) {
      self.lost=true; result.reason="device-lost"; result.error="Monitor device disappeared";break;
    }
    const bool periodTooLarge = opened.latency.bufferFrames > maximum ||
        format.nominalBufferFrames > maximum || status.observedCallbackFrames > maximum || status.bufferExceedsMaximum;
    // Provider text may contain names or paths. Only fixed product-neutral
    // messages cross this boundary; non-period failures are ordinary errors.
    result.reason=periodTooLarge ? "route-latency" : "error";
    result.error=periodTooLarge ? "Monitor buffer exceeds the supported limit" : "Native voice monitor could not start";
  }
  if (result.reason.empty()) result.reason="error";
  result.warnings=warnings(self.warningFlags); return result;
}
bool VoiceMonitorHost::setGain(float gain) noexcept {
  if (!impl_->running || !std::isfinite(gain)) return false;
  impl_->render.silent.store(0,std::memory_order_release);
  impl_->render.target.store(std::pow(10.0f,std::clamp(gain,-60.0f,12.0f)/20.0f),std::memory_order_release);
  return true;
}
VoiceMonitorStatus VoiceMonitorHost::status() {
  auto& self=*impl_;
  if (self.running) {
    const auto status=self.host.status(); self.warningFlags |= status.bufferWarnings;
    self.lost=status.state==AudioHostState::DeviceLost || status.terminalReason==AudioHostTerminalReason::DeviceLost;
    if (self.lost) self.reason="device-lost";
    if (!self.lost && status.state==AudioHostState::Running &&
        (status.routeGeneration!=self.route || status.streamGeneration!=self.stream)) routeChanged();
    else if (self.lost || status.state!=AudioHostState::Running || !status.observedCallbackFrames ||
        status.observedCallbackFrames!=status.latency.bufferFrames || status.observedCallbackFrames>256 ||
        status.bufferExceedsMaximum) self.stop(false);
    else self.latency=latencyOf(status,self.requested);
  }
  return {self.running,self.lost,self.latency,warnings(self.warningFlags),self.render.peak.load(),self.render.rms.load(),self.reason};
}
VoiceMonitorResult VoiceMonitorHost::end(uint64_t generation) {
  VoiceMonitorResult result;
  if (!generation || generation!=impl_->generation) {result.error="Stale monitor generation";return result;}
  impl_->stop(true); result.ok=true; result.warnings=warnings(impl_->warningFlags);return result;
}
void VoiceMonitorHost::close() noexcept {if(impl_)impl_->stop(true);}
void VoiceMonitorHost::routeChanged() {
  impl_->stop(true);
  impl_->lost=true;
  impl_->reason="route-changed";
}
}
