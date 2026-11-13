#include "core.h"
#include "analysis.h"
#include "signals.h"
#include "diagnostics_io.h"
#include <sstream>
#include <iostream>
#include "allocation_trap.h"
#include <zcore/routing/audio_resampler.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <thread>
#include <vector>
#include <limits>

namespace ms=monitor_spike;
#define REQUIRE(x) do { if (!(x)) { std::fprintf(stderr,"FAIL: %s\n",#x); return false; } } while(false)
constexpr uint64_t origin=10000000000ULL;
namespace {
bool floorTest() {
  const auto q=ms::queueFloor(48000,48000,32,0);
  REQUIRE(q==320);
  REQUIRE(ms::queueFloor(48000,44100,64,0)==396);
  REQUIRE(ms::queueFloor(44100,48000,128,1024)==1024);
  REQUIRE(!ms::queueFloor(0,48000,32,0));
  REQUIRE(!ms::queueFloor(48000,48000,32,20000));
  REQUIRE(!ms::queueFloor(48000,std::numeric_limits<double>::quiet_NaN(),32,0));
  return true;
}
bool clockTest() {
  for (const auto drift:{-.003,.003}) {
    ms::OutputClock clock;
    const double physical=48000*(1+drift);
    double rate=0;
    for (uint64_t f=0;f<48000ULL*600;f+=64) {
      const auto ns=origin+ms::frameNs(f,physical);
      rate=clock.observe(f,ns,64,48000);
    }
    REQUIRE(std::abs(rate-physical)<.1);
    // With nominal-only advancement an independent clock drifts 1.8 seconds
    // in ten minutes, far beyond even the default queue.
    REQUIRE(std::abs((physical/rate-1)*600)<.001);
    REQUIRE(clock.observe(0,0,64,48000)==0);
    REQUIRE(clock.observe(0,origin,64,48000)==48000);
    REQUIRE(clock.observe(64,origin-1,64,48000)==48000);
    REQUIRE(clock.observe(UINT64_MAX,origin,64,48000)==0);
  }
  ms::Anchor a; a.observe(origin,64,48000,false);
  a.observe(origin+ms::frameNs(64,48000)+10000000,64,48000,true);
  REQUIRE(a.jumps==1 && a.inferredMissing>=479);
  ms::Anchor shortGap; shortGap.observe(origin,32,48000,false);
  shortGap.observe(origin+ms::frameNs(64,48000),32,48000,true);
  REQUIRE(shortGap.jumps==1 && shortGap.inferredMissing==32);
  return true;
}
bool diagnosticsTest() {
  std::array<ms::DiagnosticRow,16> rows{};
  ms::Diagnostics d{{rows.data(),rows.size()}};
  auto row=d.interval(origin,0,64,48000); d.record(row);
  row=d.interval(origin+ms::frameNs(64,48000),64,64,48000); d.record(row);
  REQUIRE(d.used==1 && d.deltaHistogram[64]==1);
  // A two-sample phase step is below Anchor's two-frame threshold but
  // invalidates this closed 64-frame interval at the 0.5% admission bound.
  row=d.interval(origin+ms::frameNs(128,48000)+ms::frameNs(2,48000),128,64,48000);
  REQUIRE((row.flags & ms::IntervalRejected)!=0);
  REQUIRE((row.flags & ms::AnchorJump)==0);
  d.record(row,true); REQUIRE(d.used==2);
  REQUIRE(row.expectedFrames==64 && row.gotFrames==64 && row.expectedNs==ms::frameNs(64,48000));
  row=d.interval(origin,192,64,48000);
  REQUIRE((row.flags & ms::AnchorJump)!=0 && d.deltaHistogram[257]==1 && row.deltaNs<0);
  d.record(row,true);
  d.arrival(row,origin,1);
  d.arrival(row,origin+row.expectedNs+3000000,1);
  REQUIRE((row.flags & ms::ArrivalJump)!=0 && row.callbackDeltaNs==static_cast<int64_t>(row.expectedNs)+3000000 && row.timestampQuality==1);
  ms::Diagnostics full{{rows.data(),1}};
  full.record(row,true); full.record(row,true); REQUIRE(full.used==1 && full.dropped==1);
  std::ostringstream csv,json,histogram;
  ms::writeDiagnostics(csv,d,origin,false); ms::writeDiagnostics(json,d,origin,true); ms::writeHistogram(histogram,d);
  REQUIRE(csv.str().find("expected_frames,got_frames")!=std::string::npos);
  REQUIRE(json.str().find("\"delta_histogram\":[")!=std::string::npos);
  REQUIRE(histogram.str().find("nonmonotonic,nonmonotonic,1")!=std::string::npos);
  // Exact fake timestamps stay quantized to at most one ns over ten minutes.
  for (uint64_t frame=0;frame<48000ULL*600;frame+=64) {
    const auto ns=ms::syntheticTimestamp(origin,frame,48000);
    REQUIRE(ns==origin+ms::frameNs(frame,48000));
  }
  return true;
}
bool clockHoleTest() {
  // Exercise the actual zCore mapper with one timestamp step, not a mock
  // verdict. Opt-in tolerance repairs the interval; default policy preserves
  // the exact old 33/65/129-hole negative control at the same queue size.
  for (bool enabled:{false,true}) for (uint32_t period:{32u,64u,128u}) {
    zcore::routing::AudioHistory history(1,ms::capacity,zcore::routing::ResamplingFilter::LinearPhase,true,
        enabled?ms::monitorPhaseConfig:zcore::routing::SampleClockPhaseConfig{});
    ms::Capture capture; capture.history=&history; capture.rate=48000;
    std::array<ms::DiagnosticRow,256> captureRows{},renderRows{};
    ms::Diagnostics captureD{{captureRows.data(),captureRows.size()}},renderD{{renderRows.data(),renderRows.size()}};
    capture.diagnostics=&captureD;
    ms::Renderer renderer; renderer.history=&history; renderer.diagnostics=&renderD;
    renderer.measureBegin=origin; renderer.measureEnd=origin+1000000000;
    renderer.queueNs=ms::frameNs(1024,48000);
    std::array<float,128> samples{},output{}; samples.fill(.2f); float* planes[]{output.data()};
    singz::AudioHostRenderBlock b; b.output=planes; b.outputChannels=1; b.sampleRate=48000;
    b.frames=b.maximumFrames=period; b.outputTimestampValid=b.outputTimestampHardware=true;
    for (uint64_t frame=0;frame<8192;frame+=period) {
      const auto ns=ms::syntheticTimestamp(origin,frame,48000)+(frame>=4096?ms::frameNs(1,48000):0);
      zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
      const bool appended=ms::Capture::push(&capture,samples.data(),period,ns,ns, singz::AudioInputTimestampQuality::Hardware);
      b.outputFrame=frame; b.outputHostTimeNs=origin+ms::frameNs(frame,48000); b.callbackHostTimeNs=b.outputHostTimeNs;
      const bool rendered=ms::Renderer::render(&renderer,b);
      zdsp::test::setAllocationTrapEnabled(false);
      REQUIRE(appended && rendered && zdsp::test::trappedAllocationCount()==0);
    }
    uint64_t rejected=0,clockMissing=0,supportMissing=0;
    for (size_t i=0;i<captureD.used;++i) rejected+=(captureD.rows[i].flags & ms::IntervalRejected)!=0;
    for (size_t i=0;i<renderD.used;++i) if (renderD.rows[i].frame>2048) {
      clockMissing+=renderD.rows[i].clockMissing; supportMissing+=renderD.rows[i].supportMissing;
      if (renderD.rows[i].clockMissing) REQUIRE((renderD.rows[i].flags & ms::MissingRead)!=0 && renderD.rows[i].gotFrames<period);
    }
    // Raw timestamp diagnostics still identify the phase anomaly; the clock
    // decides whether it is correctable and reports the actual read coverage.
    REQUIRE(rejected==1 && supportMissing==0);
    REQUIRE(clockMissing==(enabled?0:period+1));
    REQUIRE(history.status().phaseCorrections==(enabled?1:0));
    REQUIRE(history.status().rejectedIntervals==(enabled?0:1));
    REQUIRE(history.status().discontinuities==0);
    // The synthetic direct control uses the same output callback with no input
    // channels and no history, and must copy its generated sample block.
    ms::Renderer direct; direct.direct=direct.syntheticDirect=true; direct.mute=false; direct.gain=.5f;
    direct.measureBegin=origin; direct.measureEnd=origin+1000000000;
    b.outputHostTimeNs=origin; b.outputFrame=0;
    REQUIRE(ms::Renderer::render(&direct,b)); REQUIRE(direct.missing==0);
    for (uint32_t i=0;i<period;++i) REQUIRE(output[i]==.5f*ms::testSignal(i,48000));
  }
  return true;
}
bool positionPushTest() {
  zcore::routing::AudioHistory history(1,4096,zcore::routing::ResamplingFilter::LinearPhase,true,ms::monitorPhaseConfig);
  ms::Capture capture; capture.history=&history; capture.rate=48000;
  std::array<float,64> samples{}; samples.fill(.25f);
  REQUIRE(ms::Capture::pushWithPosition(&capture,samples.data(),64,origin,origin,
      singz::AudioInputTimestampQuality::Hardware,{-64,true}));
  REQUIRE(ms::Capture::pushWithPosition(&capture,samples.data(),64,origin+ms::frameNs(65,48000),origin,
      singz::AudioInputTimestampQuality::Hardware,{0,true}));
  REQUIRE(history.status().discontinuities==0 && history.status().rejectedIntervals==0);
  REQUIRE(ms::Capture::pushWithPosition(&capture,samples.data(),64,origin+ms::frameNs(130,48000),origin,
      singz::AudioInputTimestampQuality::Hardware,{65,true}));
  REQUIRE(history.status().discontinuities==1);
  return true;
}
bool historyTest() {
  zcore::routing::AudioHistory history(1,ms::capacity);
  ms::Capture source; source.history=&history; source.rate=48000;
  source.measureBegin=origin; source.measureEnd=origin+10000000000ULL;
  std::array<float,256> samples{}; samples.fill(.25f);
  for (uint64_t f=0;f<4096;f+=256)
    REQUIRE(ms::Capture::push(&source,samples.data(),256,origin+ms::frameNs(f,48000),0,
                              singz::AudioInputTimestampQuality::Hardware));
  ms::Renderer renderer; renderer.history=&history; renderer.mute=false; renderer.gain=.5f;
  renderer.queueNs=ms::frameNs(1024,48000); renderer.measureBegin=origin;
  renderer.measureEnd=origin+10000000000ULL;
  std::array<float,512> output{}; float* planes[]{output.data()};
  singz::AudioHostRenderBlock b; b.output=planes; b.outputChannels=1;
  b.frames=b.maximumFrames=512; b.sampleRate=48000; b.outputTimestampValid=b.outputTimestampHardware=true;
  b.outputHostTimeNs=origin+ms::frameNs(3072,48000); b.callbackHostTimeNs=b.outputHostTimeNs;
  zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
  const bool rendered=ms::Renderer::render(&renderer,b);
  zdsp::test::setAllocationTrapEnabled(false);
  REQUIRE(rendered && zdsp::test::trappedAllocationCount()==0);
  REQUIRE(renderer.missing==0);
  for (auto v:output) REQUIRE(std::abs(v-.125f)<1e-6);
  // Deliberately read beyond published support: must become counted silence.
  b.outputHostTimeNs=origin+ms::frameNs(48000,48000); b.outputFrame+=512;
  REQUIRE(ms::Renderer::render(&renderer,b));
  REQUIRE(renderer.missing==512);
  for (auto v:output) REQUIRE(v==0);
  history.stop();
  return true;
}
bool directTest() {
  ms::Renderer renderer;
  renderer.direct=true; renderer.mute=false; renderer.gain=.5f;
  renderer.measureBegin=origin; renderer.measureEnd=origin+1000000000;
  std::array<float,64> input{},output{}; input.fill(2.f);
  const float* in[]{input.data()}; float* out[]{output.data()};
  singz::AudioHostRenderBlock b; b.input=in; b.output=out;
  b.inputChannels=b.outputChannels=1; b.frames=b.maximumFrames=64; b.sampleRate=48000;
  b.inputTimestampValid=b.inputTimestampHardware=b.outputTimestampValid=b.outputTimestampHardware=true;
  b.outputHostTimeNs=origin+5000000; b.inputSampleHostTimeNs=origin;
  zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
  const bool okay=ms::Renderer::render(&renderer,b);
  zdsp::test::setAllocationTrapEnabled(false);
  REQUIRE(okay && zdsp::test::trappedAllocationCount()==0);
  for (auto v:output) REQUIRE(v==.5f);
  REQUIRE(renderer.timestampLatencyMs.mean==5);
  renderer.mute=true;
  REQUIRE(ms::Renderer::render(&renderer,b));
  for (auto v:output) REQUIRE(v==0);
  b.frames=65;
  REQUIRE(!ms::Renderer::render(&renderer,b));
  REQUIRE(renderer.invalid==1);
  return true;
}
bool driftHistoryTest() {
  for (double drift:{-.003,.003}) {
    zcore::routing::AudioHistory h(1,ms::capacity);
    zcore::routing::AudioReadCursor cursor;
    std::array<float,256> source{},output{}; const float* input[]{source.data()}; float* planes[]{output.data()};
    const double physical=48000*(1+drift), dst=44100;
    uint64_t captured=0;
    const uint64_t queue=ms::frameNs(2048,48000);
    uint64_t missing=0; double error=0; size_t values=0;
    for (uint64_t f=0;f<44100;f+=128) {
      const auto now=origin+queue+ms::frameNs(f,dst);
      while (origin+ms::frameNs(captured,physical)<now) {
        for (size_t i=0;i<256;++i) source[i]=static_cast<float>(.25*std::sin(2*3.141592653589793*440*(captured+i)/physical));
        REQUIRE(h.append({input,256},256,origin+ms::frameNs(captured,physical),48000)); captured+=256;
      }
      const auto target=now-queue;
      const auto r=h.read(target,dst,{planes,256},128,cursor);
      if (f>4096) {
        missing+=r.missingFrames;
        for (size_t i=0;i<128;++i) {
          const auto expected=.25*std::sin(2*3.141592653589793*440*((f+i)/dst));
          error=std::max(error,std::abs(output[i]-expected)); ++values;
        }
      }
    }
    REQUIRE(missing==0 && values>10000 && error<.002);
  }
  return true;
}
bool concurrencyTest() {
  zcore::routing::AudioHistory h(1,4096,zcore::routing::ResamplingFilter::LinearPhase,true);
  std::array<ms::DiagnosticRow,2048> captureRows{},outputRows{};
  std::atomic<uint64_t> target{0};
  ms::Diagnostics captureD{{captureRows.data(),captureRows.size()}},outputD{{outputRows.data(),outputRows.size()}};
  captureD.outputTargetNs=outputD.outputTargetNs=&target;
  ms::Capture capture; capture.history=&h; capture.rate=48000; capture.diagnostics=&captureD;
  ms::Renderer renderer; renderer.history=&h; renderer.diagnostics=&outputD; renderer.mute=false; renderer.gain=1;
  std::atomic<bool> done{false}; std::atomic<uint64_t> end{0};
  std::thread writer([&] {
    std::array<float,128> samples{}; samples.fill(.2f);
    for (uint64_t f=0;f<128000;f+=128) {
      const auto ns=origin+ms::frameNs(f,48000);
      ms::Capture::push(&capture,samples.data(),128,ns,ns,singz::AudioInputTimestampQuality::Hardware);
      end.store(f+128,std::memory_order_release);
    }
    done.store(true,std::memory_order_release);
  });
  std::array<float,64> out{}; float* planes[]{out.data()}; bool finite=true; uint64_t reads=0;
  singz::AudioHostRenderBlock b; b.output=planes; b.outputChannels=1;
  b.frames=b.maximumFrames=64; b.sampleRate=48000; b.outputTimestampValid=b.outputTimestampHardware=true;
  do {
    const auto f=end.load(std::memory_order_acquire);
    if (f>1024) {
      b.outputFrame=reads*64; b.outputHostTimeNs=origin+ms::frameNs(f-1024,48000); b.callbackHostTimeNs=b.outputHostTimeNs;
      ms::Renderer::render(&renderer,b); ++reads;
      for (auto v:out) if (!std::isfinite(v) || std::abs(v)>.21f) finite=false;
    }
  } while (!done.load(std::memory_order_acquire));
  writer.join(); REQUIRE(finite && reads && captureD.used && outputD.used && target.load()>0); h.stop(); return true;
}
bool waveformTest() {
  constexpr double rate=48000; constexpr size_t frames=12*48000; constexpr size_t delay=240;
  std::vector<ms::Point> source(frames),returned(frames);
  for (size_t i=0;i<frames;++i) {
    const auto ns=origin+ms::frameNs(i,rate);
    source[i]={ns,ms::testSignal(i,rate)};
    returned[i]={ns,i>=4*48000 && i>=delay ? .1f*ms::testSignal(i-delay,rate):0};
  }
  const auto positive=ms::correlate(source,returned,origin,rate,20);
  REQUIRE(positive.measured && positive.windows==6 && std::abs(positive.delayMs-5)<.13);
  for (size_t i=0;i<frames;++i) returned[i].value=i>=4*48000 && i>delay ?
    .1f*(.63f*ms::testSignal(i-delay,rate)+.37f*ms::testSignal(i-delay-1,rate)):0;
  const auto fractional=ms::correlate(source,returned,origin,rate,20);
  REQUIRE(fractional.measured && std::abs(fractional.delayMs-5.00770833)<.004);
  for (auto& p:returned) p.value=0;
  const auto silent=ms::correlate(source,returned,origin,rate,20);
  REQUIRE(!silent.measured);
  // Correlated signal leaking through muted controls must never qualify.
  returned=source;
  REQUIRE(!ms::correlate(source,returned,origin,rate,20).measured);
  return true;
}
bool waveformDriftTest() {
  const double srcRate=48000*1.003, retRate=44100*.997;
  const double nominal=48000, retNominal=44100;
  std::vector<ms::Point> source(static_cast<size_t>(13*srcRate)),returned(static_cast<size_t>(13*retRate));
  ms::Recording a{{source.data(),source.size()}},b{{returned.data(),returned.size()}};
  a.begin=b.begin=origin; a.end=b.end=origin+12000000000ULL;
  std::array<float,128> buffer{};
  for (uint64_t frame=0;frame<static_cast<uint64_t>(12*srcRate);frame+=64) {
    for (size_t i=0;i<64;++i) buffer[i]=ms::testSignal(frame+i,nominal);
    a.append(buffer.data(),64,origin+ms::frameNs(frame,srcRate),nominal);
  }
  for (uint64_t frame=0;frame<static_cast<uint64_t>(12*retRate);frame+=128) {
    for (size_t i=0;i<128;++i) {
      const double seconds=static_cast<double>(frame+i)/retRate;
      const double sourcePosition=(seconds-.005)*srcRate;
      const auto base=sourcePosition>0 ? static_cast<uint64_t>(sourcePosition):0;
      const auto fraction=sourcePosition-base;
      buffer[i]=seconds>=4 && sourcePosition>=0 ? static_cast<float>(.1*(
        (1-fraction)*ms::testSignal(base,nominal)+fraction*ms::testSignal(base+1,nominal))):0;
    }
    b.append(buffer.data(),128,origin+ms::frameNs(frame,retRate),retNominal);
  }
  const auto result=ms::correlate({source.data(),a.used},{returned.data(),b.used},origin,retNominal,20);
  REQUIRE(result.measured && result.windows==6 && std::abs(result.delayMs-5)<.02);
  return true;
}
bool virtualComparisonTest() {
  ms::Gates g;
  REQUIRE(ms::pathComparison(g,5,true,true,32,true,true)==ms::Verdict::NotMeasured);
  REQUIRE(ms::pathComparison(g,20,true,true,64,true,true)==ms::Verdict::NotMeasured);
  REQUIRE(ms::pathComparison(g,5,true,true,32,false,true)==ms::Verdict::Pass);
  REQUIRE(ms::pathComparison(g,20,true,true,64,false,true)==ms::Verdict::Fail);
  REQUIRE(ms::pathComparison(g,5,true,true,64,true,false)==ms::Verdict::Pass);
  REQUIRE(ms::pathComparison(g,5,true,true,128,false,true)==ms::Verdict::NotMeasured);
  return true;
}
bool terminationTest() {
  ms::installTerminationHandlers();
  for (int signal : {SIGINT, SIGTERM
#ifdef SIGHUP
      , SIGHUP
#endif
      }) {
    ms::interrupted=0;
    REQUIRE(std::raise(signal)==0);
    REQUIRE(ms::interrupted==1);
  }
  ms::interrupted=0;
  return true;
}
bool gatesTest() {
  ms::Gates g;
  REQUIRE(ms::continuity(g,600,450000,0,0,0,true,true)==ms::Verdict::Pass);
  REQUIRE(ms::continuity(g,60,45000,0,0,0,true,true)==ms::Verdict::NotMeasured);
  REQUIRE(ms::continuity(g,600,0,0,0,0,true,true)==ms::Verdict::NotMeasured);
  REQUIRE(ms::continuity(g,600,450000,1,0,0,true,true)==ms::Verdict::Fail);
  REQUIRE(ms::continuity(g,600,450000,0,1,0,true,true)==ms::Verdict::Fail);
  REQUIRE(ms::continuity(g,600,450000,0,0,1,true,true)==ms::Verdict::Fail);
  REQUIRE(ms::continuity(g,600,450000,0,0,0,false,true)==ms::Verdict::NotMeasured);
  REQUIRE(ms::continuity(g,600,450000,0,0,0,true,false)==ms::Verdict::NotMeasured);
  const auto unknown=ms::latency(g,5,false,true);
  REQUIRE(unknown==ms::Verdict::NotMeasured);
  REQUIRE(ms::latency(g,11,true,true)==ms::Verdict::Fail);
  REQUIRE(ms::latency(g,9,true,true)==ms::Verdict::Pass);
  REQUIRE(ms::latency(g,5,true,false)==ms::Verdict::NotMeasured);
  REQUIRE(ms::latency(g,-1,true,true)==ms::Verdict::NotMeasured);
  return true;
}
}
int main(int argc,char** argv) {
  const std::string which=argc>1?argv[1]:"all";
  bool okay=false;
  if (which=="floor") okay=floorTest();
  else if (which=="clock") okay=clockTest();
  else if (which=="missing") okay=historyTest();
  else if (which=="gate") okay=gatesTest();
  else if (which=="diagnostics") okay=diagnosticsTest();
  else if (which=="synthetic") okay=diagnosticsTest();
  else if (which=="diagnostic-json" || which=="diagnostic-csv") {
    std::array<ms::DiagnosticRow,2> rows{}; ms::Diagnostics d{{rows.data(),rows.size()}};
    auto row=d.interval(origin,0,64,48000); d.record(row,true);
    row=d.interval(origin+ms::frameNs(64,48000)+50000,64,64,48000); d.record(row,true);
    ms::writeDiagnostics(std::cout,d,origin,which=="diagnostic-json"); return 0;
  }
  else if (which=="all") okay=diagnosticsTest() && clockHoleTest() && positionPushTest() && floorTest() && clockTest() && historyTest() && directTest() && driftHistoryTest() &&
                             concurrencyTest() && waveformTest() && waveformDriftTest() && gatesTest() && virtualComparisonTest() && terminationTest();
  if (okay) std::puts("monitor spike portable checks passed");
  return okay?0:1;
}
