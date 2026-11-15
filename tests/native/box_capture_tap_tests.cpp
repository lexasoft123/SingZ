#include <native/playback/box_routing_owner.h>
#include <native/playback/box_input_queue.h>
#include <native/playback/loopz_source_backend.h>
#include <loopz/document_json.hpp>
#include <array>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <cstdio>
#include <cstdlib>
#include <memory>
#include <thread>
#include <unistd.h>
#define CHECK(v) do { if(!(v)) { std::fprintf(stderr,"failed %d: %s\n",__LINE__,#v); std::abort(); } } while(false)
namespace {
using namespace singz;
uint64_t nowNs() { return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
struct Device {
  AudioHostRender render{}; void* renderContext{};
  AudioInputBusPush push{}; void* pushContext{};
  bool outputRunning=false,inputRunning=false;
  unsigned inputOpens=0;
  uint64_t frame=0;
};
class Output final:public AudioHostBackend {
  std::shared_ptr<Device> device_;
  bool opened_=false;
  AudioHostState state_=AudioHostState::Stopped;
public:
  explicit Output(std::shared_ptr<Device> device):device_(std::move(device)) {}
  AudioHostInventory enumerate() const override {
    AudioHostDeviceInfo input; input.uid="test:input"; input.label="Synthetic input";
    input.inputChannels=2; input.direction=AudioHostEndpointDirection::Input; input.nominalSampleRate=48000;
    AudioHostDeviceInfo output; output.uid="test:output"; output.label="Synthetic output";
    output.outputChannels=2; output.direction=AudioHostEndpointDirection::Output; output.nominalSampleRate=48000;
    return {{input,output},input.uid,output.uid};
  }
  AudioHostResult open(const AudioHostConfig&,AudioHostRender render,void* context) override {
    opened_=true;state_=AudioHostState::Open;device_->render=render;device_->renderContext=context;
    return {true,AudioHostError::None,AudioHostState::Open,{48000,256,256,0,2},{}};
  }
  AudioHostResult start() override { state_=AudioHostState::Running;device_->outputRunning=true;return {true,AudioHostError::None,AudioHostState::Running,{48000,256,256,0,2},{}}; }
  void stop() noexcept override { if(opened_) { opened_=false;state_=AudioHostState::Stopped;device_->outputRunning=false; } }
  AudioHostStatus status() const noexcept override {
    AudioHostStatus result;result.state=state_;
    result.format={48000,256,256,0,2};result.latency.bufferFrames=256;result.routeGeneration=result.streamGeneration=1;return result;
  }
};
class Input final:public AudioInputBackend {
  std::shared_ptr<Device> device_;
public:
  explicit Input(std::shared_ptr<Device> device):device_(std::move(device)) {}
  AudioInputResult open(const AudioInputConfig&,AudioInputPush,void*) override { return {}; }
  AudioInputBusResult openBus(const AudioInputBusConfig& config,AudioInputBusPush push,void* context) override {
    CHECK(config.deviceUid=="test:input" && config.channels.size()==2);
    ++device_->inputOpens; device_->push=push;device_->pushContext=context;
    return {AudioInputBusOpenStatus::Ready,AudioInputResult::success(AudioInputState::Starting,48000,0)};
  }
  AudioInputResult start() override { device_->inputRunning=true;return AudioInputResult::success(AudioInputState::Running,48000,0); }
  void stop() override { device_->inputRunning=false; }
  bool takeFailure(std::string&) override { return false; }
};
void drive(const std::shared_ptr<Device>& device) {
  const auto stamp=nowNs();
  std::array<float,256> left{},right{};left.fill(.25f);right.fill(-.5f);
  const std::array<const float*,2> input{left.data(),right.data()};
  if(device->inputRunning) {
    AudioInputBusBlock block{input.data(),2,256,256,stamp,stamp,AudioInputTimestampQuality::CallbackEstimate};
    CHECK(device->push(device->pushContext,block));
  }
  std::array<float*,2> output{left.data(),right.data()};
  AudioHostRenderBlock block{};block.output=output.data();block.outputChannels=2;
  block.frames=block.maximumFrames=256;block.sampleRate=48000;
  block.outputFrame=device->frame;block.callbackHostTimeNs=stamp;
  block.outputHostTimeNs=stamp;block.outputTimestampValid=true;
  block.clockDomain=block.routeGeneration=block.streamGeneration=1;
  CHECK(device->outputRunning && device->render(device->renderContext,block));
  device->frame+=256;
  pollBoxRouting();
}
}
int main() {
  using namespace singz;
  auto temporary=(std::filesystem::temp_directory_path()/"singz-box-tap-XXXXXX").string();
  CHECK(::mkdtemp(temporary.data())!=nullptr);
  const std::filesystem::path root=temporary;
  std::filesystem::permissions(root,std::filesystem::perms::owner_all);
  loopz::VirtualDeviceDefinition bus;bus.id="song";bus.name="Song";
  loopz::SourceRouting source;source.id="native";source.channels=2;source.connections={{0,0,1},{1,1,1}};
  bus.routing.sources.push_back(source);bus.bindings.push_back({"native",loopz::SourceKind::Application,"native:singz",true});
  loopz::MonitorDefinition monitor;monitor.id="speaker";monitor.deviceSelector="test:output";monitor.connections={{0,0,1},{1,1,1}};bus.monitors.push_back(monitor);
  loopz::RouteDocument document;document.devices.push_back(bus);
  std::ofstream(root/"routing.json")<<loopz::JSON{{"version",1},{"generation","1"},{"document",loopz::encodeDocument(document)}};
  auto sourceHistory=std::make_shared<LoopZSongSource>();
  std::array<float,32768> pcm{};pcm.fill(.125f);const std::array<const float*,2> planes{pcm.data(),pcm.data()};
  CHECK(sourceHistory->history->append({planes,32768},32768,nowNs()-200000000,48000,0,true));
  auto device=std::make_shared<Device>();std::string error;
  CHECK(initializeBoxRoutingWithHost((root/"routing.json").string(),error,
    [device] { return std::make_unique<Output>(device); },sourceHistory,
    [device] { return std::make_unique<Input>(device); }));
  // An existing private analysis reader keeps its lease while diagnostics
  // mirror the raw callback; recording must not steal the queue reader.
  auto analysis=acquireBoxInputTap("test:input",1);
  CHECK(device->inputOpens==1 && device->inputRunning);
  const auto directory=root/"capture";std::filesystem::create_directory(directory);
  std::filesystem::permissions(directory,std::filesystem::perms::owner_all);
  const auto request=loopz::JSON{{"seconds",.01},{"input",{{"uid","test:input"},{"channel",1}}},{"directory",directory.string()}};
  bool started=false;
  for(unsigned attempt=0;attempt<80 && !started;++attempt) {
    if(!device->outputRunning) std::fprintf(stderr,"inactive: %s\n",boxRoutingRequest(R"({"version":1,"operation":"state"})").c_str());
    drive(device);
    try { (void)boxCaptureTapStart(request.dump());started=true; }
    catch(const std::exception& exception) { CHECK(std::string(exception.what()).find("primary output")!=std::string::npos); }
    if(!started) std::this_thread::sleep_for(std::chrono::milliseconds(3));
  }
  CHECK(started && device->inputOpens==1);
  bool busy=false;try { (void)boxCaptureTapStart(request.dump()); } catch(...) { busy=true; } CHECK(busy);
  loopz::JSON result;
  for(unsigned attempt=0;attempt<200;++attempt) {
    drive(device);
    result=loopz::parseControlJSON(boxCaptureTapStatus());
    if(result.at("complete")==true) break;
    std::this_thread::sleep_for(std::chrono::milliseconds(3));
  }
  CHECK(result.at("ok")==true && result.at("complete")==true);
  CHECK(result.at("outputFrames")=="480" && result.at("inputFrames")=="480");
  CHECK(std::filesystem::file_size(directory/"pre-alsa.wav")==44+480*2*4);
  std::ifstream recorded(directory/"capture-input.wav",std::ios::binary);recorded.seekg(44);
  for(unsigned frame=0;frame<480;++frame) { float sample=0;recorded.read(reinterpret_cast<char*>(&sample),4);CHECK(recorded.good() && sample==-.5f); }
  CHECK(device->inputRunning && device->inputOpens==1 && !analysis.native->acquireReader());
  analysis.native->releaseReader();releaseBoxInputTap(analysis.id);
  CHECK(!device->inputRunning && device->outputRunning);
  shutdownBoxRouting();CHECK(!device->outputRunning);
  std::filesystem::remove_all(root);
  std::puts("Box capture command: real owner hooks, chosen raw channel, WAVs, busy guard and existing analysis lease passed");
}
