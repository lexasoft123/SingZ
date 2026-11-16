#include "take_conform.h"
#include "file_path.h"
#include <signalsmith-stretch.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <cerrno>
#include <cstdlib>
#include <filesystem>
#include <memory>
#include <numeric>
#include <stdexcept>
#if defined(_WIN32)
#include <io.h>
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <unistd.h>
#endif

namespace singz {
namespace {
constexpr uint64_t kMaxSongSeconds=36000;
constexpr uint64_t kMaximumWavFrames=(uint64_t(UINT32_MAX)-36)/2;
constexpr size_t kBlock=128,kIoBytes=65536;
constexpr double kClockDriftTolerance=1e-3;
constexpr float kProcessingFloor=1e-8F;
void require(bool ok,const char *message,TakeConformFailure code=TakeConformFailure::ConformError) { if (!ok) throw TakeConformError(code,message); }
struct Budget {
  const std::atomic<bool> *cancel;
  std::chrono::steady_clock::time_point deadline{std::chrono::steady_clock::now()+std::chrono::minutes(8)};
};
void checkpoint(const Budget &b) {
  if (b.cancel && b.cancel->load(std::memory_order_relaxed)) throw TakeConformError(TakeConformFailure::Cancelled,"Take conform cancelled");
  if (std::chrono::steady_clock::now()>b.deadline) throw std::runtime_error("Take conform exceeded eight-minute work budget");
}
bool rateValid(uint32_t r) { return r>=8000 && r<=192000; }
uint32_t u32(const unsigned char *p) { return p[0]|uint32_t(p[1])<<8|uint32_t(p[2])<<16|uint32_t(p[3])<<24; }
void put32(unsigned char *p,uint32_t v) { for (int i=0;i<4;++i) p[i]=static_cast<unsigned char>(v>>(i*8)); }
std::array<unsigned char,44> header(uint32_t rate,uint64_t frames) {
  require(frames<=kMaximumWavFrames,"Conform WAV exceeds RIFF bounds",TakeConformFailure::MemoryBudget);
  std::array<unsigned char,44> h{};
  std::memcpy(h.data(),"RIFF",4);put32(h.data()+4,static_cast<uint32_t>(frames*2+36));
  std::memcpy(h.data()+8,"WAVEfmt ",8);put32(h.data()+16,16);h[20]=1;h[22]=1;
  put32(h.data()+24,rate);put32(h.data()+28,rate*2);h[32]=2;h[34]=16;
  std::memcpy(h.data()+36,"data",4);put32(h.data()+40,static_cast<uint32_t>(frames*2));return h;
}
std::filesystem::path nativePath(const std::string &path) {
  try { return nativeFilePath(path); }
  catch(const FilePathError &e) {throw TakeConformError(e.code()!=FilePathFailure::InvalidPath?TakeConformFailure::PathTooLong:TakeConformFailure::ConformError,e.what());}
}
struct CloseFile { void operator()(std::FILE *f) const { if (f) std::fclose(f); } };
using File=std::unique_ptr<std::FILE,CloseFile>;
File openFile(const std::filesystem::path &path,bool output) {
#if defined(_WIN32)
  File f(_wfopen(path.c_str(),output?L"wbx":L"rb"));
#else
  File f(std::fopen(path.c_str(),output?"wbx":"rb"));
#endif
  if (!f) {
    const int error=errno;
    bool tooLong=error==ENAMETOOLONG;
#if defined(_WIN32)
    unsigned long systemError=0;_get_doserrno(&systemError);tooLong=tooLong || systemError==ERROR_FILENAME_EXCED_RANGE;
#endif
    throw TakeConformError(tooLong?TakeConformFailure::PathTooLong:TakeConformFailure::ConformError,
      tooLong?"Conform path exceeds filesystem length limits":output?"Cannot create conform temporary WAV":"Cannot open take WAV");
  }
  return f;
}
void seek(std::FILE *f,uint64_t position) {
#if defined(_WIN32)
  require(_fseeki64(f,static_cast<int64_t>(position),SEEK_SET)==0,"Cannot seek conform WAV");
#else
  require(fseeko(f,static_cast<off_t>(position),SEEK_SET)==0,"Cannot seek conform WAV");
#endif
}
void sync(std::FILE *f) {
  require(std::fflush(f)==0,"Cannot flush conform WAV");
#if defined(_WIN32)
  require(_commit(_fileno(f))==0,"Cannot sync conform WAV");
#else
  require(fsync(fileno(f))==0,"Cannot sync conform WAV");
#endif
}
class WavSource {
 public:
  explicit WavSource(const std::string &path):path_(nativePath(path)),file_(openFile(path_,false)) {
    require(std::fread(header_.data(),1,44,file_.get())==44,"Truncated take WAV header");
    const auto *h=header_.data();
    require(std::memcmp(h,"RIFF",4)==0 && std::memcmp(h+8,"WAVEfmt ",8)==0 && u32(h+16)==16 &&
      h[20]==1 && h[21]==0 && h[22]==1 && h[23]==0 && h[32]==2 && h[33]==0 && h[34]==16 && h[35]==0 &&
      std::memcmp(h+36,"data",4)==0,"Conform requires canonical PCM16 mono WAV");
    rate_=u32(h+24);const uint64_t bytes=u32(h+40);frames_=bytes/2;
    require(frames_<=kMaximumWavFrames,"Take WAV exceeds RIFF bounds",TakeConformFailure::MemoryBudget);
    require(rateValid(rate_) && bytes%2==0 && frames_<=kMaximumWavFrames && u32(h+28)==rate_*2 && u32(h+4)==bytes+36,"Invalid conform WAV length/rate");
    require(frames_<=kTakeConformMaximumSeconds*rate_,"Take exceeds four-hour conform limit",TakeConformFailure::TakeTooLong);
    size_=std::filesystem::file_size(path_);modified_=std::filesystem::last_write_time(path_);
    require(size_==bytes+44,"Truncated or oversized conform WAV");
  }
  uint32_t rate() const { return rate_; }
  uint64_t frames() const { return frames_; }
  int peak(const Budget &budget) {
    int maximum=0;seek(file_.get(),44);
    for (uint64_t offset=0;offset<frames_;) {
      checkpoint(budget);const size_t count=static_cast<size_t>(std::min<uint64_t>(kIoBytes/2,frames_-offset));
      require(std::fread(pages_[0].data(),2,count,file_.get())==count,"Truncated take WAV during peak scan");
      for (size_t i=0;i<count;++i) maximum=std::max(maximum,std::abs(int(decode(pages_[0].data()+i*2))));
      offset+=count;
    }
    pageIds_.fill(UINT64_MAX);verify();return maximum;
  }
  int16_t pcm(uint64_t frame) {
    const uint64_t page=frame/(kIoBytes/2);const size_t slot=page%pages_.size();
    if (pageIds_[slot]!=page) {
      const uint64_t base=page*(kIoBytes/2);
      const size_t count=static_cast<size_t>(std::min<uint64_t>(kIoBytes/2,frames_-base));
      seek(file_.get(),44+base*2);
      require(std::fread(pages_[slot].data(),2,count,file_.get())==count,"Truncated take WAV during conform");
      pageIds_[slot]=page;
    }
    return decode(pages_[slot].data()+(frame%(kIoBytes/2))*2);
  }
  float sample(int64_t frame) { return frame>=0 && uint64_t(frame)<frames_?pcm(static_cast<uint64_t>(frame))/32768.0F:0; }
  void verify() {
    require(std::filesystem::file_size(path_)==size_ && std::filesystem::last_write_time(path_)==modified_,"Take WAV changed during conform");
    std::array<unsigned char,44> h{};seek(file_.get(),0);
    require(std::fread(h.data(),1,h.size(),file_.get())==h.size() && h==header_,"Take WAV header changed during conform");
    pageIds_.fill(UINT64_MAX);
  }
 private:
  static int16_t decode(const unsigned char *p) { return static_cast<int16_t>(uint16_t(p[0])|uint16_t(p[1])<<8); }
  std::filesystem::path path_;File file_;
  uint32_t rate_{};uint64_t frames_{},size_{};
  std::filesystem::file_time_type modified_;
  std::array<unsigned char,44> header_{};
  std::array<std::array<unsigned char,kIoBytes>,2> pages_{};
  std::array<uint64_t,2> pageIds_{UINT64_MAX,UINT64_MAX};
};
class WavDestination {
 public:
  WavDestination(const std::string &path,uint32_t rate,const Budget &budget)
    :path_(nativePath(path)),file_(openFile(path_,true)),rate_(rate),budget_(budget) {
    const auto h=header(rate,0);
    if (std::fwrite(h.data(),1,h.size(),file_.get())!=h.size()) {
      file_.reset();std::error_code ignored;std::filesystem::remove(path_,ignored);throw std::runtime_error("Cannot write conform header");
    }
  }
  ~WavDestination() { file_.reset();if (!keep_) {std::error_code ignored;std::filesystem::remove(path_,ignored);} }
  void put(int16_t sample) {
    const uint16_t v=static_cast<uint16_t>(sample);buffer_[used_++]=static_cast<unsigned char>(v);buffer_[used_++]=static_cast<unsigned char>(v>>8);
    ++frames_;if (used_==buffer_.size()) flush();
  }
  void zeros(uint64_t count) { for (uint64_t i=0;i<count;++i) put(0); }
  uint64_t frames() const { return frames_; }
  void finish() {
    flush();const auto h=header(rate_,frames_);seek(file_.get(),0);
    require(std::fwrite(h.data(),1,h.size(),file_.get())==h.size(),"Cannot patch conform WAV header");sync(file_.get());
    require(std::fclose(file_.release())==0,"Cannot close conform WAV");
  }
  void keep() { keep_=true; }
 private:
  void flush() { checkpoint(budget_);require(std::fwrite(buffer_.data(),1,used_,file_.get())==used_,"Cannot write conform WAV (disk full)");used_=0; }
  std::filesystem::path path_;File file_;uint32_t rate_;const Budget &budget_;
  std::array<unsigned char,kIoBytes> buffer_{};size_t used_{};uint64_t frames_{};bool keep_{};
};
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
int16_t quantise(float sample) { return static_cast<int16_t>(std::clamp(std::lround(double(sample)*32768),-32768L,32767L)); }
// Same coefficients, accumulation order, priming and flush as pinned zCore's
// Resampler. Generate/cache at most 1 MiB of phases instead of retaining up*taps
// floats (18+ MiB for coprime rates). This changes storage, never output bytes.
class RateConverter {
 public:
  RateConverter(uint32_t source,uint32_t destination) {
    const auto divisor=std::gcd(source,destination);up_=destination/divisor;down_=source/divisor;
    const uint64_t netDown=down_/up_;taps_=netDown>=2?static_cast<int>(32*netDown)+1:24;
    cacheSize_=std::min<uint32_t>(up_,(1024u*1024u)/(sizeof(float)*taps_));coefficients_.resize(size_t(cacheSize_)*taps_);phaseIds_.assign(cacheSize_,UINT32_MAX);
    history_.assign(taps_-1,0);const int64_t n=int64_t(taps_)*up_;center_=(double(n)-1)/2;
    cutoff_=(netDown>=2?0.97:1.0)*0.5/std::max(up_,down_);beta_=netDown>=2?9.0:10.056;denominator_=bessel(beta_);
  }
  int64_t latency() const { return int64_t(3)*(taps_-1)/2*up_/down_; }
  void process(const float *input,size_t count,std::vector<float> &out) {
    const int hist=taps_-1;work_.resize(history_.size()+count);
    std::copy(history_.begin(),history_.end(),work_.begin());std::copy_n(input,count,work_.begin()+hist);
    const int64_t frames=hist+static_cast<int64_t>(count);
    for (;;) {
      const int64_t base=phase_/up_;if (base>=frames) break;
      const uint32_t poly=static_cast<uint32_t>(phase_%up_);const float *filter=coefficients(poly);double sum=0;
      for (int j=0;j<taps_;++j) {const int64_t frame=base-j;if (frame<0) break;sum+=double(filter[j])*work_[frame];}
      out.push_back(static_cast<float>(sum));phase_+=down_;
    }
    phase_-=static_cast<int64_t>(count)*up_;
    std::copy(work_.end()-hist,work_.end(),history_.begin());
  }
  void finish(std::vector<float> &out) { std::vector<float> zeros(taps_,0);process(zeros.data(),zeros.size(),out); }
 private:
  static double bessel(double x) { double sum=1,term=1,half=x/2;for(int k=1;k<64;++k){term*=(half/k)*(half/k);sum+=term;if(term<1e-12*sum)break;}return sum; }
  const float *coefficients(uint32_t phase) {
    const uint32_t slot=phase%cacheSize_;float *values=coefficients_.data()+size_t(slot)*taps_;
    if (phaseIds_[slot]!=phase) {
      for (int j=0;j<taps_;++j) {
        const int64_t i=int64_t(j)*up_+phase;const double t=double(i)-center_,argument=2*cutoff_*t;
        const double sinc=argument==0?1.0:std::sin(3.14159265358979323846*argument)/(3.14159265358979323846*argument);
        const double fraction=t/center_,window=bessel(beta_*std::sqrt(std::max(0.0,1-fraction*fraction)))/denominator_;
        values[j]=static_cast<float>(2*cutoff_*up_*sinc*window);
      }
      phaseIds_[slot]=phase;
    }
    return values;
  }
  uint32_t up_{},down_{},cacheSize_{};int taps_{};int64_t phase_{};
  double center_{},cutoff_{},beta_{},denominator_{};
  std::vector<float> coefficients_,history_,work_;std::vector<uint32_t> phaseIds_;
};
class PcmSink {
 public:
  PcmSink(WavDestination &destination,uint64_t duration,uint32_t inputRate,uint32_t outputRate,uint64_t body,int64_t start,float gain,const Budget &budget)
    :destination_(destination),duration_(duration),body_(body),gain_(gain),start_(start),budget_(budget) {
    if (inputRate!=outputRate) {resampler_=std::make_unique<RateConverter>(inputRate,outputRate);latency_=resampler_->latency();}
  }
  void push(const float *input,size_t count) {
    if (!resampler_) {write(input,count);return;}
    converted_.clear();resampler_->process(input,count,converted_);write(converted_.data(),converted_.size());
  }
  void finish() {
    if (resampler_) {converted_.clear();resampler_->finish(converted_);write(converted_.data(),converted_.size());}
    checkpoint(budget_);destination_.zeros(duration_-destination_.frames());
  }
 private:
  void write(const float *input,size_t count) {
    for (size_t i=0;i<count;++i,++cursor_) {
      const int64_t bodyFrame=cursor_-latency_,target=start_+bodyFrame;
      if (bodyFrame>=0 && uint64_t(bodyFrame)<body_ && target>=0 && uint64_t(target)<duration_) {
        if (uint64_t(target)>destination_.frames()) destination_.zeros(uint64_t(target)-destination_.frames());
        destination_.put(quantise(input[i]*gain_));
      }
    }
  }
  WavDestination &destination_;uint64_t duration_,body_;float gain_;int64_t start_,cursor_{0},latency_{0};const Budget &budget_;
  std::unique_ptr<RateConverter> resampler_;std::vector<float> converted_;
};
TakeConformStreamResult render(WavSource &source,WavDestination &destination,const TakeConformRequest &r,const Budget &budget) {
  require(rateValid(source.rate()) && rateValid(r.outputRate),"Invalid conform sample rate");
  require(source.frames()<=kTakeConformMaximumSeconds*source.rate(),"Take exceeds four-hour conform limit",TakeConformFailure::TakeTooLong);
  require(r.songDurationProjectFrames<=kMaxSongSeconds*r.outputRate,"Song exceeds conform limit");
  require(std::isfinite(r.startPositionSec) && std::isfinite(r.userOffsetSec) &&
    std::abs(r.startPositionSec)<=kMaxSongSeconds && std::abs(r.userOffsetSec)<=kMaxSongSeconds,"Invalid conform placement");
  require(r.anchors.size()>=2 && r.anchors.size()<=20000,"Invalid conform anchors");
  require(r.anchors.front().takeFrame==0 && r.anchors.back().takeFrame==source.frames(),"Anchors must span take");
  bool nearUnity=true,exactUnity=true;
  for (size_t i=0;i<r.anchors.size();++i) {
    const auto &a=r.anchors[i];
    require(a.takeFrame<=source.frames() && std::isfinite(a.projectFrame) &&
      std::abs(a.projectFrame)<=double(kMaxSongSeconds)*source.rate(),"Invalid conform anchor bounds");
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
    require(s.takeFrame<=source.frames() && (!i || s.takeFrame>r.settings[i-1].takeFrame) &&
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
  const uint64_t body=static_cast<uint64_t>(std::llround(map.length()*r.outputRate/source.rate()));
#ifdef SINGZ_CONFORM_NEGATIVE_PLACEMENT
  const int64_t start=0;
#else
  const int64_t start=std::llround((r.startPositionSec+r.userOffsetSec)*r.outputRate);
#endif
  const uint64_t duration=static_cast<uint64_t>(std::max<int64_t>(0,std::min<int64_t>(r.songDurationProjectFrames,start+static_cast<int64_t>(body))));
  require(duration<=kMaximumWavFrames,"Conform WAV exceeds RIFF bounds",TakeConformFailure::MemoryBudget);
  checkpoint(budget);TakeConformStreamResult result;result.durationFrames=duration;
  if (!duration || start>=static_cast<int64_t>(duration)) {destination.zeros(duration);return result;}
  const int peak=source.peak(budget);if (!peak) {destination.zeros(duration);return result;}
  if (exactUnity && zeroPitch && source.rate()==r.outputRate) {
    const uint64_t first=static_cast<uint64_t>(std::max<int64_t>(0,-start));
    const uint64_t leading=std::min<uint64_t>(duration,static_cast<uint64_t>(std::max<int64_t>(0,start)));
    destination.zeros(leading);
    for (uint64_t frame=first;frame<source.frames() && destination.frames()<duration;++frame) {
      if (frame%(kIoBytes/2)==0) checkpoint(budget);
      destination.put(source.pcm(frame));
    }
    destination.zeros(duration-destination.frames());return result;
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
  PcmSink sink(destination,result.durationFrames,source.rate(),r.outputRate,body,start,1.0F/workingGain,budget);
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
        output[i]=source.sample(lo)+(source.sample(lo+1)-source.sample(lo))*static_cast<float>(x-lo);
      }
      sink.push(output.data(),count);q+=static_cast<int64_t>(count);
    }
  } else {
    // One continuous instance across every anchor/settings boundary. The input
    // cursor is scheduled at inverse(output+outputLatency)+inputLatency, so the
    // latency compensation follows the local tempo even across a tempo seam.
    signalsmith::stretch::SignalsmithStretch<float> dsp(0x494e475aL);
    dsp.presetCheaper(1,static_cast<float>(source.rate()),true);
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
    int64_t q=-((warm+block-1)/block)*block,sourceCursor=cursorAt(q);
    double activePitch=1000;bool activeFormants=false;
    while (q<nativeBody) {
      checkpoint(budget);
      const int count=static_cast<int>(std::min<int64_t>(kBlock,nativeBody-q));
      const int64_t next=cursorAt(q+count),needed=next-sourceCursor;
      require(needed>=0 && uint64_t(needed)<=input.size(),"Conform input block exceeds bounds");
      for (int64_t i=0;i<needed;++i) input[i]=source.sample(sourceCursor+i)*workingGain+kProcessingFloor;
      const auto pitch=pitchAt(r,map.inverse(double(q)+result.outputLatencyFrames));
      if (pitch.semitones!=activePitch || pitch.formants!=activeFormants) {
        dsp.setTransposeSemitones(static_cast<float>(pitch.semitones),8000.0F/source.rate());
        dsp.setFormantFactor(1.0F,pitch.formants);activePitch=pitch.semitones;activeFormants=pitch.formants;
      }
      const float *ip[]{input.data()};float *op[]{output.data()};
      dsp.process(ip,static_cast<int>(needed),op,count);
      ++result.processedBlocks;
      const int offset=static_cast<int>(std::max<int64_t>(0,-q));
      if (offset<count) sink.push(output.data()+offset,static_cast<size_t>(count-offset));
      sourceCursor=next;q+=count;
    }
  }
  sink.finish();checkpoint(budget);return result;
}
} // namespace
std::wstring takeConformWindowsPath(const std::wstring &path) { try{return windowsFilePath(path);}catch(const FilePathError&e){throw TakeConformError(e.code()!=FilePathFailure::InvalidPath?TakeConformFailure::PathTooLong:TakeConformFailure::ConformError,e.what());} }
std::filesystem::path takeConformFilePath(const std::string &path) { return nativePath(path); }
TakeConformStreamResult conformTakeFile(const std::string &input,const std::string &temporaryOutput,const TakeConformRequest &request,const std::atomic<bool> *cancel) {
  try {
  require(input!=temporaryOutput,"Conform source and destination must differ");const Budget budget{cancel};checkpoint(budget);
  WavSource source(input);WavDestination destination(temporaryOutput,request.outputRate,budget);
  auto result=render(source,destination,request,budget);source.verify();checkpoint(budget);destination.finish();source.verify();checkpoint(budget);destination.keep();return result;
  } catch (const TakeConformError &) { throw; }
  catch (const std::filesystem::filesystem_error &e) { throw TakeConformError(e.code()==std::errc::filename_too_long?TakeConformFailure::PathTooLong:TakeConformFailure::ConformError,e.what()); }
  catch (const std::exception &e) { throw TakeConformError(TakeConformFailure::ConformError,e.what()); }
}
} // namespace singz
