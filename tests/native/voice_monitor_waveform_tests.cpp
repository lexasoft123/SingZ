#include "native/playback/voice_monitor_client.h"
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <string_view>
#include <zcore/routing/audio_resampler.h>
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
void publicationTiming(bool fractional=false,bool excursions=false){
  constexpr uint32_t frames=128, inputLatency=148, outputLatency=28;
  VoiceMonitorSource source;source.prepare(48000,frames,inputLatency);
  CommonVoiceMonitorRender client;client.source=&source;client.target=1;
  client.current=client.destination=1;client.hostPeriod=frames;
  AudioInputRing delivery(4,frames);VoiceMonitorCaptureTap tap{delivery.producer(),&source};
  std::array<float,frames*16> interleaved{};
  std::array<float,frames> input{},left{},right{};float* planes[]{left.data(),right.data()};
  AudioHostRenderBlock b;b.output=planes;b.outputChannels=2;b.frames=b.maximumFrames=frames;
  b.sampleRate=48000;b.outputTimestampValid=true;
  zcore::routing::AudioResampler reference;
  std::array<float,frames> expected{};float* referencePlane[]{expected.data()};
  const auto readSignal=[](const void*,uint64_t frame,std::span<float> samples) noexcept {
    samples[0]=signal(frame,11);return zcore::routing::ResampleFrame{true,1};
  };
  const uint64_t fractionNs=fractional?10416:0; // About half a 48 kHz sample: force FIR support.
  uint64_t next=0,missing=0,steadyMissing=0;uint32_t baselineQueue=0,published=0;
  bool late=false,stall=false,raised=false;
  for(uint64_t wall=0;wall<48000*(excursions?6:4);wall+=frames){
    const uint32_t sustained=excursions && wall>=144000 && wall<168000?128:0;
    // Capture arrives after one whole block and its device latency. Alternating
    // callback order coalesces two 128-frame publications, rather than making
    // the latest samples visible continuously as an ideal-clock test would.
    if((wall/frames)%2==0)while(next+frames+inputLatency+sustained<=wall){
      for(uint32_t i=0;i<frames;++i)for(uint32_t ch=0;ch<16;++ch)interleaved[i*16+ch]=signal(next+i,ch);
      for(uint32_t i=0;i<frames;++i)input[i]=interleaved[i*16+11];
      uint32_t spike=0;
      if(excursions && published<4)spike=20000; // Queued packets at Start are ignored.
      else if(excursions && !late && wall>=96000){spike=2000;late=true;}
      else if(excursions && !stall && wall>=108000){spike=20000;stall=true;}
      CHECK(VoiceMonitorCaptureTap::pushWithPosition(&tap,input.data(),frames,timeOf(next),timeOf(wall+spike),
        AudioInputTimestampQuality::Hardware,{double(next),true}));
      AudioInputBlockView captured;CHECK(delivery.peek(captured,48000));delivery.consume();next+=frames;++published;
    }
    b.outputFrame=wall;b.callbackHostTimeNs=timeOf(wall);
    b.outputHostTimeNs=timeOf(wall+frames+outputLatency+sustained)+fractionNs;
    if(excursions && (wall<4*frames || wall==96000 || wall==108032))
      b.callbackHostTimeNs-=static_cast<uint64_t>((wall==96000?2000:20000)*1e9L/48000);
    left.fill(0);right.fill(0);CommonVoiceMonitorRender::render(&client,b);
    const auto total=source.stats().missingFrames;
    if(wall>=48000){
      steadyMissing+=total-missing;
      CHECK(steadyMissing==0);
      const auto queue=source.queueFloor(48000,frames,client.outputLeadFrames.load());
      CHECK(queue!=0); // A late wake must never turn into route-latency closure.
      if(!baselineQueue)baselineQueue=queue;
      if(excursions && wall>=96000 && wall<144000)CHECK(queue==baselineQueue);
      if(excursions && wall>=151200 && wall<163200){CHECK(queue>baselineQueue);raised=true;}
      if(excursions && wall>=240000)CHECK(queue==baselineQueue);
      const auto target=wall+frames+outputLatency+sustained-queue;
      CHECK(reference.read({target,fractionNs*48000.L/1e9L,48000,48000},
        {{referencePlane,1},frames},frames,readSignal,nullptr)==0);
      for(uint32_t i=0;i<frames;++i){
        CHECK(left[i]==right[i]);
        if(!fractional)CHECK(left[i]==signal(target+i,11));
        else CHECK(std::abs(left[i]-expected[i])<1e-5f);
      }
    }
    missing=total;
  }
  CHECK(steadyMissing==0);
  CHECK(source.stats().droppedFrames==0);
  if(excursions)CHECK(late && stall && raised);
  std::printf("128/128 publication timing (%s): steady missing=%llu, captureAge=%llu, outputLead=%u, queue=%u\n",
    fractional?"fractional":"aligned",(unsigned long long)steadyMissing,
    (unsigned long long)source.stats().maximumCaptureAgeFrames,client.outputLeadFrames.load(),
    source.queueFloor(48000,frames,client.outputLeadFrames.load()));
}
void floorSnapshot(){
  VoiceMonitorSource source;source.prepare(48000,64);
  std::array<float,64> input{},output{};input.fill(.125f);
  uint64_t f=0;
  for(;f<1280;f+=64)CHECK(source.publish(input.data(),64,timeOf(f),AudioInputTimestampQuality::Hardware,
    {double(f),true},timeOf(f+64)));
  const auto preparedFloor=source.queueFloor(48000,64);
  for(;f<1536;f+=64)CHECK(source.publish(input.data(),64,timeOf(f),AudioInputTimestampQuality::Hardware,
    {double(f),true},timeOf(f+384)));
  CHECK(source.queueFloor(48000,64)>preparedFloor);
  AudioHostRenderBlock b;b.frames=b.maximumFrames=64;b.sampleRate=48000;b.outputFrame=1024;
  b.outputTimestampValid=true;b.outputHostTimeNs=timeOf(1024);
  VoiceMonitorReader reader;
  const auto result=source.render(b,output.data(),64,preparedFloor,reader,preparedFloor);
  CHECK(result.missingFrames==0);
  for(auto sample:output)CHECK(sample==.125f);
}
void timingPolicy(){
  VoiceMonitorTimingWindow window;
  uint32_t estimate=0;uint64_t f=0;
  for(;f<4*128;f+=128){
    estimate=window.observe(20000,128,timeOf(f),148);CHECK(estimate==0);
  }
  for(;f<7*128;f+=128)estimate=window.observe(20000,128,timeOf(f),148);
  CHECK(estimate>0 && estimate<=660);
  for(;f<48000*2;f+=128)estimate=window.observe(128,128,timeOf(f),148);
  CHECK(estimate==128);
  window.reset();CHECK(window.observe(20000,128,timeOf(f),148)==0);
}
}
int main(int argc,char** argv){
  if(argc>1 && std::string_view(argv[1])=="publication"){publicationTiming();return 0;}
  if(argc>1 && std::string_view(argv[1])=="excursions"){publicationTiming(false,true);return 0;}
  if(argc>1 && std::string_view(argv[1])=="snapshot"){floorSnapshot();return 0;}
  if(argc>1 && std::string_view(argv[1])=="policy"){timingPolicy();return 0;}
  waveform();clockPrecision();publicationTiming();publicationTiming(true);publicationTiming(false,true);floorSnapshot();timingPolicy();
}
