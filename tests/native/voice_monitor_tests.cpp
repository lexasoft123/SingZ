#ifdef VOICE_MONITOR_HEADER
#include VOICE_MONITOR_HEADER
#else
#include "native/playback/voice_monitor.h"
#endif
#include "native/playback/shared_audio_service.h"
#include <array>
#include <chrono>
#include <thread>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <new>
#include <vector>
namespace {
int failures=0;
bool watchHeap=false;
uint64_t heapEvents=0;
}
#define CHECK(v) do {if(!(v)){std::fprintf(stderr,"FAIL %d: %s\n",__LINE__,#v);++failures;return;}}while(false)
#if defined(__GNUC__)
__attribute__((noinline))
#endif
void* operator new(std::size_t n) {if(watchHeap)++heapEvents;if(auto p=std::malloc(n?n:1))return p;throw std::bad_alloc();}
void* operator new[](std::size_t n){return ::operator new(n);}
void operator delete(void* p)noexcept{std::free(p);}
void operator delete[](void* p)noexcept{std::free(p);}
void operator delete(void* p,std::size_t)noexcept{std::free(p);}
void operator delete[](void* p,std::size_t)noexcept{std::free(p);}
using namespace singz;
namespace {
bool near(double a,double b,double eps=1e-6){return std::abs(a-b)<eps;}
AudioHostDeviceInfo device() {
  AudioHostDeviceInfo d;d.uid="usb";d.label="AirPods";d.inputChannels=4;d.outputChannels=2;
  d.direction=AudioHostEndpointDirection::Duplex;d.transport=AudioHostTransport::Usb;
  d.nominalSampleRate=48000;d.bufferFrames={32,1024,512,0};return d;
}
struct Record {
  AudioHostDeviceInfo device=::device();
  AudioHostStatus status;
  AudioHostConfig config;
  AudioHostRender render=nullptr;void* context=nullptr;
  std::vector<uint32_t> requests;
  uint32_t rejectBelow=0,rounded=0,observed=0;
  unsigned opens=0,starts=0,stops=0,enumerations=0,writes=0;
  uint32_t stopWarning=0;
  bool badClock=false,badChannels=false,failStart=false,failOpen=false,automatic=false,noCallbacks=false;
  std::atomic<bool> halt{false};
  std::thread worker;
  std::atomic<float> lastVoice{0},voiceAtStop{0};
  void callback() {
    if(!render || !status.latency.bufferFrames)return;
    std::array<float,256> input{},left{},right{};input.fill(.1f);
    const float* in[]{input.data()};float* out[]{left.data(),right.data()};
    AudioHostRenderBlock b;b.input=in;b.output=out;b.inputChannels=1;b.outputChannels=2;
    b.frames=std::min(256u,status.latency.bufferFrames);b.maximumFrames=8192;b.inputTimestampValid=b.inputTimestampHardware=true;
    render(context,b);lastVoice.store(left[b.frames-1],std::memory_order_release);
  }
};
class FakeHost final:public AudioHostBackend {
 public:
  explicit FakeHost(std::shared_ptr<Record> r):r(std::move(r)){}
  AudioHostInventory enumerate()const override{++r->enumerations;return {{r->device},"usb","usb"};}
  AudioHostResult open(const AudioHostConfig& c,AudioHostRender fn,void* ctx)override {
    ++r->opens;r->config=c;r->render=fn;r->context=ctx;r->requests.push_back(c.requestedBufferFrames);
#if defined(__APPLE__)
    if(c.requestedBufferFrames && !c.allowSharedDeviceBufferChange)
      return {false,AudioHostError::Unsupported,AudioHostState::Unsupported,{},{},"unapproved buffer write"};
#endif
    if(r->failOpen)return {false,AudioHostError::ProviderFailure,AudioHostState::Error,{},{},"PRIVATE_DEVICE /private/SECRET"};
    if(c.requestedBufferFrames && c.allowSharedDeviceBufferChange)++r->writes;
    if(c.requestedBufferFrames && c.requestedBufferFrames<r->rejectBelow)
      return {false,AudioHostError::ProviderFailure,AudioHostState::Error,{},{},"period rejected"};
    auto& s=r->status;s={};s.state=AudioHostState::Open;
    const uint32_t buffer=r->rounded?r->rounded:(c.requestedBufferFrames?c.requestedBufferFrames:512);
    s.format={48000,c.maximumFrames,buffer,static_cast<uint32_t>(c.inputChannels.size()),static_cast<uint32_t>(c.outputChannels.size())};
    s.format.outputClockMaster=!r->badClock;if(r->badChannels)++s.format.inputChannels;
    s.latency={11,17,buffer,0};s.routeGeneration=2;s.streamGeneration=3;
    return {true,AudioHostError::None,s.state,s.format,s.latency,{}};
  }
  AudioHostResult start()override {
    ++r->starts;auto& s=r->status;s.state=r->failStart?AudioHostState::Error:AudioHostState::Running;
    s.observedCallbackFrames=r->noCallbacks?0:(r->observed?r->observed:s.latency.bufferFrames);r->callback();
    if(r->automatic && !r->failStart) {
      r->halt.store(false);
      r->worker=std::thread([record=r]{while(!record->halt.load()){record->callback();std::this_thread::sleep_for(std::chrono::milliseconds(1));}});
    }
    return {!r->failStart,AudioHostError::None,s.state,s.format,s.latency,{}};
  }
  void stop()noexcept override {
    ++r->stops;r->halt.store(true);if(r->worker.joinable())r->worker.join();
    r->voiceAtStop.store(r->lastVoice.load());r->callback();r->render=nullptr;r->context=nullptr;r->status.state=AudioHostState::Stopped;
    r->status.bufferWarnings|=r->stopWarning;
  }
  AudioHostStatus status()const noexcept override {return r->status;}
 private:std::shared_ptr<Record> r;
};
VoiceMonitorResult begin(VoiceMonitorHost& host,uint64_t generation=1){return host.begin("usb",2,"usb",true,true,0,32,256,generation);}
void renderTests() {
  VoiceMonitorRender rt;
  std::array<float,256> input{},left{},right{};input.fill(.25f);
  const float* in[]{input.data()};float* out[]{left.data(),right.data()};
  AudioHostRenderBlock b;b.input=in;b.output=out;b.inputChannels=1;b.outputChannels=2;
  b.frames=64;b.maximumFrames=256;b.inputTimestampValid=b.inputTimestampHardware=true;
  rt.target.store(1);
  auto run=[&]{auto before=heapEvents;watchHeap=true;VoiceMonitorRender::render(&rt,b);watchHeap=false;CHECK(heapEvents==before);};
  run();CHECK(near(left[0],.25/128));CHECK(near(left[63],.125));CHECK(left==right);
  run();CHECK(near(left[63],.25));CHECK(near(rt.peak.load(),.25));CHECK(near(rt.rms.load(),.25));
  input.fill(8);run();CHECK(near(left[63],kVoiceMonitorCeiling));CHECK(near(left[63],std::pow(10.,-.05)));
  input.fill(-8);run();CHECK(near(left[63],-std::pow(10.,-.05)));
  input.fill(std::numeric_limits<float>::quiet_NaN());run();CHECK(left[0]==0 && rt.peak.load()==0 && rt.rms.load()==0);
  input.fill(std::numeric_limits<float>::infinity());run();CHECK(left[63]==0);
  input.fill(std::numeric_limits<float>::denorm_min());run();CHECK(left[63]==0 && rt.peak.load()==0 && rt.rms.load()==0);
  input.fill(-std::numeric_limits<float>::denorm_min());run();CHECK(left[63]==0 && rt.peak.load()==0);
  rt.target.store(.001f);run();run();
  input.fill(std::numeric_limits<float>::min());run();CHECK(left[63]==0);
  rt.target.store(1);input.fill(.25f);run();run();
  input.fill(.25);b.inputTimestampHardware=false;run();CHECK(left[0]==0 && right[63]==0);
  b.inputTimestampHardware=true;b.inputTimestampValid=false;run();CHECK(left[0]==0);
  b.inputTimestampValid=true;b.discontinuity=AudioHostDiscontinuityXRun;run();CHECK(left[0]==0);
  b.discontinuity=0;b.outputClockMaster=false;run();CHECK(left[0]==0);
  b.outputClockMaster=true;b.inputChannels=2;run();CHECK(left[0]==0);
  b.inputChannels=1;b.input=nullptr;run();CHECK(left[0]==0);b.input=in;
  b.frames=256;rt.target.store(0);run();CHECK(near(left[0],.25*127/128.));CHECK(left[127]==0 && left[255]==0);CHECK(rt.silent.load());
  rt.target.store(1);b.frames=64;run();rt.target.store(.25f);run();
  CHECK(std::abs(left[1]-left[0])<=.25/128); // Retargeting is bounded from current gain.
}
void routeTests() {
  auto d=device();auto classify=[&](const std::string& out="usb",bool permission=true,bool platform=true,bool native=true){return classifyVoiceMonitorRoute({{d},"usb","usb"},"usb",2,out,native,permission,platform);};
  CHECK(classify().available); // An AirPods label on USB is still a wired route.
  d.monitoringSuitability=AudioHostMonitoringSuitability::Unsupported;CHECK(!classify().available);
  d.monitoringSuitability=AudioHostMonitoringSuitability::HighLatency;CHECK(classify().reason=="route-latency");
  d.monitoringSuitability=AudioHostMonitoringSuitability::LowLatency;CHECK(classify().available);
  CHECK(classify("other").reason=="route-separate-devices");
  CHECK(classify("usb",false).reason=="permission");
  CHECK(classify("usb",true,false).reason=="platform");
  CHECK(classify("usb",true,true,false).reason=="output-not-native");
  d.transport=AudioHostTransport::Bluetooth;CHECK(classify().reason=="route-bluetooth");
  d.transport=AudioHostTransport::BluetoothLowEnergy;CHECK(classify().reason=="route-bluetooth");
  d.transport=AudioHostTransport::AirPlay;CHECK(classify().reason=="route-wireless");
  d.transport=AudioHostTransport::ContinuityWireless;CHECK(classify().reason=="route-wireless");
  d.transport=AudioHostTransport::Unknown;CHECK(!classify().available);
  d.transport=AudioHostTransport::Usb;d.direction=AudioHostEndpointDirection::Input;CHECK(!classify().available);
  d.direction=static_cast<AudioHostEndpointDirection>(99);CHECK(!classify().available);
  d.direction=AudioHostEndpointDirection::Duplex;d.bufferFrames.minimumFrames=257;CHECK(classify().reason=="route-latency");
  d.bufferFrames.minimumFrames=0;CHECK(classify().reason=="error");
  d.bufferFrames.minimumFrames=32;d.inputChannels=2;CHECK(classify().reason=="no-input");
}
void hostTests() {
  auto r=std::make_shared<Record>();VoiceMonitorHost host(std::make_unique<FakeHost>(r));
  CHECK(!host.status().running);CHECK(!host.setGain(0));
  auto started=begin(host);CHECK(started.ok);CHECK(host.status().running);CHECK(r->enumerations==1);
  CHECK((r->config.inputChannels==std::vector<uint32_t>{2}));CHECK((r->config.outputChannels==std::vector<uint32_t>{0,1}));
  CHECK(r->config.allowSharedDeviceBufferChange && r->config.maximumAcceptableBufferFrames==256 && r->config.maximumFrames==8192);
  CHECK(started.latency.bufferFrames==32 && started.latency.roundTripFrames==92);CHECK(near(started.latency.roundTripMs,92*1000./48000));
  CHECK(host.setGain(100));for(int i=0;i<4;++i)r->callback();CHECK(near(r->lastVoice.load(),.1*std::pow(10.,.6)));CHECK(!host.setGain(std::numeric_limits<float>::quiet_NaN()));
  CHECK(begin(host,2).ok);const auto stopped=r->stops;
  CHECK(!host.end(1).ok);CHECK(host.status().running && r->stops==stopped);
  CHECK(!begin(host,1).ok);CHECK(host.status().running);
  r->status.state=AudioHostState::DeviceLost;r->status.terminalReason=AudioHostTerminalReason::DeviceLost;
  CHECK(host.status().lost);CHECK(!host.status().running);CHECK(r->render==nullptr);
  r->stopWarning=AudioBufferWarningRestoreFailed;CHECK(host.end(2).ok);CHECK(!host.status().warnings.empty());
  CHECK(!begin(host,2).ok);
  {
    auto f=std::make_shared<Record>();f->automatic=true;VoiceMonitorHost h(std::make_unique<FakeHost>(f));CHECK(begin(h).ok);
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
    while(f->lastVoice.load()<.099f && std::chrono::steady_clock::now()<deadline)std::this_thread::yield();
    CHECK(f->lastVoice.load()>.099f);CHECK(h.end(1).ok);CHECK(f->voiceAtStop.load()==0);
  }
  {
    auto f=std::make_shared<Record>();f->automatic=true;VoiceMonitorHost h(std::make_unique<FakeHost>(f));CHECK(begin(h).ok);
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
    while(f->lastVoice.load()<.099f && std::chrono::steady_clock::now()<deadline)std::this_thread::yield();
    CHECK(f->lastVoice.load()>.099f);h.routeChanged();
    CHECK(f->voiceAtStop.load()==0);const auto state=h.status();
    CHECK(!state.running && state.lost && state.reason=="route-changed");
  }
  {
    auto f=std::make_shared<Record>();f->failOpen=true;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    const auto result=begin(h);CHECK(!result.ok && result.reason=="error");
    CHECK(result.error.find("PRIVATE")==std::string::npos && result.error.find("SECRET")==std::string::npos);
    CHECK(result.error=="Native voice monitor could not start");
  }
  {
    auto f=std::make_shared<Record>();f->failStart=true;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    CHECK(begin(h).reason=="error");
  }
  {
    CHECK(kVoiceMonitorBeginWaitBudgetMs==200);
    auto f=std::make_shared<Record>();f->noCallbacks=true;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    const auto before=std::chrono::steady_clock::now();CHECK(begin(h).reason=="error");
    CHECK(std::chrono::steady_clock::now()-before<std::chrono::milliseconds(500));
  }
  {
    auto f=std::make_shared<Record>();VoiceMonitorHost h(std::make_unique<FakeHost>(f));CHECK(begin(h).ok);
    VoiceMonitorEnvironmentLifetime environments;environments.attach();environments.attach();
    if(environments.detach())h.close();CHECK(h.status().running);
    CHECK(environments.detach());h.close();CHECK(!h.status().running);CHECK(!environments.detach());
  }
  CHECK(voiceMonitorUseAllowed(false,false,true)); // capture, playback and training cues are compatible
  CHECK(!voiceMonitorUseAllowed(true,false,true));
  CHECK(!voiceMonitorUseAllowed(false,true,true));
  CHECK(!voiceMonitorUseAllowed(false,false,false));
  for(const auto threshold:{32u,64u,128u,256u}) {
    auto f=std::make_shared<Record>();f->rejectBelow=threshold;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    CHECK(begin(h).ok);CHECK(f->requests.back()==threshold);
    std::vector<uint32_t> expected;for(uint32_t n=32;n<=threshold;n*=2)expected.push_back(n);
    CHECK(f->requests==expected);CHECK(h.end(1).ok);
  }
  {
    auto f=std::make_shared<Record>();f->rounded=64;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    auto result=begin(h);CHECK(result.ok && result.latency.bufferFrames==64);CHECK(f->opens==1);
  }
  {
    auto f=std::make_shared<Record>();f->device.bufferFrames.minimumFrames=257;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    CHECK(begin(h).reason=="route-latency");CHECK(f->opens==0);
  }
  for(int fault=0;fault<5;++fault) {
    auto f=std::make_shared<Record>();
    if(fault==0)f->rounded=512;if(fault==1)f->observed=512;if(fault==2)f->badClock=true;if(fault==3)f->badChannels=true;if(fault==4)f->failStart=true;
    VoiceMonitorHost h(std::make_unique<FakeHost>(f));CHECK(!begin(h).ok);CHECK(!h.status().running);CHECK(f->render==nullptr);
  }
  {
    auto f=std::make_shared<Record>();VoiceMonitorHost h(std::make_unique<FakeHost>(f));CHECK(begin(h).ok);
    f->status.observedCallbackFrames=512;CHECK(!h.status().running);CHECK(f->render==nullptr);
  }
}
bool songRender(void* ctx,const AudioHostRenderBlock& b)noexcept{++*static_cast<unsigned*>(ctx);for(uint32_t c=0;c<b.outputChannels;++c)for(uint32_t i=0;i<b.frames;++i)b.output[c][i]=.4f;return true;}
void songTests() {
  auto song=std::make_shared<Record>();SharedAudioService service(std::make_unique<FakeHost>(song));
  auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"");
  AudioHostConfig c;c.outputDeviceUid="usb";c.outputChannels={0,1};c.requestedSampleRate=48000;unsigned callbacks=0;
  CHECK(client->open(c,songRender,&callbacks).ok);CHECK(client->start().ok);
#if defined(__APPLE__)
  CHECK(song->config.allowSharedDeviceBufferChange);CHECK(song->config.requestedBufferFrames==0);
#endif
#if defined(__APPLE__)
  {
    auto f=std::make_shared<Record>();SharedAudioService service(std::make_unique<FakeHost>(f));
    AudioHostConfig requested=c;requested.requestedBufferFrames=128;requested.allowSharedDeviceBufferChange=true;
    const auto result=service.initialize(requested);CHECK(!result.ok && result.error==AudioHostError::Unsupported);
    CHECK(!f->config.allowSharedDeviceBufferChange && f->writes==0);
  }
#endif
  const auto opens=song->opens,stops=song->stops;const auto generation=service.outputRouteGeneration();
  // Exercise the process singleton too: a monitor must never park either song owner.
  auto singleton=std::make_shared<Record>();auto& shared=sharedAudioService();
  CHECK(shared.configureProvider(std::make_unique<FakeHost>(singleton),"voice-test").ok);
  auto globalClient=shared.playbackBackend(std::make_unique<FakeHost>(singleton),"voice-test");unsigned globalCallbacks=0;
  CHECK(globalClient->open(c,songRender,&globalCallbacks).ok);CHECK(globalClient->start().ok);
  const auto globalStops=singleton->stops,globalOpens=singleton->opens;
  const auto globalGeneration=shared.outputRouteGeneration();
  const auto beforeCallbacks=globalCallbacks;
  auto monitor=std::make_shared<Record>();VoiceMonitorHost h(std::make_unique<FakeHost>(monitor));
  CHECK(begin(h).ok);song->callback();singleton->callback();CHECK(callbacks>0 && globalCallbacks>beforeCallbacks);
  CHECK(shared.status().state==AudioHostState::Running);
  CHECK(client->status().state==AudioHostState::Running);CHECK(globalClient->status().state==AudioHostState::Running);
  CHECK(h.end(1).ok);song->callback();singleton->callback();
  // The physical period may change underneath the song; it is not route identity.
  song->status.latency.bufferFrames=32;song->status.format.nominalBufferFrames=32;
  CHECK(service.ensureOutput().ok);CHECK(song->opens==opens && song->stops==stops);
  CHECK(service.outputRouteGeneration()==generation);CHECK(client->status().state==AudioHostState::Running);
  CHECK(globalClient->status().state==AudioHostState::Running);
  CHECK(singleton->stops==globalStops && singleton->opens==globalOpens);
  CHECK(shared.outputRouteGeneration()==globalGeneration);
  globalClient->stop();shared.shutdown();client->stop();
}
}
int main(){renderTests();routeTests();hostTests();songTests();std::printf("voice_monitor_tests: %d failures\n",failures);return failures?1:0;}
