#ifdef VOICE_MONITOR_HEADER
#include VOICE_MONITOR_HEADER
#else
#include "native/playback/voice_monitor.h"
#endif
#include "native/playback/shared_audio_service.h"
#ifdef VOICE_MONITOR_BUFFER_HEADER
#include VOICE_MONITOR_BUFFER_HEADER
#else
#include "third_party/zcore/zcore/platform/macos/audio_device_macos_buffer.h"
#endif
#ifdef VOICE_MONITOR_MAC_HELPERS_HEADER
#include VOICE_MONITOR_MAC_HELPERS_HEADER
#else
#include "third_party/zcore/zcore/platform/macos/audio_host_macos_helpers.h"
#endif
#include <array>
#include <chrono>
#include <thread>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <functional>
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
  d.nominalSampleRate=48000;d.bufferFrames={32,1024,32,0};return d;
}
// Same property interface consumed by the REAL macOS request/restore helpers.
// No HAL calls or physical device is needed for the lease transaction itself.
struct BufferProperties {
  std::atomic<uint32_t> frames{512},writes{0};
  uint32_t minimum=32,maximum=8192;
  std::string uid="usb";
  const std::string& deviceUid() const{return uid;}
  uint64_t deviceIdentity() const{return 1;}
  bool identityMatches() const{return true;}
  bool isSettable() const{return true;}
  bool readFrames(uint32_t& value) const{value=frames;return true;}
  bool readRange(uint32_t& low,uint32_t& high) const{low=minimum;high=maximum;return true;}
  bool writeFrames(uint32_t value){++writes;frames=value;return true;}
};
struct Record {
  AudioHostDeviceInfo device=::device();
  AudioHostStatus status;
  bool ledgerPath=false;
  BufferProperties properties,secondaryProperties;
  bool secondaryRoute=false;
  detail::MacAudioBufferLedger ledger;
  BufferProperties* sharedProperties=nullptr;
  detail::MacAudioBufferLedger* sharedLedger=nullptr;
  BufferProperties& deviceProperties(){return sharedProperties?*sharedProperties:properties;}
  detail::MacAudioBufferLedger& deviceLedger(){return sharedLedger?*sharedLedger:ledger;}
  detail::MacAudioBufferOwnership lease;
  detail::MacAudioBufferOwnership* songLease=nullptr;
  AudioHostConfig config;
  detail::MacAudioHostDeviceFacts openedFacts;
  // Same control-domain facts comparison used by the real macOS listener.
  // Tests deliver redundant format notifications accompanying buffer writes;
  // selectors alone must not produce terminal/boundary events.
  void notify(const detail::MacAudioHostDeviceFacts& observed,bool configuration=true) {
    const auto changes=detail::macAudioHostControlNotification(configuration,[&]{
      return detail::macAudioHostControlChange(openedFacts,observed,true,true,!config.inputChannels.empty());
    });
    if(changes) {
      ++status.routeGeneration;++status.discontinuities;
      status.state=AudioHostState::Error;status.terminalReason=AudioHostTerminalReason::RouteChanged;
    }
  }
  std::function<void()> afterOpen;
  AudioHostRender render=nullptr;void* context=nullptr;
  std::vector<uint32_t> requests,liveRequests;
  unsigned liveWrites=0;
  uint32_t rejectBelow=0,rounded=0,observed=0;
  unsigned opens=0,starts=0,stops=0,enumerations=0,writes=0;
  uint32_t stopWarning=0;
  bool badClock=false,badChannels=false,failStart=false,failOpen=false,automatic=false,noCallbacks=false;
  std::atomic<bool> halt{false};
  std::thread worker;
  std::atomic<float> lastVoice{0},voiceAtStop{0};
  std::atomic<uint32_t> lastDeliveredFrames{0};
  bool modelPeriodGaps=false;
  uint64_t outputFrame=0;
  uint32_t previousDelivered=0,lastPropertyWrites=0;
  void callback() {
    if(!render || !status.latency.bufferFrames)return;
    std::array<float,512> input{};input.fill(.1f);
    std::array<std::array<float,512>,kAudioHostMaxChannels> output{};
    std::array<float*,kAudioHostMaxChannels> out{};
    for(size_t c=0;c<out.size();++c)out[c]=output[c].data();
    const float* in[]{input.data()};
    AudioHostRenderBlock b;b.input=in;b.output=out.data();b.inputChannels=1;b.outputChannels=status.format.outputChannels;
    b.frames=std::min(512u,observed?observed:(ledgerPath?deviceProperties().frames.load():status.latency.bufferFrames));b.maximumFrames=8192;b.inputTimestampValid=b.inputTimestampHardware=true;
    b.sampleRate=48000;b.routeGeneration=status.routeGeneration;b.streamGeneration=status.streamGeneration;
    if(modelPeriodGaps && ledgerPath && previousDelivered && lastPropertyWrites!=deviceProperties().writes) {
      outputFrame+=previousDelivered;b.discontinuity=AudioHostDiscontinuitySequenceGap;++status.discontinuities;
    }
    if(ledgerPath)lastPropertyWrites=deviceProperties().writes;
    b.outputFrame=outputFrame;b.outputHostTimeNs=b.callbackHostTimeNs=1000000000+outputFrame*1000000000ull/48000;
    b.outputTimestampValid=b.outputTimestampHardware=true;
    lastDeliveredFrames.store(b.frames);render(context,b);lastVoice.store(output[0][b.frames-1],std::memory_order_release);
    outputFrame+=b.frames;previousDelivered=b.frames;
  }
};
class FakeHost final:public AudioHostBackend {
 public:
  explicit FakeHost(std::shared_ptr<Record> r):r(std::move(r)){}
  AudioHostInventory enumerate()const override{
    ++r->enumerations;auto d=r->device;
    if(r->ledgerPath)d.bufferFrames.preferredFrames=r->deviceProperties().frames;
    AudioHostInventory inventory{{d},"usb","usb"};
    if(r->secondaryRoute){auto second=d;second.uid="other";inventory.devices.push_back(second);}
    return inventory;
  }
  AudioHostResult open(const AudioHostConfig& c,AudioHostRender fn,void* ctx)override {
    if(r->secondaryRoute && c.outputDeviceUid=="other")r->sharedProperties=&r->secondaryProperties;
    ++r->opens;r->config=c;r->render=fn;r->context=ctx;r->requests.push_back(c.requestedBufferFrames);
#if defined(__APPLE__)
    if(c.requestedBufferFrames && !c.allowSharedDeviceBufferChange)
      return {false,AudioHostError::Unsupported,AudioHostState::Unsupported,{},{},"unapproved buffer write"};
#endif
    if(r->failOpen)return {false,AudioHostError::ProviderFailure,AudioHostState::Error,{},{},"PRIVATE_DEVICE /private/SECRET"};
    uint32_t negotiated=0;
    if(r->ledgerPath) {
      const auto transaction=detail::requestMacAudioBuffer(r->deviceProperties(),c.requestedBufferFrames,c.maximumFrames,
          r->lease,c.maximumAcceptableBufferFrames,r->deviceLedger(),
          true,detail::MacAudioBufferFixedCapacity{},c.holdSharedDeviceBuffer);
      if(!transaction.ok())return {false,transaction.error,AudioHostState::Error,{},{},transaction.message};
      negotiated=transaction.frames;r->writes=r->deviceProperties().writes;
    } else if(c.requestedBufferFrames && c.allowSharedDeviceBufferChange && c.requestedBufferFrames!=r->device.bufferFrames.preferredFrames)++r->writes;
    if(c.requestedBufferFrames && c.requestedBufferFrames<r->rejectBelow)
      return {false,AudioHostError::ProviderFailure,AudioHostState::Error,{},{},"period rejected"};
    auto& s=r->status;s={};s.state=AudioHostState::Open;
    const uint32_t buffer=negotiated?negotiated:(r->rounded?r->rounded:(c.requestedBufferFrames?c.requestedBufferFrames:512));
    s.format={48000,c.maximumFrames,buffer,static_cast<uint32_t>(c.inputChannels.size()),static_cast<uint32_t>(c.outputChannels.size())};
    s.format.outputClockMaster=!r->badClock;if(r->badChannels)++s.format.inputChannels;
    if(!r->ledgerPath)r->device.bufferFrames.preferredFrames=buffer;
    s.latency={11,17,buffer,0};s.routeGeneration=2;s.streamGeneration=3+r->opens;
    r->outputFrame=0;r->previousDelivered=0;r->lastPropertyWrites=r->deviceProperties().writes;
    r->openedFacts={};r->openedFacts.identity=1;r->openedFacts.rate=48000;
    r->openedFacts.inputChannels={r->device.inputChannels};r->openedFacts.outputChannels={r->device.outputChannels};
    if (auto action=std::move(r->afterOpen)) action();
    return {true,AudioHostError::None,s.state,s.format,s.latency,{}};
  }
  AudioHostResult setBufferFrames(uint32_t frames,uint32_t maximum=0)override {
    r->liveRequests.push_back(frames);
    if(frames<r->rejectBelow)return {false,AudioHostError::ProviderFailure,r->status.state,r->status.format,r->status.latency,"rejected period"};
    const uint32_t negotiated=r->rounded?r->rounded:frames;
    if(r->ledgerPath) {
      const auto before=r->deviceProperties().writes.load();
      const auto result=detail::requestMacAudioBuffer(r->deviceProperties(),negotiated,r->config.maximumFrames,r->lease,maximum,r->deviceLedger());
      r->liveWrites+=r->deviceProperties().writes-before;
      if(!result.ok())return {false,result.error,r->status.state,r->status.format,r->status.latency,result.message};
      r->status.latency.bufferFrames=result.frames;
    } else {++r->liveWrites;r->status.latency.bufferFrames=negotiated;}
    r->status.format.nominalBufferFrames=r->status.latency.bufferFrames;
    r->device.bufferFrames.preferredFrames=r->status.latency.bufferFrames;
    return {true,AudioHostError::None,r->status.state,r->status.format,r->status.latency,{}};
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
#ifdef VOICE_MONITOR_RESTORE_ON_STOP
    // Deliberate fault: emulate the former restore-on-monitor-release policy.
    if(r->ledgerPath && !r->config.inputDeviceUid.empty() && r->songLease)
      r->status.bufferWarnings|=detail::restoreMacAudioBuffer(r->deviceProperties(),*r->songLease,r->deviceLedger());
#endif
    if(r->ledgerPath)r->status.bufferWarnings|=detail::restoreMacAudioBuffer(r->deviceProperties(),r->lease,r->deviceLedger());
  }
  AudioHostStatus status()const noexcept override {
    auto status=r->status;
    if(r->ledgerPath) {
      status.latency.bufferFrames=r->deviceProperties().frames;
      status.format.nominalBufferFrames=status.latency.bufferFrames;
      if(status.state==AudioHostState::Running && !r->noCallbacks && !r->observed)
        status.observedCallbackFrames=status.latency.bufferFrames;
    }
    return status;
  }
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
  d.bufferFrames.minimumFrames=32;d.inputChannels=2;CHECK(classify().reason=="error");
}
void hostTests() {
  auto r=std::make_shared<Record>();VoiceMonitorHost host(std::make_unique<FakeHost>(r));
  CHECK(!host.status().running);CHECK(!host.setGain(0));
  auto started=begin(host);CHECK(started.ok);CHECK(host.status().running);CHECK(r->enumerations==1);
  CHECK((r->config.inputChannels==std::vector<uint32_t>{2}));CHECK((r->config.outputChannels==std::vector<uint32_t>{0,1}));
  CHECK(r->config.allowSharedDeviceBufferChange && r->config.maximumAcceptableBufferFrames==256 && r->config.maximumFrames==8192 && r->config.holdSharedDeviceBuffer);
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
    CHECK(kVoiceMonitorBeginWaitBudgetMs==125);
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
  {
    auto f=std::make_shared<Record>();f->device.bufferFrames.preferredFrames=64;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    auto result=begin(h);CHECK(result.ok && result.latency.bufferFrames==32);CHECK(f->opens==1 && f->writes==1);
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
void channelTests() {
  AudioHostConfig route;route.outputDeviceUid="usb";route.outputChannels={2,3};
  CHECK(voiceMonitorSameOutput("usb",{2,3},route,true));
  uint64_t generation=1;
  for(const auto state : {AudioHostState::Running,AudioHostState::Stopped,AudioHostState::Closed,
      AudioHostState::Open,AudioHostState::Running,AudioHostState::Suspended}) {
    AudioHostStatus status;status.state=state;status.streamGeneration=generation;
    status.latency.bufferFrames=32;status.observedCallbackFrames=32;
    const auto snapshot=voiceMonitorSongRoute(route,"coreaudio",status,generation++,true);
    CHECK(snapshot.native && snapshot.output=="usb" && snapshot.channels==std::vector<uint32_t>({2,3}));
    CHECK(voiceMonitorSameOutput("usb",{2,3},route,snapshot.native));
    CHECK(snapshot.song.state==state && snapshot.song.streamGeneration==snapshot.generation);
    CHECK(voiceMonitorSongCanBegin(snapshot)==(state==AudioHostState::Running || state==AudioHostState::Open));
  }
  CHECK(!voiceMonitorSongRoute(route,"box-loopz",{},1,true).native);
  CHECK(!voiceMonitorSongRoute(route,"coreaudio",{},1,false).native);
  CHECK(!voiceMonitorSongRoute({},"coreaudio",{},1,true).native);
  CHECK(!voiceMonitorSameOutput("other",{2,3},route,true));
  CHECK(!voiceMonitorSameOutput("usb",{0,1},route,true));
  CHECK(!voiceMonitorSameOutput("usb",{2,3},route,false));
  // There is deliberately no transient host-state/generation argument above.
  // The callback also fails closed for a full multichannel bus: only its
  // selected stereo lanes get voice; sentinels in every other lane become zero.
  VoiceMonitorRender rt;rt.outputs=8;rt.outputMask=(uint64_t{1}<<2)|(uint64_t{1}<<3);rt.target.store(1);
  std::array<float,128> input;input.fill(.25f);const float* in[]{input.data()};
  std::array<std::array<float,128>,8> output{};std::array<float*,8> out{};
  for(size_t c=0;c<8;++c){output[c].fill(.7f);out[c]=output[c].data();}
  AudioHostRenderBlock b;b.input=in;b.output=out.data();b.inputChannels=1;b.outputChannels=8;
  b.frames=128;b.maximumFrames=128;b.inputTimestampValid=b.inputTimestampHardware=true;
  VoiceMonitorRender::render(&rt,b);
  for(uint32_t c=0;c<8;++c)CHECK(near(output[c][127],c==2 || c==3?.25:0));
  for(const std::vector<uint32_t>& selected : {std::vector<uint32_t>{2,3},std::vector<uint32_t>{5}}) {
    auto f=std::make_shared<Record>();f->device.inputChannels=10;f->device.outputChannels=8;
    auto song=std::make_shared<Record>();song->device.outputChannels=8;
    SharedAudioService service(std::make_unique<FakeHost>(song));
    AudioHostConfig songConfig;songConfig.outputDeviceUid="usb";songConfig.outputChannels=selected;
    CHECK(service.initialize(songConfig).ok);
    const auto route=service.activeOutputConfig();CHECK(route.outputDeviceUid=="usb" && route.outputChannels==selected);
    VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    CHECK(h.begin("usb",7,route.outputDeviceUid,true,true,0,32,256,1,route.outputChannels).ok);
    CHECK(f->config.outputChannels==selected && f->config.inputChannels==std::vector<uint32_t>{7});
    std::vector<int32_t> map;
    CHECK(detail::buildMacAudioHostOutputChannelMap(f->config.outputChannels,8,&map));
    std::array<std::array<float,128>,2> client{};float* clientOut[]{client[0].data(),client[1].data()};
    b.output=clientOut;b.outputChannels=static_cast<uint32_t>(selected.size());
    f->render(f->context,b);
    for(uint32_t c=0;c<8;++c) {
      const float physical=map[c]<0?0:client[static_cast<size_t>(map[c])][127];
      const bool chosen=std::find(selected.begin(),selected.end(),c)!=selected.end();
      CHECK(near(physical,chosen?.25:0));
    }
  }
  for(const auto& selected : {std::vector<uint32_t>{2,2},std::vector<uint32_t>{8}}) {
    auto f=std::make_shared<Record>();f->device.outputChannels=8;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    const auto result=h.begin("usb",0,"usb",true,true,0,32,256,1,selected);
    CHECK(!result.ok && result.reason=="error" && f->opens==0);
  }
  for(uint32_t channel=0;channel<10;++channel) {
    auto f=std::make_shared<Record>();f->device.inputChannels=10;f->automatic=true;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    CHECK(h.availability("usb",channel,"usb",true,true).available);
    CHECK(h.begin("usb",channel,"usb",true,true,0,32,256,1).ok);
    CHECK(f->config.inputChannels==std::vector<uint32_t>{channel});
  }
  {
    auto f=std::make_shared<Record>();f->device.inputChannels=64;f->device.outputChannels=8;f->automatic=true;
    VoiceMonitorHost h(std::make_unique<FakeHost>(f));CHECK(h.availability("usb",63,"usb",true,true).available);
    CHECK(h.begin("usb",63,"usb",true,true,0,32,256,1).ok);
    CHECK(f->config.inputChannels==std::vector<uint32_t>{63});
    CHECK((f->config.outputChannels==std::vector<uint32_t>{0,1}));
  }
  for(const uint32_t channel:{10u,63u,64u,UINT32_MAX}) {
    auto f=std::make_shared<Record>();f->device.inputChannels=10;VoiceMonitorHost h(std::make_unique<FakeHost>(f));
    CHECK(h.availability("usb",channel,"usb",true,true).reason=="error");
    const auto result=h.begin("usb",channel,"usb",true,true,0,32,256,1);
    CHECK(!result.ok && result.reason=="error" && result.error=="Invalid microphone channel" && f->opens==0);
  }
}
bool songRender(void* ctx,const AudioHostRenderBlock& b)noexcept{++*static_cast<unsigned*>(ctx);for(uint32_t c=0;c<b.outputChannels;++c)for(uint32_t i=0;i<b.frames;++i)b.output[c][i]=.4f;return true;}
void idleMonitorTests() {
  CHECK(voiceMonitorBrowserOutputCompatible(false,"other","usb"));
  CHECK(voiceMonitorBrowserOutputCompatible(true,"usb","usb"));
  CHECK(voiceMonitorBrowserOutputCompatible(true,"","usb"));
  CHECK(!voiceMonitorBrowserOutputCompatible(true,"other","usb"));
  for(const bool songEndsFirst:{false,true}) {
    auto song=std::make_shared<Record>();song->ledgerPath=true;
    SharedAudioService service(std::make_unique<FakeHost>(song),"coreaudio");
    auto input=std::make_shared<Record>();input->ledgerPath=true;input->automatic=true;
    input->sharedProperties=&song->properties;input->sharedLedger=&song->ledger;
    VoiceMonitorHost monitor(std::make_unique<FakeHost>(input));
    const auto route=service.voiceMonitorOutputConfig();
    CHECK(route.outputDeviceUid=="usb" && route.outputChannels==std::vector<uint32_t>({0,1}));
    CHECK(song->opens==0 && !service.playbackOutputCurrent());
    CHECK(monitor.availability("usb",2,route.outputDeviceUid,true,true).available);
    CHECK(monitor.begin("usb",2,route.outputDeviceUid,true,true,0,32,256,1,route.outputChannels,&service).ok);
    CHECK(song->opens==0 && monitor.status().running && song->properties.frames==32 && song->properties.writes==1);
    CHECK(song->ledger.devices.at("usb").owners.at(input->lease.token).hold);
    // An armed, independent capture is capacity-only and must not delay restore.
    detail::MacAudioBufferOwnership capture;
    CHECK(detail::requestMacAudioBuffer(song->properties,0,8192,capture,0,song->ledger).ok());
    CHECK(!song->ledger.devices.at("usb").owners.at(capture.token).hold);
    AudioHostConfig config;config.outputDeviceUid="usb";config.outputChannels={0,1};
    config.requestedSampleRate=48000;config.requestedBufferFrames=128;config.maximumFrames=4096;
    unsigned callbacks=0;auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
    const auto inputOpens=input->opens,inputStops=input->stops;
    CHECK(client->open(config,songRender,&callbacks).ok && client->start().ok);
    CHECK(song->requests==std::vector<uint32_t>{0}); // even a legal128 preference never disturbs monitor32
    CHECK(song->ledger.devices.at("usb").owners.at(song->lease.token).hold);
    CHECK(monitor.status().running && input->opens==inputOpens && input->stops==inputStops);
    CHECK(song->properties.frames==32 && song->properties.writes==1 && callbacks>0);
    if(songEndsFirst) {
      client->stop();client.reset();CHECK(service.setPlaybackOutputCurrent(false));
      CHECK(monitor.status().running && song->properties.frames==32 && song->properties.writes==1);
      CHECK(service.voiceMonitorOutputConfig().outputDeviceUid=="usb");
      CHECK(monitor.end(1).ok);
    } else {
      CHECK(monitor.end(1).ok && song->properties.frames==32 && song->properties.writes==1);
      CHECK(client->status().state==AudioHostState::Running);
      client->stop();client.reset();CHECK(service.setPlaybackOutputCurrent(false));
    }
    CHECK(song->properties.frames==512 && song->properties.writes==2);
    const auto& remaining=song->ledger.devices.at("usb").owners;
    CHECK(remaining.size()==1 && remaining.contains(capture.token));
    CHECK(detail::restoreMacAudioBuffer(song->properties,capture,song->ledger)==0 && song->ledger.devices.empty());
    CHECK(input->opens==1 && input->starts==1);
    std::printf("idle monitor/song join: no monitor reopen/stop; one shrink, one last-user restore; songEndsFirst=%d\n",songEndsFirst);
  }
  {
    // Interleave song open after the monitor writes, before monitor start/settle.
    // A late activity registration would let the legal128 preference grow it.
    auto song=std::make_shared<Record>();song->ledgerPath=true;
    SharedAudioService service(std::make_unique<FakeHost>(song),"coreaudio");
    auto input=std::make_shared<Record>();input->ledgerPath=true;input->automatic=true;
    input->sharedProperties=&song->properties;input->sharedLedger=&song->ledger;
    auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
    AudioHostConfig config;config.outputDeviceUid="usb";config.outputChannels={0,1};
    config.requestedBufferFrames=128;config.maximumFrames=4096;unsigned callbacks=0;bool joined=false;
    input->afterOpen=[&] { joined=client->open(config,songRender,&callbacks).ok && client->start().ok; };
    VoiceMonitorHost monitor(std::make_unique<FakeHost>(input));
    CHECK(monitor.begin("usb",2,"usb",true,true,0,32,256,1,{},&service).ok && joined);
    CHECK(song->requests==std::vector<uint32_t>{0} && song->properties.writes==1 && song->properties.frames==32);
    CHECK(monitor.status().running && monitor.end(1).ok && song->properties.frames==32);
    client->stop();client.reset();CHECK(service.setPlaybackOutputCurrent(false));
    CHECK(song->properties.frames==512 && song->properties.writes==2 && song->ledger.devices.empty());
  }
  {
    auto song=std::make_shared<Record>();song->ledgerPath=true;song->secondaryRoute=true;
    SharedAudioService service(std::make_unique<FakeHost>(song),"coreaudio");
    CHECK(service.voiceMonitorOutputConfig(std::string("other")).outputDeviceUid=="other");
    CHECK(service.voiceMonitorOutputConfig(std::string{}).outputDeviceUid=="usb");
    auto input=std::make_shared<Record>();input->ledgerPath=true;input->automatic=true;
    input->sharedProperties=&song->properties;input->sharedLedger=&song->ledger;
    VoiceMonitorHost monitor(std::make_unique<FakeHost>(input));
    CHECK(monitor.begin("usb",2,"usb",true,true,0,32,256,1,{},&service).ok);
    monitor.routeChanged();CHECK(!monitor.status().running && monitor.status().lost);
    CHECK(song->properties.frames==512 && song->ledger.devices.empty());
  }
}
void sharedMonitorLeaseTests() {
#if defined(__APPLE__)
  for(const uint32_t threshold:{32u,64u,128u,256u}) {
    auto song=std::make_shared<Record>();song->ledgerPath=true;song->rejectBelow=threshold;
    SharedAudioService service(std::make_unique<FakeHost>(song));
    CHECK(service.configureProvider(std::make_unique<FakeHost>(song),"coreaudio").ok);
    AudioHostConfig config;config.outputDeviceUid="usb";config.outputChannels={0,1};config.requestedBufferFrames=512;config.maximumFrames=4096;
    unsigned callbacks=0;auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
    CHECK(client->open(config,songRender,&callbacks).ok && client->start().ok);
    const auto prepared=service.prepareVoiceMonitor();CHECK(prepared.ok && prepared.latency.bufferFrames==threshold);
    std::vector<uint32_t> expected;for(uint32_t n=32;n<=threshold;n*=2)expected.push_back(n);
    CHECK(song->liveRequests==expected && song->liveWrites==1);
    client->stop();CHECK(service.setPlaybackOutputCurrent(false));CHECK(song->properties.frames==512);
  }
  {
    auto song=std::make_shared<Record>();song->ledgerPath=true;song->rounded=64;
    SharedAudioService service(std::make_unique<FakeHost>(song));
    CHECK(service.configureProvider(std::make_unique<FakeHost>(song),"coreaudio").ok);
    AudioHostConfig c;c.outputDeviceUid="usb";c.outputChannels={0,1};c.maximumFrames=4096;unsigned callbacks=0;
    auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");CHECK(client->open(c,songRender,&callbacks).ok);
    const auto result=service.prepareVoiceMonitor();CHECK(result.ok && result.latency.bufferFrames==64 && song->liveRequests==std::vector<uint32_t>{32});
    auto input=std::make_shared<Record>();input->ledgerPath=true;input->automatic=true;
    input->sharedProperties=&song->properties;input->sharedLedger=&song->ledger;input->songLease=&song->lease;
    VoiceMonitorHost monitor(std::make_unique<FakeHost>(input));
    CHECK(monitor.begin("usb",2,"usb",true,true,0,32,256,1,{},&service).ok);
    CHECK(input->config.requestedBufferFrames==64 && !song->ledger.devices.at("usb").owners.at(input->lease.token).changed);
    CHECK(monitor.end(1).ok && song->properties.frames==64 && song->properties.writes==1);
    client->stop();service.setPlaybackOutputCurrent(false);
  }
  {
    auto song=std::make_shared<Record>();song->device.bufferFrames.minimumFrames=257;
    SharedAudioService service(std::make_unique<FakeHost>(song));CHECK(!service.prepareVoiceMonitor().ok);
    CHECK(service.configureProvider(std::make_unique<FakeHost>(song),"coreaudio").ok);
    AudioHostConfig c;c.outputDeviceUid="usb";c.outputChannels={0,1};unsigned callbacks=0;
    auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");CHECK(client->open(c,songRender,&callbacks).ok);
    CHECK(service.prepareVoiceMonitor().error==AudioHostError::InvalidConfiguration && song->liveRequests.empty());
  }
#endif
}
void externalLeaseTests() {
#if defined(__APPLE__)
  {
    auto song=std::make_shared<Record>();song->ledgerPath=true;
    detail::MacAudioBufferOwnership other;
    CHECK(detail::requestMacAudioBuffer(song->properties,32,8192,other,256,song->ledger).ok());
    SharedAudioService service(std::make_unique<FakeHost>(song));
    AudioHostConfig c;c.outputDeviceUid="usb";c.outputChannels={0,1};c.requestedBufferFrames=512;c.maximumFrames=4096;
    CHECK(service.initialize(c).ok && song->requests==std::vector<uint32_t>({512,0}));
    service.shutdown();CHECK(song->properties.frames==32);
    CHECK(detail::restoreMacAudioBuffer(song->properties,other,song->ledger)==0 && song->properties.frames==512);
  }
  {
    auto song=std::make_shared<Record>();song->ledgerPath=true;
    SharedAudioService service(std::make_unique<FakeHost>(song));CHECK(service.configureProvider(std::make_unique<FakeHost>(song),"coreaudio").ok);
    AudioHostConfig c;c.outputDeviceUid="usb";c.outputChannels={0,1};c.requestedBufferFrames=512;c.maximumFrames=4096;unsigned callbacks=0;
    auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");CHECK(client->open(c,songRender,&callbacks).ok && client->start().ok);
    CHECK(service.prepareVoiceMonitor().ok && song->properties.frames==32);
    song->properties.frames=128; // external same-process value must win on song close
    client->stop();CHECK(service.setPlaybackOutputCurrent(false));
    CHECK(song->properties.frames==128 && song->properties.writes==1);
    CHECK((song->status.bufferWarnings & AudioBufferWarningExternalChange)!=0);
  }
#endif
}
void repeatedSharedBufferTests() {
#if defined(__APPLE__)
  for(const bool retainsCallbackPeriod:{false,true}) {
    auto song=std::make_shared<Record>();song->ledgerPath=true;if(retainsCallbackPeriod)song->observed=512;
    song->modelPeriodGaps=true;
    auto input=std::make_shared<Record>();input->ledgerPath=true;input->automatic=true;
    input->sharedProperties=&song->properties;input->sharedLedger=&song->ledger;input->songLease=&song->lease;
    SharedAudioService service(std::make_unique<FakeHost>(song));
    CHECK(service.configureProvider(std::make_unique<FakeHost>(song),"coreaudio").ok);
    VoiceMonitorHost monitor(std::make_unique<FakeHost>(input));
    AudioHostConfig config;config.outputDeviceUid="usb";config.outputChannels={0,1};
    config.requestedSampleRate=48000;config.requestedBufferFrames=512;config.maximumFrames=4096;
    unsigned callbacks=0;auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
    CHECK(client->open(config,songRender,&callbacks).ok && client->start().ok);
    const auto opens=song->opens,stops=song->stops;auto baseline=client->status();auto generation=service.outputRouteGeneration();
    for(uint64_t cycle=1;cycle<=50;++cycle) {
      CHECK(monitor.begin("usb",2,"usb",true,true,0,32,256,cycle,{},&service).ok);
      CHECK(song->properties.frames==32 && song->properties.writes==1 && song->liveWrites==1);
      const auto& entry=song->ledger.devices.at("usb");
      CHECK(entry.owners.at(song->lease.token).changed && !entry.owners.at(input->lease.token).changed);
      CHECK(input->config.requestedBufferFrames==32 && input->config.maximumAcceptableBufferFrames==256);
      CHECK(input->config.maximumFrames>=512 && song->opens==opens && song->stops==stops);
      song->notify(song->openedFacts);CHECK(service.ensureOutput().ok);
      auto state=client->status();CHECK(state.state==AudioHostState::Running && state.format.nominalBufferFrames==32);
      CHECK(state.discontinuities==baseline.discontinuities && state.streamGeneration==baseline.streamGeneration && service.outputRouteGeneration()==generation);
      CHECK(state.observedCallbackFrames==(retainsCallbackPeriod?512u:32u));
      auto rendered=callbacks;song->callback();CHECK(callbacks>rendered);
      if(cycle==1)baseline=client->status(); // first HAL-period gap is expected
      CHECK(service.callbackDiagnostics().positiveSampleGapFrames==512);
      CHECK(service.callbackDiagnostics().sampleRegressions==0);
      CHECK(service.callbackDiagnostics().periodChanges==(retainsCallbackPeriod?0u:1u));
      CHECK(client->status().discontinuities==baseline.discontinuities);
      if(cycle==3) {
        // An internal graph replacement while monitoring is ON keeps both
        // physical clients and the song writer lease alive on the same pair.
        client->stop();client.reset();
        client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
        CHECK(client->open(config,songRender,&callbacks).ok && client->start().ok);
        CHECK(song->opens==opens && song->stops==stops && song->properties.writes==1);
        CHECK(monitor.status().running && input->opens==3);
        CHECK(service.outputRouteGeneration()==generation);
      }
      CHECK(monitor.end(cycle).ok);
      CHECK(song->properties.frames==32 && song->properties.writes==1 && client->status().state==AudioHostState::Running);
      CHECK(client->status().format.nominalBufferFrames==32 && song->ledger.devices.at("usb").owners.size()==1);
      if(cycle==2) {
        // Monitor is OFF: tempo-like graph re-prepare, even with smaller
        // requested capacity, must retain the physical writer (no handoff).
        client->stop();client.reset();config.maximumFrames=2048;
        client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
        CHECK(client->open(config,songRender,&callbacks).ok && client->start().ok);
        CHECK(song->opens==opens && song->stops==stops && song->properties.writes==1);
        baseline=client->status();generation=service.outputRouteGeneration();
      }
    }
    // Song close releases its hold; the monitor retains the small period.
    CHECK(monitor.begin("usb",2,"usb",true,true,0,32,256,51,{},&service).ok);
    client->stop();client.reset();CHECK(service.setPlaybackOutputCurrent(false));
    CHECK(song->properties.frames==32 && song->properties.writes==1);
    CHECK(monitor.status().running && input->render!=nullptr);
    CHECK(monitor.end(51).ok);
    CHECK(song->properties.frames==512 && song->properties.writes==2 && song->ledger.devices.empty());
    CHECK(!service.prepareVoiceMonitor().ok);
    // Real same-route song switch/close ends the session. A new native song
    // opens at its original period and its next first monitor-on shrinks once.
    config.maximumFrames=4096;
    client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
    CHECK(client->open(config,songRender,&callbacks).ok && client->start().ok && service.playbackOutputCurrent());
    CHECK(song->properties.frames==512 && song->properties.writes==2);
    CHECK(monitor.begin("usb",2,"usb",true,true,0,32,256,52,{},&service).ok);
    CHECK(song->properties.frames==32 && song->properties.writes==3);
    CHECK(monitor.end(52).ok && song->properties.frames==32);
    client->stop();client.reset();CHECK(service.setPlaybackOutputCurrent(false));
    CHECK(song->properties.frames==512 && song->properties.writes==4);
    // Subsequent toggles are not the owner: exactly shrink+song-close restore.
    std::printf("held buffer:50 toggles; first-session writes2 (firstON+songClose), 512 expected gap frames; next session writes2; opens/stops %u/%u\n",song->opens,song->stops);
  }
  {
    auto song=std::make_shared<Record>();song->ledgerPath=true;song->secondaryRoute=true;song->secondaryProperties.uid="other";
    auto input=std::make_shared<Record>();input->ledgerPath=true;input->automatic=true;input->sharedProperties=&song->properties;input->sharedLedger=&song->ledger;input->songLease=&song->lease;
    SharedAudioService service(std::make_unique<FakeHost>(song));CHECK(service.configureProvider(std::make_unique<FakeHost>(song),"coreaudio").ok);
    AudioHostConfig c;c.outputDeviceUid="usb";c.outputChannels={0,1};c.requestedSampleRate=48000;c.requestedBufferFrames=512;c.maximumFrames=4096;unsigned callbacks=0;
    auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");CHECK(client->open(c,songRender,&callbacks).ok && client->start().ok);
    VoiceMonitorHost monitor(std::make_unique<FakeHost>(input));CHECK(monitor.begin("usb",2,"usb",true,true,0,32,256,1,{},&service).ok);
    client->stop();client.reset();c.outputDeviceUid="other";
    client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");CHECK(client->open(c,songRender,&callbacks).ok && client->start().ok);
    CHECK(song->properties.frames==32 && song->properties.writes==1 && song->secondaryProperties.frames==512 && song->secondaryProperties.writes==0);
    CHECK(!voiceMonitorSameOutput("usb",{0,1},service.activeOutputConfig(),true));
    monitor.routeChanged();CHECK(!monitor.status().running && monitor.status().lost);
    CHECK(song->properties.frames==512 && song->properties.writes==2);
    CHECK(client->status().state==AudioHostState::Running);
    client->stop();service.shutdown();CHECK(song->ledger.devices.empty());
  }
#endif
}
void currentOutputAndGapTests() {
  auto song=std::make_shared<Record>();SharedAudioService service(std::make_unique<FakeHost>(song));
  CHECK(!service.playbackOutputCurrent() && !service.setPlaybackOutputCurrent(true));
  CHECK(service.configureProvider(std::make_unique<FakeHost>(song),"coreaudio").ok);
  CHECK(!service.playbackOutputCurrent()); // startup/training host is not a song
  AudioHostConfig config;config.outputDeviceUid="usb";config.outputChannels={0,1};unsigned callbacks=0;
  auto client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
  CHECK(client->open(config,songRender,&callbacks).ok && client->start().ok);
  CHECK(service.playbackOutputCurrent());
  client->stop();client.reset();CHECK(service.playbackOutputCurrent()); // native re-prepare seam
  CHECK(service.setPlaybackOutputCurrent(false) && !service.playbackOutputCurrent()); // Web Audio handback
  CHECK(!service.setPlaybackOutputCurrent(true)); // stale retained physical route cannot re-arm
  client=service.playbackBackend(std::make_unique<FakeHost>(song),"coreaudio");
  CHECK(client->open(config,songRender,&callbacks).ok && service.playbackOutputCurrent());
  client->stop();service.shutdown();CHECK(!service.playbackOutputCurrent());
  SharedAudioService restarted(std::make_unique<FakeHost>(std::make_shared<Record>()));
  CHECK(!restarted.playbackOutputCurrent());

  OutputCallbackDiagnostics diagnostics;AudioHostRenderBlock b;
  b.frames=512;b.sampleRate=48000;b.streamGeneration=1;b.routeGeneration=1;
  b.outputTimestampHardware=true;b.callbackHostTimeNs=b.outputHostTimeNs=1000000000;
  diagnostics.observe(b);
  b.outputFrame=512;b.callbackHostTimeNs+=10666666;b.outputHostTimeNs+=10666666;b.frames=32;
  diagnostics.observe(b);
  auto d=snapshotOutputCallbacks(diagnostics);
  CHECK(d.periodChanges==1 && d.positiveSampleGapFrames==0 && d.sequenceGaps==0 && d.deliveredFrames==544);
  CHECK(d.maxCallbackExcessNs==0 && d.maxOutputExcessNs==0 && d.periodOutputExcessNs==0);
  // Deliberate negative control: a REAL missing1536-frame span. Neither period
  // math nor a healthy transport may pretend this supplied timestamp gap vanished.
  b.outputFrame+=32+1536;b.callbackHostTimeNs+=666666+32000000;b.outputHostTimeNs+=666666+32000000;
  b.discontinuity=AudioHostDiscontinuitySequenceGap;diagnostics.observe(b);
  d=snapshotOutputCallbacks(diagnostics);
  CHECK(d.sequenceGaps==1 && d.positiveSampleGapFrames==1536 && d.periodOutputExcessNs==32000000);
  CHECK(d.maxCallbackExcessNs==32000000 && d.maxOutputExcessNs==32000000);
  OutputCallbackDiagnostics unknownRate;b.sampleRate=std::numeric_limits<double>::min();
  unknownRate.observe(b);unknownRate.observe(b);
  CHECK(unknownRate.maxCallbackExcessNs.load()==0 && unknownRate.maxOutputExcessNs.load()==0);
}
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
    auto f=std::make_shared<Record>();f->ledgerPath=true;SharedAudioService service(std::make_unique<FakeHost>(f));
    AudioHostConfig requested=c;requested.requestedBufferFrames=512;requested.maximumFrames=4096;
    const auto result=service.initialize(requested);CHECK(result.ok);
    CHECK(f->config.allowSharedDeviceBufferChange && f->properties.frames==512 && f->properties.writes==0);
    CHECK(f->lease.token!=0 && f->ledger.devices.size()==1);
    const auto& entry=f->ledger.devices.at("usb");
    CHECK(entry.owners.at(f->lease.token).preparedMaximum==4096);
    // A second monitor lease changes the REAL shared transaction, without
    // draining/reopening the song; the last writer restores while its capacity lease remains.
    const auto opens=f->opens,stops=f->stops;
    detail::MacAudioBufferOwnership monitor;
    CHECK(detail::requestMacAudioBuffer(f->properties,32,8192,monitor,256,f->ledger).ok());
    CHECK(f->properties.frames==32 && f->properties.writes==1 && entry.owners.size()==2);
    CHECK(detail::restoreMacAudioBuffer(f->properties,monitor,f->ledger)==AudioBufferWarningNone);
    CHECK(f->properties.frames==512 && f->properties.writes==2 && entry.owners.size()==1);
    CHECK(f->opens==opens && f->stops==stops);
    service.shutdown();CHECK(f->properties.frames==512 && f->properties.writes==2 && f->ledger.devices.empty());
  }
  {
    auto f=std::make_shared<Record>();f->ledgerPath=true;SharedAudioService service(std::make_unique<FakeHost>(f));
    AudioHostConfig requested=c;requested.requestedBufferFrames=128;requested.maximumFrames=4096;
    CHECK(service.initialize(requested).ok);
    CHECK(f->config.allowSharedDeviceBufferChange && f->properties.frames==128 && f->properties.writes==1);
    CHECK(f->lease.token!=0 && f->ledger.devices.at("usb").owners.at(f->lease.token).preparedMaximum==4096);
    service.shutdown();CHECK(f->properties.frames==512 && f->properties.writes==2);
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
int main(){renderTests();routeTests();hostTests();channelTests();idleMonitorTests();sharedMonitorLeaseTests();externalLeaseTests();repeatedSharedBufferTests();currentOutputAndGapTests();songTests();std::printf("voice_monitor_tests: %d failures\n",failures);return failures?1:0;}
