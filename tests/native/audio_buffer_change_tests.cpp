#include "native/playback/shared_audio_service.h"
#include "native/playback/voice_monitor_client.h"
#include "native/playback/training_pcm_mixer.h"
#include "native/playback/native_playback_session.h"
#include "native/electron/take_writer.h"
#include <zcore/media/wav.h>
#include "third_party/zcore/zcore/platform/macos/audio_device_macos_buffer.h"
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <fcntl.h>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

using namespace singz;
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr, "buffer change: %s at %d\n", #x, __LINE__); std::exit(1); } } while (false)
namespace {
struct Hal {
  std::string uid{"duplex"}; uint32_t frames{512};
  unsigned outputOpens{}, inputOpens{}, outputStops{}, inputStops{};
  uint32_t rejectOutput{}, rejectRollback{}, rejectInput{}, rejectStart{};
  bool throwInputFactory{};
  detail::MacAudioBufferLedger ledger;
  const std::string& deviceUid() const { return uid; }
  uint64_t deviceIdentity() const { return 7; }
  bool identityMatches() const { return true; }
  bool isSettable() const { return true; }
  bool readFrames(uint32_t& n) const { n = frames; return true; }
  bool readRange(uint32_t& lo, uint32_t& hi) const { lo = 16; hi = 4096; return true; }
  bool writeFrames(uint32_t n) { frames = n; return true; }
} *hal;
AudioHostInventory inventory() {
  AudioHostDeviceInfo d; d.uid = "duplex"; d.label = "Fake HAL";
  d.defaultInput = d.defaultOutput = true; d.inputChannels = 1; d.outputChannels = 2;
  d.nominalSampleRate = 48000; d.bufferFrames = {16,4096,512,1}; d.transport = AudioHostTransport::Usb;
  return {{d},d.uid,d.uid};
}
struct Output final : AudioHostBackend {
  AudioHostStatus current; AudioHostRender callback{}; void* context{};
  detail::MacAudioBufferOwnership lease;
  uint64_t frame{}, stream{}, sequence{}; bool first{};
  bool threaded{}; std::atomic<bool> quit{false}; std::thread worker;
  float lastPeak{};
  ~Output() override { stop(); }
  AudioHostInventory enumerate() const override { return inventory(); }
  AudioHostResult result(bool ok = true) const { return {ok, ok ? AudioHostError::None : AudioHostError::ProviderFailure,
    current.state,current.format,current.latency,ok ? "" : "Injected output failure"}; }
  AudioHostResult open(const AudioHostConfig& c, AudioHostRender cb, void* ctx) override {
    ++hal->outputOpens; callback=cb; context=ctx; frame=0; sequence=0; first=true;
    if (c.requestedBufferFrames == hal->rejectOutput || c.requestedBufferFrames == hal->rejectRollback) return result(false);
    const auto r = detail::requestMacAudioBuffer(*hal,c.requestedBufferFrames,c.maximumFrames,lease,0,hal->ledger);
    CHECK(r.ok());
    current.state=AudioHostState::Open; current.format={48000,c.maximumFrames,r.frames,0,2};
    current.latency.bufferFrames=r.frames; current.streamGeneration=++stream;
    return result();
  }
  AudioHostResult start() override {
    if (current.latency.bufferFrames == hal->rejectStart) return result(false);
    current.state=AudioHostState::Running;
    if(threaded) {
      quit=false;
      worker=std::thread([&] {
        while(!quit.load()) {
          render(static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
              std::chrono::steady_clock::now().time_since_epoch()).count()));
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
      });
    }
    return result();
  }
  void stop() noexcept override {
    quit=true; if(worker.joinable()) worker.join();
    ++hal->outputStops; detail::restoreMacAudioBuffer(*hal,lease,hal->ledger); current.state=AudioHostState::Stopped;
  }
  AudioHostStatus status() const noexcept override { return current; }
  void render(uint64_t ns) {
    CHECK(current.state==AudioHostState::Running);
    std::array<float,4096> l{},r{}; float* planes[]{l.data(),r.data()};
    AudioHostRenderBlock b; b.output=planes; b.frames=current.latency.bufferFrames;
    b.maximumFrames=current.format.maximumFrames; b.outputChannels=2; b.sampleRate=48000;
    b.outputFrame=frame; b.streamGeneration=stream; b.routeGeneration=stream;
    b.callbackSequence=sequence++;
    b.callbackHostTimeNs=b.outputHostTimeNs=ns; b.outputTimestampValid=true;
    b.discontinuity=first ? AudioHostDiscontinuityStart : 0; first=false;
    CHECK(callback(context,b)); frame+=b.frames;
    lastPeak=0; for(uint32_t i=0;i<b.frames;++i) lastPeak=std::max(lastPeak,std::abs(l[i]));
  }
};
struct Input final : AudioInputBackend {
  detail::MacAudioBufferOwnership lease;
  AudioInputPush push{}; void* context{}; AudioInputConfig config;
  AudioInputResult result() const {
    auto r=AudioInputResult::success(AudioInputState::Running,48000,0); r.inputBufferFrames=hal->frames; return r;
  }
  AudioInputResult open(const AudioInputConfig& c, AudioInputPush cb, void* ctx) override {
    ++hal->inputOpens; config=c; push=cb; context=ctx;
    if(c.requestedBufferFrames==hal->rejectInput) return AudioInputResult::failure(AudioInputState::Error,"Injected input failure",0);
    const auto r=detail::requestMacAudioBuffer(*hal,c.requestedBufferFrames,16384,lease,0,hal->ledger,false);
    CHECK(r.ok()); return result();
  }
  AudioInputResult start() override {
    std::array<float,4096> samples{}; samples.fill(.25f);
    push(context,samples.data(),hal->frames,10000000000ULL,10000000000ULL,AudioInputTimestampQuality::Hardware);
    return result();
  }
  void stop() override { ++hal->inputStops; detail::restoreMacAudioBuffer(*hal,lease,hal->ledger); }
  bool takeFailure(std::string&) override { return false; }
};
Input* activeInput{};
std::unique_ptr<AudioInputBackend> makeInput() {
  if(hal->throwInputFactory) throw std::runtime_error("Injected input factory failure");
  auto p=std::make_unique<Input>(); activeInput=p.get(); return p;
}
struct Song {
  uint64_t position{}, lastEnd{}, stream{}, sequence{}; bool seen{};
  static bool render(void* p,const AudioHostRenderBlock& b) noexcept {
    auto& s=*static_cast<Song*>(p);
    if(s.seen) { CHECK(b.outputFrame==s.lastEnd); CHECK(b.streamGeneration==s.stream); CHECK(b.callbackSequence==s.sequence+1); CHECK(!b.discontinuity); }
    s.seen=true; s.stream=b.streamGeneration; s.lastEnd=b.outputFrame+b.frames; s.position+=b.frames;
    s.sequence=b.callbackSequence;
    for(uint32_t ch=0;ch<b.outputChannels;++ch) std::fill_n(b.output[ch],b.frames,.125f);
    return true;
  }
};
struct Cue {
  TrainingPcmMixer mixer; bool heard{};
  static bool render(void* p,const AudioHostRenderBlock& b) noexcept {
    auto& c=*static_cast<Cue*>(p); const auto before=b.output[0][0];
    c.mixer.render(b); if(b.output[0][0]>before) c.heard=true;
    return true;
  }
};
void runOwner(unsigned owner, unsigned failure = 0) {
  Hal hardware; hal=&hardware;
  auto host=std::make_unique<Output>(); auto* output=host.get();
  SharedAudioService service(std::move(host),"coreaudio");
  VoiceMonitorCapture capture(makeInput); CommonVoiceMonitor monitor(service,capture);
  CHECK(service.ensureOutput().ok);
  const bool input = owner==4 || owner==5 || owner==7;
  const bool monitorOn = owner==5 || owner==7;
  std::atomic<uint64_t> delivered{0};
  if(input && owner!=5) {
    AudioInputConfig c; c.deviceUid="duplex"; c=service.inputBufferConfig(c);
    const auto devices=service.inputDevices();
    CHECK(capture.retain(VoiceCaptureUser::Arm,c,[&](const AudioInputBlockView& b) { delivered.fetch_add(b.frames); },&devices).ok);
  }
  if(monitorOn) CHECK(monitor.begin("duplex",0,true,-9,7).ok);
  Song song; std::unique_ptr<AudioHostBackend> client;
  if(owner==1 || owner==2 || owner==3 || owner==7) {
    client=service.playbackBackend(std::make_unique<Output>(),"coreaudio");
    AudioHostConfig c; c.outputDeviceUid="duplex"; c.outputChannels={0,1}; c.requestedSampleRate=48000;
    CHECK(client->open(c,Song::render,&song).ok);
    if(owner!=1) CHECK(client->start().ok);
    if(owner==2) {
      output->render(9000000000ULL); CHECK(song.position>0);
      CHECK(client->suspend().ok); song.seen=false;
    }
  }
  constexpr uint64_t origin=10000000000ULL;
  CHECK(service.ensureOutput().ok);
  output->render(origin);
  const auto oldPosition=song.position;
  const auto state=client ? client->status().state : AudioHostState::Closed;
  const auto arm=capture.users(VoiceCaptureUser::Arm), monitoring=capture.users(VoiceCaptureUser::Monitor);
  if(arm) {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
    while(!delivered.load() && std::chrono::steady_clock::now()<deadline) std::this_thread::yield();
    CHECK(delivered.load()>0);
  }
  const auto deliveredBefore=delivered.load();
  const auto gain=monitor.status().gainDb;
  Cue cue;
  if(owner>=6) {
    service.setTrainingRenderer(Cue::render,&cue);
    CHECK(cue.mixer.schedule({std::vector<float>(64,.25f)},19,48000,origin+5000000,1));
  }
  uint64_t elapsed=0;
  SharedAudioService::BufferChangeHooks hooks;
  hooks.inputUid="duplex";
  hooks.pauseInput=[&] { return capture.pauseForBufferChange(); };
  if(input) hooks.resumeInput=[&](uint32_t frames) {
    // Make the outage longer than the queued short cue, so omitting its
    // deadline shift loses the cue deterministically.
    std::this_thread::sleep_for(std::chrono::milliseconds(4));
    const auto r=capture.resumeAfterBufferChange(frames); return r.ok ? std::string{} : r.error;
  };
  hooks.prepareCues=[&](uint64_t ns, uint64_t expected) { elapsed=ns; cue.mixer.prepareForBufferResume(expected); };
  if(failure==1) hardware.rejectOutput=64;
  if(failure==2) hardware.rejectInput=64;
  if(failure==3) hardware.rejectStart=64;
  const auto began=std::chrono::steady_clock::now();
  const auto changed=service.applyBufferPreferences({{"duplex",64}},hooks);
  const auto outage=static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now()-began).count());
  CHECK(changed.ok == (failure==0));
  CHECK(hardware.frames==(failure ? 128u : 64u));
  CHECK(service.requestedBufferFrames("duplex")==hardware.frames);
  CHECK(capture.users(VoiceCaptureUser::Arm)==arm && capture.users(VoiceCaptureUser::Monitor)==monitoring);
  CHECK(!input || (capture.state()==AudioInputState::Running && capture.openingResult().inputBufferFrames==hardware.frames));
  CHECK(!client || client->status().state==state);
  CHECK(song.position==oldPosition); // No rebuild, seek or automatic Play.
  CHECK(!monitorOn || (monitor.status().running && monitor.status().gainDb==gain));
  if(arm) {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
    while(delivered.load()==deliveredBefore && std::chrono::steady_clock::now()<deadline) std::this_thread::yield();
    CHECK(delivered.load()>deliveredBefore); // Preview/analysis sink survived the reopen.
  }
  output->render(origin+5000000+outage);
  if(owner==3 || owner==7) CHECK(song.position==oldPosition+hardware.frames);
  if(owner>=6) {
    for(uint64_t i=1;i<=4;++i) output->render(origin+5000000+outage+i*hardware.frames*1000000000ULL/48000);
    CHECK(cue.heard);
  }
  if(owner==1 || owner==2) {
    CHECK(song.position==oldPosition);
    CHECK((owner==2 ? client->resume() : client->start()).ok);
    output->render(origin+10000000+elapsed);
    CHECK(song.position==oldPosition+hardware.frames);
  }
  if(input) {
    CHECK(capture.retainExisting(VoiceCaptureUser::Take));
    const auto stops=hardware.outputStops, opens=hardware.inputOpens;
    CHECK(!service.applyBufferPreferences({{"duplex",32}},hooks).ok);
    CHECK(hardware.outputStops==stops && hardware.inputOpens==opens);
    CHECK(capture.users(VoiceCaptureUser::Take)==1);
    capture.release(VoiceCaptureUser::Take);
    CHECK(service.applyBufferPreferences({{"duplex",32}},hooks).ok);
    CHECK(capture.users(VoiceCaptureUser::Arm)==arm && hardware.frames==32);
  }
  if(client) client->stop();
  monitor.close(); capture.release(VoiceCaptureUser::Arm); service.clearTrainingRenderer();
}
void concurrentReopen() {
  Hal hardware; hal=&hardware;
  auto host=std::make_unique<Output>(); auto* output=host.get(); output->threaded=true;
  SharedAudioService service(std::move(host),"coreaudio");
  VoiceMonitorCapture capture(makeInput); CommonVoiceMonitor monitor(service,capture);
  CHECK(service.ensureOutput().ok);
  AudioInputConfig c; c.deviceUid="duplex"; c=service.inputBufferConfig(c);
  auto devices=service.inputDevices(); CHECK(capture.retain(VoiceCaptureUser::Arm,c,{},&devices).ok);
  CHECK(monitor.begin("duplex",0,true,-9,7).ok);
  Song song;
  auto client=service.playbackBackend(std::make_unique<Output>(),"coreaudio");
  AudioHostConfig config; config.outputDeviceUid="duplex"; config.outputChannels={0,1}; config.requestedSampleRate=48000;
  CHECK(client->open(config,Song::render,&song).ok && client->start().ok);
  SharedAudioService::BufferChangeHooks hooks;
  hooks.inputUid="duplex"; hooks.pauseInput=[&] { return capture.pauseForBufferChange(); };
  hooks.resumeInput=[&](uint32_t frames) { const auto r=capture.resumeAfterBufferChange(frames); return r.ok ? std::string{} : r.error; };
  for(auto frames : {64u,256u,32u,128u,64u,128u}) {
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
    CHECK(service.applyBufferPreferences({{"duplex",frames}},hooks).ok);
    CHECK(monitor.status().running && capture.users(VoiceCaptureUser::Arm)==1);
  }
  client->stop();
  CHECK(song.position>0);
  monitor.close(); capture.release(VoiceCaptureUser::Arm);
}
void nativeTransport() {
  const auto path=(std::filesystem::temp_directory_path()/
      ("singz-buffer-live-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".wav")).string();
  {
    WavWriter writer; CHECK(writer.open(path,48000,1));
    std::vector<float> pcm(48000);
    for(size_t i=0;i<pcm.size();++i) pcm[i]=.2f*std::sin(2*3.14159265358979323846*220*i/48000);
    CHECK(writer.append(pcm.data(),pcm.size())); CHECK(writer.finalize());
  }
  for(double transpose : {0.,2.}) {
    Hal hardware; hal=&hardware;
    auto host=std::make_unique<Output>(); auto* output=host.get();
    SharedAudioService service(std::move(host),"coreaudio");
    NativePlaybackSession session(service.playbackBackend(std::make_unique<Output>(),"coreaudio"));
    NativePlaybackPrepareConfig config; config.outputDeviceUid="duplex"; config.outputChannels={0,1};
    config.requestedSampleRate=48000; config.maximumFrames=kAudioHostMaxFrames;
    config.transposeSemitones=transpose; config.serviceOwnsMasterGain=true;
#if defined(_WIN32)
    const int fd=_open(path.c_str(),_O_RDONLY|_O_BINARY);
#else
    const int fd=::open(path.c_str(),O_RDONLY);
#endif
    CHECK(fd>=0);
    std::vector<NativePlaybackLaneSource> lanes; lanes.push_back({"song",OwnedFileDescriptor(fd),1,false,false,{}});
    CHECK(session.prepare(std::move(config),std::move(lanes),1).ok);
    CHECK(session.openOutput(1).ok && session.start(1).ok);
    for(uint64_t i=0;i<128;++i) output->render(10000000000ULL+i*128*1000000000ULL/48000);
    if(output->lastPeak<=.001f) std::fprintf(stderr,"native transport transpose %.0f, peak %.6f\n",transpose,output->lastPeak);
    CHECK(output->lastPeak>.001f);
    auto position=session.status().renderedProjectFrame;
    CHECK(position>0);
    CHECK(service.applyBufferPreferences({{"duplex",64}}).ok);
    CHECK(session.status().state==NativePlaybackState::Running && session.status().renderedProjectFrame==position);
    output->render(10400000000ULL);
    CHECK(output->lastPeak>.001f);
    CHECK(session.status().state==NativePlaybackState::Running);
    CHECK(session.status().renderedProjectFrame==position+64);
    CHECK(session.pause(1).ok);
    output->render(10405000000ULL);
    position=session.status().renderedProjectFrame;
    CHECK(session.suspendOutput(1).ok);
    CHECK(service.applyBufferPreferences({{"duplex",32}}).ok);
    output->render(10410000000ULL);
    CHECK(session.status().renderedProjectFrame==position);
    CHECK(session.resumeOutput(1).ok && session.resume(1).ok);
    output->render(10415000000ULL);
    CHECK(session.status().renderedProjectFrame==position+32);
    CHECK(session.unload(1).ok);
  }
  CHECK(std::filesystem::remove(path));
}
void protectedTake() {
  Hal hardware; hal=&hardware;
  auto host=std::make_unique<Output>(); SharedAudioService service(std::move(host),"coreaudio");
  CHECK(service.ensureOutput().ok);
  TakeWriter writer; VoiceMonitorCapture capture(makeInput);
  std::atomic<uint64_t> delivered{0}, recorded{0};
  AudioInputConfig config; config.deviceUid="duplex"; config=service.inputBufferConfig(config);
  const auto devices=service.inputDevices();
  CHECK(capture.retain(VoiceCaptureUser::Arm,config,[&](const AudioInputBlockView& b) {
    if(writer.active() && writer.append(b)) recorded.fetch_add(b.frames);
    delivered.fetch_add(b.frames);
  },&devices).ok);
  auto waitFor=[&](const std::atomic<uint64_t>& counter,uint64_t value) {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
    while(counter.load()<value && std::chrono::steady_clock::now()<deadline) std::this_thread::yield();
    CHECK(counter.load()>=value);
  };
  waitFor(delivered,128);
  const auto root=std::filesystem::temp_directory_path()/
      ("singz-buffer-take-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  CHECK(std::filesystem::create_directories(root));
  writer.start(root.string(),"take",48000,[&] { return capture.state()!=AudioInputState::Running; });
  CHECK(capture.retainExisting(VoiceCaptureUser::Take));
  std::array<float,128> samples; samples.fill(.25f);
  auto push=[&](uint64_t frame) {
    const uint64_t ns=10000000000ULL+frame*1000000000ULL/48000;
    activeInput->push(activeInput->context,samples.data(),128,ns,ns,AudioInputTimestampQuality::Hardware);
  };
  push(128); waitFor(recorded,128);
  SharedAudioService::BufferChangeHooks hooks; hooks.inputUid="duplex";
  hooks.pauseInput=[&] { return capture.pauseForBufferChange(); };
  hooks.resumeInput=[&](uint32_t frames) { const auto r=capture.resumeAfterBufferChange(frames); return r.ok ? std::string{} : r.error; };
  const auto opens=hardware.inputOpens, stops=hardware.inputStops;
  CHECK(!service.applyBufferPreferences({{"duplex",64}},hooks).ok);
  CHECK(hardware.inputOpens==opens && hardware.inputStops==stops && writer.active());
  push(256); waitFor(recorded,256);
  const auto take=writer.finish();
  CHECK(take.error.empty() && !take.deviceLost && take.frames==256 && take.gapPaddedFrames==0 && take.droppedBlocks==0);
  CHECK(std::filesystem::file_size(take.path)==44+256*2);
  std::ifstream wav(take.path,std::ios::binary); wav.seekg(44);
  for(unsigned i=0;i<256;++i) { CHECK(wav.get()==0); CHECK(wav.get()==32); }
  wav.close();
  capture.release(VoiceCaptureUser::Take);
  CHECK(service.applyBufferPreferences({{"duplex",64}},hooks).ok);
  CHECK(capture.users(VoiceCaptureUser::Arm)==1 && hardware.frames==64);
  capture.release(VoiceCaptureUser::Arm);
  std::filesystem::remove_all(root);
}
void doubleFaultRecovery(unsigned inputFailure = 0) {
  Hal hardware; hal=&hardware;
  auto host=std::make_unique<Output>(); auto* output=host.get();
  SharedAudioService service(std::move(host),"coreaudio");
  CHECK(service.ensureOutput().ok);
  VoiceMonitorCapture capture(makeInput); CommonVoiceMonitor monitor(service,capture);
  AudioInputConfig input; input.deviceUid="duplex"; input=service.inputBufferConfig(input);
  const auto devices=service.inputDevices();
  CHECK(capture.retain(VoiceCaptureUser::Arm,input,{},&devices).ok);
  CHECK(monitor.begin("duplex",0,true,-9,7).ok);
  Song song;
  auto client=service.playbackBackend(std::make_unique<Output>(),"coreaudio");
  AudioHostConfig config; config.outputDeviceUid="duplex"; config.outputChannels={0,1}; config.requestedSampleRate=48000;
  CHECK(client->open(config,Song::render,&song).ok && client->start().ok);
  Cue attached;
  CHECK(attached.mixer.schedule({std::vector<float>(4096,.25f)},1,48000,10000000000ULL,1));
  service.setTrainingRenderer(Cue::render,&attached);
  output->render(10000000000ULL);
  CHECK(attached.heard && song.position>0);
  const auto position=song.position;
  hardware.rejectOutput=64; hardware.rejectRollback=128;
  if(inputFailure==1) hardware.rejectInput=128;
  if(inputFailure==2) hardware.throwInputFactory=true;
  SharedAudioService::BufferChangeHooks hooks; hooks.inputUid="duplex";
  hooks.pauseInput=[&] { return capture.pauseForBufferChange(); };
  hooks.resumeInput=[&](uint32_t frames) { const auto r=capture.resumeAfterBufferChange(frames); return r.ok ? std::string{} : r.error; };
  const auto failed=service.applyBufferPreferences({{"duplex",64}},hooks);
  CHECK(!failed.ok && failed.message.find("previous audio route could not be restored")!=std::string::npos);
  CHECK(service.status().state==AudioHostState::Stopped && client->status().state==AudioHostState::Error);
  CHECK(capture.users(VoiceCaptureUser::Arm)==1 && capture.users(VoiceCaptureUser::Monitor)==1);
  if(inputFailure) {
    CHECK(capture.state()==AudioInputState::Error);
    CHECK(!monitor.status().running && capture.users(VoiceCaptureUser::Monitor)==0);
    CHECK(!capture.lastError().empty() && failed.message.find("input capture could not be restored")!=std::string::npos);
  } else CHECK(capture.state()==AudioInputState::Running);
  hardware.rejectOutput=hardware.rejectRollback=0;
  attached.heard=false;
  CHECK(service.ensureOutput().ok);
  output->render(10003000000ULL);
  // The training facade still considers this renderer attached; recovery
  // cannot depend on it calling setTrainingRenderer again.
  CHECK(attached.heard && output->lastPeak>.01f);
  CHECK(song.position==position); // The incompatible song stays failed closed.
  service.clearTrainingRenderer();
  Cue replacement;
  CHECK(replacement.mixer.schedule({std::vector<float>(256,.5f)},2,48000,10006000000ULL,1));
  service.setTrainingRenderer(Cue::render,&replacement);
  output->render(10006000000ULL);
  CHECK(replacement.heard && output->lastPeak>.01f);
  service.clearTrainingRenderer();
  if(!inputFailure) {
    CHECK(monitor.status().running);
    std::array<float,128> samples; samples.fill(.25f);
    for(uint64_t frame=128;frame<4096;frame+=128) {
      const auto ns=10000000000ULL+frame*1000000000ULL/48000;
      activeInput->push(activeInput->context,samples.data(),128,ns,ns,AudioInputTimestampQuality::Hardware);
    }
    for(uint64_t i=0;i<4;++i) output->render(10070000000ULL+i*128*1000000000ULL/48000);
    CHECK(monitor.status().running && output->lastPeak>.01f); // No song or cue can mask silent capture.
    CHECK(capture.retain(VoiceCaptureUser::Take,service.inputBufferConfig(input),{},&devices).ok);
    capture.release(VoiceCaptureUser::Take);
  } else CHECK(!monitor.status().running && capture.state()==AudioInputState::Error);
  monitor.close(); capture.release(VoiceCaptureUser::Arm); client->stop();
}
}
int main() {
  for(unsigned owner=0;owner<8;++owner) runOwner(owner);
  for(unsigned failure=1;failure<=3;++failure) runOwner(7,failure);
  concurrentReopen();
  nativeTransport();
  protectedTake();
  for(unsigned inputFailure=0;inputFailure<3;++inputFailure) doubleFaultRecovery(inputFailure);
  std::puts("8 owner cases, 3 rollback cases, 6 concurrent reopens, 2 native DSP transports, protected take PCM and 3 double-fault recovery cases passed");
}
