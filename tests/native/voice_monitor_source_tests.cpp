#include "native/playback/voice_monitor_source.h"
#include "native/electron/take_writer.h"
#include "allocation_trap.h"
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <limits>
#include <string>
#include <thread>
#include <vector>

using namespace singz;
#define REQUIRE(x) do { if (!(x)) { std::fprintf(stderr, "FAIL: %s\n", #x); return false; } } while (false)
namespace {
constexpr uint64_t origin = 10000000000ULL;
uint64_t ns(uint64_t frame, double rate = 48000) {
  return origin + static_cast<uint64_t>(static_cast<long double>(frame) * 1e9L / rate);
}
AudioHostRenderBlock block(uint64_t frame, uint32_t frames = 32, double rate = 48000) {
  AudioHostRenderBlock b;
  b.outputFrame = frame; b.frames = frames; b.maximumFrames = frames;
  b.sampleRate = rate; b.outputHostTimeNs = ns(frame, rate);
  b.outputTimestampValid = true; b.outputTimestampHardware = true;
  return b;
}
bool floorTest() {
  const auto floor=voiceMonitorQueueFloor(48000,48000,32,512,192,128);
  REQUIRE(floor==640);
  REQUIRE(voiceMonitorQueueFloor(48000,44100,64,32,192,128)==396);
  REQUIRE(voiceMonitorQueueFloor(48000,48000,32,32,1024)==1024);
  REQUIRE(!voiceMonitorQueueFloor(0,48000,32,512));
  REQUIRE(!voiceMonitorQueueFloor(48000,48000,0,512));
  REQUIRE(!voiceMonitorQueueFloor(48000,48000,32,0));
  REQUIRE(!voiceMonitorQueueFloor(48000,48000,32,512,UINT32_MAX));
  REQUIRE(!voiceMonitorQueueFloor(48000,48000,32,512,0,UINT32_MAX));
  REQUIRE(!voiceMonitorQueueFloor(48000,std::numeric_limits<double>::quiet_NaN(),32,512));
  return true;
}
bool clockTest() {
  for (double drift : {-.003, .003}) {
    VoiceMonitorOutputClock clock;
    const double physical = 48000 * (1 + drift);
    double rate = 0;
    for (uint64_t f = 0; f < 48000ULL * 600; f += 64)
      rate = clock.observe(f, ns(f,physical), 64, 48000);
    REQUIRE(std::abs(rate-physical)<.1);
    REQUIRE(std::abs((physical/rate-1)*600)<.001);
    REQUIRE(clock.observe(0,0,64,48000)==0);
    REQUIRE(clock.observe(0,origin,64,48000)==48000);
    REQUIRE(clock.observe(64,origin-1,64,48000)==48000);
    REQUIRE(clock.observe(UINT64_MAX,origin,64,48000)==0);
  }
  return true;
}
struct TakeReceipt { std::vector<char> bytes; TakeWriteResult result; std::vector<AudioInputBlockView> metadata; };
TakeReceipt take(bool monitoring, const std::filesystem::path& root) {
  TakeWriter writer(256,64);
  writer.start(root.string(), monitoring ? "on" : "off", 48000);
  AudioInputRing delivery(4,64,77,88);
  VoiceMonitorSource source; source.prepare(48000,64);
  VoiceMonitorCaptureTap tap{delivery.producer(), monitoring ? &source : nullptr};
  std::array<float,64> input{};
  TakeReceipt result;
  for (uint64_t f=0; f<8192; f+=64) {
    for (uint32_t i=0; i<64; ++i) input[i]=static_cast<float>((static_cast<int>((f+i)%127)-63)/128.0);
    (void)VoiceMonitorCaptureTap::pushWithPosition(&tap,input.data(),64,ns(f),ns(f+64),
                                                  AudioInputTimestampQuality::Hardware,{static_cast<double>(f)-128,true});
    AudioInputBlockView captured;
    if (!delivery.peek(captured,48000)) break;
    writer.append(captured);
    captured.mono=nullptr; result.metadata.push_back(captured);
    delivery.consume();
  }
  result.result=writer.finish();
  std::ifstream file(result.result.path,std::ios::binary);
  result.bytes.assign(std::istreambuf_iterator<char>(file),{});
  return result;
}
bool takeTest() {
  const auto path=std::filesystem::temp_directory_path()/
      ("singz-monitor-source-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directories(path);
  const auto off=take(false,path), on=take(true,path);
  std::filesystem::remove_all(path);
  REQUIRE(off.bytes==on.bytes);
  REQUIRE(off.bytes.size()==44+8192*2);
  REQUIRE(off.result.error.empty() && on.result.error.empty());
  REQUIRE(off.result.frames==8192 && on.result.frames==8192);
  REQUIRE(off.result.firstSampleHostNs==on.result.firstSampleHostNs && on.result.firstSampleHostNs==origin);
  REQUIRE(on.result.firstSampleQuality==AudioInputTimestampQuality::Hardware);
  REQUIRE(off.result.droppedBlocks==0 && on.result.droppedBlocks==0);
  REQUIRE(off.result.gapPaddedFrames==0 && on.result.gapPaddedFrames==0);
  REQUIRE(off.metadata.size()==on.metadata.size() && on.metadata.size()==128);
  for(size_t i=0;i<on.metadata.size();++i) {
    const auto& a=off.metadata[i]; const auto& b=on.metadata[i];
    REQUIRE(a.sampleHostTimeNs==b.sampleHostTimeNs && a.callbackHostTimeNs==b.callbackHostTimeNs);
    REQUIRE(a.capture.clockDomainId==b.capture.clockDomainId && a.capture.streamGeneration==b.capture.streamGeneration);
    REQUIRE(a.capture.sequence==b.capture.sequence && a.capture.sourceFrame==b.capture.sourceFrame);
    REQUIRE(a.capture.flags==b.capture.flags && a.capture.discontinuity==b.capture.discontinuity);
    REQUIRE(a.sourcePosition.valid && b.sourcePosition.valid && a.sourcePosition.sampleFrame==b.sourcePosition.sampleFrame);
  }
  return true;
}
bool overflowTest() {
  AudioInputRing delivery(2,64);
  VoiceMonitorSource source; source.prepare(48000,64);
  VoiceMonitorCaptureTap tap{delivery.producer(),&source};
  std::array<float,64> input{}; input.fill(.25f);
  zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
  uint64_t accepted=0;
  for (uint64_t i=0;i<5000;++i)
    accepted+=VoiceMonitorCaptureTap::pushWithPosition(&tap,input.data(),64,ns(i*64),ns((i+1)*64),
        AudioInputTimestampQuality::Hardware,{static_cast<double>(i*64),true});
  zdsp::test::setAllocationTrapEnabled(false);
  REQUIRE(accepted==2 && delivery.overruns()==4998);
  REQUIRE(source.stats().publishedBlocks==5000 && source.stats().publishedFrames==5000*64);
  REQUIRE(source.stats().droppedBlocks==0);
  REQUIRE(zdsp::test::trappedAllocationCount()==0);
  AudioInputBlockView b;
  REQUIRE(delivery.peek(b,48000)); REQUIRE(b.mono[0]==.25f && b.sampleHostTimeNs==origin);
  REQUIRE(b.sourcePosition.valid && b.sourcePosition.sampleFrame==0);
  // The same callback still publishes monitor audio when the take queue is full.
  std::array<float,32> out{}; VoiceMonitorReader reader;
  auto output=block(4999*64); auto got=source.render(output,out.data(),32,1024,reader);
  REQUIRE(got.online && got.missingFrames==0);
  REQUIRE(std::abs(out[0]-.25f)<1e-6);
  REQUIRE(!source.publish(nullptr,64,origin,AudioInputTimestampQuality::Hardware));
  REQUIRE(!source.publish(input.data(),16385,origin,AudioInputTimestampQuality::Hardware));
  REQUIRE(source.stats().droppedBlocks==2 && source.stats().droppedFrames==16449);
  return true;
}
bool readTest() {
  VoiceMonitorSource source; source.prepare(48000,512);
  VoiceMonitorReader reader;
  std::array<float,512> input{}, out{}; input.fill(.25f);
  uint64_t nextInput=0,missing=0;
  // Blocks become available only after their entire 512-frame input period.
  // The output and input run without a song or graph dependency.
  for (uint64_t f=0;f<48000;f+=32) {
    while(nextInput+512<=f) {
      REQUIRE(source.publish(input.data(),512,ns(nextInput),AudioInputTimestampQuality::Hardware,
                             {static_cast<double>(nextInput),true})); nextInput+=512;
    }
    auto b=block(f);
    zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
    auto result=source.render(b,out.data(),512,0,reader);
    zdsp::test::setAllocationTrapEnabled(false);
    REQUIRE(zdsp::test::trappedAllocationCount()==0);
    if(f>4096) missing+=result.missingFrames;
  }
  REQUIRE(missing==0);
  // A callback larger than the DSP quantum is split and fully populated.
  auto b=block(47000,512); const auto result=source.render(b,out.data(),512,1536,reader);
  REQUIRE(result.online && result.missingFrames==0);
  for(float value:out) REQUIRE(std::abs(value-.25f)<1e-6);
  source.stop(); b=block(48000,512); out.fill(1);
  const auto before=source.stats().missingFrames;
  REQUIRE(source.render(b,out.data(),512,1024,reader).missingFrames==512);
  REQUIRE(source.stats().missingFrames==before+512);
  for(float value:out) REQUIRE(value==0);
  source.prepare(48000,0);
  REQUIRE(!source.queueFloor(48000,32));
  REQUIRE(source.publish(input.data(),512,origin,AudioInputTimestampQuality::CallbackEstimate));
  REQUIRE(source.inputPeriod()==512 && source.stats().estimatedTimestampBlocks==1);
  return true;
}
bool phaseTest() {
  for(uint32_t period:{32u,64u,128u}) {
    VoiceMonitorSource source; source.prepare(48000,period);
    VoiceMonitorReader reader; std::array<float,128> input{},out{}; input.fill(.2f);
    uint64_t missing=0;
    for(uint64_t f=0;f<8192;f+=period) {
      REQUIRE(source.publish(input.data(),period,ns(f)+(f>=4096?20833:0),AudioInputTimestampQuality::Hardware));
      auto b=block(f,period); const auto result=source.render(b,out.data(),128,1024,reader);
      if(f>2048) missing+=result.missingFrames;
    }
    REQUIRE(missing==0);
  }
  return true;
}
struct FakeState {
  AudioInputPush push{}; AudioInputPositionPush positioned{}; void* context{};
  std::atomic<unsigned> opens{0}, starts{0}, stops{0}, suspends{0};
  std::atomic<bool> fail{false}, prepared{false};
  bool emit(uint64_t frame) {
    std::array<float,64> samples{}; samples.fill(.3f);
    return positioned ? positioned(context,samples.data(),64,ns(frame),ns(frame+64),
                      AudioInputTimestampQuality::Hardware,{static_cast<double>(frame),true}) :
      push(context,samples.data(),64,ns(frame),ns(frame+64),AudioInputTimestampQuality::Hardware);
  }
};
FakeState* fake{};
class FakeBackend final : public AudioInputBackend {
 public:
  explicit FakeBackend(FakeState& state): s(state) {}
  AudioInputResult open(const AudioInputConfig& config,AudioInputPush push,void* context) override {
    ++s.opens; s.push=push; s.context=context; channel=config.channel;
    auto r=AudioInputResult::success(AudioInputState::Starting,48000,channel); r.inputBufferFrames=64; return r;
  }
  void setPositionPush(AudioInputPositionPush push) override { s.positioned=push; }
  AudioInputResult start() override { ++s.starts; return AudioInputResult::success(AudioInputState::Running,48000,channel); }
  void stop() override { ++s.stops; }
  bool suspendPrepared() override { if(s.prepared) { ++s.suspends; return true; } return false; }
  bool takeFailure(std::string& error) override { if(s.fail.load()) { error="fake input lost"; return true; } return false; }
 private: FakeState& s; uint32_t channel{};
};
std::unique_ptr<AudioInputBackend> factory() { return std::make_unique<FakeBackend>(*fake); }
template<class F> bool eventually(F condition) {
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(3);
  while(!condition() && std::chrono::steady_clock::now()<deadline) std::this_thread::yield();
  return condition();
}
bool lifecycleTest() {
  FakeState state; fake=&state; VoiceMonitorCapture capture(factory);
  AudioInputConfig config; config.deviceUid="portable-input";
  std::vector<AudioInputDevice> inventory{{"portable-input","fake",true,48000,1,{}}};
  std::atomic<uint64_t> delivered{0};
  REQUIRE(capture.retain(VoiceCaptureUser::Monitor,config,{},&inventory).ok);
  REQUIRE(capture.retain(VoiceCaptureUser::Arm,config,[&](const AudioInputBlockView& b){delivered+=b.frames;},&inventory).ok);
  REQUIRE(capture.retainExisting(VoiceCaptureUser::Take));
  REQUIRE(capture.retainExisting(VoiceCaptureUser::Monitor));
  REQUIRE(state.opens==1 && state.starts==1);
  REQUIRE(state.emit(0)); REQUIRE(eventually([&]{return delivered==64;}));
  capture.release(VoiceCaptureUser::Arm);
  REQUIRE(capture.state()==AudioInputState::Running && state.stops==0);
  REQUIRE(state.emit(64)); REQUIRE(eventually([&]{return delivered==128;}));
  capture.releasePrepared();
  REQUIRE(state.stops==0);
  capture.release(VoiceCaptureUser::Take); capture.release(VoiceCaptureUser::Monitor);
  REQUIRE(state.stops==0 && capture.users(VoiceCaptureUser::Monitor)==1);
  auto other=config; other.channel=1;
  REQUIRE(!capture.retain(VoiceCaptureUser::Arm,other,{},&inventory).ok);
  capture.setDeliverySink({});
  capture.release(VoiceCaptureUser::Monitor);
  REQUIRE(state.stops==1 && capture.state()==AudioInputState::Stopped);
  REQUIRE(!capture.retainExisting(VoiceCaptureUser::Take));
  REQUIRE(capture.stats().deliveredFrames==128);
  REQUIRE(capture.retain(VoiceCaptureUser::Arm,config,{},&inventory).ok);
  REQUIRE(state.opens==2 && state.starts==2);
  state.prepared=true;
  capture.release(VoiceCaptureUser::Arm,true);
  REQUIRE(state.suspends==1 && state.stops==1);
  REQUIRE(capture.retain(VoiceCaptureUser::Arm,config,{},&inventory).ok);
  REQUIRE(state.opens==2 && state.starts==3);
  capture.release(VoiceCaptureUser::Arm,true);
  REQUIRE(state.suspends==2);
  capture.releasePrepared();
  REQUIRE(state.stops==2);
  REQUIRE(capture.retain(VoiceCaptureUser::Arm,config,{},&inventory).ok);
  REQUIRE(state.opens==3 && state.starts==4);
  state.fail=true;
  REQUIRE(eventually([&]{return capture.state()==AudioInputState::Error;}));
  REQUIRE(capture.lastError()=="fake input lost");
  capture.release(VoiceCaptureUser::Arm);
  return true;
}
bool concurrentTest() {
  VoiceMonitorSource source; source.prepare(48000,64);
  std::atomic<bool> done{false};
  std::thread producer([&]{
    std::array<float,64> in{}; in.fill(.2f);
    for(uint64_t f=0;f<64000;f+=64) source.publish(in.data(),64,ns(f),AudioInputTimestampQuality::Hardware,
                                                 {static_cast<double>(f),true});
    done=true;
  });
  VoiceMonitorReader reader; std::array<float,64> out{};
  for(uint64_t f=1024;f<64000;f+=64) {
    auto b=block(f,64); source.render(b,out.data(),64,1024,reader);
    for(float value:out) {
      if(!std::isfinite(value) || std::abs(value)>.201f) { producer.join(); REQUIRE(false); }
    }
  }
  producer.join(); REQUIRE(done && source.stats().publishedFrames==64000);
  return true;
}
}
int main(int argc,char** argv) {
  if(argc==2) {
    const std::string which=argv[1];
    if(which=="floor") return readTest()?0:1;
    if(which=="delivery") return takeTest()?0:1;
    return 2;
  }
  if(!floorTest() || !clockTest() || !takeTest() || !overflowTest() || !readTest() ||
     !phaseTest() || !lifecycleTest() || !concurrentTest()) return 1;
  std::puts("voice_monitor_source: take identity, floor, clocks, overflow, phase, lifecycle and concurrency passed");
  return 0;
}
