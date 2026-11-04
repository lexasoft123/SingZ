#include "native/playback/microphone_mix.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <memory>
#include <new>
#include <string>
#include <vector>

#define CHECK(value) do { if (!(value)) { \
  std::fprintf(stderr,"CHECK %s:%d: %s\n",__FILE__,__LINE__,#value); std::abort(); \
} } while(false)
namespace {
bool trackHeap=false;
uint64_t heapEvents=0;
}
#if defined(__GNUC__)
#define HEAP_HOOK __attribute__((noinline))
#else
#define HEAP_HOOK
#endif
HEAP_HOOK void* operator new(std::size_t count) {
  if(trackHeap)++heapEvents;
  if(void* result=std::malloc(count?count:1))return result;
  throw std::bad_alloc();
}
HEAP_HOOK void* operator new[](std::size_t count){return ::operator new(count);}
void operator delete(void* p)noexcept{std::free(p);}
void operator delete[](void* p)noexcept{std::free(p);}
void operator delete(void* p,std::size_t)noexcept{std::free(p);}
void operator delete[](void* p,std::size_t)noexcept{std::free(p);}
using namespace singz;
namespace {
template<class F> auto realtime(F operation) {
  const auto before=heapEvents;trackHeap=true;
  const auto result=operation();trackHeap=false;
  CHECK(before==heapEvents);return result;
}

constexpr uint64_t origin=9000000000ULL;
uint64_t ns(uint64_t frame,double rate=48000) {
  return static_cast<uint64_t>(frame*1e9L/rate);
}
std::vector<std::string> events;
struct HostRecord {
  unsigned opens=0,starts=0,stops=0;
  AudioHostConfig config;
  AudioHostStatus status;
  AudioHostRender callback=nullptr;
  void* context=nullptr;
  bool failOpen=false,failStart=false,lateOnStop=false;
  std::string label="shared";
};
std::shared_ptr<HostRecord> relayRecord;
class Host final:public AudioHostBackend {
 public:
  explicit Host(std::shared_ptr<HostRecord> record):record(std::move(record)){}
  AudioHostInventory enumerate()const override {
    AudioHostDeviceInfo flow;flow.uid="flow";flow.inputChannels=10;flow.outputChannels=4;
    flow.defaultOutput=true;flow.defaultInput=true;flow.nominalSampleRate=48000;
    auto hdmi=flow;hdmi.uid="hdmi";hdmi.inputChannels=0;hdmi.outputChannels=2;
    hdmi.defaultInput=hdmi.defaultOutput=false;
    return {{flow,hdmi},"flow","flow"};
  }
  AudioHostResult open(const AudioHostConfig& config,AudioHostRender render,void* context) override {
    auto& r=*record;++r.opens;r.config=config;r.callback=render;r.context=context;
    CHECK(config.inputDeviceUid.empty() && config.inputChannels.empty());
    if(r.failOpen)return {false,AudioHostError::ProviderFailure,AudioHostState::Error,{},{},"open failure"};
    r.status.state=AudioHostState::Open;
    r.status.format={48000,config.maximumFrames,1024,0,static_cast<uint32_t>(config.outputChannels.size())};
    return {true,AudioHostError::None,r.status.state,r.status.format,{},{}};
  }
  AudioHostResult start() override {
    auto& r=*record;++r.starts;
    if(r.failStart)return {false,AudioHostError::ProviderFailure,AudioHostState::Error,{},{},"start failure"};
    r.status.state=AudioHostState::Running;
    return {true,AudioHostError::None,r.status.state,r.status.format,{},{}};
  }
  void stop()noexcept override {
    auto& r=*record;++r.stops;events.push_back(r.label+"-stop");
    if(r.lateOnStop && r.callback) {
      std::array<float,256>a{},b{};float* output[]{a.data(),b.data()};
      AudioHostRenderBlock block;block.output=output;block.outputChannels=2;
      block.frames=256;block.maximumFrames=kAudioHostMaxFrames;block.sampleRate=48000;
      block.callbackHostTimeNs=origin+ns(1536);
      r.callback(r.context,block);
    }
    r.callback=nullptr;r.context=nullptr;r.status.state=AudioHostState::Stopped;
  }
  AudioHostStatus status()const noexcept override{return record->status;}
 private:std::shared_ptr<HostRecord> record;
};
std::unique_ptr<AudioHostBackend> outputFactory(){return std::make_unique<Host>(relayRecord);}
struct InputRecord {
  AudioInputConfig config;
  AudioInputPush callback=nullptr;
  void* context=nullptr;
  bool running=false,failure=false;
  unsigned stops=0;
};
std::vector<std::shared_ptr<InputRecord>> inputs;
int failOpenAt=-1,failStartAt=-1;
class Input final:public AudioInputBackend {
 public:
  Input():record(std::make_shared<InputRecord>()),index(inputs.size()){inputs.push_back(record);}
  AudioInputResult open(const AudioInputConfig& config,AudioInputPush callback,void* context)override {
    record->config=config;record->callback=callback;record->context=context;
    if(static_cast<int>(index)==failOpenAt)
      return AudioInputResult::failure(AudioInputState::Error,"capture open failure",config.channel);
    return AudioInputResult::success(AudioInputState::Starting,48000,config.channel);
  }
  AudioInputResult start()override {
    if(static_cast<int>(index)==failStartAt)
      return AudioInputResult::failure(AudioInputState::Error,"capture start failure",record->config.channel);
    record->running=true;
    return AudioInputResult::success(AudioInputState::Running,48000,record->config.channel);
  }
  void stop()override {
    ++record->stops;events.push_back("capture-stop");record->running=false;
    record->callback=nullptr;record->context=nullptr;
  }
  bool takeFailure(std::string& error)override {
    if(!record->failure)return false;
    record->failure=false;error="capture disconnected";return true;
  }
 private:std::shared_ptr<InputRecord> record;size_t index;
};
std::unique_ptr<AudioInputBackend> inputFactory(){return std::make_unique<Input>();}
bool song(void*,const AudioHostRenderBlock& block)noexcept {
  for(uint32_t f=0;f<block.frames;++f){block.output[0][f]=.2f;block.output[1][f]=-.1f;}
  return true;
}
struct Fixture {
  std::shared_ptr<HostRecord> shared=std::make_shared<HostRecord>();
  SharedAudioService service{std::make_unique<Host>(std::make_shared<HostRecord>())};
  std::unique_ptr<AudioHostBackend> client;
  Fixture() {
    events.clear();inputs.clear();failOpenAt=failStartAt=-1;
    relayRecord=std::make_shared<HostRecord>();relayRecord->label="relay";
    CHECK(service.configureProvider(std::make_unique<Host>(shared),"alsa").ok);
    client=service.playbackBackend(std::make_unique<Host>(std::make_shared<HostRecord>()),"alsa");
    AudioHostConfig route;route.outputDeviceUid="flow";route.outputChannels={0,1};
    route.requestedSampleRate=48000;
    CHECK(client->open(route,song,nullptr).ok);CHECK(client->start().ok);
    events.clear();
  }
};
MicrophoneMixConfig relayConfig() {
  MicrophoneMixConfig config;config.deviceUid="flow";config.outputDeviceUid="hdmi";
  config.channels={{8,1,false,-1},{9,1,false,1}};return config;
}
void feed(uint64_t begin=origin,float l=.3f,float r=-.4f,double actual=48000,uint32_t blocks=8) {
  for(uint32_t block=0;block<blocks;++block) {
    std::array<float,256> samples;
    for(const auto& input:inputs)if(input->running) {
      samples.fill(input->config.channel==8?l:r);
      CHECK(realtime([&]{return input->callback(input->context,samples.data(),256,begin+ns(block*256,actual),0,
          AudioInputTimestampQuality::CallbackEstimate);}));
    }
  }
}
std::array<std::array<float,1024>,2> render(const std::shared_ptr<HostRecord>& host,uint64_t time,
    bool expected=true) {
  std::array<std::array<float,1024>,2> result;for(auto& plane:result)plane.fill(.75f);
  float* pointers[]{result[0].data(),result[1].data()};
  AudioHostRenderBlock block;block.output=pointers;block.outputChannels=2;
  block.frames=1024;block.maximumFrames=kAudioHostMaxFrames;block.sampleRate=48000;
  block.callbackHostTimeNs=time;
  CHECK(host->callback && realtime([&]{return host->callback(host->context,block);})==expected);
  return result;
}
void close(float a,float b){CHECK(std::abs(a-b)<.00003f);}
void relayStereoAndLifetime() {
  Fixture fixture;MicrophoneMixSession session(fixture.service,inputFactory,outputFactory);
  const auto opens=fixture.shared->opens,stops=fixture.shared->stops;
  CHECK(session.start(relayConfig()).ok);
  CHECK(relayRecord->config.outputDeviceUid=="hdmi");
  CHECK(relayRecord->config.outputChannels==std::vector<uint32_t>({0,1}));
  CHECK(inputs.size()==2 && inputs[0]->config.channel==8 && inputs[1]->config.channel==9);
  auto empty=render(relayRecord,origin+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(empty[0][i],0);close(empty[1][i],0);}
  feed();auto routed=render(relayRecord,origin+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(routed[0][i],.3f);close(routed[1][i],-.4f);}
  auto dry=render(fixture.shared,origin+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(dry[0][i],.2f);close(dry[1][i],-.1f);}
  CHECK(fixture.shared->opens==opens && fixture.shared->stops==stops);
  events.clear();relayRecord->lateOnStop=true;session.stop();
  CHECK(!session.status().active && relayRecord->status.state==AudioHostState::Stopped);
  CHECK(events.size()>=3 && events[0]=="relay-stop");
  CHECK(fixture.shared->opens==opens && fixture.shared->stops==stops);
  relayRecord->lateOnStop=false;CHECK(session.start(relayConfig()).ok);
  feed(origin+2000000000,.15f,-.2f,48000.0*1.0002);
  auto restarted=render(relayRecord,origin+2000000000+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(restarted[0][i],.15f);close(restarted[1][i],-.2f);}
}
void unknownCaptureRecovery() {
  Fixture fixture;MicrophoneMixSession session(fixture.service,inputFactory,outputFactory);
  CHECK(session.start(relayConfig()).ok);feed();
  const auto before=session.status();
  CHECK(before.active && before.diagnostics.size()==2);
  std::array<float,256> unanchored;
  for(int repeat=0;repeat<2;++repeat) {
    const auto timestamp=repeat==0?0:origin+ns(4096);
    const float level=repeat==0?.9f:.7f;
    for(const auto& input:inputs) {
      unanchored.fill(input->config.channel==8?level:-level);
      CHECK(realtime([&]{return input->callback(input->context,unanchored.data(),256,timestamp,0,
          AudioInputTimestampQuality::Unknown);}));
    }
  }
  const auto gap=session.status();
  CHECK(gap.active && gap.failures==0 && gap.diagnostics.size()==2);
  for(size_t index=0;index<gap.diagnostics.size();++index) {
    const auto& source=gap.diagnostics[index];const auto& prior=before.diagnostics[index];
    CHECK(source.historyOnline && source.historyCallbacks==8 && source.historyDiscontinuities==0);
    CHECK(source.historyCallbacks==prior.historyCallbacks && source.lastHostNs==prior.lastHostNs);
    CHECK(source.publishedEndHostNs==prior.publishedEndHostNs);
  }
  auto old=render(relayRecord,origin+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(old[0][i],.3f);close(old[1][i],-.4f);}
  const auto recovered=origin+ns(2048)+50000;
  feed(recovered,.15f,-.2f,48000,8);
  auto routed=render(relayRecord,recovered+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(routed[0][i],.15f);close(routed[1][i],-.2f);}
  const auto after=session.status();
  CHECK(after.active && after.failures==0 && after.diagnostics.size()==2);
  for(const auto& source:after.diagnostics) {
    CHECK(source.historyOnline && source.historyCallbacks==16 && source.historyDiscontinuities==1);
    CHECK(source.lastHostNs==recovered+ns(1792));
    CHECK(source.publishedEndHostNs==recovered+ns(2048));
    CHECK(source.verifiedClockSteps==0);
  }
}
void malformedCaptureFailsClosed() {
  for(int kind=0;kind<7;++kind) {
    Fixture fixture;MicrophoneMixSession session(fixture.service,inputFactory,outputFactory);
    CHECK(session.start(relayConfig()).ok);feed();
    std::array<float,256> samples{};const auto& input=inputs[0];
    auto push=[&](const float* pcm,uint32_t count,uint64_t firstNs,AudioInputTimestampQuality quality) {
      CHECK(realtime([&]{return input->callback(input->context,pcm,count,firstNs,0,quality);}));
    };
    switch(kind) {
      case 0:push(nullptr,256,origin+ns(2048),AudioInputTimestampQuality::CallbackEstimate);break;
      case 1:push(samples.data(),kAudioHostMaxFrames+1,origin+ns(2048),AudioInputTimestampQuality::CallbackEstimate);break;
      case 2:push(samples.data(),256,0,AudioInputTimestampQuality::CallbackEstimate);break;
      case 3:push(nullptr,256,0,AudioInputTimestampQuality::Unknown);break;
      case 4:push(samples.data(),kAudioHostMaxFrames+1,origin+ns(2048),AudioInputTimestampQuality::Unknown);break;
      case 5:push(samples.data(),0,0,AudioInputTimestampQuality::Unknown);break;
      default:push(samples.data(),0,origin+ns(2048),AudioInputTimestampQuality::CallbackEstimate);break;
    }
    const auto status=session.status();
    CHECK(!status.active && status.failures>0);
    CHECK(status.error=="Native capture returned invalid timestamped audio");
  }
}
uint64_t reasonTotal(const MicrophoneMixSourceDiagnostics& source) {
  const auto& missing=source.missingFramesByReason;
  return missing.invalidRequest+missing.offline+missing.anchorUnavailable+
      missing.clockMapping+missing.resamplingSupport+missing.generationChanged;
}
void relayDiagnostics() {
  Fixture fixture;MicrophoneMixSession session(fixture.service,inputFactory,outputFactory);
  CHECK(session.start(relayConfig()).ok);
  render(relayRecord,origin+ns(1536));
  auto status=session.status();
  CHECK(status.active && status.callbacks==1 && status.missingFrames==2048);
  CHECK(status.diagnostics.size()==2);
  for(size_t index=0;index<status.diagnostics.size();++index) {
    const auto& source=status.diagnostics[index];
    CHECK(source.channel==(index==0?8:9));
    CHECK(!source.historyOnline && source.historyCallbacks==0 && source.historyDiscontinuities==0);
    CHECK(source.measuredRate==0 && source.lastHostNs==0 && source.publishedEndHostNs==0);
    CHECK(source.missingFramesByReason.offline==1024 && reasonTotal(source)==1024);
    CHECK(source.unpublishedSampleReads==0 && source.expiredSampleReads==0);
    CHECK(source.racingSampleReads==0 && source.absentSampleReads==0);
    CHECK(source.verifiedClockSteps==0 && source.maximumVerifiedClockStepNs==0);
  }
  feed();render(relayRecord,origin+ns(1536));
  status=session.status();
  CHECK(status.missingFrames==2048);
  for(const auto& source:status.diagnostics) {
    CHECK(source.historyOnline && source.historyCallbacks==8 && source.historyDiscontinuities==0);
    CHECK(source.measuredRate==48000 && source.lastHostNs==origin+ns(1792));
    CHECK(source.publishedEndHostNs==origin+ns(2048));
    CHECK(source.missingFramesByReason.offline==1024 && reasonTotal(source)==1024);
    CHECK(source.unpublishedSampleReads==0 && source.expiredSampleReads==0);
    CHECK(source.racingSampleReads==0 && source.absentSampleReads==0);
    CHECK(source.verifiedClockSteps==0 && source.maximumVerifiedClockStepNs==1);
  }
  render(relayRecord,origin+ns(4096));
  status=session.status();
  CHECK(status.missingFrames==4096);
  uint64_t channelMissing=0;
  for(const auto& source:status.diagnostics) {
    CHECK(source.missingFramesByReason.offline==1024);
    CHECK(source.missingFramesByReason.resamplingSupport==1024);
    CHECK(reasonTotal(source)==2048);
    channelMissing+=reasonTotal(source);
    CHECK(source.unpublishedSampleReads>0 && source.expiredSampleReads==0);
    CHECK(source.racingSampleReads==0 && source.absentSampleReads==0);
  }
  CHECK(channelMissing==status.missingFrames);
  const auto stepped=origin+ns(2048)+50000;
  feed(stepped,.3f,-.4f,48000,1);
  status=session.status();
  for(const auto& source:status.diagnostics) {
    CHECK(source.historyOnline && source.historyCallbacks==9 && source.historyDiscontinuities==0);
    CHECK(source.lastHostNs==stepped && source.publishedEndHostNs==stepped+ns(256));
    CHECK(source.verifiedClockSteps==1 && source.maximumVerifiedClockStepNs==50000);
  }
}
void validationAndFailures() {
  Fixture fixture;MicrophoneMixSession session(fixture.service,inputFactory,outputFactory);
  auto bad=relayConfig();bad.outputDeviceUid="flow";CHECK(!session.start(bad).ok);
  bad=relayConfig();bad.delayFrames=255;CHECK(!session.start(bad).ok);
  bad=relayConfig();bad.channels[1].channel=8;CHECK(!session.start(bad).ok);
  bad=relayConfig();bad.channels[0].gain=std::numeric_limits<float>::quiet_NaN();CHECK(!session.start(bad).ok);
  bad=relayConfig();bad.channels[0].pan=2;CHECK(!session.start(bad).ok);
  bad=relayConfig();bad.outputDeviceUid=std::string(4097,'x');CHECK(!session.start(bad).ok);
  CHECK(inputs.empty() && relayRecord->opens==0);
  const auto opens=fixture.shared->opens,stops=fixture.shared->stops;
  relayRecord->failStart=true;CHECK(!session.start(relayConfig()).ok);
  CHECK(!session.status().active && relayRecord->stops>0);
  for(auto& input:inputs)CHECK(!input->running && input->stops>0);
  relayRecord->failStart=false;CHECK(session.start(relayConfig()).ok);feed();
  inputs.back()->failure=true;
  const auto status=session.status();CHECK(!status.active && status.error=="capture disconnected");
  CHECK(status.failures>0 && relayRecord->status.state==AudioHostState::Stopped);
  CHECK(fixture.shared->opens==opens && fixture.shared->stops==stops);
  CHECK(session.start(relayConfig()).ok);feed();
  fixture.shared->status.state=AudioHostState::DeviceLost;
  CHECK(!session.status().active);
}
void partialCaptureFailureAndAdditive() {
  Fixture fixture;MicrophoneMixSession session(fixture.service,inputFactory,outputFactory);
  failOpenAt=1;CHECK(!session.start(relayConfig()).ok);
  CHECK(inputs.size()==2);
  for(const auto& input:inputs)CHECK(!input->running && input->stops>0);
  failOpenAt=-1;failStartAt=static_cast<int>(inputs.size()+1);
  CHECK(!session.start(relayConfig()).ok);
  for(const auto& input:inputs)CHECK(!input->running && input->stops>0);
  failStartAt=-1;
  auto additive=relayConfig();additive.outputDeviceUid.clear();
  CHECK(session.start(additive).ok);feed();
  auto output=render(fixture.shared,origin+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(output[0][i],.5f);close(output[1][i],-.5f);}
  session.stop();output=render(fixture.shared,origin+ns(1536));
  for(uint32_t i=0;i<1024;++i){close(output[0][i],.2f);close(output[1][i],-.1f);}
}
void routeChangesFailClosed() {
  Fixture fixture;MicrophoneMixSession session(fixture.service,inputFactory,outputFactory);
  CHECK(session.start(relayConfig()).ok);feed();
  CHECK(fixture.service.configureOutput("hdmi").ok);
  auto silence=render(relayRecord,origin+ns(1536),false);
  for(uint32_t i=0;i<1024;++i){close(silence[0][i],0);close(silence[1][i],0);}
  CHECK(!session.status().active);
}
}
int main(){relayStereoAndLifetime();unknownCaptureRecovery();relayDiagnostics();validationAndFailures();malformedCaptureFailsClosed();partialCaptureFailureAndAdditive();routeChangesFailClosed();
  std::puts("Hardware main relay: stereo, unknown-timeline recovery, diagnostics, independent clock, drain and fail-closed routes passed");}
