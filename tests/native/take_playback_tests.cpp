#include "native/playback/training_pcm_mixer.h"
#include <cassert>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <cstring>
#include "allocation_trap.h"

using namespace singz;
namespace {
constexpr uint32_t rate = 8000, count = 128;
constexpr uint64_t origin = 1000000000;
int16_t pcm(uint64_t frame) { return static_cast<int16_t>(int(frame % 16384) - 8192); }
float expected(uint64_t frame) { return pcm(frame) / 32768.0F * 0.5F; }
void put32(unsigned char* p, uint32_t v) { for (int i=0;i<4;++i) p[i] = (v >> (8*i)) & 255; }
void wav(const std::filesystem::path& path, uint64_t frames, bool unpatched = false) {
  std::ofstream f(path, std::ios::binary);
  unsigned char h[44]{};
  std::memcpy(h,"RIFF",4); put32(h+4,unpatched ? 36 : uint32_t(frames*2+36));
  std::memcpy(h+8,"WAVEfmt ",8); put32(h+16,16); h[20]=1; h[22]=1;
  put32(h+24,rate); put32(h+28,rate*2); h[32]=2; h[34]=16;
  std::memcpy(h+36,"data",4); put32(h+40,unpatched ? 0 : uint32_t(frames*2));
  f.write(reinterpret_cast<char*>(h),sizeof(h));
  for(uint64_t i=0;i<frames;++i) {
    const auto v=static_cast<uint16_t>(pcm(i));
    char b[]{static_cast<char>(v & 255),static_cast<char>(v >> 8)}; f.write(b,2);
  }
  assert(f.good());
}
struct Transport {
  PlaybackPresentationHistory history;
  uint64_t tick=0, seeks=0, generation=1;
  PlaybackPresentationQuery at(double frame, double tempo=1, bool paused=false) {
    PlaybackPresentationEntry e;
    e.hostTimeNs=origin+tick*count*125000;
    e.frames=count; e.sampleRate=rate; e.projectFrame=frame;
    e.rate=paused ? 0 : tempo; e.paused=paused;
    e.generation=generation; e.continuousFrame=tick*count; e.seekCount=seeks;
    ++tick;
    assert(history.append(e)); return history.query(e.hostTimeNs);
  }
};
struct Output {
  float samples[count]{}; float* planes[1]{samples}; AudioHostRenderBlock block;
  Output() { block.output=planes; block.outputChannels=1; block.frames=count; block.sampleRate=rate; block.callbackHostTimeNs=origin; }
  void render(TrainingPcmMixer& m, const PlaybackPresentationQuery& q = {}) {
    std::fill_n(samples,count,0);
    zdsp::test::resetAllocationTrap();
    zdsp::test::setAllocationTrapEnabled(true);
    m.render(block,q);
    zdsp::test::setAllocationTrapEnabled(false);
    assert(zdsp::test::trappedAllocationCount()==0);
    block.callbackHostTimeNs+=count*125000;
  }
  void matches(uint64_t first) { for(uint32_t i=64;i<count;++i) assert(std::abs(samples[i]-expected(first+i))<1.e-7F); }
  bool silent() const { for(float v:samples) if(v!=0) return false; return true; }
};
bool seekCase(const std::string& path, bool hostOnly) {
  TrainingPcmMixer m; Output o; Transport t;
  if(hostOnly) {
    std::vector<float> p(16000); for(size_t i=0;i<p.size();++i)p[i]=pcm(i)/32768.0F;
    assert(m.schedule({p},1,rate,origin,0.5F));
  } else assert(m.scheduleTake(path,1,0,true,origin,0.5F));
  o.render(m,t.at(0));
  ++t.seeks; o.render(m,t.at(4096));
  return std::abs(o.samples[64]-expected(4160))<1.e-7F;
}
}
int main(int argc,char** argv) {
  const auto dir=std::filesystem::temp_directory_path()/
      ("singz-take-playback-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directory(dir);
  const auto shortPath=(dir/"short.wav").string(); wav(shortPath,16000);
  if(argc>1 && std::string(argv[1])=="--host-time-only-negative-control") {
    const bool aligned=seekCase(shortPath,true); std::filesystem::remove_all(dir);
    std::cerr<<"Host-time-only seek alignment: "<<(aligned?"unexpected pass":"FAILED as expected")<<"\n";
    return aligned ? 0 : 1;
  }
  assert(seekCase(shortPath,false));
  assert(!seekCase(shortPath,true)); // Old host-time-only behavior misses seek.
  {
    TrainingPcmMixer m; Output o; Transport t;
    assert(m.scheduleTake(shortPath,1,0,true,origin,0.5F));
    o.render(m,t.at(0)); o.matches(0);
    o.render(m,t.at(128,1,true)); assert(o.silent());
    o.render(m,t.at(128,1,true)); assert(o.silent());
    o.render(m,t.at(128)); o.matches(128); // Pause did not consume samples.
    ++t.generation; // Tempo graph seam preserves the uninterrupted PCM cursor.
    o.render(m,t.at(256,2)); o.matches(256);
    o.render(m,t.at(512,2)); o.matches(384); // Real time, not project rate 2.
    ++t.seeks; o.render(m,t.at(1024,0.5)); o.matches(1024);
    o.render(m,t.at(1088,0.5)); o.matches(1152); // Still rate 1 after seek.
    // A missing/stopped/unloaded song silences the take, then re-anchors.
    o.render(m); assert(o.silent());
    o.render(m,t.at(2048)); o.matches(2048);
    m.cancel(1); // Training cancellation cannot cancel a take with the same id.
    o.render(m,t.at(2176)); o.matches(2176);
    m.cancelTakes(1); o.render(m,t.at(2304));
    assert(o.samples[0]!=0 && o.samples[40]==0);
    o.render(m,t.at(2432)); assert(o.silent());
  }
  {
    TrainingPcmMixer m; Output o; Transport t;
    assert(m.scheduleTake(shortPath,2,1,true,origin,0.5F,0.5));
    o.render(m,t.at(0,0.5)); assert(o.silent());
    ++t.seeks; o.render(m,t.at(8000+512,0.5)); o.matches(1024);
    // Recorded tempo locates the seek; later song tempo does not stretch it.
    o.render(m,t.at(8576,2)); o.matches(1152);
  }
  {
    TrainingPcmMixer m; Output o; Transport t;
    assert(m.scheduleTake(shortPath,3,64.0/rate,true,origin,0.5F));
    o.render(m,t.at(0));
    for(int i=0;i<64;++i) assert(o.samples[i]==0);
    assert(std::abs(o.samples[127]-expected(63))<1.e-7F); // Interior onset.
  }
  {
    TrainingPcmMixer m; Output o;
    // No song query and no input block/device: immediate host-time mode.
    assert(m.scheduleTake(shortPath,4,123,false,0,0.5F));
    o.block.callbackHostTimeNs+=1000000000; // Preload delay must not skip onset.
    o.render(m); o.matches(0);
    o.block.callbackHostTimeNs+=1000000000; // Scheduling jitter cannot skip PCM.
    o.render(m); o.matches(128);
  }
  {
    // Input/output clocks may have different sample rates. Interpolation is
    // the sole rate conversion; the song's tempo never enters its step.
    TrainingPcmMixer m; Output o; o.block.sampleRate=16000;
    PlaybackPresentationQuery q; q.found=true; q.sampleRate=16000; q.rate=2;
    assert(m.scheduleTake(shortPath,6,0,true,origin,0.5F));
    o.render(m,q);
    for(uint32_t i=96;i<count;++i) {
      const double frame=i*0.5;
      const auto index=static_cast<uint64_t>(frame);
      const float value=expected(index)+(expected(index+1)-expected(index))*float(frame-index);
      assert(std::abs(o.samples[i]-value)<1.e-7F);
    }
    q.projectFrame=512; ++q.discontinuitySerial;
    o.render(m,q);
    assert(std::abs(o.samples[96]-expected(256+48))<1.e-7F);
  }
  const auto longPath=(dir/"long-unpatched.wav").string(); wav(longPath,rate*121,true);
  {
    TrainingPcmMixer m; Output o; Transport t;
    assert(m.scheduleTake(longPath,5,0,true,origin,0.5F));
    ++t.seeks;
    bool played=false;
    for(int attempt=0;attempt<1000 && !played;++attempt) {
      ++t.seeks; o.render(m,t.at(rate*120));
      if(o.samples[64]!=0) { o.matches(rate*120); played=true; }
      else std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    assert(played); // Streamed beyond 120 seconds; header length is still zero.
    // Missing distant data yields silence, never stale window contents.
    ++t.seeks; o.render(m,t.at(0));
    if(!o.silent()) o.matches(0);
    m.cancelTakes(); o.render(m,t.at(128)); o.render(m,t.at(256));
    assert(o.silent());
  }
  {
    TrainingPcmMixer m;
    assert(!m.scheduleTake(shortPath,0,0,false,origin));
    assert(!m.scheduleTake(shortPath,1,0,false,origin,1,0));
    assert(!m.scheduleTake((dir/"absent.wav").string(),1,0,false,origin));
    // Every take consumes a bounded 1.5MiB, independently of WAV length.
    for(uint64_t i=1;i<=32;++i) assert(m.scheduleTake(longPath,i,0,false,origin));
    assert(!m.scheduleTake(longPath,33,0,false,origin));
    assert(!m.canSchedule(4500000,1)); // 48MiB streams +18MiB cue exceeds64MiB.
    m.clearQuiesced(); assert(m.canSchedule(4500000,1));
  }
  {
    // A sparse synthetic WAV larger than the entire PCM budget. Only fixed
    // windows are resident; a distant seek must fetch the actual tail samples.
    const auto hugePath=dir/"over-budget.wav";
    wav(hugePath,1,true);
    constexpr uint64_t hugeFrames=40ULL*1024*1024, tail=hugeFrames-256;
    std::filesystem::resize_file(hugePath,44+hugeFrames*2);
    std::fstream f(hugePath,std::ios::in|std::ios::out|std::ios::binary);
    f.seekp(44+tail*2);
    for(uint64_t i=tail;i<hugeFrames;++i) {
      const auto v=static_cast<uint16_t>(pcm(i));
      char b[]{static_cast<char>(v & 255),static_cast<char>(v >> 8)}; f.write(b,2);
    }
    f.close();
    TrainingPcmMixer m; Output o; Transport t;
    assert(m.scheduleTake(hugePath.string(),40,0,true,origin,0.5F));
    bool played=false;
    for(int attempt=0;attempt<1000 && !played;++attempt) {
      ++t.seeks; o.render(m,t.at(tail));
      if(o.samples[64]!=0) { o.matches(tail); played=true; }
      else std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    assert(played);
    m.clearQuiesced();
  }
  // Validate that the allocation trap itself rejects a deliberate allocation.
  zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
  void* negative=::operator new(16);
  zdsp::test::setAllocationTrapEnabled(false);
  ::operator delete(negative);
  assert(zdsp::test::trappedAllocationCount()>0);
  std::filesystem::remove_all(dir);
  std::cout<<"take playback: seek, pause/resume, tempo, standalone, long WAV, bounded storage and negative control passed\n";
}
