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
bool perDeviceLatencies=false;
struct Output final:AudioHostBackend {
  AudioHostRender callback{}; void* context{}; AudioHostStatus current{};
  unsigned opens=0,starts=0,stops=0,writes=0;
  AudioHostInventory inventory=devices();
  AudioHostInventory enumerate() const override {return inventory;}
  AudioHostResult open(const AudioHostConfig& config,AudioHostRender cb,void* ctx) override {
    ++opens;callback=cb;context=ctx;current.state=AudioHostState::Open;
    const auto period=config.requestedBufferFrames ? config.requestedBufferFrames : 64;
    current.format={config.requestedSampleRate ? config.requestedSampleRate : 48000,config.maximumFrames,period,0,static_cast<uint32_t>(config.outputChannels.size())};
    current.latency={0,perDeviceLatencies ? (config.outputDeviceUid=="out"?28u:96u) : 0u,period,0};
    ++current.streamGeneration;
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
  AudioInputResult success() {auto r=AudioInputResult::success(AudioInputState::Running,48000,0);r.inputBufferFrames=64;r.inputLatencyFrames=perDeviceLatencies?(config.deviceUid=="in"?148u:320u):0u;return r;}
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
  for(auto transport:{AudioHostTransport::BuiltIn,AudioHostTransport::Usb,AudioHostTransport::Virtual,AudioHostTransport::Aggregate,AudioHostTransport::Unknown}) {
    inventory=devices();inventory.devices[1].transport=transport;
    inventory.devices[0].monitoringSuitability=AudioHostMonitoringSuitability::Unsupported;
    inventory.devices[1].monitoringSuitability=AudioHostMonitoringSuitability::HighLatency;
    CHECK(classifyCommonVoiceMonitorRoute(inventory,"in",0,"out",true).available);
  }
  auto loop = devices(); loop.devices[0].outputChannels = 2;
  loop.devices[0].transport = AudioHostTransport::Virtual;loop.devices[0].label="BlackHole 2ch";
  auto refused = classifyCommonVoiceMonitorRoute(loop,"in",0,"in",true);
  CHECK(!refused.available && refused.reason=="route-feedback" && !refused.detail.empty());
  CHECK(classifyCommonVoiceMonitorRoute(loop,"in",0,"out",true).available);
  loop.devices[0].label="NoMachine Audio Adapter";
  CHECK(classifyCommonVoiceMonitorRoute(loop,"in",0,"in",true).available);
  loop.devices[0].label="Custom Virtual Device";
  CHECK(classifyCommonVoiceMonitorRoute(loop,"in",0,"in",true).available);
  loop.devices[0].transport=AudioHostTransport::Aggregate;
  for (const char* label : {"Mic + headphones", "BlackHole 2ch"}) {
    loop.devices[0].label=label;CHECK(classifyCommonVoiceMonitorRoute(loop,"in",0,"in",true).available);
  }
  CommonVoiceMonitorRender ownerless;AudioHostConfig admissionConfig;AudioHostResult admissionOpening;
  CHECK(!CommonVoiceMonitor::admit(nullptr,inventory,admissionConfig,admissionOpening));
  CHECK(!CommonVoiceMonitor::admit(&ownerless,inventory,admissionConfig,admissionOpening));
  for (auto transport : {AudioHostTransport::BuiltIn, AudioHostTransport::Usb}) {
    auto physical = devices(); physical.devices[0].outputChannels=2;physical.devices[0].transport=transport;
    CHECK(classifyCommonVoiceMonitorRoute(physical,"in",0,"in",true).available);
  }
  CHECK(monitor.begin("in",0,true,0,1).ok);
  CHECK(capture.users(VoiceCaptureUser::Monitor)==1 && output->opens==1 && output->writes==0);
  auto virtualPair=devices();virtualPair.devices[0].outputChannels=2;
  virtualPair.devices[0].transport=AudioHostTransport::Virtual;virtualPair.devices[0].label="NoMachine";
  AudioHostConfig virtualOutput;virtualOutput.outputDeviceUid="in";
  CommonVoiceMonitorRender stopping;stopping.owner=&monitor;stopping.target.store(0);
  CHECK(CommonVoiceMonitor::admit(&stopping,virtualPair,virtualOutput,admissionOpening));
  CHECK(stopping.target.load()==0); // Safety entry must never unmute a concurrent end.
  stopping.feedbackRisk.store(0);stopping.target.store(.001f);
  CHECK(CommonVoiceMonitor::admit(&stopping,virtualPair,virtualOutput,admissionOpening));
  CHECK(stopping.target.load()==.001f); // Never raise a quieter user gain.

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
  service.parkOutput();CHECK(monitor.status().running);
  CHECK(capture.users(VoiceCaptureUser::Monitor)==1 && capture.users(VoiceCaptureUser::Take)==1);
  CHECK(monitor.end(2).ok);
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
  // A deliberate output change re-registers before callbacks resume.
  left.fill(1);right.fill(1);output->callback(output->context,block);
  CHECK(left[63]==0 && right[63]==0);
  CHECK(monitor.status().running && capture.users(VoiceCaptureUser::Monitor)==1);
  pcm.fill(.25f);render(32);CHECK(std::abs(left[63]-.0625f)<1e-5);
  CHECK(monitor.end(5).ok);
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
  // Different sides must use their own opening snapshots, never a stale
  // input field from the output host or a previous capture device.
  perDeviceLatencies=true;
  CHECK(service.configureOutput("other").ok && monitor.begin("in",0,true,0,7).ok);
  auto measured=monitor.status().latency;
  CHECK(measured.inputDeviceFrames==148 && measured.outputDeviceFrames==96);
  CHECK(monitor.end(7).ok);
  CHECK(service.configureOutput("out").ok && monitor.begin("out",0,true,0,8).ok);
  measured=monitor.status().latency;
  CHECK(measured.inputDeviceFrames==320 && measured.outputDeviceFrames==28);
  CHECK(monitor.end(8).ok);
  perDeviceLatencies=false;
  output->inventory.devices[1].transport=AudioHostTransport::Unknown;
  output->inventory.devices[1].monitoringSuitability=AudioHostMonitoringSuitability::Unsupported;
  service.refreshInventory();CHECK(monitor.begin("in",0,true,0,9).ok);
  output->current.latency.bufferFrames=32;
  CHECK(monitor.status().latency.delayed && !monitor.status().warnings.empty());
  output->inventory.devices[1].transport=AudioHostTransport::Usb;service.refreshInventory();
  CHECK(!monitor.status().latency.delayed);
  // A graph prepared before the monitor has a smaller cached capacity. Its
  // first open must rebind the monitor on the same physical route/512 period.
  pcm.fill(.25f);block.outputChannels=2;render(64);
  AudioHostConfig reopened;reopened.outputDeviceUid="out";reopened.outputChannels={0,1};
  reopened.requestedSampleRate=48000;reopened.maximumFrames=1024;reopened.requestedBufferFrames=512;
  auto nextSong=service.playbackBackend(std::make_unique<Output>(),"coreaudio");
  const auto oldGeneration=service.outputRouteGeneration();
  CHECK(nextSong->open(reopened,song,&music).ok);
  CHECK(service.outputRouteGeneration()>oldGeneration && output->current.state==AudioHostState::Running);
  CHECK(monitor.status().running && input->opens==1 && input->starts==1);
  measured=monitor.status().latency;
  CHECK(measured.outputPeriodFrames==512 && measured.queueFloorFrames==1280 && measured.queueFrames==1280 && measured.delayed);
  render(1); // The first post-gap block fades in, rather than resuming full-scale.
  CHECK(left[0]>0 && left[0]<.001f && left[63]>left[0] && left[63]<.04f);
  render(64);CHECK(std::abs(left[63]-.0625f)<1e-5); // Voice before first Play.
  CHECK(nextSong->start().ok);render(8);CHECK(std::abs(left[63]-.09375f)<1e-5);
  nextSong->stop();CHECK(service.setPlaybackOutputCurrent(false));
  CHECK(monitor.status().running && capture.users(VoiceCaptureUser::Monitor)==1);
  auto switchedSong=service.playbackBackend(std::make_unique<Output>(),"coreaudio");
  reopened.maximumFrames=512;reopened.requestedBufferFrames=256;
  CHECK(switchedSong->open(reopened,song,&music).ok);
  CHECK(monitor.status().running && monitor.status().latency.outputPeriodFrames==256);
  CHECK(monitor.status().latency.queueFrames==768);
  render(64);CHECK(std::abs(left[63]-.0625f)<1e-5);
  switchedSong->stop();CHECK(service.setPlaybackOutputCurrent(false));
  CHECK(monitor.status().running && input->opens==1 && input->starts==1);
  CHECK(monitor.end(0).ok && capture.users(VoiceCaptureUser::Monitor)==0);
  output->inventory.devices[1].transport=AudioHostTransport::Virtual;
  output->inventory.devices[1].label="BlackHole 2ch";service.refreshInventory();
  CHECK(service.configureOutput("other").ok && monitor.begin("out",0,true,0,12).ok);
  render(64);CHECK(std::abs(left[63]-.0625f)<1e-5);
  CHECK(service.configureOutput("out").ok);render(1);
  CHECK(left[0]==0 && left[63]==0); // No feedback leaks before the first control poll.
  CHECK(!monitor.status().running && monitor.status().reason=="route-feedback");
  output->inventory.devices[1].label="NoMachine Audio Adapter";service.refreshInventory();
  auto quiet = monitor.begin("out",0,true,12,13);
  CHECK(quiet.ok && quiet.gainDb && *quiet.gainDb==-40);
  CHECK(std::find(quiet.warnings.begin(),quiet.warnings.end(),"route-feedback-risk")!=quiet.warnings.end());
  render(64);CHECK(std::abs(left[63]-.000625f)<1e-6);
  CHECK(monitor.setGain(0));render(4);CHECK(std::abs(left[63]-.0625f)<1e-5);
  service.parkOutput();CHECK(monitor.status().running);render(64);
  CHECK(monitor.status().gainDb==0); // A period/reopen seam preserves deliberate gain adjustment.
  CHECK(service.configureOutput("other").ok && monitor.status().running);
  CHECK(service.configureOutput("out").ok);render(4);
  CHECK(std::abs(left[63]-.000625f)<1e-6 && monitor.status().gainDb==-40); // Quiet before any poll.
  CHECK(monitor.end(13).ok);
  CHECK(monitor.begin("out",0,true,-60,14).gainDb==-60);CHECK(monitor.end(14).ok);
  output->inventory.devices[1].transport=AudioHostTransport::Aggregate;
  output->inventory.devices[1].label="Microphone + Headphones";service.refreshInventory();
  CHECK(monitor.begin("out",0,true,0,15).ok);
  const auto aggregate = monitor.status();CHECK(aggregate.running && aggregate.gainDb==0 && !aggregate.warnings.empty());
  CHECK(std::find(aggregate.warnings.begin(),aggregate.warnings.end(),"route-feedback-risk")==aggregate.warnings.end());
  render(64);CHECK(std::abs(left[63]-.0625f)<1e-5);CHECK(monitor.end(15).ok);
  output->inventory.devices[1].transport=AudioHostTransport::Usb;service.refreshInventory();
  // Orphan reconciliation preserves the independent take owner.
  const auto known=service.inputDevices();AudioInputConfig orphan;orphan.deviceUid="in";
  CHECK(capture.retain(VoiceCaptureUser::Take,orphan,{},&known).ok);
  CHECK(capture.retainExisting(VoiceCaptureUser::Monitor));
  CHECK(!monitor.status().running && capture.users(VoiceCaptureUser::Monitor)==0 && capture.users(VoiceCaptureUser::Take)==1);
  capture.release(VoiceCaptureUser::Take);
  CHECK(monitor.begin("in",0,true,0,10).ok);
  service.clearVoiceMonitorRenderer();
  CHECK(!monitor.status().running && monitor.status().reason=="error" && capture.users(VoiceCaptureUser::Monitor)==0);
  CHECK(monitor.begin("in",0,true,0,11).ok);
  const auto removed=output->inventory.devices[1];
  output->inventory.devices.erase(output->inventory.devices.begin()+1);service.refreshInventory();
  CHECK(service.configureOutput("other").ok);
  CHECK(monitor.status().lost && capture.users(VoiceCaptureUser::Monitor)==0);
  output->inventory.devices.push_back(removed);service.refreshInventory();
  CHECK(!monitor.status().running); // Genuine device removal never auto-restarts on fallback.
  std::puts("common monitor client: ok");
}
