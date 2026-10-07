#include "training_audio_session.h"
#include "../playback/shared_audio_service.h"
#include "native_audio_ownership.h"
#include "../playback/training_pcm_mixer.h"
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <mutex>
#include <vector>
#if defined(__APPLE__)
#include <mach/mach_time.h>
#elif defined(_WIN32)
#include <windows.h>
#endif

namespace singz {
namespace {
uint64_t nowNs() noexcept {
#if defined(__APPLE__)
  static const mach_timebase_info_data_t scale = [] { mach_timebase_info_data_t s{}; mach_timebase_info(&s); return s; }();
  return static_cast<uint64_t>(static_cast<long double>(mach_absolute_time()) * scale.numer / scale.denom);
#elif defined(_WIN32)
  static const int64_t frequency = [] { LARGE_INTEGER f{}; QueryPerformanceFrequency(&f); return f.QuadPart; }();
  LARGE_INTEGER value{}; QueryPerformanceCounter(&value);
  return static_cast<uint64_t>(static_cast<long double>(value.QuadPart) * 1000000000.0L / frequency);
#else
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
TrainingPcmMixer mixer;
std::mutex control;
bool attached = false;
NativeAudioOwnership* ownership = nullptr;
DesktopPlaybackBackendFactory factory = nullptr;
bool render(void*, const AudioHostRenderBlock& block) noexcept { return mixer.render(block); }
napi_value object(napi_env env) { napi_value o; napi_create_object(env, &o); return o; }
void number(napi_env env, napi_value o, const char* k, double n) { napi_value v; napi_create_double(env,n,&v); napi_set_named_property(env,o,k,v); }
void text(napi_env env, napi_value o, const char* k, const std::string& s) { napi_value v; napi_create_string_utf8(env,s.c_str(),s.size(),&v); napi_set_named_property(env,o,k,v); }
void boolean(napi_env env, napi_value o, const char* k, bool b) { napi_value v; napi_get_boolean(env,b,&v); napi_set_named_property(env,o,k,v); }
napi_value failure(napi_env env, const char* s) { auto o=object(env); boolean(env,o,"ok",false); text(env,o,"error",s); return o; }
bool scalar(napi_env env, napi_value o, const char* k, double* n) {
  napi_value v; return napi_get_named_property(env,o,k,&v)==napi_ok && napi_get_value_double(env,v,n)==napi_ok && std::isfinite(*n);
}
bool generation(napi_env env, napi_value v, uint64_t& g) { bool lossless=false; return napi_get_value_bigint_uint64(env,v,&g,&lossless)==napi_ok && lossless && g; }
napi_value initialize(napi_env env, napi_callback_info info) {
  size_t argc=1; napi_value arg{}; napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr);
  AudioHostConfig config;
  bool explicitOutput = false;
  std::string provider;
  if (argc) {
    napi_value uid; bool present=false;
    napi_has_named_property(env,arg,"provider",&present);
    if (present) {
      size_t length=0;
      if(napi_get_named_property(env,arg,"provider",&uid)!=napi_ok || napi_get_value_string_utf8(env,uid,nullptr,0,&length)!=napi_ok || length>32)
        return failure(env,"Invalid audio provider");
      provider.resize(length+1);
      napi_get_value_string_utf8(env,uid,provider.data(),provider.size(),&length);
      provider.resize(length);
    }
    napi_has_named_property(env,arg,"outputDeviceUid",&present);
    if (present) {
      explicitOutput = true;
      size_t length=0;
      if(napi_get_named_property(env,arg,"outputDeviceUid",&uid)!=napi_ok || napi_get_value_string_utf8(env,uid,nullptr,0,&length)!=napi_ok || length>4096)
        return failure(env,"Invalid output device UID");
      config.outputDeviceUid.resize(length+1);
      napi_get_value_string_utf8(env,uid,config.outputDeviceUid.data(),config.outputDeviceUid.size(),&length);
      config.outputDeviceUid.resize(length);
    }
  }
#if defined(_WIN32)
  if (!config.outputDeviceUid.empty()) {
    const std::string prefix = provider + ":";
    if ((provider != "wasapi" && provider != "asio") || !config.outputDeviceUid.starts_with(prefix) || config.outputDeviceUid.size() == prefix.size())
      return failure(env,"The output device identity does not match the audio provider");
    config.outputDeviceUid.erase(0,prefix.size());
  }
#endif
  std::lock_guard<std::mutex> lock(control);
  if (ownership && ownership->snapshot().kind == NativeAudioOwnerKind::Monitor)
    return failure(env,"Native monitoring currently owns the audio output");
  if (!provider.empty()) {
    std::string reason;
    auto backend = factory ? factory(provider,&reason) : nullptr;
    if (!backend) return failure(env,reason.empty() ? "The selected provider is unavailable" : reason.c_str());
    auto configured = sharedAudioService().configureProvider(std::move(backend),provider);
    if (!configured.ok) return failure(env,configured.message.c_str());
  }
  auto result = explicitOutput ? sharedAudioService().configureOutput(config.outputDeviceUid)
                               : sharedAudioService().initialize(config);
  if (!result.ok) return failure(env,result.message.c_str());
  if (!attached) { sharedAudioService().setTrainingRenderer(render,nullptr); attached=true; }
  auto o=object(env); boolean(env,o,"ok",true); return o;
}
napi_value refreshInventory(napi_env env,napi_callback_info) {
  sharedAudioService().refreshInventory();
  auto o=object(env); boolean(env,o,"ok",true); return o;
}
napi_value schedule(napi_env env, napi_callback_info info) {
  size_t argc=2; napi_value args[2]{}; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  uint64_t g=0; double rate=0,delay=0,gain=0;
  if (argc!=2 || !generation(env,args[1],g) || !scalar(env,args[0],"sampleRate",&rate) || rate<8000 || rate>192000 ||
      !scalar(env,args[0],"startDelayMs",&delay) || delay<0 || delay>120000 || !scalar(env,args[0],"gain",&gain) || gain<0 || gain>8)
    return failure(env,"Invalid training cue configuration");
  napi_value channels; bool array=false; uint32_t count=0;
  if (napi_get_named_property(env,args[0],"channels",&channels)!=napi_ok || napi_is_array(env,channels,&array)!=napi_ok || !array || napi_get_array_length(env,channels,&count)!=napi_ok || count<1 || count>2)
    return failure(env,"Training cue requires one or two PCM planes");
  std::array<const float*,2> sources{}; size_t frames=0;
  for (uint32_t c=0;c<count;++c) {
    napi_value plane; napi_typedarray_type type; size_t length=0,offset=0; void* data=nullptr; napi_value buffer;
    if (napi_get_element(env,channels,c,&plane)!=napi_ok || napi_get_typedarray_info(env,plane,&type,&length,&data,&buffer,&offset)!=napi_ok || type!=napi_float32_array || !length || length>120*rate || length*count*sizeof(float)>48*1024*1024 || (c && length!=frames))
      return failure(env,"Invalid training PCM plane");
    frames=length; auto* samples=static_cast<float*>(data);
    sources[c] = samples;
    for (size_t frame=0;frame<length;++frame) if (!std::isfinite(samples[frame])) return failure(env,"Non-finite training PCM");
  }
  std::lock_guard<std::mutex> lock(control);
  if (ownership && ownership->snapshot().kind == NativeAudioOwnerKind::Monitor)
    return failure(env,"Native monitoring currently owns the audio output");
  if (!mixer.canSchedule(frames,count)) return failure(env,"Training PCM capacity exceeded");
  std::vector<std::vector<float>> planes;
  for(uint32_t channel=0;channel<count;++channel) planes.emplace_back(sources[channel],sources[channel]+frames);
  auto ready=sharedAudioService().ensureOutput();
  if (!ready.ok) return failure(env,ready.message.c_str());
  if (!attached) { sharedAudioService().setTrainingRenderer(render,nullptr); attached=true; }
  const uint64_t start = nowNs()+static_cast<uint64_t>(delay*1e6);
  if(!mixer.schedule(std::move(planes),g,rate,start,static_cast<float>(gain)))
    return failure(env,"Training PCM capacity exceeded");
  auto o=object(env); boolean(env,o,"ok",true); text(env,o,"startHostTimeNs",std::to_string(start)); number(env,o,"durationMs",frames/rate*1000); return o;
}
napi_value cancel(napi_env env,napi_callback_info info) {
  size_t argc=1; napi_value arg; napi_get_cb_info(env,info,&argc,&arg,nullptr,nullptr); uint64_t g=0;
  if(argc!=1 || !generation(env,arg,g)) return failure(env,"Invalid training cue generation");
  std::lock_guard<std::mutex> lock(control);
  mixer.cancel(g);
  auto o=object(env); boolean(env,o,"ok",true); return o;
}
napi_value setGain(napi_env env,napi_callback_info info) {
  size_t argc=2; napi_value args[2]{}; napi_get_cb_info(env,info,&argc,args,nullptr,nullptr);
  uint64_t g=0; double gain=0;
  if(argc!=2 || !generation(env,args[0],g) || napi_get_value_double(env,args[1],&gain)!=napi_ok || !std::isfinite(gain) || gain<0 || gain>8)
    return failure(env,"Invalid training cue gain");
  std::lock_guard<std::mutex> lock(control);
  mixer.setGain(g,static_cast<float>(gain));
  auto o=object(env); boolean(env,o,"ok",true); return o;
}
napi_value status(napi_env env,napi_callback_info) {
  auto o=object(env); const auto host=sharedAudioService().status(); text(env,o,"hostTimeNs",std::to_string(nowNs()));
  text(env,o,"renderedFrames",std::to_string(host.renderedFrames));
  text(env,o,"callbacks",std::to_string(host.callbacks));
  number(env,o,"sampleRate",host.format.sampleRate);
  number(env,o,"streamGeneration",static_cast<double>(host.streamGeneration));
  number(env,o,"enumerationCount",static_cast<double>(sharedAudioService().enumerationCount()));
  number(env,o,"watchedDeviceCount",static_cast<double>(sharedAudioService().watchedDeviceCount()));
  const auto& latency=host.latency; const double rate=sharedAudioService().sampleRate();
  number(env,o,"outputLatencyMs",rate>0 ? (latency.outputDeviceFrames+latency.bufferFrames+latency.externalRouteFrames)*1000.0/rate:0); return o;
}
// N-API is an exception boundary: allocation or provider exceptions become
// ordinary result errors, never an unwind across the C ABI.
template <napi_value (*Call)(napi_env,napi_callback_info)>
napi_value guarded(napi_env env,napi_callback_info info) noexcept {
  try { return Call(env,info); }
  catch(const std::exception& error) { return failure(env,error.what()); }
  catch(...) { return failure(env,"Native training audio failed"); }
}

}
void defineTrainingAudioExports(napi_env env,napi_value exports,NativeAudioOwnership* owner,DesktopPlaybackBackendFactory backendFactory) {
  ownership = owner;
  factory = backendFactory;
  napi_property_descriptor p[]={
    {"initializeSharedAudio",nullptr,guarded<initialize>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"scheduleTrainingCue",nullptr,guarded<schedule>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"cancelTrainingCues",nullptr,guarded<cancel>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"refreshSharedAudioInventory",nullptr,guarded<refreshInventory>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"setTrainingCueGain",nullptr,guarded<setGain>,nullptr,nullptr,nullptr,napi_default,nullptr},
    {"trainingCueStatus",nullptr,guarded<status>,nullptr,nullptr,nullptr,napi_default,nullptr}};
  napi_define_properties(env,exports,6,p);
}
void cleanupTrainingAudio() noexcept {
  std::lock_guard<std::mutex> lock(control);
  if(attached) { sharedAudioService().clearTrainingRenderer(); attached=false; }
  mixer.clearQuiesced();
}
}
