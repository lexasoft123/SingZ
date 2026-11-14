#ifndef VOICE_MONITOR_CLIENT_HEADER
#define VOICE_MONITOR_CLIENT_HEADER "native/playback/voice_monitor_client.h"
#endif
#include VOICE_MONITOR_CLIENT_HEADER
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
using namespace singz;
#define CHECK(x) do { if (!(x)) { std::fprintf(stderr,"line %d: %s\n",__LINE__,#x); std::exit(1); } } while(0)
constexpr uint64_t origin=10000000000ULL;
uint64_t timeOf(uint64_t frame,double rate){return origin+static_cast<uint64_t>(frame*1e9L/rate);}
void continuity(double nominal,double drift,bool negative=false) {
  VoiceMonitorSource source;source.prepare(48000,64);
  CommonVoiceMonitorRender client;client.source=&source;client.target=1;
  std::array<float,64> input{},left{},right{};input.fill(.125);
  float* planes[]{left.data(),right.data()};
  AudioHostRenderBlock b;b.output=planes;b.outputChannels=2;b.frames=b.maximumFrames=64;
  b.sampleRate=nominal;b.outputTimestampValid=true;
  const double actual=nominal*(1+drift);
  const char* configured=std::getenv("SINGZ_MONITOR_CLOCK_SECONDS");
  const double seconds=configured ? std::strtod(configured,nullptr) : 600;
  CHECK(std::isfinite(seconds) && seconds>=10 && seconds<=600);
  uint64_t nextInput=0,missing=0;
  const uint32_t floor=source.queueFloor(nominal,64);CHECK(floor>=384 && floor<512);
  for(uint64_t frame=0;frame<static_cast<uint64_t>(actual*seconds);frame+=64){
    const auto now=timeOf(frame,actual);
    while(timeOf(nextInput+64,48000)<=now){
      CHECK(source.publish(input.data(),64,timeOf(nextInput,48000),AudioInputTimestampQuality::Hardware,
                           {static_cast<double>(nextInput),true}));nextInput+=64;
    }
    b.outputFrame=frame;
    // Negative control deliberately discards the measured presentation clock.
    b.outputHostTimeNs=negative?timeOf(frame,nominal):now;
    left.fill(0);right.fill(0);CommonVoiceMonitorRender::render(&client,b);
    const auto total=source.stats().missingFrames;
    if(frame>static_cast<uint64_t>(actual*2)){
      CHECK(total==missing); // No missing history after warm-up, for ten minutes.
      for(float sample:left)CHECK(std::abs(sample-.125f)<1e-5);
    }
    missing=total;
  }
  std::printf("%.0f second clock %.0f Hz %+0.3f%%: continuous, floor %u\n",seconds,nominal,drift*100,floor);
}
void pulse(uint32_t period=64){
  VoiceMonitorSource source;source.prepare(48000,64);CommonVoiceMonitorRender client;client.source=&source;client.target=1;
  std::array<float,64> input{},output{};float* planes[]{output.data()};
  AudioHostRenderBlock b;b.output=planes;b.outputChannels=1;b.frames=b.maximumFrames=64;b.sampleRate=48000;b.outputTimestampValid=true;
  uint64_t nextInput=0,heard=0;constexpr uint64_t pulseFrame=48000;
  client.hostPeriod=period;
  const auto floor=source.queueFloor(48000,period);
  for(uint64_t f=0;f<96000;f+=64){
    while(nextInput+64<=f){
      for(unsigned i=0;i<64;++i)input[i]=nextInput+i>=pulseFrame && nextInput+i<pulseFrame+128?.5f:0;
      CHECK(source.publish(input.data(),64,timeOf(nextInput,48000),AudioInputTimestampQuality::Hardware,{double(nextInput),true}));nextInput+=64;
    }
    b.outputFrame=f;b.outputHostTimeNs=timeOf(f,48000);output.fill(0);
    CommonVoiceMonitorRender::render(&client,b);
    for(unsigned i=0;i<64;++i)if(!heard && output[i]>.25f)heard=f+i;
  }
  CHECK(heard && std::abs(double(heard)-double(pulseFrame+floor))<=48);
}
int main(int argc,char**){
  if(argc>1){continuity(48000,.003,true);return 0;}
  pulse(); pulse(512);
  for(double rate:{48000.,44100.})for(double drift:{-.003,.003})continuity(rate,drift);
}
