#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif
// Private GPUI bridge, protocol 1. Commands are bounded ASCII lines; audio
// sources arrive as argv paths, never shell text. The shared session owns DSP.
#include <native_playback_session.h>
#include <shared_audio_service.h>
#include <training_pcm_mixer.h>
#include <training_phrase_renderer.h>
#include <lane_measure.h>
#include <zcore/media/wav.h>
#include <zcore/media/flac_io.h>
#include <zcore/media/streaming_audio_source.h>
#include <zcore/media/audio_export.h>
#include <zcore/device/audio_host_fake.h>
#include "json_string.h"
#include "gpui_playback_graph.h"
#include "gpui_audio_provider.h"
#include <cmath>
#include <algorithm>
#include <chrono>
#include <thread>
#include <filesystem>
#include <cstdlib>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <string>
#include <vector>
#include <charconv>
#include <cerrno>
#include <atomic>
#include <array>
#include <stdexcept>
#include <functional>
#include <cctype>
#include <sys/stat.h>
#if defined(__APPLE__)
#include <mach/mach_time.h>
#endif
#if defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#else
#include <fcntl.h>
#include <poll.h>
#include <unistd.h>
#endif

int duplicateSource(int fd) {
#if defined(_WIN32)
  return _dup(fd);
#else
  return ::dup(fd);
#endif
}

uint64_t cueClockNs() noexcept {
#if defined(__APPLE__)
  static const auto scale=[] { mach_timebase_info_data_t value{}; mach_timebase_info(&value); return value; }();
  return static_cast<uint64_t>(static_cast<long double>(mach_absolute_time())*scale.numer/scale.denom);
#elif defined(_WIN32)
  static const auto frequency=[] { LARGE_INTEGER value{}; QueryPerformanceFrequency(&value); return value.QuadPart; }();
  LARGE_INTEGER value{}; QueryPerformanceCounter(&value);
  return static_cast<uint64_t>(static_cast<long double>(value.QuadPart)*1000000000/frequency);
#else
  return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
bool readCueGeneration(std::istream& input,uint64_t& generation) {
  std::string token;if(!(input>>token) || token.empty() || token.size()>20 ||
    !std::all_of(token.begin(),token.end(),[](char c){return c>='0'&&c<='9';}))return false;
  const auto parsed=std::from_chars(token.data(),token.data()+token.size(),generation);
  return parsed.ec==std::errc{} && parsed.ptr==token.data()+token.size() && generation>0;
}

// Multi-line private cue transactions keep every IPC line bounded. Nothing is
// visible to the callback until the complete candidate passes the shared planner.
struct MetronomeDraft {
  singz::PlaybackCuePlanRequest request;
  size_t beats{0}, bars{0};
};
struct CarryPlan {
  bool enabled{false};
  unsigned mode{0};
  double period{0};
  std::vector<std::string> laneIds;
  std::vector<std::pair<double,double>> windows;
};
struct CarryDraft {
  CarryPlan plan;
  size_t lanes{0},windows{0};
  bool arm{true};
};
std::optional<singz::NativePlaybackTrainingDuckConfig> nativeCarry(
    const std::optional<CarryPlan>& plan,double rate,const std::vector<std::string>& available) {
  if(!plan || rate<=0)return {};
  singz::NativePlaybackTrainingDuckConfig config;
  config.mode=static_cast<singz::NativePlaybackTrainingMode>(plan->mode);
  config.enabled=plan->enabled;
  config.periodFrames=static_cast<int64_t>(std::floor(plan->period*rate+0.5));
  for(const auto& id:plan->laneIds)if(std::find(available.begin(),available.end(),id)!=available.end())config.laneIds.push_back(id);
  if(config.laneIds.empty() || (plan->mode==1 && plan->windows.empty()))return {};
  for(const auto& window:plan->windows)config.windows.push_back({static_cast<int64_t>(std::floor(window.first*rate+0.5)),static_cast<int64_t>(std::floor(window.second*rate+0.5))});
  return config;
}
struct LaneManifest {
  size_t count{0};
  std::vector<std::pair<std::string,std::string>> sources;
};
bool decodeManifestText(const std::string& hex,size_t maximum,std::string& text) {
  if(hex.empty() || hex.size()%2 || hex.size()>maximum*2)return false;
  text.clear();text.reserve(hex.size()/2);
  const auto digit=[](char c)->int {if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;};
  for(size_t i=0;i<hex.size();i+=2){const int a=digit(hex[i]),b=digit(hex[i+1]);if(a<0||b<0)return false;const auto c=static_cast<unsigned char>(a*16+b);if(c<32||c==127)return false;text.push_back(static_cast<char>(c));}
  // The bridge promises UTF-8, rather than allowing malformed bytes to leak
  // into JSON or platform path conversion. Reject overlongs and surrogates.
  for(size_t i=0;i<text.size();){const auto c=static_cast<unsigned char>(text[i++]);if(c<128)continue;
    unsigned value=0,remaining=0,minimum=0;
    if(c>=0xc2&&c<=0xdf){value=c&31;remaining=1;minimum=0x80;}
    else if(c>=0xe0&&c<=0xef){value=c&15;remaining=2;minimum=0x800;}
    else if(c>=0xf0&&c<=0xf4){value=c&7;remaining=3;minimum=0x10000;}else return false;
    if(remaining>text.size()-i)return false;
    for(unsigned n=0;n<remaining;++n){const auto next=static_cast<unsigned char>(text[i++]);if((next&0xc0)!=0x80)return false;value=(value<<6)|(next&63);}
    if(value<minimum||value>0x10ffff||(value>=0xd800&&value<=0xdfff))return false;
  }
  return true;
}
// Pin ordinary bounded inputs before asking a decoder to touch them. NONBLOCK
// prevents a malicious FIFO path from hanging the helper's control thread.
singz::OwnedFileDescriptor openManifestSource(const std::string& name) {
  const auto path=std::filesystem::u8path(name);
  if(!path.is_absolute())return {};
#if defined(_WIN32)
  const HANDLE handle=CreateFileW(path.c_str(),GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,
    nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_SEQUENTIAL_SCAN,nullptr);
  if(handle==INVALID_HANDLE_VALUE)return {};
  BY_HANDLE_FILE_INFORMATION info{};
  if(!GetFileInformationByHandle(handle,&info) || GetFileType(handle)!=FILE_TYPE_DISK ||
      (info.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY))){CloseHandle(handle);return {};}
  const int fd=_open_osfhandle(reinterpret_cast<intptr_t>(handle),_O_RDONLY|_O_BINARY);
  if(fd<0){CloseHandle(handle);return {};}
  struct _stat64 metadata{};
  const bool ordinary=_fstat64(fd,&metadata)==0 && (metadata.st_mode&_S_IFMT)==_S_IFREG;
#else
  const int fd=::open(path.c_str(),O_RDONLY|O_NONBLOCK|O_NOFOLLOW);
  if(fd<0)return {};
  struct stat metadata{};
  const bool ordinary=::fstat(fd,&metadata)==0 && S_ISREG(metadata.st_mode);
#endif
  singz::OwnedFileDescriptor file(fd);
  if(!ordinary || metadata.st_size<=0 || static_cast<uint64_t>(metadata.st_size)>(uint64_t{2}<<30))return {};
  return file;
}
// A measurement may decode through a duplicated descriptor, but admission
// remains bound to the original ordinary input and its current pathname.
struct MeasureInputStamp {
  std::array<uint64_t,8> fields{};
  bool operator==(const MeasureInputStamp&) const = default;
};
bool measureInputStamp(int fd,MeasureInputStamp& out) {
#if defined(_WIN32)
  const HANDLE handle=reinterpret_cast<HANDLE>(_get_osfhandle(fd));
  BY_HANDLE_FILE_INFORMATION info{};FILE_BASIC_INFO basic{};
  if(handle==INVALID_HANDLE_VALUE || GetFileType(handle)!=FILE_TYPE_DISK ||
      !GetFileInformationByHandle(handle,&info) ||
      !GetFileInformationByHandleEx(handle,FileBasicInfo,&basic,sizeof(basic)) ||
      (info.dwFileAttributes&(FILE_ATTRIBUTE_REPARSE_POINT|FILE_ATTRIBUTE_DIRECTORY)))return false;
  out.fields={info.dwVolumeSerialNumber,(uint64_t{info.nFileIndexHigh}<<32)|info.nFileIndexLow,
    (uint64_t{info.nFileSizeHigh}<<32)|info.nFileSizeLow,
    static_cast<uint64_t>(basic.LastWriteTime.QuadPart),static_cast<uint64_t>(basic.ChangeTime.QuadPart),0,0,0};
#else
  struct stat info{};
  if(::fstat(fd,&info) || !S_ISREG(info.st_mode))return false;
#if defined(__APPLE__)
  const auto modified=info.st_mtimespec,changed=info.st_ctimespec;
#else
  const auto modified=info.st_mtim,changed=info.st_ctim;
#endif
  out.fields={static_cast<uint64_t>(info.st_dev),static_cast<uint64_t>(info.st_ino),
    static_cast<uint64_t>(info.st_size),static_cast<uint64_t>(modified.tv_sec),
    static_cast<uint64_t>(modified.tv_nsec),static_cast<uint64_t>(changed.tv_sec),
    static_cast<uint64_t>(changed.tv_nsec),0};
#endif
  return out.fields[2]>0 && out.fields[2]<=(uint64_t{2}<<30);
}
int measureInput(const std::string& input) {
  using namespace singz;
  try {
    const auto native=std::filesystem::absolute(std::filesystem::u8path(input)).u8string();
    const std::string path(native.begin(),native.end());
    auto pinned=openManifestSource(path);
    MeasureInputStamp before{};
    if(!pinned.valid() || !measureInputStamp(pinned.get(),before))throw std::runtime_error("Cannot pin ordinary bounded source");
    auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(120);
    DecodeCancellation cancellation{&deadline,[](void* context) noexcept {
      return std::chrono::steady_clock::now()>=*static_cast<std::chrono::steady_clock::time_point*>(context);
    }};
    LaneMeasureRequest request;request.id="input";request.descriptor=OwnedFileDescriptor(duplicateSource(pinned.get()));
    request.policy.minimumPeaks=2;request.policy.maximumPeaks=2;
    const auto measured=measureLane(std::move(request),cancellation);
    double rms=measured.rms;
    uint32_t rate=measured.sampleRate,channels=measured.channels;
    uint64_t frames=measured.frameCount;
    if(!measured.ok) {
      // Never reinterpret corruption, cancellation or I/O failure as silence.
      // Only an unsupported streaming format gets the existing native decoder.
      if(measured.status!=DecodedAudioStatus::UnsupportedFormat)throw std::runtime_error("Streaming input measurement failed");
      DecodedAudioPrepareOptions options;
      options.requiredSampleRate=0;options.maximumChannels=64;
      options.maximumFrames=768000ull*3600;options.maximumEncodedBytes=uint64_t{2}<<30;
      options.maximumDecodedBytes=size_t{1}<<29;options.maximumWorkingBytes=size_t{1}<<30;
      const auto decoded=prepareDecodedAudio(OwnedFileDescriptor(duplicateSource(pinned.get())),options,cancellation);
      if(!decoded.ok())throw std::runtime_error("Native decoded input measurement failed");
      rate=decoded.audio->sampleRate();channels=decoded.audio->channelCount();frames=decoded.audio->frameCount();
      if(!rate || !channels || channels>64 || !frames || frames>options.maximumFrames)throw std::runtime_error("Invalid decoded measurement dimensions");
      std::array<const float*,64> planes{};
      for(uint32_t channel=0;channel<channels;++channel){planes[channel]=decoded.audio->channelData(channel);if(!planes[channel])throw std::runtime_error("Missing decoded measurement channel");}
      double energy=0.;
      for(uint64_t at=0;at<frames;) {
        if(cancellation.isRequested())throw std::runtime_error("Input measurement cancelled");
        const uint64_t end=std::min<uint64_t>(frames,at+4096);
        for(;at<end;++at)for(uint32_t channel=0;channel<channels;++channel){
          const double sample=planes[channel][at];
          if(!std::isfinite(sample))throw std::runtime_error("Nonfinite decoded measurement sample");
          energy+=sample*sample;
        }
        if(!std::isfinite(energy))throw std::runtime_error("Nonfinite decoded measurement energy");
      }
      // Frame/channel bounds above keep this denominator nonzero and finite.
      rms=std::sqrt(energy/(static_cast<double>(frames)*channels));
    }
    if(cancellation.isRequested() || !rate || !channels || channels>64 || !frames || !std::isfinite(rms) || rms<0.)throw std::runtime_error("Invalid native measurement result");
    auto current=openManifestSource(path);
    MeasureInputStamp held{},named{};
    if(!current.valid() || !measureInputStamp(pinned.get(),held) || !measureInputStamp(current.get(),named) || !(held==before) || !(named==before))throw std::runtime_error("Measurement input changed");
    std::cout<<"{\"protocol\":1,\"ok\":true,\"rms\":"<<rms<<",\"sampleRate\":"<<rate<<",\"channels\":"<<channels<<",\"frames\":"<<frames<<"}\n";
    return 0;
  }catch(const std::exception& error){std::cerr<<"Cannot measure analysis input: "<<error.what()<<'\n';return 1;}
}
#include "gpui_graph_manifest.h"

// Offline exports never construct SharedAudioService or claim playback. The
// caller owns publication; this process may create only its exclusive staging
// file, and retires it before reporting any failure/cancellation.
bool validExportPath(const std::string& path) {
  if(path.empty() || path.size()>4096)return false;
  static constexpr char hex[]="0123456789abcdef";
  std::string encoded;encoded.reserve(path.size()*2);
  for(const unsigned char byte:path){encoded.push_back(hex[byte>>4]);encoded.push_back(hex[byte&15]);}
  std::string checked;
  return decodeManifestText(encoded,4096,checked) && std::filesystem::u8path(path).is_absolute();
}

void readExportCancellation(std::atomic<bool>& cancelled,std::atomic<bool>& done,
                            std::atomic<bool>& invalidControl) noexcept {
  std::array<char,64> command{};
  size_t commandSize=0;
  bool first=true;
  // Inspect queued control input at least once even if a tiny export finishes
  // before this thread is scheduled. A prequeued cancel still owns disposal.
  while(first || !done.load(std::memory_order_acquire)){
    first=false;
    char bytes[128];int count=0;
#if defined(_WIN32)
    const auto handle=GetStdHandle(STD_INPUT_HANDLE);
    const auto type=GetFileType(handle);
    DWORD available=0,read=0;
    if(type==FILE_TYPE_PIPE){
      if(!PeekNamedPipe(handle,nullptr,0,nullptr,&available,nullptr))return;
      if(!available){std::this_thread::sleep_for(std::chrono::milliseconds(10));continue;}
    }else if(type!=FILE_TYPE_DISK)return;
    if(!ReadFile(handle,bytes,sizeof(bytes),&read,nullptr) || !read)return;
    count=static_cast<int>(read);
#else
    pollfd descriptor{STDIN_FILENO,POLLIN,0};
    const int ready=::poll(&descriptor,1,25);
    if(ready<0){if(errno==EINTR)continue;return;}
    if(!ready)continue;
    if(!(descriptor.revents&(POLLIN|POLLHUP)))return;
    count=static_cast<int>(::read(STDIN_FILENO,bytes,sizeof(bytes)));
    if(count<0 && errno==EINTR)continue;
    if(count<=0)return;
#endif
    for(int i=0;i<count;++i){
      if(bytes[i]=='\n'){
        if(commandSize && command[commandSize-1]=='\r')--commandSize;
        if(commandSize!=6 || !std::equal(command.begin(),command.begin()+6,"cancel"))invalidControl.store(true,std::memory_order_release);
        cancelled.store(true,std::memory_order_release);return;
      }
      if(commandSize>=command.size()){invalidControl.store(true,std::memory_order_release);cancelled.store(true,std::memory_order_release);return;}
      command[commandSize++]=bytes[i];
    }
  }
}

