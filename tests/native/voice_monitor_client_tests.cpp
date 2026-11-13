#include "native/playback/voice_monitor_client.h"
#include "allocation_trap.h"
#include <cstdio>
#include <cstdlib>
#include <limits>
#include <thread>
#include <chrono>
using namespace singz;
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr,"line %d: %s\n",__LINE__,#x); std::exit(1); } } while(0)
namespace {
AudioHostInventory devices() {
  AudioHostDeviceInfo in; in.uid="in"; in.label="wired input";in.inputChannels=1;
  in.direction=AudioHostEndpointDirection::Input; in.transport=AudioHostTransport::Usb;
  in.nominalSampleRate=48000; in.bufferFrames={32,1024,64,1};
  AudioHostDeviceInfo out=in;out.uid="out";out.label="common output";
  out.inputChannels=0;out.outputChannels=4;out.direction=AudioHostEndpointDirection::Output;
  return {{in,out},"in","out"};
}
struct Output final:AudioHostBackend {
  AudioHostRender callback{}; void* context{}; AudioHostStatus current{};
  unsigned opens=0,starts=0,stops=0,writes=0;
  AudioHostInventory inventory=devices();
  AudioHostInventory enumerate() const override {return inventory;}
  AudioHostResult open(const AudioHostConfig& config,AudioHostRender cb,void* ctx) override {
    ++opens;callback=cb;context=ctx;current.state=AudioHostState::Open;
    current.format={48000,config.maximumFrames,64,0,static_cast<uint32_t>(config.outputChannels.size())};
    current.latency={0,0,64,0};
    return {true,AudioHostError::None,current.state,current.format,current.latency,{}};
  }
  AudioHostResult start() override {++starts;current.state=AudioHostState::Running;return {true,AudioHostError::None,current.state,current.format,current.latency,{}};}
  void stop() noexcept override {++stops;current.state=AudioHostState::Stopped;}
  AudioHostStatus status() const noexcept override{return current;}
  AudioHostResult setBufferFrames(uint32_t,uint32_t) override {++writes;return {};}
};
struct Input final:AudioInputBackend {
  AudioInputPush push{};void* context{};AudioInputConfig config;std::atomic<bool> failed{false};
  unsigned opens=0,starts=0,stops=0;
  AudioInputResult open(const AudioInputConfig& cfg,AudioInputPush cb,void* ctx) override {
    config=cfg;push=cb;context=ctx;++opens;return success();
  }
  AudioInputResult success() {auto r=AudioInputResult::success(AudioInputState::Running,48000,0);r.inputBufferFrames=64;return r;}
  AudioInputResult start() override {++starts;return success();}
  void stop() override {++stops;}
  bool takeFailure(std::string& error) override {if(!failed)return false;error="input removed";return true;}
};
Input* input{};
std::unique_ptr<AudioInputBackend> makeInput(){auto p=std::make_unique<Input>();input=p.get();return p;}
bool song(void* ctx,const AudioHostRenderBlock& b) noexcept {
  float value=*static_cast<float*>(ctx);
  for(uint32_t ch=0;ch<b.outputChannels;++ch)for(uint32_t f=0;f<b.frames;++f)b.output[ch][f]+=value;
  return true;
}
}
int main(){
  auto backend=std::make_unique<Output>();auto* output=backend.get();
  SharedAudioService service(std::move(backend),"coreaudio");VoiceMonitorCapture capture(makeInput);
  CommonVoiceMonitor monitor(service,capture);
  auto inventory=devices();
  CHECK(classifyCommonVoiceMonitorRoute(inventory,"in",0,"out",true).available);
  CHECK(classifyCommonVoiceMonitorRoute(inventory,"in",0,"out",false).reason=="permission");
  CHECK(classifyCommonVoiceMonitorRoute(inventory,"in",1,"out",true).reason=="no-input");
  for(auto transport:{AudioHostTransport::Bluetooth,AudioHostTransport::AirPlay}){
    inventory.devices[1].transport=transport;
    CHECK(!classifyCommonVoiceMonitorRoute(inventory,"in",0,"out",true).available);
  }
  CHECK(monitor.begin("in",0,true,0,1).ok);
  CHECK(capture.users(VoiceCaptureUser::Monitor)==1 && output->opens==1 && output->writes==0);
  CHECK(input->config.requestedBufferFrames==32 && input->config.maximumAcceptableBufferFrames==256);
  auto began=monitor.status(); CHECK(began.running && began.latency.queueFrames==384 && began.latency.delayed);
  std::array<float,64> pcm;pcm.fill(.25f);
  std::array<float,64> left{},right{},extra{};float* planes[]{left.data(),right.data(),extra.data()};
  AudioHostRenderBlock block;block.output=planes;block.outputChannels=3;block.frames=64;block.maximumFrames=64;
  block.sampleRate=48000;block.outputTimestampValid=true;block.outputHostTimeNs=1000000000;
  uint64_t captureFrame=0;
  auto render=[&](unsigned blocks){
    for(unsigned i=0;i<blocks;++i){
      // Capture is delivered up to output presentation time; history reads its queue behind it.
      while(captureFrame<=block.outputFrame){
        const uint64_t ns=1000000000+captureFrame*1000000000/48000;
        input->push(input->context,pcm.data(),64,ns,ns,AudioInputTimestampQuality::Hardware);
        captureFrame+=64;
      }
      auto before=zdsp::test::trappedAllocationCount();zdsp::test::setAllocationTrapEnabled(true);
      CHECK(output->callback(output->context,block));zdsp::test::setAllocationTrapEnabled(false);
      CHECK(zdsp::test::trappedAllocationCount()==before);
      block.outputFrame+=block.frames;block.outputHostTimeNs=1000000000+block.outputFrame*1000000000/48000;
    }
  };
  CHECK(service.setMasterGain(.25));render(32);
  CHECK(std::abs(left[63]-.0625f)<1e-5 && right[63]==left[63] && extra[63]==0);
  output->current.latency.bufferFrames=32;block.frames=32;render(4);
  CHECK(!monitor.status().latency.delayed);
  output->current.latency.bufferFrames=64;block.frames=64;render(4);
  CHECK(monitor.status().latency.delayed);
  // Other additive clients may join/leave without detaching live voice.
  float cue=.125f;
  service.setMicrophoneRenderer(song,&cue);render(4);CHECK(std::abs(left[63]-.09375f)<1e-5);
  service.clearMicrophoneRenderer();render(4);CHECK(std::abs(left[63]-.0625f)<1e-5);
  service.setTrainingRenderer(song,&cue);render(4);CHECK(std::abs(left[63]-.09375f)<1e-5);
  service.clearTrainingRenderer();render(4);CHECK(std::abs(left[63]-.0625f)<1e-5);
  // Same route song join/suspend/stop/replacement/unload has no physical reopen.
  const auto opens=output->opens;
  float music=.125;
  AudioHostConfig cfg;cfg.outputDeviceUid="out";cfg.outputChannels={0,1};cfg.requestedSampleRate=48000;
  cfg.maximumFrames=1024;cfg.requestedBufferFrames=512;
  cfg.maximumFrames=std::max(cfg.maximumFrames,service.retainedPlaybackCapacity(cfg));
  for(unsigned i=0;i<3;++i){
    auto client=service.playbackBackend(std::make_unique<Output>(),"coreaudio");
    CHECK(client->open(cfg,song,&music).ok && client->start().ok);
    render(4);CHECK(std::abs(left[63]-.09375f)<1e-5);
    CHECK(client->suspend().ok);render(4);CHECK(std::abs(left[63]-.0625f)<1e-5);
    CHECK(client->resume().ok);client->stop();CHECK(service.setPlaybackOutputCurrent(false));
    render(4);CHECK(monitor.status().running && output->opens==opens);
  }
  // Capture joins a take without changing opening policy or sample values.
  std::vector<float> take; take.reserve(32768);
  AudioInputConfig recording;recording.deviceUid="in";
  CHECK(capture.retain(VoiceCaptureUser::Take,recording,[&](const AudioInputBlockView& b){take.insert(take.end(),b.mono,b.mono+b.frames);}).ok);
  CHECK(input->opens==1 && input->starts==1);
  render(4);
  const auto deliveryDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
  bool received=false;
  while (!received && std::chrono::steady_clock::now()<deliveryDeadline) {
    capture.synchronizeDelivery([&]{received=!take.empty();});
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  CHECK(received);
  CHECK(!monitor.end(99).ok && monitor.status().running);
  CHECK(monitor.end(1).ok && capture.users(VoiceCaptureUser::Monitor)==0 && capture.users(VoiceCaptureUser::Take)==1);
  CHECK(monitor.begin("in",0,true,0,2).ok && input->opens==1 && input->starts==1);
  // A private leaf limiter would fail: hot voice is recovered by master attenuation.
  CHECK(monitor.setGain(12));render(4);
  CHECK(std::abs(left[63]-.25f*.25f*std::pow(10.f,12.f/20))<1e-5);
  CHECK(monitor.setGain(0));render(1);
  for(unsigned i=1;i<64;++i) CHECK(left[i]<=left[i-1] && left[i-1]-left[i]<.002f);
  CHECK(left[63]>.0625f);render(1);CHECK(std::abs(left[63]-.0625f)<1e-5);
  CHECK(monitor.setGain(100));render(4);CHECK(left[63]==kServiceMasterCeiling);
  CHECK(monitor.setGain(-100));render(4);CHECK(std::abs(left[63]-.0000625f)<1e-6);
  CHECK(!monitor.setGain(std::numeric_limits<float>::quiet_NaN()));
  capture.synchronizeDelivery([&]{CHECK(!take.empty());for(float sample:take) CHECK(sample==.25f);});
  capture.setDeliverySink({});
  pcm.fill(std::numeric_limits<float>::infinity());render(32);
  for(float value:left)CHECK(std::isfinite(value));
  CHECK(service.configureOutput("in").ok==false); // Input-only endpoint cannot be chosen.
  service.parkOutput();CHECK(!monitor.status().running && monitor.status().reason=="error");
  CHECK(capture.users(VoiceCaptureUser::Monitor)==0 && capture.users(VoiceCaptureUser::Take)==1);
  capture.release(VoiceCaptureUser::Take);
  CHECK(!take.empty()); for(float sample:take)CHECK(sample==.25f);
  CHECK(!monitor.status().running); // Never auto-restart.
  CHECK(!monitor.begin("in",0,true,0,3,32).ok);
  CHECK(capture.users(VoiceCaptureUser::Monitor)==0);
  CHECK(monitor.begin("in",0,true,0,3,2048).ok);
  CHECK(monitor.status().latency.queueFrames==2048 && monitor.status().latency.delayed);
  CHECK(monitor.end(3).ok);
  CHECK(monitor.begin("in",0,true,0,3).ok);
  output->current.state=AudioHostState::DeviceLost;
  CHECK(monitor.status().lost && capture.users(VoiceCaptureUser::Monitor)==0);
  CHECK(!monitor.status().running);
  CHECK(monitor.begin("in",0,true,0,4).ok);
  output->current.latency.bufferFrames=8192;
  CHECK(!monitor.status().running && monitor.status().reason=="route-latency");
  CHECK(capture.users(VoiceCaptureUser::Monitor)==0);
  output->current.latency.bufferFrames=64;
  CHECK(monitor.begin("in",0,true,0,4).ok);
  input->failed=true;
  const auto lossDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(1);
  while(capture.state()!=AudioInputState::Error && std::chrono::steady_clock::now()<lossDeadline)
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  CHECK(monitor.status().lost && capture.users(VoiceCaptureUser::Monitor)==0);
  CHECK(monitor.begin("in",0,true,0,5).ok);
  auto other=output->inventory.devices.back();other.uid="other";
  output->inventory.devices.push_back(other);service.refreshInventory();
  CHECK(service.configureOutput("other").ok);
  // Route change gates voice before the next control status/release; it never
  // leaks the old input into the newly selected output.
  left.fill(1);right.fill(1);output->callback(output->context,block);
  CHECK(left[63]==0 && right[63]==0);
  CHECK(!monitor.status().running && monitor.status().reason=="error");
  CHECK(capture.users(VoiceCaptureUser::Monitor)==0);
  // A take opened before monitoring keeps its buffer and transport; a song
  // on that same physical device is never retuned to the monitor target.
  output->inventory.devices[1].inputChannels=1;
  output->inventory.devices[1].direction=AudioHostEndpointDirection::Duplex;
  service.refreshInventory();CHECK(service.configureOutput("out").ok);
  auto songClient=service.playbackBackend(std::make_unique<Output>(),"coreaudio");
  CHECK(songClient->open(cfg,song,&music).ok && songClient->start().ok);
  const auto songOpens=output->opens;
  AudioInputConfig firstTake;firstTake.deviceUid="out";
  const auto inputs=service.inputDevices();
  CHECK(capture.retain(VoiceCaptureUser::Take,firstTake,{},&inputs).ok);
  CHECK(monitor.begin("out",0,true,0,6).ok);
  CHECK(input->config.requestedBufferFrames==0 && input->opens==1 && input->starts==1);
  CHECK(output->opens==songOpens && output->writes==0);
  songClient->stop();CHECK(service.setPlaybackOutputCurrent(false));
  CHECK(monitor.status().running && output->opens==songOpens);
  service.setTrainingRenderer(song,&cue);
  const auto cueOpens=output->opens, cueStarts=output->starts, cueStops=output->stops;
  const auto cueRoute=service.outputRouteGeneration();
  CHECK(monitor.end(6).ok && capture.users(VoiceCaptureUser::Take)==1);
  CHECK(service.status().state==AudioHostState::Running);
  CHECK(output->opens==cueOpens && output->starts==cueStarts && output->stops==cueStops);
  CHECK(service.outputRouteGeneration()==cueRoute && service.activeOutputConfig().holdSharedDeviceBuffer);
  output->callback(output->context,block);CHECK(std::abs(left[63]-.03125f)<1e-6);
  service.setMicrophoneRenderer(song,&cue);
  service.clearTrainingRenderer();
  CHECK(output->opens==cueOpens && output->stops==cueStops && service.outputRouteGeneration()==cueRoute);
  output->callback(output->context,block);CHECK(std::abs(left[63]-.03125f)<1e-6);
  service.clearMicrophoneRenderer();
  CHECK(output->opens==cueOpens && output->stops==cueStops+1);
  CHECK(service.outputRouteGeneration()==cueRoute+1 && !service.activeOutputConfig().holdSharedDeviceBuffer);
  CHECK(input->opens==1 && input->starts==1);
  capture.release(VoiceCaptureUser::Take);
  std::puts("common monitor client: ok");
}
