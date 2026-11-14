#include "take_conform_fixture.h"
#include "take_conform_stream_tests.h"
#include "take_conform_seam_tests.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#if defined(__unix__) || defined(__APPLE__)
#include <sys/resource.h>
#endif
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace singz;
namespace {
void check(bool value, const char *message) { if (!value) throw std::runtime_error(message); }
constexpr uint32_t rate = 48000;
TakeConformRequest request(size_t frames, double ratio = 1) {
  return {{{0,0},{frames,frames*ratio}},{{0,0}},{{"pitch-follow",true,0,false}},rate*600,0,0,rate};
}
TakeConformPcm tone(double seconds, double hz = 440) {
  TakeConformPcm p{rate,std::vector<int16_t>(static_cast<size_t>(rate*seconds))};
  for (size_t i=0;i<p.samples.size();++i) p.samples[i]=static_cast<int16_t>(10000*std::sin(i*hz*2*3.141592653589793/rate));
  return p;
}
double frequency(const TakeConformPcm &p) {
  size_t start = p.samples.size()/4, end = p.samples.size()*3/4;
  std::vector<double> crossings;
  for (size_t i=start+1;i<end;++i) if (p.samples[i-1] <= 0 && p.samples[i] > 0)
    crossings.push_back(i-1 + double(-p.samples[i-1])/(p.samples[i]-p.samples[i-1]));
  check(crossings.size()>10,"Tone missing");
  return p.sampleRate*(crossings.size()-1)/(crossings.back()-crossings.front());
}
// Reused by the positive suite and by exactly one targeted mutant run.
// The latter has no golden-byte check to mask the behaviour discriminator.
void driftRegression() {
  {
    auto clean=tone(60);auto jitter=request(clean.samples.size());jitter.anchors.clear();
    jitter.anchors.push_back({0,0});
    for(uint64_t f=rate*2;f<clean.samples.size();f+=rate*2)
      jitter.anchors.push_back({f,double(f)+((f/(rate*2))%2?1:-1)});
    jitter.anchors.push_back({clean.samples.size(),double(clean.samples.size())});
    auto drifted=conformTakePcm(clean,jitter);
    check(drifted.signalsmithPasses==0 && drifted.processedBlocks==0,"Jittered tempo-one take must never enter Signalsmith");
    check(drifted.pcm.samples.size()==clean.samples.size(),"Jitter must not accumulate duration error");
    check(std::abs(1200*std::log2(frequency(drifted.pcm)/440))<0.5,"Direct drift resampling must keep near-identity pitch");
  }
}
void placementRegression() {
  auto p=tone(2);auto r=request(p.samples.size());TakeConformResult x;
  r.startPositionSec=0.125; r.userOffsetSec=0.125;
  x=conformTakePcm(p,r);
  check(x.pcm.samples.size()==p.samples.size()+12000,"Placement length");
  check(std::all_of(x.pcm.samples.begin(),x.pcm.samples.begin()+12000,[](auto v){return v==0;}),"Leading silence");
  check(std::equal(p.samples.begin(),p.samples.end(),x.pcm.samples.begin()+12000),"Sample accurate placement");
  r.startPositionSec=-0.25;r.userOffsetSec=0;r.songDurationProjectFrames=rate;
  x=conformTakePcm(p,r);
  check(x.pcm.samples.size()==rate && std::equal(x.pcm.samples.begin(),x.pcm.samples.end(),p.samples.begin()+12000),"Negative head and tail trim");
}
void ratioRegression() {
  auto p=tone(2);TakeConformRequest r;TakeConformResult x;
  r=request(p.samples.size(),0.5);
  x=conformTakePcm(p,r);
  check(x.pcm.samples.size()==p.samples.size()/2,"Half-tempo length");
  check(std::abs(1200*std::log2(frequency(x.pcm)/440))<5,"Stretch must preserve pitch");
  // Length and steady-tone pitch alone cannot distinguish compression from
  // truncating a tempo-one render: its transient must follow the anchor map.
  p={rate,std::vector<int16_t>(rate*2)};p.samples[rate*3/4]=30000;
  r=request(p.samples.size(),0.5);x=conformTakePcm(p,r);
  const auto peak=std::max_element(x.pcm.samples.begin(),x.pcm.samples.end(),[](auto a,auto b){return std::abs(a)<std::abs(b);});
  check(x.signalsmithPasses==1 && std::abs(*peak)>1000 &&
    std::abs(double(peak-x.pcm.samples.begin())-rate*3.0/8)<=48,"Half-tempo anchor mapping exceeds 1 ms");
}
void latencyRegression() {
  TakeConformPcm p;TakeConformRequest r;TakeConformResult x;
  p={rate,std::vector<int16_t>(rate*3)};p.samples[rate]=30000;p.samples[rate+1]=15000;
  r=request(p.samples.size(),1.5);x=conformTakePcm(p,r);
  const auto measuredPeak=std::max_element(x.pcm.samples.begin(),x.pcm.samples.end(),[](auto a,auto b){return std::abs(a)<std::abs(b);})-x.pcm.samples.begin();
  const double latencyError=std::abs(double(measuredPeak)-rate*1.5);
  check(latencyError<=48,"Measured DSP latency alignment exceeds 1 ms");
  std::cout<<"measured DSP alignment "<<latencyError<<" frames ("<<latencyError/rate*1000<<" ms)\n";
}
void tests() {
  seam_tests::bursts();
  auto p=tone(2); auto r=request(p.samples.size());
  auto x=conformTakePcm(p,r);
  check(x.pcm.samples==p.samples,"Identity must be sample equal");
  r.settings.push_back({p.samples.size(),2});
  x=conformTakePcm(p,r);
  check(x.signalsmithPasses==0 && x.pcm.samples==p.samples,"Terminal key stamp must not vocode an identity take");
  r=request(p.samples.size());
  driftRegression();
  placementRegression();
  ratioRegression();
  auto pitched=tone(3,440*std::pow(2,2.0/12));r=request(pitched.samples.size(),0.5);r.settings[0].transposeSemitones=2;
  x=conformTakePcm(pitched,r);
  const double cents=1200*std::log2(frequency(x.pcm)/440);
  std::cout<<"compensated tone error "<<cents<<" cents\n";
  check(std::abs(cents)<5,"Recorded transpose compensation");
  r.effects[0].enabled=false;x=conformTakePcm(pitched,r);
  check(std::abs(1200*std::log2(frequency(x.pcm)/(440*std::pow(2,2.0/12))))<5,"Pitch follow bypass");
  r.effects[0].enabled=true;r.effects[0].manualOffsetSemitones=3;x=conformTakePcm(pitched,r);
  check(std::abs(1200*std::log2(frequency(x.pcm)/(440*std::pow(2,3.0/12))))<5,"Pitch follow manual offset");
  r.effects[0].preserveFormants=true;
  auto preserved=conformTakePcm(pitched,r);
  check(preserved.pcm.samples!=x.pcm.samples,"Supported formant compensation must configure shifter");
  check(std::abs(1200*std::log2(frequency(preserved.pcm)/(440*std::pow(2,3.0/12))))<5,"Formant preservation keeps target pitch");
  check(conformTakePcm(pitched,r).pcm.samples==preserved.pcm.samples,"Determinism");
  p=tone(2);r=request(p.samples.size());r.outputRate=44100;r.startPositionSec=0.25;
  x=conformTakePcm(p,r);
  check(x.pcm.samples.size()==99225,"Output-rate project duration and placement");
  check(std::all_of(x.pcm.samples.begin(),x.pcm.samples.begin()+11025,[](auto v){return v==0;}),"Output-rate leading silence");
  check(std::abs(1200*std::log2(frequency(x.pcm)/440))<5,"Output-rate pitch");
  const auto path=(std::filesystem::temp_directory_path()/("singz-conform-"+std::to_string(std::chrono::steady_clock::now().time_since_epoch().count())+".wav")).string();
  writeTakeConformWav(path,x.pcm);auto roundtrip=readTakeConformWav(path);std::filesystem::remove(path);
  check(roundtrip.sampleRate==44100 && roundtrip.samples==x.pcm.samples,"PCM16 WAV roundtrip");
  p=tone(1);r=request(p.samples.size());r.outputRate=47999;x=conformTakePcm(p,r);
  p={11025,std::vector<int16_t>(11025)};for(size_t i=0;i<p.samples.size();++i)p.samples[i]=static_cast<int16_t>(10000*std::sin(i*440*2*3.141592653589793/11025));
  r=request(p.samples.size());r.outputRate=192000;x=conformTakePcm(p,r);
  p={192000,std::vector<int16_t>(192000)};for(size_t i=0;i<p.samples.size();++i)p.samples[i]=static_cast<int16_t>(10000*std::sin(i*440*2*3.141592653589793/192000));
  r=request(p.samples.size(),0.75);r.settings[0].transposeSemitones=2;x=conformTakePcm(p,r);
  check(x.signalsmithPasses==1,"Maximum-rate fixture must traverse streaming DSP");
  p=tone(2,12000);r=request(p.samples.size());r.outputRate=8000;x=conformTakePcm(p,r);
  double energy=0;for(size_t i=1000;i+1000<x.pcm.samples.size();++i)energy+=double(x.pcm.samples[i])*x.pcm.samples[i];
  check(std::sqrt(energy/(x.pcm.samples.size()-2000))<30,"Output downsampling must reject aliased tone");
  // Missing latency compensation shifts a gated tone by >100 ms.
  p=tone(3);std::fill(p.samples.begin(),p.samples.begin()+rate,0);r=request(p.samples.size(),1.5);x=conformTakePcm(p,r);
  auto gate=std::find_if(x.pcm.samples.begin(),x.pcm.samples.end(),[](auto v){return std::abs(v)>3000;})-x.pcm.samples.begin();
  check(std::abs(double(gate)-rate*1.5)<rate*0.04,"Algorithmic latency compensation");
  // This pulse, and the three-segment click train below, use the real DSP path.
  latencyRegression();
  p={rate,std::vector<int16_t>(rate*6)};
  for(auto f:{12000,36000,60000,84000,108000,132000,156000,180000,204000,228000,252000,276000})p.samples[f]=30000;
  r=request(p.samples.size());r.anchors={{0,0},{rate*2,rate},{rate*4,rate*4},{rate*6,rate*6}};
  x=conformTakePcm(p,r);
  check(x.signalsmithPasses==1 && x.processedBlocks>0,"Three-segment clicks must traverse one Signalsmith instance");
  double worst=0;
  for(auto f:{12000,36000,60000,84000,108000,132000,156000,180000,204000,228000,252000,276000}){
    const int target=f<96000?f/2:f<192000?48000+(f-96000)*3/2:192000+(f-192000);
    const int lo=std::max(0,target-4800),hi=std::min(int(x.pcm.samples.size()),target+4800);
    auto peak=std::max_element(x.pcm.samples.begin()+lo,x.pcm.samples.begin()+hi,[](auto a,auto b){return std::abs(a)<std::abs(b);});
    const double error=std::abs(double(peak-x.pcm.samples.begin())-target);
    worst=std::max(worst,error);check(std::abs(*peak)>1000 && error<=48,"Piecewise impulse alignment exceeds 1 ms");
  }
  for(const int frame:{95999,96000,96001,191999,192000,192001}) {
    TakeConformPcm seamPulse{rate,std::vector<int16_t>(rate*6)};seamPulse.samples[frame]=30000;
    auto curve=request(seamPulse.samples.size());curve.anchors={{0,0},{rate*2,rate},{rate*4,rate*4},{rate*6,rate*6}};
    const auto rendered=conformTakePcm(seamPulse,curve);
    const int target=static_cast<int>(std::llround(frame<96000?frame*0.5:frame<192000?48000+(frame-96000)*1.5:192000+(frame-192000)));
    const auto peak=std::max_element(rendered.pcm.samples.begin()+target-4800,rendered.pcm.samples.begin()+target+4800,
      [](auto a,auto b){return std::abs(a)<std::abs(b);});
    const double error=std::abs(double(peak-rendered.pcm.samples.begin())-target);worst=std::max(worst,error);
    check(rendered.signalsmithPasses==1 && std::abs(*peak)>1000 && error<=48,"Pulse at tempo seam must pass DSP within 1 ms");
  }
  p={rate,std::vector<int16_t>(rate*2)};p.samples[24000]=100;r=request(p.samples.size(),0.5);x=conformTakePcm(p,r);
  auto quiet=std::max_element(x.pcm.samples.begin(),x.pcm.samples.end(),[](auto a,auto b){return std::abs(a)<std::abs(b);});
  std::cout<<"quiet DSP peak "<<(quiet-x.pcm.samples.begin())<<" amplitude "<<*quiet<<"\n";
  check(x.signalsmithPasses==1 && std::abs(quiet-x.pcm.samples.begin()-12000)<=48 && std::abs(*quiet)>10,"Quiet impulse must traverse DSP and stay anchored");
  std::cout<<"latency "<<x.inputLatencyFrames<<"+"<<x.outputLatencyFrames<<" input/output frames; click error "<<worst<<" frames\n";
  p=tone(6);r=request(p.samples.size(),0.75);
  const auto sparse=conformTakePcm(p,r);
  r.anchors={{0,0},{rate*2,rate*1.5},{rate*4,rate*3.0},{rate*6,rate*4.5}};
  const auto dense=conformTakePcm(p,r);
  check(sparse.pcm.samples==dense.pcm.samples,"Periodic anchors must not reset phase or splice processor output");
  check(dense.signalsmithPasses==1,"Periodic anchors must share one processor");
  r.anchors={{0,0},{rate*2,rate},{rate*4,rate*4},{rate*6,rate*6}};
  const auto seamed=conformTakePcm(p,r);int discontinuity=0;
  for(size_t edge:{size_t(rate),size_t(rate*4)})
    for(size_t i=edge-rate/50;i<edge+rate/50;++i)
      discontinuity=std::max(discontinuity,std::abs(int(seamed.pcm.samples[i])-int(seamed.pcm.samples[i-1])));
  check(discontinuity<2000,"Sustained-tone sample step across tempo anchor exceeds bound");
  std::cout<<"seam discontinuity "<<discontinuity<<" PCM16 units (bound 2000)\n";
  p=tone(4);for(size_t i=rate*2;i<p.samples.size();++i)
    p.samples[i]=static_cast<int16_t>(10000*std::sin((i-rate*2)*440*std::pow(2,2.0/12)*2*3.141592653589793/rate));
  r=request(p.samples.size());r.settings.push_back({rate*2,2});
  const auto keyChange=conformTakePcm(p,r);int keyDiscontinuity=0;
  for(size_t i=rate*2-rate/25;i<rate*2+rate/25;++i)
    keyDiscontinuity=std::max(keyDiscontinuity,std::abs(int(keyChange.pcm.samples[i])-int(keyChange.pcm.samples[i-1])));
  check(keyChange.signalsmithPasses==1 && keyDiscontinuity<2000,"Recorded-key change must not hard-splice processors");
  TakeConformPcm tail{rate,{keyChange.pcm.samples.begin()+rate*3,keyChange.pcm.samples.begin()+rate*7/2}};
  check(std::abs(1200*std::log2(frequency(tail)/440))<5,"Continuous shifter follows recorded-key changes");
  std::cout<<"key-change discontinuity "<<keyDiscontinuity<<" PCM16 units\n";
  // Storage grows on disk, not in resident PCM. Sanity guards are time/RIFF only.
  const auto invalid=conformFixturePath(),unused=conformFixturePath();
  writeTakeConformWav(invalid,{rate,std::vector<int16_t>(1,0)});
  {std::fstream file(invalid,std::ios::binary|std::ios::in|std::ios::out);
    const uint32_t bytes=uint32_t(rate*(kTakeConformMaximumSeconds+1)*2);
    auto put=[&](int at,uint32_t value){const char b[]{char(value),char(value>>8),char(value>>16),char(value>>24)};file.seekp(at);file.write(b,4);};put(4,bytes+36);put(40,bytes);
  }
  bool refused=false;try{conformTakeFile(invalid,unused,request(1));}catch(const TakeConformError&e){refused=e.code()==TakeConformFailure::TakeTooLong && std::string(e.what()).find("four-hour")!=std::string::npos;}
  std::filesystem::remove(invalid);check(refused && !std::filesystem::exists(unused),"Refuse over-four-hour take before payload IO");
  p=tone(1);r=request(p.samples.size(),0.75);r.settings[0].transposeSemitones=2;
  TakeConformPcm parallelA, parallelB;
  std::thread a([&]{parallelA=conformTakePcm(p,r).pcm;}), b([&]{parallelB=conformTakePcm(p,r).pcm;});
  a.join();b.join();check(parallelA.samples==parallelB.samples,"Independent concurrent deterministic renders");
  std::atomic<bool> stop{false};bool stopped=false;
  auto longPcm=tone(300);auto longRequest=request(longPcm.samples.size(),1.5);
  std::thread worker([&]{try{conformTakePcm(longPcm,longRequest,&stop);}catch(const std::exception&){stopped=true;}});
  std::this_thread::sleep_for(std::chrono::milliseconds(5));stop.store(true);worker.join();check(stopped,"Cancellation during render");
  p={rate,std::vector<int16_t>(1,1000)};r=request(1,0.5);x=conformTakePcm(p,r);check(x.pcm.samples.size()==1,"Short take");
  p={8000,std::vector<int16_t>(1,1000)};r=request(1,0.5);r.outputRate=48000;
  x=conformTakePcm(p,r);check(x.pcm.samples.size()==3 && std::any_of(x.pcm.samples.begin(),x.pcm.samples.end(),[](auto s){return s!=0;}),"Fractional native-frame tail survives output-rate conversion");
  p=tone(1);r=request(p.samples.size(),0.5);r.startPositionSec=10;r.songDurationProjectFrames=rate;
  x=conformTakePcm(p,r);check(x.signalsmithPasses==0 && std::all_of(x.pcm.samples.begin(),x.pcm.samples.end(),[](auto s){return s==0;}),"Fully cropped take needs no DSP");
  p={8000,std::vector<int16_t>(8000*600)};r=request(p.samples.size());r.outputRate=8000;r.songDurationProjectFrames=p.samples.size();x=conformTakePcm(p,r);check(x.pcm.samples.size()==p.samples.size(),"Ten-minute silent take");
  bool rejected=false;try{r.anchors[1].projectFrame=-1;conformTakePcm(p,r);}catch(...){rejected=true;}check(rejected,"Reject invalid anchors");
  r=request(p.samples.size());std::atomic<bool> cancelled{true};rejected=false;try{conformTakePcm(p,r,&cancelled);}catch(...){rejected=true;}check(rejected,"Cancellation");
}
}
int main(int argc,char **argv){try{
  if(argc>1 && std::string(argv[1])=="regression-ratio"){ratioRegression();return 0;}
  if(argc>1 && std::string(argv[1])=="regression-placement"){placementRegression();return 0;}
  if(argc>1 && std::string(argv[1])=="regression-latency"){latencyRegression();return 0;}
  if(argc>1 && std::string(argv[1])=="regression-drift"){driftRegression();return 0;}
  if(argc>1 && std::string(argv[1])=="stream"){stream_tests::benchmark(argc>2?std::stoul(argv[2]):7200,argc>3?std::stoul(argv[3]):48000,argc>4?std::stoul(argv[4]):48000);return 0;}
  if(argc>1 && std::string(argv[1])=="stream-failures"){stream_tests::failures();return 0;}
  if(argc>1 && std::string(argv[1])=="resident-negative"){
    auto p=tone(300);auto r=request(p.samples.size(),0.75);r.settings[0].transposeSemitones=2;
    singz_v2_reference::TakeConformRequest old;old.anchors={{0,0},{p.samples.size(),p.samples.size()*0.75}};old.settings={{0,2}};old.effects={{"pitch-follow",true,0,false}};old.outputRate=rate;old.songDurationProjectFrames=rate*600;
    const auto result=singz_v2_reference::conformTakePcm(p,old);check(!result.pcm.samples.empty(),"Reference produced no PCM");
    std::cout<<"Resident-v2 negative-control RSS "<<stream_tests::peakRss()<<" MiB\n";check(stream_tests::peakRss()<16,"Resident v2 exceeds streaming RSS bound");return 0;
  }
  tests();
  return 0;
}catch(const std::exception&e){std::cerr<<e.what()<<'\n';return 1;}}