int exportAudioCommand(int argc,char** argv) {
  using namespace singz;
  bool ok=false,created=false;
  uint64_t bytes=0,frames=0;
  uint32_t sampleRate=0,channels=0;
  std::string error;
  std::filesystem::path staging;
  std::atomic<bool> cancelled{false},done{false},invalidControl{false};
  std::thread control;
  try {
    if(argc<5 || argc>68)throw std::runtime_error("Export requires 1 to 64 audio sources");
    AudioExportFormat format;
    const std::string requested=argv[2];
    if(requested=="wav")format=AudioExportFormat::Wav;
    else if(requested=="flac")format=AudioExportFormat::Flac;
    else if(requested=="mp3")format=AudioExportFormat::Mp3;
    else throw std::runtime_error("Invalid audio export format");
    size_t pathBytes=0;
    for(int i=3;i<argc;++i){const std::string path=argv[i];pathBytes+=path.size();if(!validExportPath(path) || pathBytes>262144)throw std::runtime_error("Invalid or oversized absolute UTF-8 export path");}
    staging=std::filesystem::u8path(argv[3]);
    control=std::thread(readExportCancellation,std::ref(cancelled),std::ref(done),std::ref(invalidControl));
    std::vector<OwnedFileDescriptor> sources;
    for(int i=4;i<argc;++i){
      if(cancelled.load(std::memory_order_acquire))throw std::runtime_error("Export cancelled");
      auto path=std::filesystem::u8path(argv[i]);
      auto source=openManifestSource(argv[i]);
      if(!source.valid()){
        std::error_code missingError;
        const auto status=std::filesystem::symlink_status(path,missingError);
        auto role=path.stem().u8string(),extension=path.extension().u8string(),directory=path.parent_path().filename().u8string();
        const auto lower=[](auto& text){for(auto& letter:text)if(letter>=u8'A' && letter<=u8'Z')letter+=u8'a'-u8'A';};
        lower(role);lower(extension);lower(directory);
        const bool builtin=role==u8"vocals" || role==u8"drums" || role==u8"bass" || role==u8"other" || role==u8"guitar" || role==u8"piano";
        if(status.type()==std::filesystem::file_type::not_found && directory==u8"stems" && extension==u8".wav" && builtin){
          path.replace_extension(".flac");
          const auto native=path.u8string();source=openManifestSource(std::string(native.begin(),native.end()));
        }
      }
      if(!source.valid())throw std::runtime_error("Cannot open ordinary bounded export source");
      sources.push_back(std::move(source));
    }
#if defined(_WIN32)
    const int destination=_wopen(staging.c_str(),_O_CREAT|_O_EXCL|_O_RDWR|_O_BINARY,_S_IREAD|_S_IWRITE);
#else
    const int destination=::open(staging.c_str(),O_CREAT|O_EXCL|O_RDWR|O_NOFOLLOW,0600);
#endif
    if(destination<0)throw std::runtime_error("Cannot exclusively create export staging file");
    created=true;
    OwnedFileDescriptor output(destination),metrics(duplicateSource(destination));
    if(!metrics.valid())throw std::runtime_error("Cannot retain export staging descriptor");
    DecodeCancellation cancellation{&cancelled,[](void* context) noexcept{return static_cast<std::atomic<bool>*>(context)->load(std::memory_order_acquire);}};
    const auto result=sources.size()==1
      ?exportAudio(std::move(sources.front()),std::move(output),format,cancellation)
      :exportAudioMix(std::move(sources),std::move(output),format,cancellation);
    if(!result.ok)throw std::runtime_error(result.error);
    if(cancelled.load(std::memory_order_acquire))throw std::runtime_error("Export cancelled");
#if defined(_WIN32)
    struct _stat64 metadata{};
    if(_commit(metrics.get()) || _fstat64(metrics.get(),&metadata))throw std::runtime_error("Could not sync exported audio");
#else
    struct stat metadata{};
    if(::fsync(metrics.get()) || ::fstat(metrics.get(),&metadata))throw std::runtime_error("Could not sync exported audio");
#endif
    auto encoded=openStreamingAudioSource(OwnedFileDescriptor(duplicateSource(metrics.get())),{},nullptr);
    if(!encoded || !encoded->info().frameCount || !encoded->info().sampleRate || !encoded->info().channels || metadata.st_size<=0)throw std::runtime_error("Could not read encoded audio metadata");
    frames=encoded->info().frameCount;sampleRate=encoded->info().sampleRate;channels=encoded->info().channels;
    bytes=static_cast<uint64_t>(metadata.st_size);ok=true;
  }catch(const std::exception& failure){error=failure.what();}
  catch(...){error="Native audio export failed";}
  done.store(true,std::memory_order_release);
  if(control.joinable())control.join();
  const bool wasCancelled=cancelled.load(std::memory_order_acquire) && !invalidControl.load(std::memory_order_acquire);
  if(invalidControl.load(std::memory_order_acquire)){ok=false;error="Invalid export control command";}
  else if(wasCancelled){ok=false;error="Export cancelled";}
  if(!ok && created){std::error_code cleanup;std::filesystem::remove(staging,cleanup);if(cleanup)error+="; could not remove partial staging file";}
  if(!ok){bytes=0;frames=0;sampleRate=0;channels=0;}
  if(error.size()>2048)error.resize(2048);
  std::cout<<"{\"protocol\":1,\"ok\":"<<(ok?"true":"false")<<",\"error\":"<<singz::tools::jsonString(error)
    <<",\"cancelled\":"<<(wasCancelled?"true":"false")<<",\"bytes\":"<<bytes<<",\"sampleRate\":"<<sampleRate
    <<",\"channels\":"<<channels<<",\"frames\":"<<frames<<",\"duration\":"<<(sampleRate?static_cast<double>(frames)/sampleRate:0.)<<"}\n"<<std::flush;
  return ok?0:1;
}

// Duration comes from the same native source/container authority as playback.
// A header-only streaming open avoids another PCM scan on normal WAV/FLAC/MP3
// startup. Nonstreaming formats use the native decoder, never renderer data.
double nativeLaneDuration(int descriptor,const singz::DecodedAudioPrepareOptions& options) {
  using namespace singz;
  StreamingAudioOpenOptions open;open.sourceFormat=options.sourceFormat;
  auto source=openStreamingAudioSource(OwnedFileDescriptor(duplicateSource(descriptor)),open,nullptr);
  if(source){const auto& info=source->info();if(info.frameCount && info.sampleRate)return static_cast<double>(info.frameCount)/info.sampleRate;}
  auto decode=options;decode.requiredSampleRate=0;
  const auto result=prepareDecodedAudio(OwnedFileDescriptor(duplicateSource(descriptor)),decode);
  return result.ok()&&result.audio&&result.audio->sampleRate()?static_cast<double>(result.audio->frameCount())/result.audio->sampleRate():0.;
}

struct CueSamples {
  std::filesystem::path directory;
  static std::shared_ptr<const singz::DecodedAudio> lookup(void* context, singz::TrainingInstrument instrument, unsigned root) {
    const char* names[]{"piano","electric","guitar"};
    if(static_cast<unsigned>(instrument)>=3 || root>4)return {};
    const auto path=static_cast<CueSamples*>(context)->directory /
      (std::string(names[static_cast<unsigned>(instrument)])+"-C"+std::to_string(root+2)+".mp3");
#if defined(_WIN32)
    const int fd=_wopen(path.c_str(),_O_RDONLY|_O_BINARY);
#else
    const int fd=::open(path.c_str(),O_RDONLY);
#endif
    singz::DecodedAudioPrepareOptions options;options.sourceFormat=singz::DecodedAudioSourceFormat::Mp3;
    options.maximumChannels=2;options.maximumFrames=192000*30;
    options.maximumEncodedBytes=1024*1024;options.maximumDecodedBytes=16*1024*1024;options.maximumWorkingBytes=32*1024*1024;
    return singz::prepareDecodedAudio(singz::OwnedFileDescriptor(fd),options).audio;
  }
};

// The explicit fake-host mode can add a new system-default endpoint without
// touching platform devices. Rendering and lifecycle still use the native fake
// provider and the real playback engine; only inventory/UID translation differs.
class TestDefaultAudioHost final : public singz::AudioHostBackend {
 public:
  TestDefaultAudioHost(singz::FakeAudioHostOptions options,
                      std::shared_ptr<std::atomic<bool>> alternate)
      : host_(singz::createFakeAudioHostBackend(options)), alternate_(std::move(alternate)) {}
  singz::AudioHostInventory enumerate() const override {
    auto inventory = host_->enumerate();
    if (alternate_->load(std::memory_order_acquire)) {
      auto added = inventory.devices.front();
      added.uid = alternateUid();
      added.label = "New default output fixture";
      added.inputChannels = 0;
      added.nominalSampleRate = 44100;
      added.inputChannelLabels.clear();
      added.defaultInput = false;
      added.defaultOutput = true;
      added.direction = singz::AudioHostEndpointDirection::Output;
      for (auto& device : inventory.devices) device.defaultOutput = false;
      inventory.defaultOutputUid = added.uid;
      inventory.devices.push_back(std::move(added));
    }
    return inventory;
  }
  singz::AudioHostResult open(const singz::AudioHostConfig& config,
                            singz::AudioHostRender render, void* context) override {
    auto translated = config;
    if (translated.outputDeviceUid == alternateUid() && alternate_->load(std::memory_order_acquire))
      translated.outputDeviceUid = host_->enumerate().defaultOutputUid;
    return host_->open(translated, render, context);
  }
  singz::AudioHostResult start() override { return host_->start(); }
  void stop() noexcept override { host_->stop(); }
  singz::AudioHostStatus status() const noexcept override { return host_->status(); }
  singz::AudioHostResult suspend() override { return host_->suspend(); }
  singz::AudioHostResult resume() override { return host_->resume(); }
  static const char* alternateUid() { return "singz:fake-new-default"; }
 private:
  std::unique_ptr<singz::AudioHostBackend> host_;
  std::shared_ptr<std::atomic<bool>> alternate_;
};

void printInventory(const singz::AudioHostInventory& inventory, const singz::tools::GpuiAudioProviderSelection& provider, bool newline=true) {
  std::cout<<"{\"protocol\":1,\"ok\":true";singz::tools::writeGpuiAudioProviderIdentity(std::cout,provider);
  std::cout<<",\"defaultInputUid\":"<<singz::tools::jsonString(inventory.defaultInputUid)<<",\"defaultOutputUid\":"<<singz::tools::jsonString(inventory.defaultOutputUid)<<",\"devices\":[";
  for(size_t i=0;i<inventory.devices.size();++i){if(i)std::cout<<',';const auto& d=inventory.devices[i];std::cout<<"{\"uid\":"<<singz::tools::jsonString(d.uid)<<",\"label\":"<<singz::tools::jsonString(d.label)<<",\"inputChannels\":"<<d.inputChannels<<",\"outputChannels\":"<<d.outputChannels<<",\"sampleRate\":"<<d.nominalSampleRate<<",\"inputProbeBusy\":"<<(d.inputProbeBusy?"true":"false")<<",\"outputProbeBusy\":"<<(d.outputProbeBusy?"true":"false")<<"}";}
  std::cout<<"]}";if(newline)std::cout<<'\n'<<std::flush;
}
bool decodeUid(const std::string& encoded,std::string& uid){
  if(encoded=="default"){uid.clear();return true;}if(encoded.empty()||encoded.size()>4096||encoded.size()%2)return false;
  for(size_t i=0;i<encoded.size();i+=2){const auto digit=[](char c)->int{if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;};int a=digit(encoded[i]),b=digit(encoded[i+1]);if(a<0||b<0||(a==0&&b==0))return false;uid.push_back(static_cast<char>(a*16+b));}return true;
}
// Offline input preparation uses the same decoder/resampler as playback. It
// never constructs an audio host or opens an output device.
int renderInput(const char* input,const char* output) {
  using namespace singz;
#if defined(_WIN32)
  const int fd=_wopen(std::filesystem::u8path(input).c_str(),_O_RDONLY|_O_BINARY);
#else
  const int fd=::open(input,O_RDONLY);
#endif
  DecodedAudioPrepareOptions options;options.requiredSampleRate=44100;options.maximumChannels=2;
  options.maximumFrames=44100ull*60*60;options.maximumDecodedBytes=size_t{1}<<30;
  const auto decoded=prepareDecodedAudio(OwnedFileDescriptor(fd),options);
  if(!decoded.ok() || !decoded.audio->frameCount()) {
    std::cerr<<"Cannot decode splitter input (native status "<<static_cast<unsigned>(decoded.status)<<")\n";return 1;
  }
  const auto& audio=*decoded.audio;
  if(std::filesystem::symlink_status(std::filesystem::u8path(output)).type()!=std::filesystem::file_type::not_found) {std::cerr<<"Splitter input destination already exists\n";return 1;}
  WavWriter writer;if(!writer.open(output,44100,2))return 1;
  std::vector<float> block(4096*2);
  for(uint64_t at=0;at<audio.frameCount();at+=4096) {
    const auto count=std::min<uint64_t>(4096,audio.frameCount()-at);
    for(uint64_t i=0;i<count;++i)for(unsigned ch=0;ch<2;++ch) {
      const auto value=audio.channelData(std::min(ch,audio.channelCount()-1))[at+i];
      if(!std::isfinite(value)) {std::cerr<<"Non-finite splitter input\n";return 1;}
      block[i*2+ch]=value;
    }
    if(!writer.append(block.data(),static_cast<int64_t>(count)))return 1;
  }
  if(!writer.finalize())return 1;
  std::cout<<"{\"protocol\":1,\"ok\":true,\"sampleRate\":44100,\"channels\":2,\"frames\":"<<audio.frameCount()<<"}\n";
  return 0;
}

