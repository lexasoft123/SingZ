#include "native/playback/voice_monitor_client.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
using namespace singz;
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr,"FAIL: %s\n",#x); std::exit(1); } } while(0)
namespace {
constexpr uint64_t origin=10000000000ULL;
uint64_t timeOf(uint64_t f){return origin+static_cast<uint64_t>(f*1e9L/48000);}
float signal(uint64_t f,uint32_t ch){
  uint32_t bits=static_cast<uint32_t>(f)*747796405u+ch*2891336453u;
  bits=((bits>>((bits>>28u)+4u))^bits)*277803737u; bits=(bits>>22u)^bits;
  return static_cast<float>(.2*std::sin(f*(2*3.141592653589793*997/48000))+ .1*(double(bits)/UINT32_MAX-.5));
}
void waveform(){
  constexpr uint32_t frames=512,channels=16,selected=11;
  VoiceMonitorSource source;source.prepare(48000,frames);
  CommonVoiceMonitorRender client;client.source=&source;client.target=1;client.current=client.destination=1;client.hostPeriod=frames;
  AudioInputRing delivery(4,frames);VoiceMonitorCaptureTap tap{delivery.producer(),&source};
  std::array<float,frames*channels> interleaved{};std::array<float,frames> mono{};
  std::array<std::array<float,frames>,channels> output{};std::array<float*,channels> planes{};
  for(uint32_t ch=0;ch<channels;++ch)planes[ch]=output[ch].data();
  AudioHostRenderBlock b;b.output=planes.data();b.outputChannels=channels;b.frames=b.maximumFrames=frames;b.sampleRate=48000;b.outputTimestampValid=true;
  const auto delay=source.queueFloor(48000,frames);uint64_t next=0,compared=0,mismatched=0,missing=0;double maximum=0,squares=0;
  for(uint64_t f=0;f<48000*4;f+=frames){
    while(next+frames<=f){
      for(uint32_t i=0;i<frames;++i)for(uint32_t ch=0;ch<channels;++ch)interleaved[i*channels+ch]=signal(next+i,ch);
      // AUHAL's mono Float32 client/channel map supplies this selected channel
      // to BOTH consumers; history never sees an interleaved hardware block.
      for(uint32_t i=0;i<frames;++i)mono[i]=interleaved[i*channels+selected];
      CHECK(VoiceMonitorCaptureTap::pushWithPosition(&tap,mono.data(),frames,timeOf(next),timeOf(next+frames),AudioInputTimestampQuality::Hardware,{double(next),true}));
      AudioInputBlockView captured;CHECK(delivery.peek(captured,48000));
      for(uint32_t i=0;i<frames;++i)CHECK(captured.mono[i]==signal(next+i,selected));
      delivery.consume();next+=frames;
    }
    for(auto& plane:output)plane.fill(0);
    b.outputFrame=f;b.outputHostTimeNs=timeOf(f);CommonVoiceMonitorRender::render(&client,b);
    const auto totalMissing=source.stats().missingFrames;
    if(f>=48000)CHECK(totalMissing==missing);
    missing=totalMissing;
    if(f<48000)continue;
    for(uint32_t i=0;i<frames;++i){
      const auto expected=signal(f+i-delay,selected);const auto error=std::abs(double(output[0][i])-expected);
      maximum=std::max(maximum,error);squares+=error*error;++compared;mismatched+=output[0][i]!=expected;
      CHECK(output[0][i]==output[1][i]);for(uint32_t ch=2;ch<channels;++ch)CHECK(output[ch][i]==0);
    }
  }
  CHECK(mismatched==0);
  CHECK(source.stats().droppedFrames==0);
  CHECK(source.stats().phaseCorrections==0 && source.stats().rejectedIntervals==0);
  std::printf("16ch/512/48k: delay=%u compared=%llu mismatched=%llu maxError=%.9g rmsError=%.9g missing=%llu\n",delay,(unsigned long long)compared,(unsigned long long)mismatched,maximum,std::sqrt(squares/compared),(unsigned long long)source.stats().missingFrames);
}
void clockPrecision(){
  for(double nominal:{44100.,48000.})for(uint32_t period:{32u,64u,512u}){
    VoiceMonitorOutputClock clock;
    for(uint64_t f=0;f<96000;f+=period)
      CHECK(clock.observe(f,origin+static_cast<uint64_t>(f*1e9L/nominal),period,nominal)==nominal);
    for(double drift:{-.003,.003}){
      clock.reset();const double physical=nominal*(1+drift);double measured=0;
      for(uint64_t f=0;f<96000;f+=period)
        measured=clock.observe(f,origin+static_cast<uint64_t>(f*1e9L/physical),period,nominal);
      CHECK(std::abs(measured-physical)<.01); // Real drift must still resample.
    }
  }
}
}
int main(){waveform();clockPrecision();}
