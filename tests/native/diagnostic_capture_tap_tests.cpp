#include <native/playback/diagnostic_capture_tap.h>
#include <array>
#include <filesystem>
#include <fstream>
#include <cstring>
#include <limits>
#include <cstdio>
#include <cstdlib>
#define CHECK(v) do { if(!(v)) { std::fprintf(stderr,"failed line %d: %s\n",__LINE__,#v); std::abort(); } } while(false)
int main(int argc,char** argv) {
  const bool omitSong=argc>1 && std::strcmp(argv[1],"--omit-song-negative-control")==0;
  using namespace singz;
  const auto root=std::filesystem::temp_directory_path()/std::filesystem::path("singz-capture-tap-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directory(root);
  DiagnosticCaptureTap tap;
  int identity=0,other=0;
  for(double seconds:{0.,30.1,std::numeric_limits<double>::quiet_NaN()}) {
    bool rejected=false; try { tap.start(1,seconds,7,&identity,1,root.string()); } catch(...) { rejected=true; }
    CHECK(rejected);
  }
  std::array<float,256> left{},right{};
  left.fill(.125f); right.fill(-.25f);
  std::array<float*,2> output{left.data(),right.data()};
  std::array<const float*,2> input{left.data(),right.data()};
  AudioHostRenderBlock block{}; block.output=output.data(); block.outputChannels=2;
  block.frames=block.maximumFrames=256; block.sampleRate=48000;
  block.outputTimestampValid=true; block.outputHostTimeNs=1234567;
  AudioInputBusBlock bus{}; bus.planes=input.data(); bus.channelCount=2;
  bus.frames=bus.capacityFrames=256; bus.firstNs=7654321;
  tap.start(1,.01,7,&identity,1,root.string(),true);
  block.outputClockMaster=false;
  tap.song(block); // A fallback/non-master block is not the direct song.
  CHECK(tap.status().songFrames==0);
  block.outputClockMaster=true;
  bool busy=false; try { tap.start(2,.01,7,&identity,1,root.string()); } catch(...) { busy=true; } CHECK(busy);
  tap.output(8,block); tap.input(&other,bus,48000);
  CHECK(tap.status().outputFrames==0 && tap.status().inputFrames==0);
  tap.output(7,block); tap.input(&identity,bus,48000); if(!omitSong) tap.song(block);
  CHECK(tap.status().outputFrames==256 && tap.status().inputFrames==256);
  left.fill(.5f); right.fill(.75f);
  tap.output(7,block); tap.input(&identity,bus,48000); if(!omitSong) tap.song(block);
  left.fill(9); right.fill(9); // A borrowed provider buffer cannot be retained.
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(3);
  auto result=tap.status();
  while(result.active && std::chrono::steady_clock::now()<deadline) { std::this_thread::sleep_for(std::chrono::milliseconds(1)); result=tap.status(); }
  CHECK(result.ok && result.complete && !result.active && result.outputFrames==480 && result.inputFrames==480);
  CHECK(result.firstOutputHostNs==1234567 && result.firstInputHostNs==7654321);
  CHECK(result.songFrames==480 && result.firstSongHostNs==1234567);
  const auto verify=[&](const std::string& path,uint32_t channels) {
    std::ifstream file(path,std::ios::binary);
    std::array<char,44> header{}; CHECK(bool(file.read(header.data(),header.size())));
    CHECK(std::memcmp(header.data(),"RIFF",4)==0 && std::memcmp(header.data()+8,"WAVE",4)==0);
    CHECK(uint8_t(header[20])==3 && uint8_t(header[22])==channels);
    CHECK(std::filesystem::file_size(path)==44+480*channels*4);
    for(uint32_t frame=0;frame<480;++frame) for(uint32_t channel=0;channel<channels;++channel) {
      float value=0; CHECK(bool(file.read(reinterpret_cast<char*>(&value),4)));
      const float expected=channels==1 ? (frame<256?-.25f:.75f) : (frame<256?(channel?-.25f:.125f):(channel?.75f:.5f));
      CHECK(value==expected);
    }
  };
  verify(result.outputPath,2); verify(result.inputPath,1); verify(result.songPath,2);
  // Exclusive creation must preserve the earlier recording on an accidental
  // destination reuse, and expose a failed receipt rather than success.
  tap.start(2,.01,7,&identity,1,root.string());
  for(unsigned i=0;i<2;++i) { tap.output(7,block); tap.input(&identity,bus,48000); }
  result=tap.status();
  while(result.active && std::chrono::steady_clock::now()<deadline) { std::this_thread::sleep_for(std::chrono::milliseconds(1)); result=tap.status(); }
  CHECK(result.complete && !result.ok);
  verify((root/"pre-alsa.wav").string(),2);
  // Concurrent callbacks can keep arriving after cancellation. Closed gate
  // admission prevents any access while the next job replaces its storage.
  const auto next=root/"cancel"; std::filesystem::create_directory(next);
  tap.start(3,30,7,&identity,1,next.string());
  std::atomic<bool> stop{false};
  std::thread outputThread([&] { while(!stop.load()) tap.output(7,block); });
  std::thread inputThread([&] { while(!stop.load()) tap.input(&identity,bus,48000); });
  tap.cancel(); stop.store(true); outputThread.join(); inputThread.join();
  CHECK(tap.status().complete && !tap.status().ok);
  CHECK(!std::filesystem::exists(next/"pre-alsa.wav"));
  std::filesystem::remove_all(root);
  std::puts("Diagnostic tap: bounds, identity, float WAV fidelity, ownership, exclusivity, and concurrent cancellation passed");
}