// The editor's two energy views use source-rate PCM and the renderer's original
// first-two-channel mean, deliberately distinct from whole-channel RMS. Both
// Float32 assignments mirror Float32Array rounding in computeEnvelope.
bool vocalEnvelopeValues(const singz::DecodedAudio& audio,double hopSeconds,std::vector<float>& envelope) {
  const auto hop=std::max<uint64_t>(1,static_cast<uint64_t>(std::floor(audio.sampleRate()*hopSeconds+0.5)));
  const auto count=std::max<uint64_t>(1,(audio.frameCount()+hop-1)/hop);
  envelope.resize(static_cast<size_t>(count));
  const auto* left=audio.channelData(0);
  const auto* right=audio.channelCount()>1?audio.channelData(1):nullptr;
  for(uint64_t frame=0;frame<count;++frame) {
    const auto begin=frame*hop;
    const auto end=std::min(audio.frameCount(),begin+hop);
    double sum=0;
    for(auto i=begin;i<end;++i) {
      const float mono=right?static_cast<float>((static_cast<double>(left[i])+static_cast<double>(right[i]))/2.):left[i];
      if(!std::isfinite(mono))return false;
      sum+=std::abs(static_cast<double>(mono));
    }
    envelope[static_cast<size_t>(frame)]=begin<end?static_cast<float>(sum/static_cast<double>(end-begin)):0;
  }
  auto sorted=envelope;std::sort(sorted.begin(),sorted.end());
  const auto quantile=std::min(sorted.size()-1,static_cast<size_t>(std::floor(sorted.size()*0.9)));
  const auto p90=sorted[quantile];
  if(p90>0)for(auto& value:envelope) {
    value=static_cast<float>(static_cast<double>(value)/static_cast<double>(p90));
    if(!std::isfinite(value))return false;
  }
  return true;
}
int vocalEnvelope(const char* input) {
  using namespace singz;
#if defined(_WIN32)
  const int fd=_wopen(std::filesystem::u8path(input).c_str(),_O_RDONLY|_O_BINARY);
#else
  const int fd=::open(input,O_RDONLY);
#endif
  DecodedAudioPrepareOptions options;options.requiredSampleRate=0;options.maximumChannels=64;
  options.maximumFrames=768000ull*60*60;options.maximumEncodedBytes=uint64_t{1}<<30;
  options.maximumDecodedBytes=size_t{1}<<29;options.maximumWorkingBytes=size_t{1}<<29;
  const auto decoded=prepareDecodedAudio(OwnedFileDescriptor(fd),options);
  if(!decoded.ok() || !decoded.audio->frameCount() || !decoded.audio->sampleRate() ||
      decoded.audio->frameCount()>uint64_t(decoded.audio->sampleRate())*3600) {
    std::cerr<<"Cannot decode vocal envelope input (native status "<<static_cast<unsigned>(decoded.status)<<")\n";return 1;
  }
  std::vector<float> coarse,fine;
  if(!vocalEnvelopeValues(*decoded.audio,0.05,coarse) || !vocalEnvelopeValues(*decoded.audio,0.01,fine)) {
    std::cerr<<"Non-finite vocal envelope samples\n";return 1;
  }
  const auto print=[](const std::vector<float>& values) {std::cout<<'[';for(size_t i=0;i<values.size();++i){if(i)std::cout<<',';std::cout<<values[i];}std::cout<<']';};
  std::cout<<"{\"protocol\":1,\"ok\":true,\"sampleRate\":"<<decoded.audio->sampleRate()<<",\"channels\":"<<decoded.audio->channelCount()<<",\"frames\":"<<decoded.audio->frameCount()<<",\"coarse\":{\"hop\":0.05,\"env\":";print(coarse);
  std::cout<<"},\"fine\":{\"hop\":0.01,\"env\":";print(fine);std::cout<<"}}\n";
  return 0;
}
int renderLyricsInput(const char* input,const char* output) {
  using namespace singz;
#if defined(_WIN32)
  const int fd=_wopen(std::filesystem::u8path(input).c_str(),_O_RDONLY|_O_BINARY);
#else
  const int fd=::open(input,O_RDONLY);
#endif
  DecodedAudioPrepareOptions options;options.requiredSampleRate=16000;options.maximumChannels=2;
  options.maximumFrames=768000ull*3600;options.maximumEncodedBytes=uint64_t{1}<<30;
  options.maximumDecodedBytes=size_t{1}<<29;options.maximumWorkingBytes=size_t{1}<<30;
  const auto decoded=prepareDecodedAudio(OwnedFileDescriptor(fd),options);
  if(!decoded.ok() || !decoded.audio->frameCount() || decoded.audio->sampleRate()!=16000 ||
      decoded.audio->frameCount()>16000ull*3600) {
    std::cerr<<"Cannot decode lyrics alignment input (native status "<<static_cast<unsigned>(decoded.status)<<")\n";return 1;
  }
  const auto destination=std::filesystem::u8path(output);
#if defined(_WIN32)
  const int outputFd=_wopen(destination.c_str(),_O_WRONLY|_O_CREAT|_O_EXCL|_O_BINARY,_S_IREAD|_S_IWRITE);
#else
  const int outputFd=::open(destination.c_str(),O_WRONLY|O_CREAT|O_EXCL,0600);
#endif
  if(outputFd<0){std::cerr<<"Cannot create exclusive lyrics alignment input\n";return 1;}
  struct OutputGuard {
    OwnedFileDescriptor file;std::filesystem::path path;bool complete{false};
    ~OutputGuard(){file.reset();if(!complete){std::error_code error;std::filesystem::remove(path,error);}}
  } guard{OwnedFileDescriptor(outputFd),destination,false};
  const auto& audio=*decoded.audio;std::vector<float> block(4096);
  const auto* left=audio.channelData(0);const auto* right=audio.channelCount()>1?audio.channelData(1):nullptr;
  for(uint64_t at=0;at<audio.frameCount();at+=block.size()) {
    const auto count=std::min<uint64_t>(block.size(),audio.frameCount()-at);
    for(uint64_t i=0;i<count;++i) {
      const float value=right?static_cast<float>((static_cast<double>(left[at+i])+static_cast<double>(right[at+i]))/2.):left[at+i];
      if(!std::isfinite(value)){std::cerr<<"Non-finite lyrics alignment input\n";return 1;}
      block[static_cast<size_t>(i)]=value;
    }
    const auto* bytes=reinterpret_cast<const char*>(block.data());size_t remain=static_cast<size_t>(count)*sizeof(float);
    while(remain) {
#if defined(_WIN32)
      const auto wrote=_write(guard.file.get(),bytes,static_cast<unsigned>(remain));
#else
      const auto wrote=::write(guard.file.get(),bytes,remain);
#endif
      if(wrote<0 && errno==EINTR)continue;
      if(wrote<=0){std::cerr<<"Cannot write lyrics alignment input\n";return 1;}
      bytes+=wrote;remain-=static_cast<size_t>(wrote);
    }
  }
#if defined(_WIN32)
  if(_commit(guard.file.get())!=0)return 1;
#else
  if(::fsync(guard.file.get())!=0)return 1;
#endif
  guard.complete=true;
  std::cout<<"{\"protocol\":1,\"ok\":true,\"sampleRate\":16000,\"channels\":1,\"frames\":"<<audio.frameCount()<<"}\n";
  return 0;
}
int run(int argc, char** argv) {
  using namespace singz;
  std::cout << std::setprecision(17);
  if(argc>1 && std::string(argv[1])=="--export-audio")return exportAudioCommand(argc,argv);
  if(argc>1 && std::string(argv[1])=="--vocal-envelope")return argc==3?vocalEnvelope(argv[2]):2;
  if(argc>1 && std::string(argv[1])=="--render-lyrics-input")return argc==4?renderLyricsInput(argv[2],argv[3]):2;
  if(argc==3 && std::string(argv[1])=="--measure-input")return measureInput(argv[2]);
  if(argc==4 && std::string(argv[1])=="--render-input")return renderInput(argv[2],argv[3]);
  if(argc==4 && std::string(argv[1])=="--compact-stem") {
    const auto result=compactStem(argv[2],argv[3]);
    if(!result.ok){std::cerr<<result.error<<'\n';return 1;}
    std::cout<<"{\"protocol\":1,\"ok\":true,\"bytes\":"<<result.bytes<<"}\n";return 0;
  }
  const bool muted = std::getenv("SINGZ_MUTE") != nullptr;
  if(argc==2 && std::string(argv[1])=="--providers") {singz::tools::writeGpuiAudioProviders(std::cout);std::cout<<'\n'<<std::flush;return 0;}
  bool fake=false,trainingOnly=false,emptyProject=false,devicesOnly=false,explicitProvider=false;
  bool forceDecodedLanes=false,testFailUnparkPrepareOnce=false,testFailUnparkBeforeLeaseClaimOnce=false;
  std::string requestedProvider;
  int first=1;
  auto providerFailure=[&](const std::string& id,const std::string& code,const std::string& message,int exitCode=1) {
    std::cout<<"{\"protocol\":1,\"ok\":false,\"provider\":"<<singz::tools::jsonString(id)
      <<",\"backendProvider\":null,\"fixture\":"<<(fake?"true":"false")
      <<",\"errorCode\":"<<singz::tools::jsonString(code)<<",\"detail\":"<<singz::tools::jsonString(message)
      <<",\"error\":"<<singz::tools::jsonString(message)<<"}\n"<<std::flush;return exitCode;
  };
  while(first<argc) {
    const std::string option=argv[first];
    if(option=="--test-fake-host") {if(fake)return providerFailure(requestedProvider,"invalid-arguments","Duplicate fake host option",2);fake=true;++first;}
    else if(option=="--no-stream-lanes") {if(forceDecodedLanes)return providerFailure(requestedProvider,"invalid-arguments","Duplicate decoded-lane override",2);forceDecodedLanes=true;++first;}
    else if(option=="--test-fail-unpark-prepare-once") {if(testFailUnparkPrepareOnce)return providerFailure(requestedProvider,"invalid-arguments","Duplicate unpark failure injection",2);testFailUnparkPrepareOnce=true;++first;}
    else if(option=="--test-fail-unpark-before-lease-claim-once") {if(testFailUnparkBeforeLeaseClaimOnce)return providerFailure(requestedProvider,"invalid-arguments","Duplicate unpark failure injection",2);testFailUnparkBeforeLeaseClaimOnce=true;++first;}
    else if(option=="--provider") {
      if(explicitProvider || first+1>=argc)return providerFailure(requestedProvider,"invalid-provider","Expected one explicit Windows provider",2);
      requestedProvider=argv[first+1];explicitProvider=true;first+=2;
    } else if(option=="--training-only") {if(trainingOnly||emptyProject||devicesOnly)return providerFailure(requestedProvider,"invalid-arguments","Conflicting native helper modes",2);trainingOnly=true;++first;}
    else if(option=="--empty-project") {if(trainingOnly||emptyProject||devicesOnly)return providerFailure(requestedProvider,"invalid-arguments","Conflicting native helper modes",2);emptyProject=true;++first;}
    else if(option=="--devices") {if(trainingOnly||emptyProject||devicesOnly)return providerFailure(requestedProvider,"invalid-arguments","Conflicting native helper modes",2);devicesOnly=true;++first;}
    else break;
  }
  if((forceDecodedLanes||testFailUnparkPrepareOnce||testFailUnparkBeforeLeaseClaimOnce)&&!fake)
    return providerFailure(requestedProvider,"invalid-arguments","Native test options require the fake host",2);
  singz::tools::GpuiAudioProviderSelection providerSelection;
  singz::tools::GpuiAudioProviderInfo unavailableProvider;
  if(!singz::tools::selectGpuiAudioProvider(requestedProvider,explicitProvider,fake,providerSelection,unavailableProvider))
    return providerFailure(providerSelection.id,unavailableProvider.errorCode,unavailableProvider.detail);
  if(devicesOnly) {
    if(first!=argc)return providerFailure(providerSelection.id,"invalid-arguments","Unexpected inventory arguments",2);
    auto backend=fake?createFakeAudioHostBackend():singz::tools::createGpuiPlatformAudioProvider(providerSelection);
    backend=singz::tools::scopeGpuiOutputProvider(std::move(backend),providerSelection);
    if(!backend)return providerFailure(providerSelection.id,"runtime-unavailable","The selected native provider could not be created");
    NativePlaybackSession inventoryHost(std::move(backend));printInventory(inventoryHost.enumerate(),providerSelection);return 0;
  }
  std::string selectedOutput;
  if(first+1<argc && std::string(argv[first])=="--output"){selectedOutput=argv[first+1];first+=2;}
  if(!providerSelection.validOutputUid(selectedOutput))
    return providerFailure(providerSelection.id,"provider-device-mismatch","Output device identity does not match the selected provider");
  double initialTempo=1.,initialTranspose=0.;
  while(first+1<argc && (std::string(argv[first])=="--tempo" || std::string(argv[first])=="--transpose")) {
    double value=0.;size_t consumed=0;try{value=std::stod(argv[first+1],&consumed);}catch(...){return providerFailure(providerSelection.id,"invalid-arguments","Invalid playback tempo or transpose",2);}
    if(consumed!=std::string(argv[first+1]).size()||!std::isfinite(value))return providerFailure(providerSelection.id,"invalid-arguments","Invalid playback tempo or transpose",2);
    if(std::string(argv[first])=="--tempo")initialTempo=value;else initialTranspose=value;
    first+=2;
  }
  if(initialTempo<0.25||initialTempo>4.||initialTranspose<-24.||initialTranspose>24.||std::floor(initialTranspose)!=initialTranspose)return providerFailure(providerSelection.id,"invalid-arguments","Playback tempo or transpose is out of range",2);
  std::optional<NativePlaybackGraphDocument> graphDocument;
  if(first+1<argc && std::string(argv[first])=="--graph-manifest") {
    NativePlaybackGraphDocument graph;
    if(trainingOnly||emptyProject||!readGpuiGraphManifest(argv[first+1],graph)){
      return providerFailure(providerSelection.id,"invalid-graph","Invalid native graph manifest");
    }
    graphDocument=std::move(graph);first+=2;
  }
  if ((trainingOnly || emptyProject) ? argc!=first : ((argc-first)%2 || argc-first < 2 || argc-first > static_cast<int>(kNativePlaybackMaximumLanes*2))) return providerFailure(providerSelection.id,"invalid-arguments","Invalid native playback lane arguments",2);
  // One physical owner serves both the song and training PCM. Client unload
  // alone does not close that base output; Park below verifies both layers.
  // Routing is explicit in this helper. Disable the service's automatic route
  // watcher, which follows a missing preferred endpoint to system default.
  // Refresh before Play/cues/route commands and retain the app's refusal policy.
  FakeAudioHostOptions fakeOptions;fakeOptions.callbackCount=1000000;fakeOptions.realtimePaced=true;
  auto testDefault = fake ? std::make_shared<std::atomic<bool>>(false) : nullptr;
  std::unique_ptr<AudioHostBackend> provider;
  if(fake)provider=std::make_unique<TestDefaultAudioHost>(fakeOptions,testDefault);
  else provider=singz::tools::createGpuiPlatformAudioProvider(providerSelection);
  provider=singz::tools::scopeGpuiOutputProvider(std::move(provider),providerSelection);
  if(!provider)return providerFailure(providerSelection.id,"runtime-unavailable","The selected native provider could not be created");
  auto service = std::make_unique<SharedAudioService>(std::move(provider));
  auto owner = std::make_unique<NativePlaybackSession>(service->playbackBackend(nullptr,service->providerId()));
  auto& engine = *owner;
  TrainingPcmMixer cueMixer;
  struct CueDetach { SharedAudioService& service; ~CueDetach(){service.clearTrainingRenderer();} } cueDetach{*service};
  const auto executableDirectory=std::filesystem::absolute(std::filesystem::u8path(argv[0])).parent_path();
  // Signed macOS bundles keep data under Resources, outside their code-only
  // MacOS directory. Loose developer/Windows/Linux runtimes stay adjacent.
  const auto sampleDirectory=executableDirectory.filename()=="MacOS" && executableDirectory.parent_path().filename()=="Contents"
    ? executableDirectory.parent_path()/"Resources"/"training-sounds"
    : executableDirectory/"training-sounds";
  CueSamples cueSamples{sampleDirectory};
  uint64_t cueGeneration=0,cueStart=0,cueEnd=0;
  double cueGain=0;
  std::vector<TrainingPlannedNote> cueNotes;
  auto clearCues=[&] {
    // Let the existing native mixer apply its 5 ms cancellation ramp. A host
    // which has stopped delivering callbacks cannot hold control indefinitely.
    if(cueGeneration && cueMixer.active(cueGeneration) && service->status().state==AudioHostState::Running){
      cueMixer.cancel(cueGeneration);
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(150);
      while(cueMixer.active(cueGeneration) && std::chrono::steady_clock::now()<deadline)
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    service->clearTrainingRenderer();cueMixer.clearQuiesced();cueStart=cueEnd=0;cueGain=0;cueNotes.clear();
  };
  uint64_t generation=emptyProject?0:1;
  uint64_t nextGeneration=emptyProject?1:2;
  uint64_t laneSetRevision=1;
  bool emptyNeverClaimed=emptyProject;
  std::optional<NativePlaybackCleanupResult> emptyCleanup;
  NativePlaybackPrepareConfig config;
#if defined(__APPLE__) || defined(_WIN32)
  // Match Electron desktop: stream FLAC lanes from their files on macOS and
  // Windows. Linux remains opt-in until its session path is qualified.
  config.streamLanes = true;
#endif
  if(forceDecodedLanes)config.streamLanes=false;
  config.graphDocument=std::move(graphDocument);
  const auto inventory=engine.enumerate();
  const AudioHostDeviceInfo* output=nullptr;
  for(const auto& device:inventory.devices) if(device.uid==(selectedOutput.empty()?inventory.defaultOutputUid:selectedOutput) && device.outputChannels>0) {output=&device;break;}
  if(!output && !emptyProject) return providerFailure(providerSelection.id,"device-unavailable","Selected native output device is unavailable");
  // An empty saved document is still usable without any output endpoint.
  // These are desired prepare options only; no device is opened or claimed.
  if(output){
    config.outputDeviceUid=output->uid;
    config.outputChannels=output->outputChannels>=2?std::vector<uint32_t>{0,1}:std::vector<uint32_t>{0};
    config.requestedSampleRate=output->nominalSampleRate;
    config.requestedBufferFrames=output->bufferFrames.preferredFrames;
  }else{
    // Preserve an unavailable explicit preference. An empty document needs no
    // device, but a later Add must not silently turn this into system default.
    config.outputDeviceUid=selectedOutput;config.requestedSampleRate=48000;
  }
  config.playbackRate=initialTempo;config.transposeSemitones=initialTranspose;
  // Desktop playback always has a reference bus, including a zero-event plan
  // used by click previews. Explicit saved graphs must be admitted against that
  // same context on their initial prepare, before metronome configuration.
  if(config.graphDocument){PlaybackCuePlanRequest silent;silent.playbackRate=initialTempo;config.cuePlan=silent;}
  config.masterGain = muted ? 0.0F : 1.0F;
  config.initialTransport.startPaused = true;
  config.maximumRetainedBytes = size_t{1} << 30;
  std::vector<NativePlaybackLaneSource> lanes;
  std::vector<std::string> ids;
  std::vector<OwnedFileDescriptor> pinned;
  std::vector<std::string> sourceKeys;
  std::vector<double> laneDurations;
  for (int i=first; i<argc; i+=2) {
#if defined(_WIN32)
    const int fd = _wopen(std::filesystem::u8path(argv[i+1]).c_str(), _O_RDONLY | _O_BINARY);
#else
    const int fd = ::open(argv[i+1], O_RDONLY);
#endif
    if (fd < 0) return providerFailure(providerSelection.id,"source-unavailable","Cannot open audio source");
    NativePlaybackLaneSource lane;
    lane.id = argv[i]; lane.descriptor = OwnedFileDescriptor(fd);
    const double duration=nativeLaneDuration(fd,config.decodeOptions);
    if(!std::isfinite(duration)||duration<=0)return providerFailure(providerSelection.id,"invalid-source-duration","Cannot determine native lane duration");
    laneDurations.push_back(duration);
    const int copy=duplicateSource(fd);if(copy<0)return providerFailure(providerSelection.id,"source-pin-failed","Cannot retain native audio source");
    pinned.emplace_back(copy);lane.sourceKey=std::string(argv[i])+":"+argv[i+1];sourceKeys.push_back(lane.sourceKey);
    ids.push_back(lane.id); lanes.push_back(std::move(lane));
  }
  std::string outputUid=output?output->uid:selectedOutput,outputLabel=output?output->label:"";
  bool parked=false,physicalReleased=emptyProject;
  NativePlaybackStatus parkedStatus{};
  size_t parkedBytes=0;
  uint64_t parkedHandoffLease=0;
  bool unparkAdoptedParkedPcm=false;
  std::optional<NativePlaybackInitialLoop> loopIntent;
  std::optional<NativePlaybackInitialLoop> regionIntent;
  std::optional<PlaybackCuePlanRequest> metronome;
  std::optional<MetronomeDraft> metDraft;
  std::optional<LaneManifest> laneDraft;
  std::optional<CarryDraft> carryDraft;
  std::optional<CarryPlan> carry;
  uint64_t carryRevision=1;
  bool carryCommitted=false;
  bool wantsPlaying=false;
  bool countInPending=false;
  bool countInSeen=false;
  double countInLandingSeconds=-1.;
  bool lanesCommitted=false;
  bool publishInventory = true; // Prepare/route receipts seed the separate inventory worker.
  std::string publishedOutputUid;
  auto reply = [&](const NativePlaybackResult& receipt, bool peaks=false) {
    auto s = parked?parkedStatus:engine.status();
    const auto baseHost=service->status();
    if(emptyProject){
      const bool graphReleased=emptyNeverClaimed || (emptyCleanup && emptyCleanup->globallyComplete());
      physicalReleased=graphReleased && (baseHost.state==AudioHostState::Stopped || baseHost.state==AudioHostState::Closed || baseHost.state==AudioHostState::Unsupported);
    }
    if(trainingOnly){s.host=baseHost;s.playbackRate=1;s.masterGain=0;}
    // Logical preferences survive an unloaded document; transport, lanes and
    // device telemetry remain the actual native session status.
    if(emptyProject){s.playbackRate=config.playbackRate;s.transposeSemitones=config.transposeSemitones;s.masterGain=config.masterGain;}
    if(s.state==NativePlaybackState::Prepared && regionIntent){s.regionEnabled=true;s.regionStartFrame=regionIntent->startProjectFrame;s.regionEndFrame=regionIntent->endProjectFrame;}
    if(s.state==NativePlaybackState::Prepared && loopIntent){s.loopEnabled=true;s.loopStartFrame=loopIntent->startProjectFrame;s.loopEndFrame=loopIntent->endProjectFrame;}
    const double rate = s.host.format.sampleRate;
    const bool audible=s.audibleProjectionQuality==NativePlaybackAudibleProjectionQuality::Current;
    double position=rate>0?(audible?s.audibleProjectFrame:s.renderedProjectFrame)/rate:0.;
    if(!audible && rate>0 && (s.transportState==NativePlaybackTransportState::Playing || s.transportState==NativePlaybackTransportState::PreRoll)){
      position-=s.totalPresentationLatencyFrames*s.playbackRate/rate;
      const double start=s.loopStartFrame/rate,end=s.loopEndFrame/rate;
      if(s.loopEnabled && end>start && position<start && s.loopCount>0){
        const double laps=std::min<double>(s.loopCount,std::ceil((start-position)/(end-start)));position+=laps*(end-start);
      }
    }
    // Match DesktopNativePlaybackClient.countInHeard: count by the native
    // render clock at the ear, retaining the latency tail after the landing.
    // A nonzero landing is an absolute project frame after pre-roll; negative
    // frames are the runway relative to that landing.
    const double latencyProjectFrames=std::round(s.totalPresentationLatencyFrames*s.playbackRate);
    std::optional<double> secondsToLanding;
    const bool advancing=wantsPlaying && (s.transportState==NativePlaybackTransportState::Playing || s.transportState==NativePlaybackTransportState::PreRoll);
    if(countInPending && countInLandingSeconds>=0 && advancing && rate>0 && s.countInEventCount>0 && s.countInBeatsPerBar>0){
      if(s.renderedProjectFrame<0){countInSeen=true;secondsToLanding=std::min(0.,s.renderedProjectFrame-latencyProjectFrames)/rate;}
      else if(countInSeen){
        const double sinceLanding=s.renderedProjectFrame-std::round(countInLandingSeconds*rate);
        const double remaining=latencyProjectFrames-sinceLanding;
        if(sinceLanding>=0 && remaining>0)secondsToLanding=-remaining/rate;
        else {countInPending=false;countInSeen=false;countInLandingSeconds=-1.;}
      }else {countInPending=false;countInSeen=false;countInLandingSeconds=-1.;}
    }
    const bool countingIn=secondsToLanding.has_value();
    std::cout << "{\"protocol\":1,\"ok\":" << (receipt.ok?"true":"false");
    singz::tools::writeGpuiAudioProviderIdentity(std::cout,providerSelection);
    std::cout << ",\"trainingOnly\":" << (trainingOnly?"true":"false")
      << ",\"emptyProject\":" << (emptyProject?"true":"false")
      << ",\"laneSetRevision\":" << laneSetRevision
      << ",\"lanesCommitted\":" << (lanesCommitted?"true":"false")
      << ",\"lanesWarning\":" << singz::tools::jsonString(lanesCommitted&&!receipt.ok?receipt.message:"")
      << ",\"error\":" << singz::tools::jsonString(receipt.ok?"":receipt.message)
      << ",\"parked\":" << (parked?"true":"false")
      << ",\"physicalOutputReleased\":" << (physicalReleased?"true":"false")
      << ",\"parkedLaneBytes\":" << parkedBytes
      << ",\"parkedPcmAdopted\":" << (unparkAdoptedParkedPcm?"true":"false")
        << ",\"graphGeneration\":" << generation
        << ",\"explicitGraph\":" << (config.graphDocument.has_value()?"true":"false")
        << ",\"graphNodeCount\":" << s.graphNodeCount
        << ",\"graphConnectionCount\":" << s.graphConnectionCount
        << ",\"graphLatencyFrames\":" << s.graphLatencyFrames
        << ",\"latencyCompensatedEdgeCount\":" << s.latencyCompensatedEdgeCount
        << ",\"graphSnapshot\":";
    singz::tools::writePlaybackGraphSnapshot(std::cout,s);
    std::cout
      << ",\"cueGeneration\":" << cueGeneration << ",\"cueStartHostNs\":\"" << cueStart << "\",\"cueEndHostNs\":\"" << cueEnd << '"'
      << ",\"cueGain\":" << cueGain
      << ",\"cueActive\":" << (cueMixer.active(cueGeneration)?"true":"false")
      << ",\"cueNowHostNs\":\"" << cueClockNs() << '"'
      << ",\"baseHostState\":" << static_cast<unsigned>(baseHost.state)
      << ",\"baseCallbacks\":" << baseHost.callbacks
      << ",\"baseHostTerminalReason\":" << static_cast<unsigned>(baseHost.terminalReason)
      << ",\"baseHostXruns\":" << baseHost.xruns
      << ",\"baseHostRenderFailures\":" << baseHost.renderFailures
      << ",\"cueOutputLatencyMs\":" << (baseHost.format.sampleRate>0?(baseHost.latency.outputDeviceFrames+baseHost.latency.bufferFrames+baseHost.latency.externalRouteFrames)*1000./baseHost.format.sampleRate:0)
      << ",\"state\":" << static_cast<unsigned>(s.state)
      << ",\"transportState\":" << static_cast<unsigned>(s.transportState)
      << ",\"transportGeneration\":" << s.transportGeneration
      << ",\"transportCommandsQueued\":" << s.transportCommandsQueued
      << ",\"transportCommandsApplied\":" << s.transportCommandsApplied
      << ",\"playing\":" << ((s.transportState == NativePlaybackTransportState::Playing || s.transportState == NativePlaybackTransportState::PreRoll)?"true":"false")
      << ",\"position\":" << std::max(0.,position)
      << ",\"duration\":" << (rate>0 ? s.durationFrames/rate : 0)
      << ",\"outputUid\":" << singz::tools::jsonString(outputUid) << ",\"outputLabel\":" << singz::tools::jsonString(outputLabel)
      << ",\"sampleRate\":" << rate << ",\"masterGain\":" << s.masterGain
      << ",\"playbackRate\":" << s.playbackRate << ",\"transpose\":" << s.transposeSemitones
      << ",\"streamGeneration\":" << s.host.streamGeneration << ",\"swapLandings\":" << s.swapLandings
      << ",\"audibleCurrent\":" << (audible?"true":"false") << ",\"seekCount\":" << s.seekCount << ",\"loopCount\":" << s.loopCount
      << ",\"regionEnabled\":" << (s.regionEnabled?"true":"false") << ",\"regionStart\":" << (rate>0?s.regionStartFrame/rate:0.) << ",\"regionEnd\":" << (rate>0?s.regionEndFrame/rate:0.) << ",\"regionStopArmed\":" << (s.regionStopArmed?"true":"false")
      << ",\"looping\":" << (s.loopEnabled?"true":"false") << ",\"loopStart\":" << (rate>0?s.loopStartFrame/rate:0.) << ",\"loopEnd\":" << (rate>0?s.loopEndFrame/rate:0.);
    std::cout << ",\"metronomeClick\":" << (metronome && metronome->click?"true":"false")
      << ",\"metronomeBars\":" << (metronome?metronome->countInBars:0)
      << ",\"metronomeVolume\":" << (metronome?metronome->volume:0.7)
      << ",\"metronomeAccent\":" << (!metronome || metronome->accent?"true":"false")
      << ",\"metronomeBeats\":" << (metronome?metronome->beatGrid.beats.size():0)
      << ",\"metronomeDownbeats\":" << (metronome?metronome->beatGrid.downbeats.size():0)
      << ",\"cueEventCount\":" << s.cueEventCount << ",\"cueEventsCompleted\":" << s.cueEventsCompleted
      << ",\"preRollFrames\":" << s.preRollFrames << ",\"countInEvents\":" << s.countInEventCount
      << ",\"countInBeatsPerBar\":" << s.countInBeatsPerBar << ",\"renderedProjectFrame\":" << s.renderedProjectFrame
      << ",\"presentationLatencyFrames\":" << s.totalPresentationLatencyFrames
      << ",\"countingIn\":" << (countingIn?"true":"false")
      << ",\"outputPeak\":" << s.outputPeak << ",\"outputClippedBlocks\":" << s.outputClippedBlocks << ",\"referenceGain\":" << s.referenceGain
      << ",\"previewClicksEnqueued\":" << s.previewClicksEnqueued << ",\"previewClicksStarted\":" << s.previewClicksStarted
      << ",\"previewClicksCompleted\":" << s.previewClicksCompleted;
    std::cout << ",\"countInHeard\":";
    if(secondsToLanding)std::cout << "{\"secondsToLanding\":" << *secondsToLanding
      << ",\"landingSeconds\":" << countInLandingSeconds
      << ",\"total\":" << s.countInEventCount
      << ",\"perBar\":" << s.countInBeatsPerBar
      << ",\"preRollSeconds\":" << std::abs(static_cast<double>(s.preRollFrames))/rate << '}';
    else std::cout << "null";
    std::cout << ",\"carryCommitted\":" << (carryCommitted?"true":"false")
      << ",\"carryRevision\":" << carryRevision
      << ",\"carryEnabled\":" << (s.trainingEnabled?"true":"false")
      << ",\"carryRequested\":" << (carry && carry->enabled?"true":"false")
      << ",\"carryMode\":" << (carry?carry->mode:0)
      << ",\"carryPeriod\":" << (carry?carry->period:0.);
    std::cout << ",\"carryLaneIds\":[";
    if(carry)for(size_t i=0;i<carry->laneIds.size();++i){if(i)std::cout<<',';std::cout<<singz::tools::jsonString(carry->laneIds[i]);}
    std::cout << "],\"carryWindows\":[";
    if(carry)for(size_t i=0;i<carry->windows.size();++i){if(i)std::cout<<',';std::cout<<'['<<carry->windows[i].first<<','<<carry->windows[i].second<<']';}
    std::cout << ']';
    std::cout << ",\"cleanupProof\":";
    if(emptyProject){
      const auto proof=emptyCleanup.value_or(NativePlaybackCleanupResult{});
      std::cout << "{\"neverClaimed\":" << (emptyNeverClaimed?"true":"false")
        << ",\"globallyComplete\":" << (emptyCleanup && proof.globallyComplete()?"true":"false")
        << ",\"generation\":" << proof.generation
        << ",\"safety\":" << static_cast<unsigned>(proof.safety)
        << ",\"error\":" << static_cast<unsigned>(proof.error)
        << ",\"state\":" << static_cast<unsigned>(proof.state)
        << ",\"retainedBytes\":" << proof.retainedBytes
        << ",\"parkedLaneBytes\":" << proof.parkedLaneBytes
        << ",\"physicalOwnershipRetained\":" << (proof.physicalOwnershipRetained?"true":"false")
        << ",\"quarantineBytes\":" << proof.processQuarantineRetainedBytes
        << ",\"quarantineReserved\":" << (proof.processQuarantineReserved?"true":"false")
        << ",\"quarantinePoisoned\":" << (proof.processQuarantinePoisoned?"true":"false")
        << ",\"coordinatorState\":" << static_cast<unsigned>(proof.coordinatorState)
        << ",\"handoffLease\":" << proof.handoffLease << '}';
    }else std::cout << "null";
    std::cout<<",\"lanes\":[";for(size_t i=0;i<s.lanes.size();++i){if(i)std::cout<<',';const auto& lane=s.lanes[i];std::cout<<"{\"id\":"<<singz::tools::jsonString(lane.id)<<",\"gain\":"<<lane.gain<<",\"muted\":"<<(lane.muted?"true":"false")<<",\"solo\":"<<(lane.solo?"true":"false")<<",\"streamed\":"<<(lane.streamed?"true":"false")<<",\"starvedBlocks\":"<<lane.starvedBlocks<<",\"stagedJumps\":"<<lane.stagedJumps<<"}";}std::cout<<']';
    std::cout<<",\"laneIds\":[";for(size_t i=0;i<ids.size();++i){if(i)std::cout<<',';std::cout<<singz::tools::jsonString(ids[i]);}std::cout<<']';
    std::cout<<",\"laneDurations\":[";for(size_t i=0;i<laneDurations.size();++i){if(i)std::cout<<',';std::cout<<(rate>0?std::floor(laneDurations[i]*rate+0.5)/rate:laneDurations[i]);}std::cout<<']';
    std::cout<<",\"cueNotes\":[";for(size_t i=0;i<cueNotes.size();++i){if(i)std::cout<<',';const auto& note=cueNotes[i];std::cout<<"{\"midi\":"<<note.midi<<",\"cueIndex\":"<<note.cueIndex<<",\"start\":"<<note.start<<",\"end\":"<<note.end<<'}';}std::cout<<']';
    if (emptyProject) std::cout << ",\"peaks\":[],\"peaksValid\":[]";
    else if (peaks) {
      const auto summaries = engine.lanePeaks(generation);
      std::vector<bool> peakIncluded(ids.size(),false);
      std::cout << ",\"peaks\":[";
      for (size_t i=0;i<ids.size();++i) {
        if(i) std::cout << ',';
        std::cout << '[';
        const bool publish=i<summaries.lanes.size()&&summaries.lanes[i].valid;
        peakIncluded[i]=publish;
        if(publish)for(size_t b=0;b<summaries.lanes[i].peaks.size();++b) { if(b)std::cout<<','; std::cout<<summaries.lanes[i].peaks[b]; }
        std::cout << ']';
      }
      std::cout << "],\"peaksValid\":[";
      for (size_t i=0;i<ids.size();++i) {
        if(i) std::cout << ',';
        std::cout << (peakIncluded[i] ? "true" : "false");
      }
      std::cout << ']';
    }
    // Play, preview and training may follow a newly available system default
    // without an explicit output command. Publish its proven capabilities on
    // that same receipt, before a fresh exclusive-device probe can see EBUSY.
    if(publishInventory || publishedOutputUid!=outputUid){
      std::cout<<",\"deviceInventory\":";printInventory(engine.enumerate(),providerSelection,false);
      publishInventory=false;publishedOutputUid=outputUid;
    }
    std::cout << "}\n" << std::flush;
  };
  if (!trainingOnly && !emptyProject && !engine.claimGeneration(generation)) return providerFailure(providerSelection.id,"generation-rejected","Cannot claim native playback generation");
  auto baseConfig=config;
  NativePlaybackResult result;
  if(trainingOnly || emptyProject)result.ok=true;else result=engine.prepare(config, std::move(lanes), generation);
  reply(result, true);
  if (!result.ok) return 1;
  bool started = false;
  // Preview can run callbacks with transport still Stopped. Track accepted
  // starts explicitly: callback telemetry may lag a just-issued paused Start.
  bool songStarted = false;
  auto startSong=[&]{auto receipt=engine.start(generation);if(receipt.ok)songStarted=true;return receipt;};

  auto waitRegion=[&](std::optional<NativePlaybackInitialLoop> region,bool looping){
    NativePlaybackResult receipt;const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
    while(true){const auto state=engine.status();
      if(state.transportGeneration==generation && state.regionEnabled==region.has_value() && state.loopEnabled==looping &&
         (!region || (state.regionStartFrame==region->startProjectFrame && state.regionEndFrame==region->endProjectFrame && (!looping || (state.loopStartFrame==region->startProjectFrame && state.loopEndFrame==region->endProjectFrame))))){receipt.ok=true;break;}
      if(std::chrono::steady_clock::now()>=deadline || state.state==NativePlaybackState::Terminal || state.state==NativePlaybackState::Quarantined){receipt.message="Native playback region did not settle";break;}
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }return receipt;
  };
  bool completionParked = false;
  std::string line;
  while (true) {
    line.clear();
    lanesCommitted=false;carryCommitted=false;
    bool oversized=false;
    char c;
    while(std::cin.get(c) && c!='\n') { if(line.size()>=4096)oversized=true;else line.push_back(c); }
    if(line.empty() && !std::cin) break;
    if(oversized){laneDraft.reset();carryDraft.reset();NativePlaybackResult invalid;invalid.message="Protocol command exceeds 4096 bytes";reply(invalid);continue;}
    std::istringstream input(line);
    std::string command; input >> command;
    if(command=="output")publishInventory=true;
    double a=0,b=0; unsigned index=0,mute=0,solo=0;
    auto validEnd=[&] { input >> std::ws; return input.eof(); };
    auto invalid=[&] { NativePlaybackResult r; r.message="Invalid protocol command"; return r; };
    result=invalid();
    if(command=="test-default") {
      std::string choice;
      if(testDefault && input>>choice && validEnd() && (choice=="original" || choice=="alternate")) {
        testDefault->store(choice=="alternate",std::memory_order_release);
        result.ok=true;
      }
      reply(result);continue;
    }
    auto before=parked?parkedStatus:engine.status();
    if(trainingOnly){before.host=service->status();before.playbackRate=1;before.masterGain=0;}
    double rate=emptyProject?baseConfig.requestedSampleRate:before.host.format.sampleRate;
    auto audibleFrame=[&] {
      int64_t frame=before.audibleProjectionQuality==NativePlaybackAudibleProjectionQuality::Current?before.audibleProjectFrame:before.renderedProjectFrame;
      if(before.audibleProjectionQuality!=NativePlaybackAudibleProjectionQuality::Current && before.transportState==NativePlaybackTransportState::Playing){
        frame-=static_cast<int64_t>(before.totalPresentationLatencyFrames*before.playbackRate);
        const int64_t length=before.loopEndFrame-before.loopStartFrame;
        if(before.loopEnabled && length>0 && frame<before.loopStartFrame && before.loopCount>0)
          frame+=static_cast<int64_t>(std::min<double>(before.loopCount,std::ceil(static_cast<double>(before.loopStartFrame-frame)/length)))*length;
      }
      if(frame<0 && countInLandingSeconds>=0)frame=static_cast<int64_t>(countInLandingSeconds*rate);
      return std::clamp<int64_t>(frame,0,before.durationFrames);
    };
    // Core completion is callback-owned; explicitly park its desired transport
    // before a later seek/resume, rather than confusing ended with paused.
    if(before.transportState!=NativePlaybackTransportState::Completed) completionParked=false;
    if(wantsPlaying && !completionParked && (before.transportState==NativePlaybackTransportState::Completed ||
       (before.transportState==NativePlaybackTransportState::Paused && before.regionEnabled && !before.loopEnabled && !before.regionStopArmed && before.renderedProjectFrame>=before.regionEndFrame))) {
      const auto parked=engine.pause(generation);
      if(!parked.ok){reply(parked);continue;}
      wantsPlaying=false;completionParked=true;
    }
    auto changeOutput=[&](std::string uid){NativePlaybackResult result;const bool useDefault=uid.empty();
        if(!providerSelection.validOutputUid(uid)){result.message="Output device identity does not match the selected provider";return result;}
        service->refreshInventory();
        const auto devices=engine.enumerate();if(uid.empty())uid=devices.defaultOutputUid;
        const AudioHostDeviceInfo* target=nullptr;for(const auto& d:devices.devices)if(d.uid==uid&&d.outputChannels>0&&d.nominalSampleRate>0){target=&d;break;}
        if(!target){result.ok=false;result.message="Selected native output device is unavailable";}
        else {
          clearCues();
          if(trainingOnly || emptyProject){service->parkOutput();baseConfig.outputDeviceUid=target->uid;baseConfig.outputChannels=target->outputChannels>=2?std::vector<uint32_t>{0,1}:std::vector<uint32_t>{0};baseConfig.requestedSampleRate=target->nominalSampleRate;baseConfig.requestedBufferFrames=target->bufferFrames.preferredFrames;outputUid=target->uid;outputLabel=target->label;selectedOutput=useDefault?"":uid;result.ok=true;return result;}
          auto replacement=baseConfig;replacement.outputDeviceUid=target->uid;replacement.outputChannels=target->outputChannels>=2?std::vector<uint32_t>{0,1}:std::vector<uint32_t>{0};replacement.requestedSampleRate=target->nominalSampleRate;replacement.requestedBufferFrames=target->bufferFrames.preferredFrames;
          replacement.playbackRate=before.playbackRate;replacement.transposeSemitones=before.transposeSemitones;if(replacement.cuePlan)replacement.cuePlan->playbackRate=replacement.playbackRate;replacement.masterGain=muted?0.F:before.masterGain;if(replacement.cuePlan)replacement.referenceGainOverride=static_cast<float>(replacement.cuePlan->volume*replacement.masterGain);replacement.initialTransport.startPaused=true;
          replacement.trainingDuck=nativeCarry(carry,target->nominalSampleRate,ids);
          const double oldRate=before.host.format.sampleRate;
          const auto projectFrame=audibleFrame();
          replacement.preparedStartProjectFrame=static_cast<int64_t>(std::clamp<int64_t>(projectFrame,0,before.durationFrames)*target->nominalSampleRate/oldRate);
          if(loopIntent){replacement.initialTransport.loop=NativePlaybackInitialLoop{static_cast<int64_t>(loopIntent->startProjectFrame*target->nominalSampleRate/oldRate),static_cast<int64_t>(loopIntent->endProjectFrame*target->nominalSampleRate/oldRate)};}
          if(regionIntent){replacement.initialTransport.region=NativePlaybackInitialLoop{static_cast<int64_t>(regionIntent->startProjectFrame*target->nominalSampleRate/oldRate),static_cast<int64_t>(regionIntent->endProjectFrame*target->nominalSampleRate/oldRate)};replacement.initialTransport.regionStopArmed=before.regionStopArmed;}
          std::vector<NativePlaybackLaneSource> sources;result.ok=true;
          for(size_t j=0;j<ids.size();++j){NativePlaybackLaneSource lane;lane.id=ids[j];lane.sourceKey=sourceKeys[j];lane.descriptor=OwnedFileDescriptor(duplicateSource(pinned[j].get()));if(!lane.descriptor.valid()){result.ok=false;result.message="Cannot duplicate audio source";break;}for(const auto& control:before.lanes)if(control.id==lane.id){lane.gain=control.gain;lane.muted=control.muted;lane.solo=control.solo;break;}sources.push_back(std::move(lane));}
          // Same-session reprepare retains decoded PCM; no fallback/output-owner handoff.
          if(result.ok)result=engine.unload(generation,NativePlaybackLaneRetention::Park);
          if(result.ok){started=false;songStarted=false;wantsPlaying=false;const auto candidate=nextGeneration++;auto nextLoop=replacement.initialTransport.loop;auto nextRegion=replacement.initialTransport.region;auto nextBase=replacement;nextBase.initialTransport.loop.reset();nextBase.initialTransport.region.reset();nextBase.initialTransport.regionStopArmed.reset();nextBase.preparedStartProjectFrame.reset();
            result=engine.prepare(std::move(replacement),std::move(sources),candidate);if(result.ok){generation=candidate;result=engine.openOutput(generation);if(result.ok)result=startSong();started=result.ok;}
            if(result.ok){baseConfig=nextBase;countInPending=false;countInSeen=false;countInLandingSeconds=-1.;outputUid=target->uid;outputLabel=target->label;loopIntent=nextLoop;regionIntent=nextRegion;selectedOutput=useDefault?"":uid;completionParked=false;
              {const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);while(true){const auto state=engine.status();if(state.transportGeneration==generation&&state.transportState==NativePlaybackTransportState::Paused)break;if(std::chrono::steady_clock::now()>=deadline){result.ok=false;result.message="Native output route did not settle paused";break;}std::this_thread::sleep_for(std::chrono::milliseconds(2));}}}
          }
        }
      return result;
    };
    auto rebuild=[&](NativePlaybackPrepareConfig replacement,bool countIn=false,const std::vector<std::string>* unmute=nullptr,bool forceSwap=false){NativePlaybackResult result;
      replacement.masterGain=muted?0.0F:before.masterGain;if(replacement.cuePlan)replacement.referenceGainOverride=static_cast<float>(replacement.cuePlan->volume*replacement.masterGain);
      replacement.preparedStartProjectFrame=before.renderedProjectFrame<0?audibleFrame():std::clamp<int64_t>(before.renderedProjectFrame,0,before.durationFrames);
      replacement.initialTransport.startPaused=countIn?false:!wantsPlaying;replacement.initialTransport.loop=loopIntent;replacement.initialTransport.region=regionIntent;replacement.initialTransport.regionStopArmed=before.regionStopArmed;
      if(countIn){replacement.preparedStartProjectFrame.reset();replacement.initialTransport.regionStopArmed.reset();}
      if(replacement.cuePlan){
        replacement.cuePlan->playbackRate=replacement.playbackRate;
        auto checked=*replacement.cuePlan;checked.sampleRate=replacement.requestedSampleRate;
        checked.durationSeconds=before.durationFrames/rate;
        const auto planned=preparePlaybackCuePlan(checked);
        if(!planned.ok()){result.ok=false;result.message=planned.message;return result;}
      }
      if(forceSwap){
        if(!started){result=engine.openOutput(generation);if(result.ok)result=startSong();started=result.ok;}
        else if(!songStarted)result=startSong();else result.ok=true;
        if(!result.ok)return result;
      }
      std::vector<NativePlaybackLaneSource> sources;
      result.ok=true;
      for(size_t j=0;j<ids.size();++j){
        NativePlaybackLaneSource lane;lane.id=ids[j];lane.sourceKey=sourceKeys[j];lane.descriptor=OwnedFileDescriptor(duplicateSource(pinned[j].get()));
        if(!lane.descriptor.valid()){result.ok=false;result.message="Cannot duplicate audio source";break;}
        for(const auto& control:before.lanes)if(control.id==lane.id){lane.gain=control.gain;lane.muted=control.muted;lane.solo=control.solo;break;}
        if(unmute && std::find(unmute->begin(),unmute->end(),lane.id)!=unmute->end())lane.muted=false;
        sources.push_back(std::move(lane));
      }
      const bool swap=!countIn && started && (forceSwap || before.host.state==AudioHostState::Running);
      if(result.ok && !swap){result=engine.unload(generation,NativePlaybackLaneRetention::Park);if(result.ok){started=false;songStarted=false;}}
      if(result.ok){
        if(swap)replacement.swapFromGeneration=generation;
        const auto candidate=nextGeneration++;
        result=engine.prepare(std::move(replacement),std::move(sources),candidate);
        if(result.ok){
          generation=candidate;
          if(forceSwap)carryCommitted=true;
          if(swap){
            const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
            while(true){const auto state=engine.status();if(state.swapPendingGeneration==0&&state.transportGeneration==generation)break;
              if(std::chrono::steady_clock::now()>=deadline||state.state==NativePlaybackState::Terminal||state.state==NativePlaybackState::Quarantined){result.ok=false;result.message="Native playback reconfiguration did not settle";break;}
              std::this_thread::sleep_for(std::chrono::milliseconds(2));
            }
          }
        }
      }
      if(result.ok && !countIn){countInPending=false;countInSeen=false;countInLandingSeconds=-1.;}
      return result;
    };
    if(command=="carry-begin"){
      carryDraft.reset();CarryDraft draft;unsigned on=0,arm=1;
      bool parsed=static_cast<bool>(input>>on>>draft.plan.mode>>draft.plan.period>>draft.lanes>>draft.windows);
      if(parsed){
        input>>std::ws;
        if(!input.eof())parsed=static_cast<bool>(input>>arm) && arm<=1 && validEnd();
      }
      if(!trainingOnly && parsed && on<=1 && draft.plan.mode<=1 &&
        std::isfinite(draft.plan.period) && draft.plan.period>=0 && draft.plan.period<=3600 &&
        draft.lanes<=kNativePlaybackMaximumLanes && draft.windows<=kNativePlaybackMaximumTrainingWindows &&
        (draft.plan.mode==0?(draft.plan.period>0 && draft.windows==0):true)){
        draft.plan.enabled=on;draft.arm=arm!=0;carryDraft=std::move(draft);result.ok=true;
      }
      reply(result);continue;
    }
    if(command=="carry-lane"){
      std::string encoded,id;
      const bool valid=carryDraft && input>>encoded && validEnd() && decodeManifestText(encoded,128,id) && carryDraft->plan.laneIds.size()<carryDraft->lanes &&
        std::find(ids.begin(),ids.end(),id)!=ids.end() && std::find(carryDraft->plan.laneIds.begin(),carryDraft->plan.laneIds.end(),id)==carryDraft->plan.laneIds.end();
      if(valid){carryDraft->plan.laneIds.push_back(std::move(id));result.ok=true;}else carryDraft.reset();
      reply(result);continue;
    }
    if(command=="carry-window"){
      const bool valid=carryDraft && carryDraft->plan.mode==1 && input>>a>>b && validEnd() &&
        carryDraft->plan.windows.size()<carryDraft->windows && std::isfinite(a) && std::isfinite(b) && a>=0 && b>a && b<=3600 &&
        (carryDraft->plan.windows.empty() || a>=carryDraft->plan.windows.back().second);
      if(valid){carryDraft->plan.windows.emplace_back(a,b);result.ok=true;}else carryDraft.reset();
      reply(result);continue;
    }
    if(command=="carry-cancel"){carryDraft.reset();result.ok=validEnd();reply(result);continue;}
    if(command=="carry-apply"){
      auto draft=std::move(carryDraft);carryDraft.reset();
      if(!validEnd() || trainingOnly || !draft || draft->plan.laneIds.size()!=draft->lanes || draft->plan.windows.size()!=draft->windows){reply(result);continue;}
      if(emptyProject){result.message="Empty project has no Carry the line audio graph";reply(result);continue;}
      if(parked || countInPending){result.message="Wait for playback ownership before changing Carry the line";reply(result);continue;}
      auto next=nativeCarry(draft->plan,rate,ids);
      bool valid=std::all_of(draft->plan.laneIds.begin(),draft->plan.laneIds.end(),[&](const auto& id){return std::find(ids.begin(),ids.end(),id)!=ids.end();});
      if(next){
        if(next->mode==NativePlaybackTrainingMode::Period && next->periodFrames<=0)valid=false;
        for(size_t i=0;i<next->windows.size();++i)if(next->windows[i].endProjectFrame<=next->windows[i].startProjectFrame || (i && next->windows[i].startProjectFrame<next->windows[i-1].endProjectFrame))valid=false;
      }
      if(!valid){result.message="Carry the line schedule is invalid for the current native lanes or sample rate";reply(result);continue;}
      auto replacement=baseConfig;replacement.playbackRate=before.playbackRate;replacement.transposeSemitones=before.transposeSemitones;replacement.trainingDuck=next;
      // Source toggleTraining unmutes on the requested off->on transition,
      // including an empty line plan. Later lyric/config updates while the
      // request remains on must preserve a singer's intervening manual mute.
      // Restoring an already armed saved project is not a user toggle: its
      // manually muted guides must remain muted in the replacement graph.
      const bool arming=draft->arm && draft->plan.enabled && (!carry || !carry->enabled);
      result=rebuild(std::move(replacement),false,arming?&draft->plan.laneIds:nullptr,true);
      if(carryCommitted){carry=std::move(draft->plan);baseConfig.trainingDuck=std::move(next);++carryRevision;}
      reply(result);continue;
    }
    if(command=="lanes-begin") {
      laneDraft.reset();size_t count=0;
      if(!trainingOnly && input>>count && validEnd() && count<=kNativePlaybackMaximumLanes){laneDraft=LaneManifest{count,{}};result.ok=true;}
      reply(result);continue;
    }
    if(command=="lanes-add") {
      std::string encodedId,encodedPath,id,path;
      bool valid=laneDraft && input>>encodedId>>encodedPath && validEnd() &&
        decodeManifestText(encodedId,128,id) && decodeManifestText(encodedPath,1800,path) &&
        std::filesystem::u8path(path).is_absolute() && laneDraft->sources.size()<laneDraft->count;
      if(valid)valid=std::none_of(laneDraft->sources.begin(),laneDraft->sources.end(),[&](const auto& source){return source.first==id;});
      if(valid){laneDraft->sources.emplace_back(std::move(id),std::move(path));result.ok=true;}else laneDraft.reset();
      reply(result);continue;
    }
    if(command=="lanes-cancel") {
      laneDraft.reset();result.ok=validEnd();reply(result);continue;
    }
    if(command=="lanes-apply") {
      auto draft=std::move(laneDraft);laneDraft.reset();
      if(!validEnd() || trainingOnly || !draft || draft->sources.size()!=draft->count){reply(result);continue;}
      if(draft->count==0){
        // Retiring the final lane is a genuine Release, including any parked
        // PCM. The shared physical provider is retired separately; both must
        // prove completion before a subsequent prepare may consume its lease.
        if(emptyProject){clearCues();service->parkOutput();const auto hostState=service->status().state;result.ok=(emptyNeverClaimed || (emptyCleanup && emptyCleanup->globallyComplete())) && (hostState==AudioHostState::Stopped || hostState==AudioHostState::Closed || hostState==AudioHostState::Unsupported);result.message=result.ok?"":"Empty project cleanup is uncertain";reply(result,true);continue;}
        config.playbackRate=before.playbackRate;config.transposeSemitones=before.transposeSemitones;config.masterGain=before.masterGain;
        baseConfig.playbackRate=config.playbackRate;baseConfig.transposeSemitones=config.transposeSemitones;baseConfig.masterGain=config.masterGain;
        clearCues();
        const auto retired=engine.unloadWithCleanup(generation,NativePlaybackLaneRetention::Release);
        service->parkOutput();
        emptyCleanup=retired.cleanup;emptyNeverClaimed=false;emptyProject=true;
        const auto hostState=service->status().state;
        physicalReleased=retired.cleanup.globallyComplete() &&
          (hostState==AudioHostState::Stopped || hostState==AudioHostState::Closed || hostState==AudioHostState::Unsupported);
        result=retired.playback;result.ok=physicalReleased;
        if(!result.ok)result.message="Playback lanes were removed, but native output cleanup is uncertain. Close and reopen this project.";
        if(physicalReleased)generation=0;
        ids.clear();sourceKeys.clear();pinned.clear();laneDurations.clear();
        parked=false;parkedBytes=0;started=false;songStarted=false;wantsPlaying=false;completionParked=false;
        countInPending=false;countInSeen=false;countInLandingSeconds=-1.;loopIntent.reset();regionIntent.reset();metronome.reset();metDraft.reset();
        if(carry){carry.reset();++carryRevision;}carryDraft.reset();baseConfig.trainingDuck.reset();
        // The reference gain is owned by the cue plan. Keeping a nonzero
        // override after removing that plan makes the next real prepare
        // invalid (and would otherwise resurrect an orphan reference bus).
        baseConfig.cuePlan.reset();baseConfig.referenceGainOverride.reset();
        baseConfig.initialTransport.loop.reset();baseConfig.initialTransport.region.reset();baseConfig.initialTransport.regionStopArmed.reset();baseConfig.preparedStartProjectFrame=0;
        lanesCommitted=true;++laneSetRevision;
        reply(result,true);continue;
      }
      if(emptyProject && !emptyNeverClaimed && (!emptyCleanup || !emptyCleanup->globallyComplete())){result.message="Empty project cleanup is uncertain; reopen before adding audio";reply(result);continue;}
      if(parked){result.message="Playback is parked for microphone monitoring";reply(result);continue;}
      if(countInPending){result.message="Wait for the count-in before changing playback lanes";reply(result);continue;}
      if(emptyProject){
        // Resolve desired routing before claiming a generation or touching any
        // candidate PCM. Default follows the current endpoint; an unavailable
        // explicit UID is a refusal, never permission to use another device.
        service->refreshInventory();const auto devices=engine.enumerate();
        const auto requested=selectedOutput.empty()?devices.defaultOutputUid:selectedOutput;
        const AudioHostDeviceInfo* target=nullptr;
        for(const auto& device:devices.devices)if(device.uid==requested && device.outputChannels>0 && device.nominalSampleRate>0){target=&device;break;}
        if(!target){result.message="Selected native output device is unavailable";reply(result);continue;}
        outputUid=target->uid;outputLabel=target->label;baseConfig.outputDeviceUid=target->uid;
        baseConfig.outputChannels=target->outputChannels>=2?std::vector<uint32_t>{0,1}:std::vector<uint32_t>{0};
        baseConfig.requestedSampleRate=target->nominalSampleRate;baseConfig.requestedBufferFrames=target->bufferFrames.preferredFrames;rate=baseConfig.requestedSampleRate;
      }
      // Every descriptor and native duration is prepared while the old graph
      // is untouched. A malformed, missing or undecodable lane cannot retire
      // the working song. The core bounds candidate decoded memory as well.
      auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(45);
      DecodeCancellation cancellation{&deadline,[](void* context) noexcept {
        return std::chrono::steady_clock::now()>=*static_cast<std::chrono::steady_clock::time_point*>(context);
      }};
      std::vector<OwnedFileDescriptor> candidatePinned;
      std::vector<NativePlaybackLaneSource> candidateSources;
      std::vector<std::string> candidateIds,candidateKeys;
      std::vector<double> candidateDurations;
      int64_t durationFrames=0;result.ok=true;
      for(const auto& entry:draft->sources){
        auto file=openManifestSource(entry.second);
        if(!file.valid()){result.ok=false;result.message="Cannot open ordinary bounded replacement audio source";break;}
        LaneMeasureRequest request;request.id=entry.first;request.descriptor=OwnedFileDescriptor(duplicateSource(file.get()));request.policy.minimumPeaks=2;request.policy.maximumPeaks=2;
        const auto measured=measureLane(std::move(request),cancellation);
        double seconds=measured.ok?measured.durationSeconds:0.;
        if(!measured.ok){
          // The streaming measurer handles WAV/FLAC/MP3. Keep every other
          // format supported by the actual native decoder available too.
          auto options=baseConfig.decodeOptions;options.requiredSampleRate=static_cast<uint32_t>(rate);
          const auto decoded=prepareDecodedAudio(OwnedFileDescriptor(duplicateSource(file.get())),options,cancellation);
          if(decoded.ok() && decoded.audio && decoded.audio->sampleRate())seconds=static_cast<double>(decoded.audio->frameCount())/decoded.audio->sampleRate();
        }
        if(!std::isfinite(seconds) || seconds<=0 || seconds>3600 || rate<=0){result.ok=false;result.message="Cannot decode bounded replacement audio source";break;}
        candidateDurations.push_back(seconds);
        durationFrames=std::max(durationFrames,static_cast<int64_t>(std::floor(seconds*rate+0.5)));
        NativePlaybackLaneSource lane;lane.id=entry.first;lane.descriptor=OwnedFileDescriptor(duplicateSource(file.get()));
        // A manifest replacement must read the supplied bytes, even when a
        // path was reused. Later rate rebuilds keep this committed key and may
        // safely adopt the newly decoded PCM during their own transaction.
        lane.sourceKey=entry.first+":"+entry.second+":lanes-"+std::to_string(nextGeneration);
        if(!lane.descriptor.valid()){result.ok=false;result.message="Cannot pin replacement audio source";break;}
        for(const auto& control:before.lanes)if(control.id==lane.id){lane.gain=control.gain;lane.muted=control.muted;lane.solo=control.solo;break;}
        candidateIds.push_back(lane.id);candidateKeys.push_back(lane.sourceKey);candidateSources.push_back(std::move(lane));candidatePinned.push_back(std::move(file));
      }
      if(!result.ok){reply(result);continue;}
      auto replacement=baseConfig;replacement.playbackRate=emptyProject?config.playbackRate:before.playbackRate;replacement.transposeSemitones=emptyProject?config.transposeSemitones:before.transposeSemitones;
      replacement.masterGain=muted?0.F:(emptyProject?config.masterGain:before.masterGain);
      if(replacement.cuePlan){replacement.cuePlan->playbackRate=replacement.playbackRate;replacement.referenceGainOverride=static_cast<float>(replacement.cuePlan->volume*replacement.masterGain);}
      auto nextCarry=carry;
      if(nextCarry)nextCarry->laneIds.erase(std::remove_if(nextCarry->laneIds.begin(),nextCarry->laneIds.end(),[&](const auto& id){return std::find(candidateIds.begin(),candidateIds.end(),id)==candidateIds.end();}),nextCarry->laneIds.end());
      replacement.trainingDuck=nativeCarry(nextCarry,rate,candidateIds);
      auto nextLoop=loopIntent;
      if(nextLoop){nextLoop->endProjectFrame=std::min(nextLoop->endProjectFrame,durationFrames);if(nextLoop->startProjectFrame>=nextLoop->endProjectFrame)nextLoop.reset();}
      auto nextRegion=regionIntent;
      if(nextRegion){nextRegion->endProjectFrame=std::min(nextRegion->endProjectFrame,durationFrames);if(nextRegion->startProjectFrame>=nextRegion->endProjectFrame)nextRegion.reset();}
      replacement.initialTransport.startPaused=!wantsPlaying;replacement.initialTransport.loop=nextLoop;replacement.initialTransport.region=nextRegion;replacement.initialTransport.regionStopArmed=before.regionStopArmed;
      replacement.preparedStartProjectFrame=std::clamp<int64_t>(before.renderedProjectFrame<0?audibleFrame():before.renderedProjectFrame,0,durationFrames);
      if(emptyProject){
        clearCues();service->parkOutput();
        const auto emptyHostState=service->status().state;
        if(emptyHostState!=AudioHostState::Stopped && emptyHostState!=AudioHostState::Closed && emptyHostState!=AudioHostState::Unsupported){result.ok=false;result.message="Native training output did not release before adding audio";reply(result);continue;}
        // No generation-zero device open and no zero-lane PCM placeholder.
        // Consume the precise native cleanup lease in a fresh paused prepare.
        replacement.swapFromGeneration=0;replacement.initialTransport.startPaused=true;
        replacement.initialTransport.loop.reset();replacement.initialTransport.region.reset();replacement.initialTransport.regionStopArmed.reset();replacement.preparedStartProjectFrame=0;
        replacement.handoffLease=emptyCleanup?emptyCleanup->handoffLease:0;
        const auto candidate=nextGeneration++;
        result=engine.prepare(std::move(replacement),std::move(candidateSources),candidate,cancellation);
        emptyNeverClaimed=false;
        if(result.ok){
          generation=candidate;ids=std::move(candidateIds);sourceKeys=std::move(candidateKeys);pinned=std::move(candidatePinned);laneDurations=std::move(candidateDurations);
          emptyProject=false;emptyCleanup.reset();physicalReleased=false;parked=false;parkedBytes=0;
          started=false;songStarted=false;wantsPlaying=false;completionParked=false;
          if(carry && nextCarry && carry->laneIds!=nextCarry->laneIds)++carryRevision;
          carry=std::move(nextCarry);baseConfig.trainingDuck=nativeCarry(carry,rate,ids);
          lanesCommitted=true;++laneSetRevision;
        }else{
          // A failed admission can itself have claimed ownership. Recover its
          // real cleanup capability rather than reusing a consumed old lease.
          emptyCleanup=engine.abortPrepareDelivery(candidate);service->parkOutput();
          const auto hostState=service->status().state;
          physicalReleased=emptyCleanup->globallyComplete() &&
            (hostState==AudioHostState::Stopped || hostState==AudioHostState::Closed || hostState==AudioHostState::Unsupported);
          if(!physicalReleased)result.message+="; native cleanup is uncertain, reopen this project";
        }
        reply(result,lanesCommitted);continue;
      }
      // A swap needs callbacks, including for an initially prepared/paused
      // song. Open that SAME old generation paused rather than unloading it.
      if(!started){result=engine.openOutput(generation);if(result.ok)result=startSong();started=result.ok;}
      else if(!songStarted)result=startSong();
      if(result.ok){
        replacement.swapFromGeneration=generation;
        const auto candidate=nextGeneration++;
        result=engine.prepare(std::move(replacement),std::move(candidateSources),candidate,cancellation);
        if(result.ok){
          // prepare has armed an irreversible callback swap. Commit bridge
          // ownership now even if later retirement telemetry reports failure.
          generation=candidate;ids=std::move(candidateIds);sourceKeys=std::move(candidateKeys);pinned=std::move(candidatePinned);loopIntent=nextLoop;regionIntent=nextRegion;
          laneDurations=std::move(candidateDurations);
          if(carry && nextCarry && carry->laneIds!=nextCarry->laneIds)++carryRevision;
          carry=std::move(nextCarry);baseConfig.trainingDuck=nativeCarry(carry,rate,ids);
          lanesCommitted=true;++laneSetRevision;
          const auto landingDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
          while(true){const auto current=engine.status();if(current.swapPendingGeneration==0&&current.transportGeneration==generation)break;
            if(std::chrono::steady_clock::now()>=landingDeadline||current.state==NativePlaybackState::Terminal||current.state==NativePlaybackState::Quarantined){result.ok=false;result.message="Playback lanes were committed, but native playback did not settle. Pause and reopen this project.";break;}
            std::this_thread::sleep_for(std::chrono::milliseconds(2));
          }
        }
      }
      reply(result,lanesCommitted);continue;
    }
    if(command=="quit" && validEnd()) break;
    const bool emptyCueCommand=command=="cue" || command=="cue-timed" || command=="cue-confirm" || command=="cue-cancel" || command=="cue-gain";
    if(emptyProject && emptyCueCommand && !emptyNeverClaimed && (!emptyCleanup || !emptyCleanup->globallyComplete())){result.message="Empty project cleanup is uncertain; reopen before training";reply(result);continue;}
    if(emptyProject && !emptyCueCommand){
      if(command=="status" && validEnd())result.ok=true;
      else if((command=="pause" || command=="unpark" || command=="unloop" || command=="unregion") && validEnd())result.ok=emptyNeverClaimed || (emptyCleanup && emptyCleanup->globallyComplete());
      else if(command=="park" && validEnd()){clearCues();service->parkOutput();const auto hostState=service->status().state;result.ok=(emptyNeverClaimed || (emptyCleanup && emptyCleanup->globallyComplete())) && (hostState==AudioHostState::Stopped || hostState==AudioHostState::Closed || hostState==AudioHostState::Unsupported);if(!result.ok)result.message="Native empty project output cleanup is uncertain";}
      else if(command=="master" && input>>a && validEnd() && std::isfinite(a) && a>=0 && a<=4){config.masterGain=muted?0.F:static_cast<float>(a);baseConfig.masterGain=config.masterGain;result.ok=true;}
      else if(command=="rate" && input>>a>>b && validEnd() && std::isfinite(a) && std::isfinite(b) && a>=0.25 && a<=4. && b>=-24. && b<=24. && std::floor(b)==b){config.playbackRate=a;config.transposeSemitones=b;baseConfig.playbackRate=a;baseConfig.transposeSemitones=b;result.ok=true;}
      else if(command=="output"){
        std::string token,uid;
        if(input>>token && validEnd() && decodeUid(token,uid)){
          if(!providerSelection.validOutputUid(uid)){result.message="Output device identity does not match the selected provider";reply(result);continue;}
          service->refreshInventory();const auto devices=engine.enumerate();const auto requested=uid.empty()?devices.defaultOutputUid:uid;
          for(const auto& device:devices.devices)if(device.uid==requested && device.outputChannels>0 && device.nominalSampleRate>0){
            clearCues();service->parkOutput();selectedOutput=uid;outputUid=device.uid;outputLabel=device.label;
            baseConfig.outputDeviceUid=device.uid;baseConfig.outputChannels=device.outputChannels>=2?std::vector<uint32_t>{0,1}:std::vector<uint32_t>{0};
            baseConfig.requestedSampleRate=device.nominalSampleRate;baseConfig.requestedBufferFrames=device.bufferFrames.preferredFrames;result.ok=true;break;
          }
          if(!result.ok)result.message="Selected native output device is unavailable";
        }
      }else result.message="Empty project has no audio graph; use a separate training or monitoring session";
      reply(result);continue;
    }

    if(command=="park" && validEnd()) {
      if(parked){result.ok=true;reply(result);continue;}
      clearCues();
      if(trainingOnly){service->parkOutput();const auto state=service->status().state;
        physicalReleased=state==AudioHostState::Stopped || state==AudioHostState::Closed || state==AudioHostState::Unsupported;
        result.ok=physicalReleased;if(!result.ok)result.message="Training output release is uncertain";parked=result.ok;reply(result);continue;}
      const auto cleanup=engine.unloadWithCleanup(generation,NativePlaybackLaneRetention::Park);
      service->parkOutput();
      const auto baseState=service->status().state;
      result=cleanup.playback;
      // This is a physical-stream release, not a globally-empty/fallback lease:
      // decoded PCM intentionally remains parked in this same session.
      physicalReleased=result.ok && (baseState==AudioHostState::Stopped || baseState==AudioHostState::Closed || baseState==AudioHostState::Unsupported)
        && !cleanup.cleanup.physicalOwnershipRetained
        && cleanup.cleanup.state==NativePlaybackState::Unloaded
        && cleanup.cleanup.retainedBytes==cleanup.cleanup.parkedLaneBytes
        && cleanup.cleanup.coordinatorState!=NativePlaybackCoordinatorState::Poisoned
        && (cleanup.cleanup.error==NativePlaybackError::None ||
            (cleanup.cleanup.error==NativePlaybackError::TeardownUncertain && cleanup.cleanup.parkedLaneBytes>0))
        && !cleanup.cleanup.processQuarantinePoisoned
        && !cleanup.cleanup.processQuarantineReserved
        && cleanup.cleanup.processQuarantineRetainedBytes==0;
      if(result.ok&&!physicalReleased){result.ok=false;result.message="Playback output release is uncertain";}
      if(result.ok){parkedStatus=before;parkedStatus.transportState=NativePlaybackTransportState::Paused;
        parkedStatus.regionEnabled=regionIntent.has_value();if(regionIntent){parkedStatus.regionStartFrame=regionIntent->startProjectFrame;parkedStatus.regionEndFrame=regionIntent->endProjectFrame;}
        parkedStatus.loopEnabled=loopIntent.has_value();if(loopIntent){parkedStatus.loopStartFrame=loopIntent->startProjectFrame;parkedStatus.loopEndFrame=loopIntent->endProjectFrame;}
        parkedStatus.state=NativePlaybackState::Unloaded;parkedStatus.audibleProjectionQuality=NativePlaybackAudibleProjectionQuality::Unavailable;
        // Freeze at the last audible position, including latency compensation.
        parkedStatus.renderedProjectFrame=audibleFrame();
        parkedBytes=cleanup.cleanup.parkedLaneBytes;parkedHandoffLease=cleanup.cleanup.handoffLease;countInPending=false;countInSeen=false;countInLandingSeconds=-1.;parked=true;started=false;songStarted=false;wantsPlaying=false;completionParked=false;}
      reply(result);continue;
    }
    if(command=="unpark" && validEnd()) {
      if(!parked){result.ok=true;reply(result);continue;}
      if(trainingOnly){parked=false;physicalReleased=false;result.ok=true;reply(result);continue;}
      auto replacement=baseConfig;replacement.playbackRate=before.playbackRate;replacement.transposeSemitones=before.transposeSemitones;if(replacement.cuePlan)replacement.cuePlan->playbackRate=replacement.playbackRate;
      // A streamed graph has no decoded PCM for Park to retain. Its cleanup
      // therefore returns the process fallback lease; consume that lease to
      // reclaim native playback ownership for this session's replacement.
      replacement.handoffLease=parkedHandoffLease;
      replacement.masterGain=muted?0.F:before.masterGain;if(replacement.cuePlan)replacement.referenceGainOverride=static_cast<float>(replacement.cuePlan->volume*replacement.masterGain);replacement.initialTransport.startPaused=true;replacement.initialTransport.loop=loopIntent;replacement.initialTransport.region=regionIntent;replacement.initialTransport.regionStopArmed=before.regionStopArmed;
      replacement.preparedStartProjectFrame=before.renderedProjectFrame;
      std::vector<NativePlaybackLaneSource> sources;result.ok=true;
      for(size_t j=0;j<ids.size();++j){NativePlaybackLaneSource lane;lane.id=ids[j];lane.sourceKey=sourceKeys[j];lane.descriptor=OwnedFileDescriptor(duplicateSource(pinned[j].get()));if(!lane.descriptor.valid()){result.ok=false;result.message="Cannot duplicate retained audio source";break;}for(const auto& control:before.lanes)if(control.id==lane.id){lane.gain=control.gain;lane.muted=control.muted;lane.solo=control.solo;break;}sources.push_back(std::move(lane));}
      if(result.ok){
        if(testFailUnparkPrepareOnce){replacement.maximumRetainedBytes=1;testFailUnparkPrepareOnce=false;}
        if(testFailUnparkBeforeLeaseClaimOnce){replacement.handoffLease=9007199254740992ULL;testFailUnparkBeforeLeaseClaimOnce=false;}
        const auto candidate=nextGeneration++;
        const bool hadParkedPcm=parkedBytes>0;
        result=engine.prepare(std::move(replacement),std::move(sources),candidate);
        if(result.ok){generation=candidate;parked=false;physicalReleased=false;parkedBytes=0;parkedHandoffLease=0;unparkAdoptedParkedPcm=result.adoptedParkedLanes&&hadParkedPcm;}
        else {
          // Prepare may have consumed the old fallback lease before rejecting
          // its candidate. Retire that failed generation and retain its fresh
          // cleanup lease so a later unpark retry can reclaim ownership.
          const auto failed=engine.unloadWithCleanup(candidate,NativePlaybackLaneRetention::Release);
          if(failed.cleanup.handoffLease!=0)parkedHandoffLease=failed.cleanup.handoffLease;
        }
      }
      reply(result);
      // Adoption describes this unpark only; a later rebuild re-decodes, so
      // no later reply may still claim the parked PCM was adopted.
      unparkAdoptedParkedPcm=false;
      continue;
    }
    if(parked && command!="status"){result.message="Playback is parked for microphone monitoring";reply(result);continue;}
    if(command=="cue" || command=="cue-timed") {
      uint64_t candidate=0;unsigned sound=0,count=0;double gain=0;
      TrainingPhraseTiming timing;
      bool valid=readCueGeneration(input,candidate) && static_cast<bool>(input>>sound>>gain) && candidate>cueGeneration && sound<4 && std::isfinite(gain) && gain>=0 && gain<=2;
      if(valid && command=="cue-timed")valid=static_cast<bool>(input>>timing.noteDuration>>timing.sequenceGap>>timing.contextGap>>timing.questionGap>>timing.answerGap>>timing.attack>>timing.release>>timing.peakGain);
      valid=valid && static_cast<bool>(input>>count) && count>0 && count<=128;
      std::vector<TrainingCue> cues;
      size_t total=0;
      for(unsigned i=0;valid && i<count;++i){unsigned purpose=0,together=0,notes=0;
        valid=static_cast<bool>(input>>purpose>>together>>notes) && purpose<3 && together<=1 && notes>0 && notes<=32 && total+notes<=256;
        TrainingCue cue;cue.purpose=static_cast<TrainingPurpose>(purpose);cue.together=together;
        for(unsigned n=0;valid && n<notes;++n){int midi=0;valid=static_cast<bool>(input>>midi) && midi>=0 && midi<=127;if(valid)cue.notes.push_back(midi);}
        total+=notes;if(valid)cues.push_back(std::move(cue));
      }
      if(valid && validEnd()) {
        auto phrase=renderTrainingPhrase(static_cast<TrainingInstrument>(sound),cues,timing,CueSamples::lookup,&cueSamples);
        if(!phrase.ok()){result.message="Native training phrase rendering failed";reply(result);continue;}
        service->refreshInventory();
        const auto devices=engine.enumerate();
        if(selectedOutput.empty() && devices.defaultOutputUid!=outputUid){result=changeOutput("");if(!result.ok){reply(result);continue;}}
        else if(std::none_of(devices.devices.begin(),devices.devices.end(),[&](const auto& d){return d.uid==outputUid&&d.outputChannels>0;})){
          result.message="Selected native output device is unavailable";reply(result);continue;
        }
        // Start a paused song callback if needed, retaining its transport state.
        // This also establishes the exact selected route for the shared base.
        if(trainingOnly || emptyProject){AudioHostConfig route;route.outputDeviceUid=outputUid;
          const auto opened=service->initialize(route);auto ready=opened;if(ready.ok)ready=service->ensureOutput();
          result.ok=ready.ok;result.message=ready.message;}
        else if(!started){result=engine.openOutput(generation);if(result.ok)result=startSong();started=result.ok;}else result.ok=true;
        if(result.ok){
          const auto host=service->status();
          if(host.state!=AudioHostState::Running){result.ok=false;result.message="Native training output is not running";}
        }
        if(result.ok){
          clearCues();cueGeneration=candidate;cueStart=cueClockNs()+50000000;
          cueEnd=cueStart+static_cast<uint64_t>(phrase.duration*1e9);cueGain=muted?0:gain;cueNotes=std::move(phrase.notes);
          result.ok=cueMixer.schedule(std::move(phrase.planes),candidate,48000,cueStart,static_cast<float>(cueGain));
          if(result.ok)service->setTrainingRenderer([](void* context,const AudioHostRenderBlock& block)noexcept{return static_cast<TrainingPcmMixer*>(context)->render(block);},&cueMixer);
          else {clearCues();result.message="Native training PCM capacity exceeded";}
        }
        if(emptyProject && !result.ok){clearCues();service->parkOutput();}
      }
    }
    else if(command=="cue-confirm") {
      uint64_t candidate=0;
      if(readCueGeneration(input,candidate) && input>>a && validEnd() && std::isfinite(a) && a>=0 && a<=2){
        result.ok=true;
        if(candidate==cueGeneration && service->status().state==AudioHostState::Running){
          std::vector<float> pcm(4080);
          for(size_t i=0;i<pcm.size();++i){const double at=i/48000.;const double envelope=at<.004?at/.004:(.085-at)/(.085-.004);pcm[i]=static_cast<float>(std::sin(2*3.14159265358979323846*660*at)*envelope*.08);}
          result.ok=cueMixer.schedule({std::move(pcm)},candidate,48000,cueClockNs()+2000000,muted?0.F:static_cast<float>(std::min(1.,a)));
          if(!result.ok)result.message="Native confirmation tone capacity exceeded";
        }
      }
    }
    else if(command=="cue-cancel") {
      uint64_t candidate=0;
      if(readCueGeneration(input,candidate) && validEnd()){if(candidate==cueGeneration){clearCues();if(emptyProject)service->parkOutput();}result.ok=true;}
    }
    else if(command=="cue-gain") {
      uint64_t candidate=0;
      if(readCueGeneration(input,candidate) && input>>a && validEnd() && std::isfinite(a) && a>=0 && a<=2){
        if(candidate==cueGeneration){cueGain=muted?0:a;cueMixer.setGain(candidate,static_cast<float>(cueGain));}result.ok=true;
      }
    }
    else if(command=="status" && validEnd()) { result.ok=true;reply(result,true);continue; }
    else if(trainingOnly && command=="output") {std::string token,uid;if(input>>token && validEnd() && decodeUid(token,uid))result=changeOutput(uid);}
    else if(trainingOnly){result.message="No song is loaded in this training session";}
    else if(command=="met-begin") {
      metDraft.reset();MetronomeDraft draft;unsigned click=0,accent=0;
      if(input>>click>>draft.request.countInBars>>draft.request.volume>>accent>>draft.request.beatGrid.beatsPerBar>>draft.request.beatGrid.downbeat>>draft.beats>>draft.bars && validEnd() &&
        click<=1 && accent<=1 && draft.request.countInBars<=2 && std::isfinite(draft.request.volume) && draft.request.volume>=0 && draft.request.volume<=1 &&
        (draft.request.beatGrid.beatsPerBar==2||draft.request.beatGrid.beatsPerBar==3||draft.request.beatGrid.beatsPerBar==4||draft.request.beatGrid.beatsPerBar==6) &&
        draft.request.beatGrid.downbeat<draft.request.beatGrid.beatsPerBar && draft.beats<=kPlaybackCueMaximumBeats && (draft.beats==0||draft.beats>=2) && draft.bars<=draft.beats && (!click||draft.beats>=2)) {
        draft.request.click=click;draft.request.accent=accent;metDraft=std::move(draft);result.ok=true;
      }
    }
    else if(command=="met-beats" || command=="met-bars") {
      size_t offset=0,count=0;bool valid=metDraft.has_value() && static_cast<bool>(input>>offset>>count) && count>0 && count<=96;
      if(valid){auto& draft=*metDraft;
        if(command=="met-beats"){
          auto& beats=draft.request.beatGrid.beats;valid=offset==beats.size() && count<=draft.beats-beats.size();
          for(size_t i=0;valid && i<count;++i){double beat=0;valid=static_cast<bool>(input>>beat)&&std::isfinite(beat)&&beat>=0&&beat<=kPlaybackCueMaximumDurationSeconds&&(beats.empty()||beat-beats.back()>0.05);if(valid)beats.push_back(beat);}
        }else{
          auto& bars=draft.request.beatGrid.downbeats;valid=offset==bars.size() && count<=draft.bars-bars.size();
          for(size_t i=0;valid && i<count;++i){uint32_t beat=0;valid=static_cast<bool>(input>>beat)&&beat<draft.beats&&(bars.empty()||beat>bars.back());if(valid)bars.push_back(beat);}
        }
      }
      valid=valid && validEnd();if(valid)result.ok=true;else metDraft.reset();
    }
    else if(command=="met-apply" && validEnd()) {
      if(metDraft && metDraft->request.beatGrid.beats.size()==metDraft->beats && metDraft->request.beatGrid.downbeats.size()==metDraft->bars){
        auto request=std::move(metDraft->request);metDraft.reset();
        uint64_t maximumBar=request.beatGrid.beatsPerBar;
        for(size_t i=1;i<request.beatGrid.downbeats.size();++i)maximumBar=std::max<uint64_t>(maximumBar,request.beatGrid.downbeats[i]-request.beatGrid.downbeats[i-1]);
        const uint64_t countPotential=request.countInBars*(request.beatGrid.beats.empty()?3:maximumBar);
        if(countPotential>kPlaybackCueMaximumEvents || (request.click && request.beatGrid.beats.size()+2+countPotential>kPlaybackCueMaximumEvents)){
          result.message="Metronome count-in exceeds the cue event limit";reply(result);continue;
        }
        auto checked=request;checked.sampleRate=rate;checked.playbackRate=before.playbackRate;checked.durationSeconds=before.durationFrames/rate;
        const auto planned=preparePlaybackCuePlan(checked);
        if(!planned.ok()){result.message=planned.message;reply(result);continue;}
        auto replacement=baseConfig;replacement.playbackRate=before.playbackRate;replacement.transposeSemitones=before.transposeSemitones;
        replacement.cuePlan=request;replacement.cuePlan->countInBars=0;replacement.cuePlan->volume=muted?0.:request.volume;
        result=rebuild(std::move(replacement));
        if(result.ok){metronome=request;request.countInBars=0;request.playbackRate=before.playbackRate;request.volume=muted?0.:request.volume;baseConfig.cuePlan=std::move(request);}
      }else metDraft.reset();
    }
    else if(command=="met-preview" && input>>index && validEnd() && index<=1) {
      service->refreshInventory();
      if(selectedOutput.empty()&&engine.enumerate().defaultOutputUid!=outputUid){result=changeOutput("");if(!result.ok){reply(result);continue;}}
      result=engine.previewClick(generation,index?NativePlaybackPreviewClickSound::Accent:NativePlaybackPreviewClickSound::Ordinary);
      if(result.ok)started=true;
    }
    else if((command=="play" || command=="play-flat") && validEnd()) {
      service->refreshInventory();
      if(selectedOutput.empty()&&engine.enumerate().defaultOutputUid!=outputUid){result=changeOutput("");if(!result.ok){reply(result);continue;}}
      if(command=="play" && !wantsPlaying && metronome && metronome->countInBars>0){
        auto replacement=baseConfig;replacement.playbackRate=before.playbackRate;replacement.transposeSemitones=before.transposeSemitones;
        replacement.cuePlan=*metronome;replacement.cuePlan->volume=muted?0.:metronome->volume;replacement.cuePlan->countInAnchorSeconds=before.transportState==NativePlaybackTransportState::Completed?0.:audibleFrame()/rate;countInLandingSeconds=replacement.cuePlan->countInAnchorSeconds;
        result=rebuild(std::move(replacement),true);
        if(result.ok){result=engine.openOutput(generation);if(result.ok)result=startSong();started=result.ok;}
        if(result.ok){wantsPlaying=true;countInSeen=false;countInPending=true;}
        reply(result);continue;
      }
      if(!started) { result=engine.openOutput(generation); if(result.ok) result=startSong(); started=result.ok; }
      else if(!songStarted)result=startSong();
      else result.ok=true;
      if(result.ok && before.durationFrames>0 && (before.transportState==NativePlaybackTransportState::Completed || before.audibleProjectFrame>=static_cast<int64_t>(before.durationFrames))) result=engine.seek(generation,0);
      if(result.ok && !wantsPlaying) result=engine.resume(generation);
      if(result.ok) wantsPlaying=true;
    } else if(command=="pause" && validEnd()) {
      if(wantsPlaying) result=engine.pause(generation); else result.ok=true;
      if(result.ok){wantsPlaying=false;countInPending=false;countInSeen=false;countInLandingSeconds=-1.;}
    }
    else if(command=="seek" && input>>a && validEnd() && std::isfinite(a) && a>=0 && rate>0 && a<=engine.status().durationFrames/rate+1./rate) {
      // Start a paused stream for callback-applied seek receipts.
      if(!started) { result=engine.openOutput(generation); if(result.ok) result=startSong(); started=result.ok; }
      else if(!songStarted)result=startSong();
      else result.ok=true;
      if(result.ok){result=engine.seek(generation,std::min<int64_t>(engine.status().durationFrames,static_cast<int64_t>(a*rate)));if(result.ok){countInPending=false;countInSeen=false;countInLandingSeconds=-1.;}}
    } else if(command=="master" && input>>a && validEnd() && std::isfinite(a) && a>=0 && a<=4) result=engine.setSongAndReferenceGain(generation,muted?0.0F:static_cast<float>(a),muted?0.0F:static_cast<float>(a*(metronome?metronome->volume:0.)));
    else if(command=="lane" && input>>index>>a>>mute>>solo && validEnd() && index<ids.size() && std::isfinite(a) && a>=0 && a<=4 && mute<=1 && solo<=1) result=engine.setLaneControl(generation,ids[index],static_cast<float>(a),mute,solo);
    else if(command=="rate" && input>>a>>b && validEnd() && std::isfinite(a)&&std::isfinite(b)&&a>=0.25&&a<=4.&&b>=-24.&&b<=24.&&std::floor(b)==b) {
      auto replacement=baseConfig;replacement.playbackRate=a;replacement.transposeSemitones=b;
      result=rebuild(std::move(replacement));
    }
    else if(command=="output") {
      std::string token,uid;if(input>>token && validEnd() && decodeUid(token,uid))result=changeOutput(uid);
    }
    else if(command=="loop" || command=="region") {
      unsigned looping=1;
      const bool valid=static_cast<bool>(input>>a>>b) && (command=="loop" || static_cast<bool>(input>>looping)) && looping<=1 && validEnd() && std::isfinite(a) && std::isfinite(b) && a>=0 && b>a && rate>0 && b<=engine.status().durationFrames/rate+1./rate;
      if(valid){
        if(!started){result=engine.openOutput(generation);if(result.ok)result=startSong();started=result.ok;}else if(!songStarted)result=startSong();else result.ok=true;
        if(result.ok){const auto end=std::min<int64_t>(engine.status().durationFrames,static_cast<int64_t>(b*rate));const NativePlaybackInitialLoop region{static_cast<int64_t>(a*rate),end};
          result=engine.setRegion(generation,region.startProjectFrame,region.endProjectFrame,looping!=0);
          if(result.ok){result=waitRegion(region,looping!=0);if(result.ok){regionIntent=region;loopIntent=looping?regionIntent:std::nullopt;}}
        }
      }
    }
    else if((command=="unloop" || command=="unregion") && validEnd()) {
      if(!started){result=engine.openOutput(generation);if(result.ok)result=startSong();started=result.ok;}
      else if(!songStarted)result=startSong();else result.ok=true;
      if(result.ok){result=engine.clearRegion(generation);if(result.ok){result=waitRegion(std::nullopt,false);if(result.ok){loopIntent.reset();regionIntent.reset();}}}
    }
    reply(result);
  }
  clearCues();
  bool cleaned=true;
  if(!trainingOnly && generation)cleaned=engine.unloadWithCleanup(generation).playback.ok;
  service->parkOutput();
  return cleaned ? 0 : 1;
}

#if defined(_WIN32)
int wmain(int argc,wchar_t** wide) {
  std::vector<std::string> strings;
  for(int i=0;i<argc;++i) {
    const int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,nullptr,0,nullptr,nullptr);
    if(count<=0)return 2;
    std::string text(static_cast<size_t>(count),'\0');
    if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,text.data(),count,nullptr,nullptr))return 2;
    text.pop_back();strings.push_back(std::move(text));
  }
  std::vector<char*> args;for(auto& text:strings)args.push_back(text.data());
  return run(argc,args.data());
}
#else
int main(int argc,char** argv){return run(argc,argv);}
#endif
