#include "take_conform.h"
#include <signalsmith-stretch.h>
#include <zcore/legacy/resample.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <fstream>
#include <memory>
#include <numeric>
#include <stdexcept>

namespace singz {
namespace {
constexpr uint64_t kMaxSeconds = 600;
constexpr uint64_t kMaxSongSeconds = 36000;
constexpr size_t kBlock = 128;
constexpr double kClockDriftTolerance = 1e-3;
// Keep Signalsmith's silence shortcut from dropping its latency/history clock.
// This fixed -160 dBFS DC floor is below PCM16 quantisation, is not mixed around
// the shifter, and is also processed through pitch-follow. Exact-silent takes
// and the non-vocoded drift path never need it.
constexpr float kProcessingFloor = 1e-8F;
void require(bool condition, const char *message) {
  if (!condition) throw std::runtime_error(message);
}
struct Budget {
  const std::atomic<bool> *cancel;
  std::chrono::steady_clock::time_point deadline{std::chrono::steady_clock::now()+std::chrono::seconds(90)};
};
void checkpoint(const Budget &budget) {
  if (budget.cancel && budget.cancel->load(std::memory_order_relaxed)) throw std::runtime_error("Take conform cancelled");
  if (std::chrono::steady_clock::now() > budget.deadline) throw std::runtime_error("Take conform exceeded 90-second work budget");
}
bool rateValid(uint32_t rate) { return rate >= 8000 && rate <= 192000; }
uint32_t u32(const unsigned char *p) { return p[0] | uint32_t(p[1])<<8 | uint32_t(p[2])<<16 | uint32_t(p[3])<<24; }
void put32(std::ostream &f, uint32_t v) {
  const char b[]{char(v), char(v>>8), char(v>>16), char(v>>24)}; f.write(b, 4);
}
// The per-engine allowance matches the conservative linear envelope in
// signalsmith_time_pitch.cpp. Unlike that RT wrapper, offline conform has ONE
// engine and no seek slots or loop banks. The fixed headroom includes block
// buffers, vector capacities, anchor metadata and the rate-converter history.
uint64_t workingBytes(uint32_t inputRate, uint32_t outputRate) {
  uint64_t bytes = 8u*1024u*1024u + uint64_t(inputRate)*128u;
  if (inputRate != outputRate) {
    const uint64_t divisor = std::gcd(inputRate, outputRate);
    const uint64_t up = outputRate/divisor, down = inputRate/divisor;
    const uint64_t taps = down/up >= 2 ? 32*(down/up)+1 : 24;
    bytes += up*taps*sizeof(float);
  }
  return bytes;
}
class TakeMap {
 public:
  explicit TakeMap(const std::vector<TakeConformAnchor> &anchors) : anchors_(anchors) {}
  double length() const { return anchors_.back().projectFrame-anchors_.front().projectFrame; }
  // Extend the first/last slope for analysis warm-up and latency drain. Source
  // samples outside the take are zero, but the time map must stay continuous.
  double inverse(double project) const {
#ifdef SINGZ_CONFORM_NEGATIVE_RATIO
    return project;
#else
    const double absolute = project+anchors_.front().projectFrame;
    auto b=std::upper_bound(anchors_.begin(),anchors_.end(),absolute,
      [](double p,const auto &a){return p<a.projectFrame;});
    if (b==anchors_.begin()) ++b;
    if (b==anchors_.end()) --b;
    const auto &a=*(b-1);
    return a.takeFrame+(absolute-a.projectFrame)*(b->takeFrame-a.takeFrame)/(b->projectFrame-a.projectFrame);
#endif
  }
 private:
  const std::vector<TakeConformAnchor> &anchors_;
};
struct Pitch { double semitones{0}; bool formants{false}; };
Pitch pitchAt(const TakeConformRequest &r, double takeFrame) {
  // A terminal settings stamp owns no captured sample; latency drain must keep
  // the pitch of the last real sample rather than apply a post-take change.
  takeFrame=std::min(takeFrame,double(r.anchors.back().takeFrame)-1);
  const auto upper=std::upper_bound(r.settings.begin(),r.settings.end(),takeFrame,
    [](double f,const auto &s){return f<s.takeFrame;});
  const auto &setting=upper==r.settings.begin()?r.settings.front():*(upper-1);
  Pitch result;
  // Ordered effects. The currently supported pitch slot is fused into the
  // structural stretch, rather than adding a second phase-vocoder pass.
  for (const auto &e:r.effects) {
    if (!e.enabled) continue;
    if (e.id=="pitch-follow") { result.semitones+=-setting.transposeSemitones+e.manualOffsetSemitones; result.formants=e.preserveFormants; }
    else throw std::runtime_error("Unsupported offline conform effect");
  }
  return result;
}
float sample(const TakeConformPcm &take,int64_t frame) {
  return frame>=0 && uint64_t(frame)<take.samples.size()?take.samples[frame]/32768.0F:0;
}
int16_t quantise(float sample) {
  return static_cast<int16_t>(std::clamp(std::lround(double(sample)*32768),-32768L,32767L));
}
// Converts one continuous stream, retaining only bounded blocks; no take-sized
// float buffer or per-segment output exists. Rate-converter latency is dropped
// before placement, just like Signalsmith's latency is dropped before this sink.
class PcmSink {
 public:
  PcmSink(TakeConformResult &result,uint32_t inputRate,uint64_t body,int64_t start,float gain)
    : result_(result),body_(body),gain_(gain),start_(start) {
    if (inputRate!=result.pcm.sampleRate) {
      resampler_=std::make_unique<Resampler>(inputRate,result.pcm.sampleRate,1);
      latency_=resampler_->latencyOutFrames();
    }
  }
  void push(const float *input,size_t count) {
    if (!resampler_) { write(input,count); return; }
    converted_.clear();resampler_->process(input,static_cast<int64_t>(count),converted_);
    write(converted_.data(),converted_.size());
  }
  void finish() {
    if (resampler_) { converted_.clear();resampler_->flush(converted_);write(converted_.data(),converted_.size()); }
  }
 private:
  void write(const float *input,size_t count) {
    for (size_t i=0;i<count;++i,++cursor_) {
      const int64_t bodyFrame=cursor_-latency_;
      const int64_t destination=start_+bodyFrame;
      if (bodyFrame>=0 && uint64_t(bodyFrame)<body_ && destination>=0 && uint64_t(destination)<result_.pcm.samples.size())
        result_.pcm.samples[destination]=quantise(input[i]*gain_);
    }
  }
  TakeConformResult &result_;
  uint64_t body_;
  float gain_;
  int64_t start_,cursor_{0},latency_{0};
  std::unique_ptr<Resampler> resampler_;
  std::vector<float> converted_;
};
}

TakeConformResult conformTakePcm(const TakeConformPcm &take,const TakeConformRequest &r,
                               const std::atomic<bool> *cancel) {
  const Budget budget{cancel};
  require(rateValid(take.sampleRate) && rateValid(r.outputRate),"Invalid conform sample rate");
  require(take.samples.size()<=kMaxSeconds*take.sampleRate,"Take exceeds ten-minute conform limit");
  require(r.songDurationProjectFrames<=kMaxSongSeconds*r.outputRate && r.songDurationProjectFrames<=(256u*1024u*1024u-44u)/2,"Song exceeds conform limit");
  require(std::isfinite(r.startPositionSec) && std::isfinite(r.userOffsetSec) &&
    std::abs(r.startPositionSec)<=kMaxSongSeconds && std::abs(r.userOffsetSec)<=kMaxSongSeconds,"Invalid conform placement");
  require(r.anchors.size()>=2 && r.anchors.size()<=20000,"Invalid conform anchors");
  require(r.anchors.front().takeFrame==0 && r.anchors.back().takeFrame==take.samples.size(),"Anchors must span take");
  bool nearUnity=true,exactUnity=true;
  for (size_t i=0;i<r.anchors.size();++i) {
    const auto &a=r.anchors[i];
    require(a.takeFrame<=take.samples.size() && std::isfinite(a.projectFrame) &&
      std::abs(a.projectFrame)<=double(kMaxSongSeconds)*take.sampleRate,"Invalid conform anchor bounds");
    if (!i) continue;
    const auto &p=r.anchors[i-1];
    require(a.takeFrame>p.takeFrame && a.projectFrame>p.projectFrame,"Conform anchors must increase");
    const double ratio=(a.projectFrame-p.projectFrame)/(a.takeFrame-p.takeFrame);
    require(ratio>=0.2 && ratio<=5,"Conform anchor ratio exceeds bounds");
    nearUnity=nearUnity && std::abs(ratio-1)<kClockDriftTolerance;
    exactUnity=exactUnity && a.projectFrame-p.projectFrame==double(a.takeFrame-p.takeFrame);
  }
  require(!r.settings.empty() && r.settings.size()<=20000 && r.settings.front().takeFrame==0,"Invalid conform settings");
  for (size_t i=0;i<r.settings.size();++i) {
    const auto &s=r.settings[i];
    require(s.takeFrame<=take.samples.size() && (!i || s.takeFrame>r.settings[i-1].takeFrame) &&
      std::isfinite(s.transposeSemitones) && std::abs(s.transposeSemitones)<=24,"Invalid conform recorded pitch");
  }
  require(r.effects.size()<=16,"Too many conform effects");
  std::vector<std::string> effectIds;
  for (const auto &e:r.effects) {
    require(e.id=="pitch-follow" && std::isfinite(e.manualOffsetSemitones) && std::abs(e.manualOffsetSemitones)<=24,"Invalid conform effect");
    require(std::find(effectIds.begin(),effectIds.end(),e.id)==effectIds.end(),"Duplicate conform effect slot");effectIds.push_back(e.id);
  }
  bool zeroPitch=true;
  for (const auto &s:r.settings) zeroPitch=zeroPitch && pitchAt(r,s.takeFrame).semitones==0;
  const TakeMap map(r.anchors);
  const uint64_t body=static_cast<uint64_t>(std::llround(map.length()*r.outputRate/take.sampleRate));
#ifdef SINGZ_CONFORM_NEGATIVE_PLACEMENT
  const int64_t start=0;
#else
  const int64_t start=std::llround((r.startPositionSec+r.userOffsetSec)*r.outputRate);
#endif
  const uint64_t duration=static_cast<uint64_t>(std::max<int64_t>(0,std::min<int64_t>(r.songDurationProjectFrames,start+static_cast<int64_t>(body))));
  require(take.samples.capacity()<=kTakeConformMaximumResidentBytes/sizeof(int16_t),"Take conform memory budget exceeded");
  const uint64_t admitted=uint64_t(take.samples.capacity())*sizeof(int16_t)+duration*sizeof(int16_t)+workingBytes(take.sampleRate,r.outputRate);
  require(admitted<=kTakeConformMaximumResidentBytes,"Take conform memory budget exceeded");
  checkpoint(budget);
  TakeConformResult result;
  result.estimatedPeakBytes=admitted;result.pcm.sampleRate=r.outputRate;result.pcm.samples.resize(duration,0);
  if (!duration || start>=static_cast<int64_t>(duration)) return result;
  int peak=0;for (const auto value:take.samples) peak=std::max(peak,std::abs(int(value)));
  if (!peak) return result;
  if (exactUnity && zeroPitch && take.sampleRate==r.outputRate) {
    const size_t source=static_cast<size_t>(std::max<int64_t>(0,-start)),destination=static_cast<size_t>(std::max<int64_t>(0,start));
    if (source<take.samples.size() && destination<duration)
      std::copy_n(take.samples.begin()+source,std::min(take.samples.size()-source,size_t(duration)-destination),result.pcm.samples.begin()+destination);
    checkpoint(budget);return result;
  }
  // The capture/output clocks can disagree by a frame at periodic anchors.
  // Such drift needs only direct interpolation, never a phase-vocoder pass.
  bool direct=nearUnity && zeroPitch;
#ifdef SINGZ_CONFORM_NEGATIVE_DRIFT
  direct=exactUnity && zeroPitch;
#endif
  // The backend uses absolute spectral noise floors. Normalise quiet takes to
  // ordinary working level, then undo that gain at quantisation; this prevents
  // low-level clicks/voice from taking a different numerical/noise-floor path.
  const float workingGain=!direct && peak<16384?16384.0F/peak:1.0F;
  PcmSink sink(result,take.sampleRate,body,start,1.0F/workingGain);
  // Keep the final fractional native-rate frame for the output-rate converter;
  // the sink still trims to the once-rounded output-domain body length.
  const int64_t nativeBody=static_cast<int64_t>(std::ceil(map.length()));
  std::array<float,kBlock> output{};
  if (direct) {
    for (int64_t q=0;q<nativeBody;) {
      checkpoint(budget);
      const size_t count=static_cast<size_t>(std::min<int64_t>(kBlock,nativeBody-q));
      for (size_t i=0;i<count;++i) {
        const double x=map.inverse(double(q)+i);const int64_t lo=static_cast<int64_t>(std::floor(x));
        output[i]=sample(take,lo)+(sample(take,lo+1)-sample(take,lo))*static_cast<float>(x-lo);
      }
      sink.push(output.data(),count);q+=static_cast<int64_t>(count);
    }
  } else {
    // One continuous instance across every anchor/settings boundary. The input
    // cursor is scheduled at inverse(output+outputLatency)+inputLatency, so the
    // latency compensation follows the local tempo even across a tempo seam.
    signalsmith::stretch::SignalsmithStretch<float> dsp(0x494e475aL);
    dsp.presetCheaper(1,static_cast<float>(take.sampleRate),true);
    result.signalsmithPasses=1;result.inputLatencyFrames=dsp.inputLatency();result.outputLatencyFrames=dsp.outputLatency();
    std::array<float,kBlock*5+2> input{};
    const auto cursorAt=[&](int64_t q) {
#ifdef SINGZ_CONFORM_NEGATIVE_LATENCY
      return std::llround(map.inverse(double(q)));
#else
      return std::llround(map.inverse(double(q)+result.outputLatencyFrames)+result.inputLatencyFrames);
#endif
    };
    const int64_t warm=5*(2*dsp.blockSamples()+dsp.inputLatency())+dsp.outputLatency();
    const int64_t block=static_cast<int64_t>(kBlock);
    int64_t q=-((warm+block-1)/block)*block,source=cursorAt(q);
    double activePitch=1000;bool activeFormants=false;
    while (q<nativeBody) {
      checkpoint(budget);
      const int count=static_cast<int>(std::min<int64_t>(kBlock,nativeBody-q));
      const int64_t next=cursorAt(q+count),needed=next-source;
      require(needed>=0 && uint64_t(needed)<=input.size(),"Conform input block exceeds bounds");
      for (int64_t i=0;i<needed;++i) input[i]=sample(take,source+i)*workingGain+kProcessingFloor;
      const auto pitch=pitchAt(r,map.inverse(double(q)+result.outputLatencyFrames));
      if (pitch.semitones!=activePitch || pitch.formants!=activeFormants) {
        dsp.setTransposeSemitones(static_cast<float>(pitch.semitones),8000.0F/take.sampleRate);
        dsp.setFormantFactor(1.0F,pitch.formants);activePitch=pitch.semitones;activeFormants=pitch.formants;
      }
      const float *ip[]{input.data()};float *op[]{output.data()};
      dsp.process(ip,static_cast<int>(needed),op,count);
      ++result.processedBlocks;
      const int offset=static_cast<int>(std::max<int64_t>(0,-q));
      if (offset<count) sink.push(output.data()+offset,static_cast<size_t>(count-offset));
      source=next;q+=count;
    }
  }
  sink.finish();checkpoint(budget);return result;
}

TakeConformPcm readTakeConformWav(const std::string &path) {
  std::ifstream f(path, std::ios::binary);
  unsigned char h[44]{}; f.read(reinterpret_cast<char *>(h), 44);
  require(f.gcount() == 44 && std::string(reinterpret_cast<char *>(h), 4) == "RIFF" &&
    std::string(reinterpret_cast<char *>(h+8), 8) == "WAVEfmt " && u32(h+16) == 16 &&
    h[20] == 1 && h[21] == 0 && h[22] == 1 && h[23] == 0 && h[32] == 2 && h[33] == 0 && h[34] == 16 && h[35] == 0 &&
    std::string(reinterpret_cast<char *>(h+36), 4) == "data", "Conform requires canonical PCM16 mono WAV");
  const uint32_t rate = u32(h+24), bytes = u32(h+40);
  require(rateValid(rate) && bytes%2 == 0 && bytes/2 <= kMaxSeconds*rate && u32(h+28) == rate*2 && u32(h+4) == bytes+36, "Invalid conform WAV length/rate");
  require(uint64_t(bytes)+workingBytes(rate,rate)<=kTakeConformMaximumResidentBytes, "Take conform memory budget exceeded");
  TakeConformPcm result{rate, std::vector<int16_t>(bytes/2)};
  std::vector<unsigned char> block(65536);
  for (size_t offset=0; offset<result.samples.size();) {
    const size_t count = std::min(block.size()/2, result.samples.size()-offset);
    f.read(reinterpret_cast<char *>(block.data()), static_cast<std::streamsize>(count*2));
    require(static_cast<size_t>(f.gcount()) == count*2, "Truncated conform WAV");
    for (size_t i=0; i<count; ++i) result.samples[offset+i] = static_cast<int16_t>(uint16_t(block[i*2]) | uint16_t(block[i*2+1])<<8);
    offset += count;
  }
  require(bool(f) && f.peek() == std::char_traits<char>::eof(), "Truncated or oversized conform WAV");
  return result;
}
void writeTakeConformWav(const std::string &path, const TakeConformPcm &pcm) {
  require(rateValid(pcm.sampleRate) && pcm.samples.size() <= (UINT32_MAX-36)/2, "Conform WAV exceeds RIFF bounds");
  std::ofstream f(path, std::ios::binary | std::ios::trunc);
  const uint32_t bytes = static_cast<uint32_t>(pcm.samples.size()*2);
  f.write("RIFF", 4); put32(f, bytes+36); f.write("WAVEfmt ", 8); put32(f, 16);
  f.write("\x01\x00\x01\x00", 4); put32(f, pcm.sampleRate); put32(f, pcm.sampleRate*2);
  f.write("\x02\x00\x10\x00", 4); f.write("data", 4); put32(f, bytes);
  std::vector<char> block(65536);
  for (size_t offset=0; offset<pcm.samples.size();) {
    const size_t count = std::min(block.size()/2, pcm.samples.size()-offset);
    for (size_t i=0; i<count; ++i) { const uint16_t v = static_cast<uint16_t>(pcm.samples[offset+i]); block[i*2]=char(v); block[i*2+1]=char(v>>8); }
    f.write(block.data(), static_cast<std::streamsize>(count*2)); offset += count;
  }
  f.flush(); require(bool(f), "Could not write conformed WAV (disk full or unavailable)");
}
} // namespace singz
