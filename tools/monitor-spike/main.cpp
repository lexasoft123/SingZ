#include "core.h"
#include "analysis.h"
#include "signals.h"
#include "diagnostics_io.h"
#include <fstream>
#include <zcore/device/audio_host.h>
#include <zcore/routing/audio_resampler.h>
#include <zcore/device/audio_input_backend.h>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <csignal>
#include <iomanip>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#if defined(__APPLE__)
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <pthread.h>
#endif

namespace ms = monitor_spike;
namespace {
using ms::interrupted;
uint64_t hostNow() noexcept {
#if defined(__APPLE__)
  static const auto scale=[] { mach_timebase_info_data_t v{}; mach_timebase_info(&v); return v; }();
  return static_cast<uint64_t>(static_cast<long double>(mach_absolute_time())*scale.numer/scale.denom);
#else
  return static_cast<uint64_t>(std::chrono::duration_cast<std::chrono::nanoseconds>(
      std::chrono::steady_clock::now().time_since_epoch()).count());
#endif
}
uint64_t threadCpu() noexcept {
#if defined(__APPLE__)
  thread_basic_info_data_t info{}; mach_msg_type_number_t count=THREAD_BASIC_INFO_COUNT;
  if (thread_info(pthread_mach_thread_np(pthread_self()), THREAD_BASIC_INFO,
                  reinterpret_cast<thread_info_t>(&info), &count)!=KERN_SUCCESS) return 0;
  return (static_cast<uint64_t>(info.user_time.seconds)+info.system_time.seconds)*1000000000ULL+
         (static_cast<uint64_t>(info.user_time.microseconds)+info.system_time.microseconds)*1000ULL;
#else
  return 0;
#endif
}
struct Options {
  bool run{}, list{}, help{}, virtualSource{}, syntheticSource{}, mute{}, audible{}, bed{}, bufferConsent{};
  std::string input, output, mode="history", dumpPrefix, dumpFormat="csv";
  uint32_t diagnosticCapacity=262144;
  uint32_t inputChannel{}, outputChannel{}, loopbackChannel=UINT32_MAX;
  std::vector<uint32_t> periods{32,64,128};
  uint32_t lookback=1024, quantum=256;
  double seconds=60, warmup=3, outputRate=0, inputRate=0, gain=.05, maxLag=100, correlation=.9999, controlRmsLimit=1e-5;
  ms::Gates gates;
};
double number(const std::string& s, double lo, double hi) {
  size_t used=0; const auto v=std::stod(s,&used);
  if (used!=s.size() || !std::isfinite(v) || v<lo || v>hi) throw std::runtime_error("Invalid number: "+s);
  return v;
}
uint32_t integer(const std::string& s, uint32_t lo, uint32_t hi) {
  const auto v=number(s,lo,hi);
  if (v!=std::floor(v)) throw std::runtime_error("Expected integer: "+s);
  return static_cast<uint32_t>(v);
}
Options parse(int argc,char** argv) {
  Options o;
  for (int i=1;i<argc;++i) {
    const std::string a=argv[i];
    auto value=[&] { if (++i>=argc) throw std::runtime_error("Missing value for "+a); return std::string(argv[i]); };
    if (a=="--run") o.run=true;
    else if (a=="--list-devices") o.list=true;
    else if (a=="--help" || a=="-h") o.help=true;
    else if (a=="--synthetic-source") o.syntheticSource=true;
    else if (a=="--dump-prefix") o.dumpPrefix=value();
    else if (a=="--dump-format") o.dumpFormat=value();
    else if (a=="--diagnostic-capacity") o.diagnosticCapacity=integer(value(),1,2000000);
    else if (a=="--virtual-source") o.virtualSource=true;
    else if (a=="--mute-output") o.mute=true;
    else if (a=="--audible") o.audible=true;
    else if (a=="--bed") o.bed=true;
    else if (a=="--allow-buffer-change") o.bufferConsent=true;
    else if (a=="--input") o.input=value();
    else if (a=="--output") o.output=value();
    else if (a=="--mode") o.mode=value();
    else if (a=="--input-channel") o.inputChannel=integer(value(),0,63);
    else if (a=="--output-channel") o.outputChannel=integer(value(),0,63);
    else if (a=="--loopback-channel") o.loopbackChannel=integer(value(),0,63);
    else if (a=="--queue-frames") o.lookback=integer(value(),0,ms::capacity/2);
    else if (a=="--quantum") o.quantum=integer(value(),0,4096);
    else if (a=="--seconds") o.seconds=number(value(),.1,3600);
    else if (a=="--warmup") o.warmup=number(value(),.1,60);
    else if (a=="--required-seconds") o.gates.requiredSeconds=number(value(),.1,3600);
    else if (a=="--max-latency-ms") o.gates.maxLatencyMs=number(value(),0,500);
    else if (a=="--allowed-missing") o.gates.allowedMissing=integer(value(),0,1000000);
    else if (a=="--output-rate") o.outputRate=number(value(),8000,192000);
    else if (a=="--input-rate") o.inputRate=number(value(),8000,192000);
    else if (a=="--gain") o.gain=number(value(),.0001,.5);
    else if (a=="--max-lag-ms") o.maxLag=number(value(),1,500);
    else if (a=="--correlation") o.correlation=number(value(),.9,1);
    else if (a=="--control-rms-limit") o.controlRmsLimit=number(value(),1e-8,.01);
    else if (a=="--periods") {
      o.periods.clear(); auto s=value(); size_t pos=0;
      do { const auto end=s.find(',',pos); const auto p=integer(s.substr(pos,end-pos),32,128);
        if (p!=32 && p!=64 && p!=128) throw std::runtime_error("Periods must be 32,64,128");
        o.periods.push_back(p); if (end==std::string::npos) break; pos=end+1;
      } while (true);
    } else throw std::runtime_error("Unknown option: "+a);
  }
  if (o.mode!="history" && o.mode!="direct" && o.mode!="both") throw std::runtime_error("mode: history, direct, both");
  if (o.dumpFormat!="csv" && o.dumpFormat!="json") throw std::runtime_error("dump format: csv, json");
  if (o.syntheticSource && (o.virtualSource || o.loopbackChannel!=UINT32_MAX))
    throw std::runtime_error("Synthetic controls require no --virtual-source or loopback");
  return o;
}
void usage() {
  std::cout << "monitor_spike_harness (no devices open without --run; macOS hardware only)\n"
    "  --list-devices | --help\n"
    "  --run --input NAME_OR_UID --output NAME_OR_UID --mode history|direct|both\n"
    "  --mute-output | --audible [--gain 0.05 (maximum 0.5)]\n"
    "  --periods 32,64,128 --allow-buffer-change --input-channel 0 --output-channel 0\n"
    "  --synthetic-source (exact timestamps, no capture; direct uses output-only sample copy)\n"
    "  --dump-prefix PATH --dump-format csv|json --diagnostic-capacity 262144\n"
    "  --virtual-source [--loopback-channel N] --bed --seconds 60 --warmup 3\n"
    "  --queue-frames 1024 --quantum 256 (0 tests below default floor; experimental)\n"
    "  --input-rate HZ (assert current capture rate) --output-rate HZ\n"
    "  --required-seconds 600 --max-latency-ms 10 --allowed-missing 0\n"
    "  --max-lag-ms 100 --correlation 0.9999 --control-rms-limit 0.00001\n"
    "Channels are zero-based. Both mode and all periods run sequentially.\n"
    "Loopback adds 12s calibration (4s muted, 2x4s signal) before the measured run.\n"
    "Exit: 0 completed, 1 measured gate failure, 2 invalid/open/runtime failure; NOT MEASURED is not acceptance.\n";
}
const singz::AudioHostDeviceInfo& select(const singz::AudioHostInventory& inventory,const std::string& key,bool input) {
  const singz::AudioHostDeviceInfo* selected=nullptr;
  for (const auto& d:inventory.devices) if ((input?d.inputChannels:d.outputChannels) && (d.uid==key || d.label==key)) {
    if (selected) throw std::runtime_error("Ambiguous device name; use exact UID"); selected=&d;
  }
  if (!selected) throw std::runtime_error("Device not found: "+key);
  return *selected;
}
void moments(const char* label,const ms::Moments& v) {
  std::cout << label << ": ";
  if (!v.n) { std::cout << "NOT MEASURED\n"; return; }
  std::cout << "mean=" << v.mean << " sd=" << v.deviation() << " min=" << v.minimum << " max=" << v.maximum << " n=" << v.n << '\n';
}
struct CaptureOwner {
  std::unique_ptr<singz::AudioInputBackend> backend;
  ~CaptureOwner() { if (backend) backend->stop(); }
};
// Exact timestamp grid, independent of output callbacks. Wake-up jitter is
// deliberately NOT copied into source timestamps. A late worker publishes late
// and remains observable as unpublished support, rather than relabeling time.
struct SyntheticOwner {
  std::jthread thread;
  void start(ms::Capture& capture,uint32_t period,uint64_t origin) {
    thread=std::jthread([&capture,period,origin](std::stop_token stop) {
      std::array<float,ms::maximum> samples{};
      for (uint64_t frame=0;!stop.stop_requested();frame+=period) {
        const auto ns=ms::syntheticTimestamp(origin,frame,capture.rate);
        const auto deadline=ns+ms::frameNs(period,capture.rate);
        while (!stop.stop_requested() && hostNow()<deadline)
          std::this_thread::sleep_for(std::chrono::microseconds(100));
        if (stop.stop_requested()) break;
        for (uint32_t i=0;i<period;++i) samples[i]=ms::testSignal(frame+i,capture.rate);
        ms::Capture::push(&capture,samples.data(),period,ns,hostNow(),singz::AudioInputTimestampQuality::Hardware);
      }
    });
  }
  void stop() { if (thread.joinable()) { thread.request_stop(); thread.join(); } }
  ~SyntheticOwner() { stop(); }
};
void dump(const Options& o,const ms::Diagnostics& d,uint64_t start,const std::string& cell,const char* stream) {
  const std::string path=o.dumpPrefix+"."+cell+"."+stream+"."+o.dumpFormat;
  std::ofstream file(path); if (!file) throw std::runtime_error("Cannot open diagnostic dump: "+path);
  ms::writeDiagnostics(file,d,start,o.dumpFormat=="json");
  file.close(); if (!file) throw std::runtime_error("Cannot write diagnostic dump: "+path);
  if (o.dumpFormat=="csv") {
    std::ofstream histogram(path+".histogram.csv"); ms::writeHistogram(histogram,d);
    histogram.close(); if (!histogram) throw std::runtime_error("Cannot write histogram");
  }
  uint64_t events=0; for (size_t i=0;i<d.used;++i) events+=d.rows[i].flags!=ms::Sample;
  std::cout << "diagnostics stream=" << stream << " rows=" << d.used << " events=" << events
            << " dropped=" << d.dropped << " file=" << path << '\n';
}
int runCell(const Options& o,const singz::AudioHostDeviceInfo& in,
            const singz::AudioHostDeviceInfo& out,uint32_t period,bool direct) {
  const bool same=in.uid==out.uid;
  if (direct && !same && !o.syntheticSource) throw std::runtime_error("DIRECT requires one device UID");
  if ((!o.syntheticSource && o.inputChannel>=in.inputChannels) || o.outputChannel>=out.outputChannels ||
      (o.loopbackChannel!=UINT32_MAX && o.loopbackChannel>=out.inputChannels)) throw std::runtime_error("Channel outside device inventory");
  const bool waveform=o.loopbackChannel!=UINT32_MAX && !o.mute;
  ms::Capture capture, returned;
  ms::Renderer renderer;
  std::vector<ms::DiagnosticRow> captureRows,outputRows;
  if (!o.dumpPrefix.empty()) { captureRows.resize(o.diagnosticCapacity); outputRows.resize(o.diagnosticCapacity); }
  ms::Diagnostics captureDiagnostics{{captureRows.data(),captureRows.size()}}, outputDiagnostics{{outputRows.data(),outputRows.size()}};
  std::atomic<uint64_t> diagnosticTarget{0};
  captureDiagnostics.outputTargetNs=outputDiagnostics.outputTargetNs=&diagnosticTarget;
  if (!o.dumpPrefix.empty()) { capture.diagnostics=&captureDiagnostics; renderer.diagnostics=&outputDiagnostics; }
  // Ownership is allocated before callbacks and destroyed after all hosts join.
  zcore::routing::AudioHistory history(1,ms::capacity,zcore::routing::ResamplingFilter::LinearPhase,!o.dumpPrefix.empty(),ms::monitorPhaseConfig);
  std::vector<ms::Point> sourcePoints,returnPoints;
  if (waveform) { sourcePoints.resize(13*192000); returnPoints.resize(13*192000); }
  ms::Recording sourceRecord{{sourcePoints.data(),sourcePoints.size()}},returnRecord{{returnPoints.data(),returnPoints.size()}};
  CaptureOwner inputOwner,returnOwner;
  SyntheticOwner synthetic;
  singz::AudioHost host;
  capture.history=direct?nullptr:&history; capture.virtualSource=o.virtualSource;
  // A physical direct-loopback comparison needs an independent hardware capture
  // reference: AUHAL duplex block.input carries the render callback's timestamp.
  if (!o.syntheticSource && (!direct || (waveform && !o.virtualSource))) {
    inputOwner.backend=singz::createPlatformAudioInputBackend();
    if (!inputOwner.backend) throw std::runtime_error("Capture backend unavailable");
    singz::AudioInputConfig cfg; cfg.deviceUid=in.uid; cfg.channel=o.inputChannel;
    // On same hardware, keep capture's buffer lease compatible with the host.
    if (o.bufferConsent) { cfg.requestedBufferFrames=period; cfg.allowSharedDeviceBufferChange=true; }
    const auto opened=inputOwner.backend->open(cfg,ms::Capture::push,&capture);
    if (!opened.ok) throw std::runtime_error(opened.error);
    inputOwner.backend->setPositionPush(ms::Capture::pushWithPosition);
    capture.rate=opened.sampleRate;
    std::cout << "capture rate=" << opened.sampleRate << " period=" << opened.inputBufferFrames
              << " latency_frames=" << opened.inputLatencyFrames << " latency_source=" << opened.inputLatencySource << '\n';
  }
  singz::AudioHostConfig cfg; cfg.outputDeviceUid=out.uid; cfg.outputChannels={o.outputChannel};
  if (direct && !o.syntheticSource) { cfg.inputDeviceUid=in.uid; cfg.inputChannels={o.inputChannel}; }
  cfg.requestedBufferFrames=period; cfg.allowSharedDeviceBufferChange=o.bufferConsent;
  cfg.maximumAcceptableBufferFrames=period; cfg.requestedSampleRate=o.outputRate;
  const auto opened=host.open(cfg,ms::Renderer::render,&renderer);
  if (!opened.ok) throw std::runtime_error(opened.message);
  const auto rate=opened.format.sampleRate;
  if (o.syntheticSource) capture.rate=o.inputRate?o.inputRate:rate;
  else if (direct && !inputOwner.backend) capture.rate=rate;
  if (direct && o.syntheticSource && std::abs(capture.rate-rate)>.01)
    throw std::runtime_error("Synthetic direct copy runs at output rate; use history for rate conversion");
  if (direct && !o.syntheticSource && std::abs(capture.rate-rate)>.01)
    throw std::runtime_error("Direct reference capture and duplex rates differ");
  if ((o.inputRate && std::abs(capture.rate-o.inputRate)>.01) ||
      (o.outputRate && std::abs(rate-o.outputRate)>.01)) throw std::runtime_error("Negotiated rate differs from explicit rate assertion");
  if (opened.format.nominalBufferFrames!=period || opened.latency.bufferFrames!=period)
    throw std::runtime_error("Negotiated period differs from requested cell");
  const auto queue=ms::queueFloor(capture.rate,rate,period,o.lookback,o.quantum);
  if (!queue) throw std::runtime_error("Invalid queue floor");
  renderer.history=direct?nullptr:&history; renderer.direct=direct; renderer.virtualSource=o.virtualSource;
  renderer.syntheticDirect=direct && o.syntheticSource;
  renderer.mute=o.mute; renderer.bed=o.bed; renderer.gain=static_cast<float>(o.gain);
  renderer.cpuTime=threadCpu; renderer.queueNs=direct?0:ms::frameNs(queue,capture.rate);
  if (waveform) {
    returnOwner.backend=singz::createPlatformAudioInputBackend();
    if (!returnOwner.backend) throw std::runtime_error("Loopback backend unavailable");
    singz::AudioInputConfig rc; rc.deviceUid=out.uid; rc.channel=o.loopbackChannel;
    const auto ro=returnOwner.backend->open(rc,ms::Capture::push,&returned);
    if (!ro.ok) throw std::runtime_error(ro.error);
    returnOwner.backend->setPositionPush(ms::Capture::pushWithPosition);
    returned.rate=ro.sampleRate; returned.recording=&returnRecord;
    if (direct && o.virtualSource) renderer.reference=&sourceRecord; else capture.recording=&sourceRecord;
  }
  const auto diagnosticStart=hostNow();
  const auto calibrationBegin=diagnosticStart+static_cast<uint64_t>(o.warmup*1e9);
  const auto measureBegin=calibrationBegin+(waveform?12000000000ULL:0);
  const auto measureEnd=measureBegin+static_cast<uint64_t>(o.seconds*1e9);
  capture.measureBegin=returned.measureBegin=renderer.measureBegin=measureBegin;
  capture.measureEnd=returned.measureEnd=renderer.measureEnd=measureEnd;
  sourceRecord.begin=returnRecord.begin=calibrationBegin;
  sourceRecord.end=returnRecord.end=calibrationBegin+12000000000ULL;
  renderer.unmuteBegin=waveform?calibrationBegin+4000000000ULL:0;
  if (o.syntheticSource && !direct) synthetic.start(capture,period,diagnosticStart);
  if (inputOwner.backend) { const auto r=inputOwner.backend->start(); if (!r.ok) throw std::runtime_error(r.error); }
  if (returnOwner.backend) { const auto r=returnOwner.backend->start(); if (!r.ok) throw std::runtime_error(r.error); }
  const auto started=host.start(); if (!started.ok) throw std::runtime_error(started.message);
  std::cout << "cell=" << (direct?"DIRECT":"HISTORY") << '/' << (same?"same":"cross") << " requested=" << period
            << " actual=" << opened.format.nominalBufferFrames << " input_hz=" << capture.rate << " output_hz=" << rate
            << " queue_frames=" << (direct?0:queue) << " queue_ms=" << renderer.queueNs/1e6 << " gain=" << o.gain
            << " muted=" << o.mute << " bed=" << o.bed << " duration_s=" << o.seconds
            << " source=" << (o.syntheticSource?"synthetic":o.virtualSource?"virtual":"physical") << " warmup_s=" << o.warmup
            << " requested_queue_frames=" << o.lookback << " quantum=" << o.quantum
            << " G1_required_s=" << o.gates.requiredSeconds << " allowed_missing=" << o.gates.allowedMissing
            << " G2_max_ms=" << o.gates.maxLatencyMs << std::endl;
  if (o.virtualSource)
    std::cout << "VIRTUAL TIMING BIAS: HISTORY starts at capture hardware first-sample time and includes input-side buffering in its queue; "
      "DIRECT starts at the AUHAL render timestamp and excludes about one input period plus input latency. "
      "DIRECT-virtual therefore looks faster by that amount; virtual numbers across modes are NOT COMPARABLE, "
      "and DIRECT-virtual is excluded from the waveform path comparison gate." << std::endl;
  auto baseline=host.status(); bool healthy=true;
  uint64_t historyBaseline=history.status().discontinuities;
  uint64_t inputDropsBaseline=0, returnDropsBaseline=0;
  std::string failure;
  while (!interrupted && hostNow()<measureEnd+ms::frameNs(period*2,rate)) {
    const auto status=host.status();
    if (hostNow()<measureBegin) {
      baseline=status;
      historyBaseline=history.status().discontinuities;
      inputDropsBaseline=inputOwner.backend?inputOwner.backend->renderSliceDrops():0;
      returnDropsBaseline=returnOwner.backend?returnOwner.backend->renderSliceDrops():0;
    }
    if (status.state!=singz::AudioHostState::Running ||
        (inputOwner.backend && inputOwner.backend->takeFailure(failure)) ||
        (returnOwner.backend && returnOwner.backend->takeFailure(failure))) { healthy=false; break; }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  const auto final=host.status();
  host.stop();
  if (inputOwner.backend) inputOwner.backend->stop();
  if (returnOwner.backend) returnOwner.backend->stop();
  synthetic.stop();
  history.stop();
  if (!o.dumpPrefix.empty()) {
    const auto cell=std::string(o.syntheticSource?"synthetic-":"")+(direct?"direct":"history")+"."+std::to_string(period);
    dump(o,captureDiagnostics,diagnosticStart,cell,"capture");
    dump(o,outputDiagnostics,diagnosticStart,cell,"output");
  }
  const auto drops=(inputOwner.backend?inputOwner.backend->renderSliceDrops()-inputDropsBaseline:0)+
                   (returnOwner.backend?returnOwner.backend->renderSliceDrops()-returnDropsBaseline:0);
  const auto historyDiscontinuities=history.status().discontinuities-historyBaseline;
  const auto xruns=final.xruns-baseline.xruns;
  const auto failures=final.renderFailures-baseline.renderFailures;
  const auto invalid=final.invalidCallbacks-baseline.invalidCallbacks;
  const auto deadline=final.deadlineMisses-baseline.deadlineMisses;
  const auto timestampErrors=capture.anchor.jumps+renderer.anchor.jumps+capture.unknown+
     renderer.invalid+capture.invalid+renderer.discontinuities+capture.appendFailures+returned.anchor.jumps+returned.unknown+
     returned.invalid+historyDiscontinuities;
  const auto missing=renderer.missing+capture.anchor.inferredMissing;
  const auto tolerance=ms::frameNs(period*2,rate);
  const bool complete=healthy && !interrupted && !captureDiagnostics.dropped && !outputDiagnostics.dropped && renderer.firstMeasuredNs &&
    renderer.firstMeasuredNs<=measureBegin+tolerance && renderer.lastMeasuredEndNs+tolerance>=measureEnd &&
    renderer.smallestPeriod==period && renderer.largestPeriod==period &&
    final.routeGeneration==baseline.routeGeneration && final.streamGeneration==baseline.streamGeneration;
  const auto g1=ms::continuity(o.gates,o.seconds,renderer.callbacks,missing,timestampErrors,
                              xruns+failures+invalid+deadline+drops,o.bed && !o.mute,complete);
  ms::WaveformResult wave;
  if (waveform) wave=ms::correlate({sourcePoints.data(),sourceRecord.used},{returnPoints.data(),returnRecord.used},
                                  calibrationBegin,returned.rate,o.maxLag,o.correlation,o.controlRmsLimit);
  const bool waveformHardware=sourceRecord.hardwareTimestamps && returnRecord.hardwareTimestamps && renderer.calibrationHardware;
  wave.measured=wave.measured && waveformHardware;
  // Virtual source bypasses the physical input converter; it cannot qualify
  // the owner's physical microphone round-trip gate, even with a return.
  const auto g2=ms::latency(o.gates,wave.delayMs,wave.measured && !o.virtualSource && !o.syntheticSource,same && period<=64);
  std::cout << std::fixed << std::setprecision(5)
    << "mode | topology | period | waveform_ms | timestamp_estimate_ms | missing | xruns | G1 | G2 | G3\n"
    << (direct?"DIRECT":"HISTORY") << " | " << (same?"same":"cross") << " | " << period << " | ";
  if (wave.measured) std::cout << wave.delayMs; else std::cout << "NOT MEASURED";
  std::cout << " | ";
  if (renderer.timestampLatencyMs.n) std::cout << renderer.timestampLatencyMs.mean; else std::cout << "NOT MEASURED";
  std::cout << " | " << missing << " | " << xruns << " | " << ms::name(g1) << " | " << ms::name(g2)
            << " | " << ((!same && g1==ms::Verdict::Fail)?"FAIL":"NOT MEASURED") << '\n';
  const auto pathLatency=ms::pathComparison(o.gates,wave.delayMs,wave.measured,same,period,direct,o.virtualSource || o.syntheticSource);
  std::cout << "waveform path comparison gate: " << ms::name(pathLatency)
    << "; capture-to-return G2=" << ms::name(g2)
    << "; G3 requires independent-clock equal/different-rate receipts and owner ceiling\n";
  std::cout << "callbacks=" << renderer.callbacks << " measured_frames=" << renderer.measuredFrames
    << " observed_period_min=" << renderer.smallestPeriod << " max=" << renderer.largestPeriod
    << " counted_silence=" << renderer.missing << " inferred_capture_missing=" << capture.anchor.inferredMissing
    << " capture_anchor_jumps=" << capture.anchor.jumps << " output_anchor_jumps=" << renderer.anchor.jumps
    << " timestamp_errors=" << timestampErrors << " estimated_capture_blocks=" << capture.estimated
    << " estimated_output_blocks=" << renderer.timestampEstimates << " discontinuities=" << renderer.discontinuities
    << " history_discontinuities=" << historyDiscontinuities << " render_failures=" << failures << " deadline_misses=" << deadline << " capture_slice_drops=" << drops << '\n';
  const auto historyStatus=history.status();
  std::cout << "history_measured_input_hz=" << (direct?0:historyStatus.measuredRate)
    << " phase_corrections=" << historyStatus.phaseCorrections
    << " corrected_samples=" << historyStatus.correctedSamples
    << " rejected_intervals=" << historyStatus.rejectedIntervals << '\n';
  moments("measured_output_hz",renderer.outputRateHz);
  moments("queue_occupancy_ms",renderer.occupancyMs);
  moments("callback_arrival_jitter_ms",renderer.callbackJitterMs);
  moments("output_callback_thread_cpu_percent (includes history/resampler and measurement overhead)",renderer.cpuPercent);
  std::cout << "cpu_clock_failures=" << renderer.cpuFailures << " waveform_windows=" << wave.windows
    << " minimum_correlation=" << wave.minCorrelation << " delay_spread_ms=" << wave.spreadMs
    << " measured_duration_s=" << (renderer.lastMeasuredEndNs>renderer.firstMeasuredNs ?
       (renderer.lastMeasuredEndNs-renderer.firstMeasuredNs)/1e9 : 0)
    << " host_buffer_warnings=" << host.status().bufferWarnings
    << " input_buffer_warnings=" << (inputOwner.backend?inputOwner.backend->bufferWarnings():0)
    << " waveform_hardware_timestamps=" << waveformHardware << " correlation_threshold=" << o.correlation << " control_rms_limit=" << o.controlRmsLimit
    << " muted_control_correlation=" << wave.controlCorrelation << " muted_control_rms=" << wave.controlRms << " muted_control=" << (wave.controlSilent?"PASS":"NOT MEASURED") << '\n';
  if (captureDiagnostics.dropped || outputDiagnostics.dropped) failure="Diagnostic row capacity exceeded";
  if (!complete) { std::cerr << "Incomplete cell: " << failure << '\n'; return 2; }
  return g1==ms::Verdict::Fail || g2==ms::Verdict::Fail || pathLatency==ms::Verdict::Fail?1:0;
}
}
int main(int argc,char** argv) {
  try {
    const auto o=parse(argc,argv);
    if (o.help || (!o.list && !o.run)) { usage(); return 0; }
    if (o.run && ((o.input.empty() && !o.syntheticSource) || o.output.empty() || o.mute==o.audible || !o.bufferConsent))
      throw std::runtime_error("--run requires --input (unless synthetic), --output, --allow-buffer-change and exactly one of --mute-output/--audible");
#if !defined(__APPLE__)
    if (o.run) throw std::runtime_error("Hardware spike is macOS-first; use portable tests on this platform");
#endif
    singz::AudioHost inventoryHost; const auto inventory=inventoryHost.enumerate();
    if (o.list) {
      for (const auto& d:inventory.devices)
        std::cout << d.label << "\tuid=" << d.uid << "\tinput=" << d.inputChannels << " output=" << d.outputChannels
                  << " hz=" << d.nominalSampleRate << " period=" << d.bufferFrames.preferredFrames
                  << " transport=" << static_cast<uint32_t>(d.transport) << '\n';
      if (!o.run) return 0;
    }
    const auto& out=select(inventory,o.output,false);
    const auto& in=o.syntheticSource?out:select(inventory,o.input,true);
    if (o.loopbackChannel!=UINT32_MAX && o.mute)
      throw std::runtime_error("Loopback waveform mode requires --audible");
    if (!o.syntheticSource && in.uid!=out.uid && o.mode!="history") throw std::runtime_error("Cross-device runs require --mode history");
    ms::installTerminationHandlers();
    int result=0;
    for (auto period:o.periods) {
      if (o.mode!="direct") result=std::max(result,runCell(o,in,out,period,false));
      if (interrupted) break;
      if (o.mode!="history") result=std::max(result,runCell(o,in,out,period,true));
      if (interrupted) break;
    }
    return result;
  } catch (const std::exception& e) { std::cerr << "monitor spike: " << e.what() << '\n'; return 2; }
}
