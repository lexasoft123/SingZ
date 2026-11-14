#include "voice_monitor_bridge.h"
#include "../playback/voice_monitor.h"
#include "../playback/voice_monitor_client.h"
#include <cstdlib>
#include "../playback/shared_audio_service.h"
#include "native_audio_ownership.h"
#include "microphone_mix_bridge.h"
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
#include "../playback/box_routing_owner.h"
#endif
#include <exception>
#include <mutex>
#if defined(__APPLE__)
#include <TargetConditionals.h>
#if TARGET_OS_OSX
#include <objc/message.h>
#include <objc/runtime.h>
extern "C" void* const AVMediaTypeAudio;
#endif
#endif
namespace singz {
namespace {
std::mutex control;
// Cross-platform DSP stays testable; shipping v1 awaits windows-field qualification.
constexpr bool monitorPlatformSupported() noexcept {
#if defined(__APPLE__) && TARGET_OS_OSX
  return true;
#else
  return false;
#endif
}
bool permissionGranted();
inline bool permissionGrantedForMonitor() { return permissionGranted(); }
// One-release escape hatch; no second output host is constructed by default.
class Monitor {
  bool legacy_ = [] { const char* flag = std::getenv("SINGZ_LEGACY_VOICE_MONITOR"); return flag && std::string(flag) == "1"; }();
  std::unique_ptr<VoiceMonitorHost> legacyHost_;
  CommonVoiceMonitor common_{sharedAudioService(), sharedVoiceMonitorCapture()};
 public:
  Monitor() { if (legacy_) legacyHost_ = std::make_unique<VoiceMonitorHost>(); }
  VoiceMonitorAvailability availability(const std::string& uid, uint32_t channel,
      const std::string& output, bool native, bool permission) {
    if (!monitorPlatformSupported()) {
      VoiceMonitorAvailability result; result.reason="platform";
      result.detail="Live monitoring is available on macOS"; return result;
    }
    return legacy_ ? legacyHost_->availability(uid,channel,output,native,permission) : common_.availability(uid,channel,permission);
  }
  VoiceMonitorResult begin(const std::string& uid, uint32_t channel, const std::string& output,
      bool native, bool permission, float gain, uint32_t target, uint32_t maximum, uint64_t generation,
      const std::vector<uint32_t>& channels, SharedAudioService* service) {
    if (!monitorPlatformSupported()) {
      VoiceMonitorResult result; result.reason="platform";
      result.error="Live monitoring is available on macOS"; return result;
    }
    return legacy_ ? legacyHost_->begin(uid,channel,output,native,permission,gain,target,maximum,generation,channels,service) :
        common_.begin(uid,channel,permission,gain,generation);
  }
  bool setGain(float value) { return legacy_ ? legacyHost_->setGain(value) : common_.setGain(value); }
  VoiceMonitorStatus status() {
    if (!legacy_ && !permissionGrantedForMonitor()) common_.refuse("permission");
    return legacy_ ? legacyHost_->status() : common_.status();
  }
  VoiceMonitorResult end(uint64_t generation) {
    if (legacy_ && !generation) { legacyHost_->close(); VoiceMonitorResult r; r.ok=true; return r; }
    return legacy_ ? legacyHost_->end(generation) : common_.end(generation);
  }
  void close() { if (legacy_) legacyHost_->close(); else common_.close(); }
  void routeChanged() { if (legacy_) legacyHost_->routeChanged(); else common_.routeChanged(); }
};
// Construct only after the first explicit RPC; static teardown never orders
// the common capture/service owners before this client.
Monitor& monitorHost() { static auto* host = new Monitor; return *host; }
std::string monitoredOutput;
std::vector<uint32_t> monitoredChannels;
NativeAudioOwnership* ownership=nullptr;
VoiceMonitorEnvironmentLifetime environments;

std::optional<std::string> publishedOutput;
std::string monitoredInput;
uint32_t monitoredInputChannel=0;
bool useAllowed() {
  bool supported=false;
  if (ownership) {
    // Recording and native playback (including training cues) coexist with
    // the common monitor. Deny unknown future owners instead of assuming.
    switch (ownership->snapshot().kind) {
      case NativeAudioOwnerKind::None:
      case NativeAudioOwnerKind::Capture:
      case NativeAudioOwnerKind::Playback: supported=true; break;
      default: break;
    }
  }
  bool box=false;
#if defined(SINGZ_BOX_LOOPZ_ROUTING)
  box=boxRoutingOwnsCapture();
#endif
  return voiceMonitorUseAllowed(box,microphoneMixActive(),supported);
}
bool permissionGranted() {
#if defined(__APPLE__) && TARGET_OS_OSX
  // Query ONLY. Do not invoke requestAccessForMediaType or open capture here.
  const auto device=objc_getClass("AVCaptureDevice");
  if (!device) return false;
  using Query=long (*)(id,SEL,id);
  return reinterpret_cast<Query>(objc_msgSend)(reinterpret_cast<id>(device),
      sel_registerName("authorizationStatusForMediaType:"),reinterpret_cast<id>(AVMediaTypeAudio))==3;
#else
  return false; // Unsupported platforms never open a monitoring input.
#endif
}
VoiceMonitorSongRoute currentRoute() {
  auto& service=sharedAudioService();
  const auto config=service.voiceMonitorOutputConfig();
  return {config.outputDeviceUid, !config.outputDeviceUid.empty(), config.outputChannels,
      service.status(), service.outputRouteGeneration()};
}
napi_value object(napi_env env) {napi_value o;napi_create_object(env,&o);return o;}
void boolean(napi_env env,napi_value o,const char* key,bool b) {napi_value v;napi_get_boolean(env,b,&v);napi_set_named_property(env,o,key,v);}
void number(napi_env env,napi_value o,const char* key,double n) {napi_value v;napi_create_double(env,n,&v);napi_set_named_property(env,o,key,v);}
void text(napi_env env,napi_value o,const char* key,const std::string& s) {napi_value v;napi_create_string_utf8(env,s.data(),s.size(),&v);napi_set_named_property(env,o,key,v);}
void warnings(napi_env env,napi_value o,const std::vector<std::string>& notes) {
  napi_value a;napi_create_array_with_length(env,notes.size(),&a);
  for(size_t i=0;i<notes.size();++i){napi_value v;napi_create_string_utf8(env,notes[i].data(),notes[i].size(),&v);napi_set_element(env,a,i,v);}
  napi_set_named_property(env,o,"warnings",a);
}
void latency(napi_env env,napi_value o,const VoiceMonitorLatency& l) {
  napi_value v=object(env);
  number(env,v,"sampleRate",l.sampleRate);number(env,v,"requestedFrames",l.requestedFrames);
  number(env,v,"bufferFrames",l.bufferFrames);number(env,v,"inputDeviceFrames",l.inputDeviceFrames);
  number(env,v,"outputDeviceFrames",l.outputDeviceFrames);number(env,v,"roundTripFrames",static_cast<double>(l.roundTripFrames));
  number(env,v,"roundTripMs",l.roundTripMs);number(env,v,"queueFrames",l.queueFrames);number(env,v,"inputBufferFrames",l.inputBufferFrames);number(env,v,"inputSampleRate",l.inputSampleRate);number(env,v,"outputPeriodFrames",l.outputPeriodFrames);number(env,v,"observedOutputFrames",l.observedOutputFrames);number(env,v,"queueFloorFrames",l.queueFloorFrames);boolean(env,v,"delayed",l.delayed);text(env,v,"source","estimated");napi_set_named_property(env,o,"latency",v);
}
void outputs(napi_env env,napi_value o,const std::string& input,uint32_t channel,const std::string& output) {
  (void)input; (void)channel;
  VoiceMonitorOutputChoices choices;
  for (const auto& device : sharedAudioService().inventory().devices)
    if (device.uid==output && device.outputChannels) { choices.id=device.uid;choices.name=device.label; }
  napi_value resolved;
  if(choices.id.empty()) napi_get_null(env,&resolved);
  else { resolved=object(env);text(env,resolved,"id",choices.id);text(env,resolved,"name",choices.name); }
  napi_set_named_property(env,o,"outputDevice",resolved);
  napi_value list;napi_create_array_with_length(env,choices.candidates.size(),&list);
  for(size_t i=0;i<choices.candidates.size();++i) {
    const auto& device=choices.candidates[i];auto entry=object(env);
    text(env,entry,"id",device.id);text(env,entry,"name",device.name);boolean(env,entry,"usable",device.usable);
    if(!device.reason.empty())text(env,entry,"reason",device.reason);
    napi_set_element(env,list,i,entry);
  }
  napi_set_named_property(env,o,"outputCandidates",list);
}
napi_value error(napi_env env,const char* message) {
  auto o=object(env);boolean(env,o,"ok",false);text(env,o,"reason","error");text(env,o,"error",message);return o;
}
bool scalar(napi_env env,napi_value o,const char* key,double& n) {
  napi_value v;return napi_get_named_property(env,o,key,&v)==napi_ok && napi_get_value_double(env,v,&n)==napi_ok && std::isfinite(n);
}
bool selection(napi_env env,napi_value o,std::string& uid,uint32_t& channel,bool allowEmpty=false) {
  napi_value v;size_t length=0;double n=0;
  if(napi_get_named_property(env,o,"inputUid",&v)!=napi_ok ||
      napi_get_value_string_utf8(env,v,nullptr,0,&length)!=napi_ok || (!length && !allowEmpty) || length>4096 ||
      !scalar(env,o,"inputChannel",n) || n<0 || n>=kAudioHostMaxChannels || std::floor(n)!=n)return false;
  uid.resize(length+1);if(napi_get_value_string_utf8(env,v,uid.data(),uid.size(),&length)!=napi_ok)return false;
  uid.resize(length);channel=static_cast<uint32_t>(n);return uid.find('\0')==std::string::npos;
}
bool generation(napi_env env,napi_value v,uint64_t& g,bool zero=false){bool exact=false;return napi_get_value_bigint_uint64(env,v,&g,&exact)==napi_ok && exact && (zero || g);}
napi_value result(napi_env env,const VoiceMonitorResult& r) {
  auto o=object(env);boolean(env,o,"ok",r.ok);
  if(!r.reason.empty())text(env,o,"reason",r.reason);
  if(!r.error.empty())text(env,o,"error",r.error);
  if(r.ok && r.latency.bufferFrames)latency(env,o,r.latency);
  if(r.gainDb)number(env,o,"gainDb",*r.gainDb);
  warnings(env,o,r.warnings);return o;
}
napi_value availability(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value arg{};napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
  std::string uid;uint32_t channel=0;
  bool contextOnly=false;
  napi_value contextFlag;
  if(argc==1 && napi_get_named_property(env,arg,"contextOnly",&contextFlag)==napi_ok)
    napi_get_value_bool(env,contextFlag,&contextOnly);
  if(argc!=1 || (!contextOnly && !selection(env,arg,uid,channel,true))) {
    auto o=object(env);boolean(env,o,"available",false);text(env,o,"reason","error");text(env,o,"detail","Invalid input selection");return o;
  }
  std::lock_guard lock(control);
  if (!monitorPlatformSupported()) {
    auto o=object(env);boolean(env,o,"available",false);text(env,o,"reason","platform");return o;
  }
  if(contextOnly) {
    napi_value value;size_t length=0;bool playing=false;
    auto readUid=[&](const char* key,std::string& target) {
      if(napi_get_named_property(env,arg,key,&value)!=napi_ok ||
          napi_get_value_string_utf8(env,value,nullptr,0,&length)!=napi_ok || length>4096) return false;
      target.resize(length+1);
      if(napi_get_value_string_utf8(env,value,target.data(),target.size(),&length)!=napi_ok) return false;
      target.resize(length);return target.find('\0')==std::string::npos;
    };
    std::string browser,selected;
    if(napi_get_named_property(env,arg,"webAudioPlaying",&value)!=napi_ok ||
        napi_get_value_bool(env,value,&playing)!=napi_ok || !readUid("browserOutputUid",browser) ||
        !readUid("selectedOutputUid",selected)) return error(env,"Invalid playback context");
    // Apply the app common-output selection even without a song or cue.
    (void)playing; (void)browser;
    if (!publishedOutput || *publishedOutput != selected) {
      const auto changed = sharedAudioService().configureOutput(selected);
      if (!changed.ok) {
        auto o=object(env);boolean(env,o,"available",false);text(env,o,"reason","device-lost");text(env,o,"detail",changed.message);return o;
      }
      publishedOutput=selected;
    }
    monitorHost().status();
    auto o=object(env);boolean(env,o,"available",true);return o;
  }
  const auto route=currentRoute();
  if(!useAllowed()) {
    auto o=object(env);boolean(env,o,"available",false);text(env,o,"reason","error");
    text(env,o,"detail","Audio input is busy or unsupported");outputs(env,o,uid,channel,route.output);return o;
  }
  const auto r=monitorHost().availability(uid,channel,route.output,route.native,permissionGranted());
  auto o=object(env);boolean(env,o,"available",r.available);
  if(!r.reason.empty())text(env,o,"reason",r.reason);
  if(!r.detail.empty())text(env,o,"detail",r.detail);
  if(!r.deviceUid.empty())text(env,o,"deviceUid",r.deviceUid);
  if(r.minBufferFrames)number(env,o,"minBufferFrames",r.minBufferFrames);
  if(r.maxBufferFrames)number(env,o,"maxBufferFrames",r.maxBufferFrames);
  outputs(env,o,uid,channel,route.output);
  return o;
}
napi_value begin(napi_env env,napi_callback_info info) {
  size_t argc=2;napi_value args[2]{};napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  std::string uid;uint32_t channel=0;uint64_t g=0;double gain=0,target=0,maximum=0;
  if(argc!=2 || !selection(env,args[0],uid,channel) || !generation(env,args[1],g) ||
      !scalar(env,args[0],"gainDb",gain) || !scalar(env,args[0],"targetFrames",target) ||
      !scalar(env,args[0],"maxFrames",maximum) || target!=32 || maximum!=256)return error(env,"Invalid monitor configuration or generation");
  if (!monitorPlatformSupported()) {
    VoiceMonitorResult unavailable; unavailable.reason="platform";
    unavailable.error="Live monitoring is available on macOS"; return result(env,unavailable);
  }
  std::lock_guard lock(control);
  if(!useAllowed())return error(env,"Audio input is busy or unsupported");
  const auto route=currentRoute();
  auto r=monitorHost().begin(uid,channel,route.output,route.native,permissionGranted(),static_cast<float>(std::clamp(gain,double(kVoiceMonitorGainMinDb),double(kVoiceMonitorGainMaxDb))),32,256,g,route.channels,&sharedAudioService());
  if(r.ok){monitoredOutput=route.output;monitoredChannels=route.channels;monitoredInput=uid;monitoredInputChannel=channel;}
  auto o=result(env,r);outputs(env,o,uid,channel,route.output);return o;
}
napi_value outputCurrent(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value arg{};bool current=false;
  napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
  if(argc!=1 || napi_get_value_bool(env,arg,&current)!=napi_ok)return error(env,"Invalid output state");
  std::lock_guard lock(control);
  auto o=object(env);boolean(env,o,"ok",sharedAudioService().setPlaybackOutputCurrent(current));
  return o;
}
napi_value gain(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value arg{};napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);double gain=0;
  if(argc!=1 || napi_get_value_double(env,arg,&gain)!=napi_ok || !std::isfinite(gain)){auto o=object(env);boolean(env,o,"ok",false);return o;}
  std::lock_guard lock(control);auto o=object(env);
  boolean(env,o,"ok",monitorHost().setGain(static_cast<float>(std::clamp(gain,double(kVoiceMonitorGainMinDb),double(kVoiceMonitorGainMaxDb)))));return o;
}
napi_value status(napi_env env,napi_callback_info) {
  std::lock_guard lock(control);
  const auto route=currentRoute();
  if(!useAllowed()) { monitorHost().close();monitoredOutput.clear();monitoredChannels.clear(); }
  // Common status may reopen/re-admit a stopped output while preserving capture.
  const auto r=monitorHost().status();
  if(r.running){monitoredOutput=sharedAudioService().activeOutputUid();monitoredChannels=sharedAudioService().activeOutputConfig().outputChannels;}
  auto o=object(env);if(r.gainDb)number(env,o,"gainDb",*r.gainDb);boolean(env,o,"running",r.running);boolean(env,o,"lost",r.lost);
  if(r.running)latency(env,o,r.latency);
  if(!r.reason.empty())text(env,o,"reason",r.reason);
  text(env,o,"outputDeviceUid",monitoredOutput);
  const auto pairCount=std::min(monitoredChannels.size(),size_t{2});
  napi_value pair;napi_create_array_with_length(env,pairCount,&pair);
  for(size_t c=0;c<pairCount;++c){napi_value v;napi_create_uint32(env,monitoredChannels[c],&v);napi_set_element(env,pair,c,v);}
  napi_set_named_property(env,o,"outputChannels",pair);
  text(env,o,"songOutputGeneration",std::to_string(route.generation));
  text(env,o,"songStreamGeneration",std::to_string(route.song.streamGeneration));
  text(env,o,"songHostRouteGeneration",std::to_string(route.song.routeGeneration));
  number(env,o,"songHostStateCode",static_cast<uint32_t>(route.song.state));
  number(env,o,"monitorObservedCallbackFrames",r.observedCallbackFrames);
  number(env,o,"monitorPeak",r.peak);number(env,o,"monitorRms",r.rms);
  auto& capture=sharedVoiceMonitorCapture();
  text(env,o,"inputDeviceUid",capture.openingResult().deviceUid);
  text(env,o,"inputCaptureState",audioInputStateName(capture.state()));
  number(env,o,"monitorCaptureUsers",capture.users(VoiceCaptureUser::Monitor));
  number(env,o,"armCaptureUsers",capture.users(VoiceCaptureUser::Arm));
  number(env,o,"takeCaptureUsers",capture.users(VoiceCaptureUser::Take));
  const auto history=capture.source().stats();auto historyStats=object(env);
#define MONITOR_DIAG(name) text(env,historyStats,#name,std::to_string(history.name))
  MONITOR_DIAG(publishedBlocks);MONITOR_DIAG(publishedFrames);MONITOR_DIAG(droppedBlocks);
  MONITOR_DIAG(droppedFrames);MONITOR_DIAG(missingFrames);MONITOR_DIAG(estimatedTimestampBlocks);
  MONITOR_DIAG(unknownTimestampBlocks);
  MONITOR_DIAG(phaseCorrections);MONITOR_DIAG(correctedSamples);MONITOR_DIAG(rejectedIntervals);
  MONITOR_DIAG(discontinuities);
#undef MONITOR_DIAG
  napi_set_named_property(env,o,"monitorHistoryDiagnostics",historyStats);
  number(env,o,"songProcessBufferFrames",route.song.latency.bufferFrames);
  number(env,o,"songBufferWarnings",route.song.bufferWarnings);
  number(env,o,"songObservedCallbackFrames",route.song.observedCallbackFrames);
  const auto d=sharedAudioService().callbackDiagnostics();
  auto diagnostics=object(env);
#define SONG_DIAG(name) text(env,diagnostics,#name,std::to_string(d.name))
  SONG_DIAG(callbacks);SONG_DIAG(deliveredFrames);SONG_DIAG(periodChanges);SONG_DIAG(sequenceGaps);
  SONG_DIAG(timestampChanges);SONG_DIAG(clockChanges);SONG_DIAG(routeChanges);
  SONG_DIAG(positiveSampleGapFrames);SONG_DIAG(sampleRegressions);SONG_DIAG(maxCallbackExcessNs);
  SONG_DIAG(maxOutputExcessNs);SONG_DIAG(periodOutputExcessNs);SONG_DIAG(lastFlags);SONG_DIAG(lastFrames);
#undef SONG_DIAG
  napi_set_named_property(env,o,"songCallbackDiagnostics",diagnostics);
  boolean(env,o,"songOutputCurrent",sharedAudioService().playbackOutputCurrent());
  outputs(env,o,monitoredInput,monitoredInputChannel,route.output);
  warnings(env,o,r.warnings);return o;
}
napi_value end(napi_env env,napi_callback_info info) {
  size_t argc=1;napi_value arg{};napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);uint64_t g=0;
  if(argc!=1 || !generation(env,arg,g,true)){auto o=object(env);boolean(env,o,"ok",false);return o;}
  std::lock_guard lock(control);auto r=monitorHost().end(g);if(r.ok){monitoredOutput.clear();monitoredChannels.clear();}
  auto o=object(env);boolean(env,o,"ok",r.ok);warnings(env,o,r.warnings);return o;
}
template<napi_callback Callback> napi_value exceptionResult(napi_env env,const char* message) {
  if constexpr(Callback==begin || Callback==status) {
    std::lock_guard lock(control);monitorHost().close();monitoredOutput.clear();monitoredChannels.clear();
  }
  auto o=object(env);
  if constexpr(Callback==availability) {
    boolean(env,o,"available",false);text(env,o,"reason","error");text(env,o,"detail",message);
  } else if constexpr(Callback==status) {
    boolean(env,o,"running",false);boolean(env,o,"lost",false);warnings(env,o,{message});
  } else if constexpr(Callback==begin) {
    return error(env,message);
  } else {
    boolean(env,o,"ok",false);
    if constexpr(Callback==end)warnings(env,o,{message});
  }
  return o;
}
template<napi_callback Callback> napi_value guarded(napi_env env,napi_callback_info info) {
  try{return Callback(env,info);}
  catch(const std::exception&){return exceptionResult<Callback>(env,"Native voice monitor failed");}
  catch(...){return exceptionResult<Callback>(env,"Native voice monitor failed");}
}
}
void defineVoiceMonitorExports(napi_env env,napi_value exports,NativeAudioOwnership* owner) {
  std::lock_guard lock(control);
  ownership=owner;
  environments.attach();
  napi_property_descriptor properties[]={
    {"setPlaybackOutputCurrent",nullptr,guarded<outputCurrent>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"voiceMonitorAvailability",nullptr,guarded<availability>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"beginVoiceMonitor",nullptr,guarded<begin>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setVoiceMonitorGain",nullptr,guarded<gain>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"voiceMonitorStatus",nullptr,guarded<status>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"endVoiceMonitor",nullptr,guarded<end>,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,sizeof(properties)/sizeof(properties[0]),properties);
}
bool cleanupVoiceMonitor() noexcept {
  std::lock_guard lock(control);
  if(!environments.detach())return false;
  monitorHost().close();monitoredOutput.clear();monitoredChannels.clear();ownership=nullptr;
  monitoredInput.clear();publishedOutput.reset();
  return true;
}
}
