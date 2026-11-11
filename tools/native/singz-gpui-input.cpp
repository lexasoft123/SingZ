// Native capture/monitor worker. No Node, PCM IPC or detector reimplementation.
#include <zcore/device/audio_input.h>
#include <zcore/audio/capture_recording.h>
#include <zcore/device/audio_host_fake.h>
#include <zcore/media/wav.h>
#include <zdsp/analysis/pitch_analysis_module.h>
#include <audio_monitor_session.h>
#include "json_string.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <fstream>
#include <filesystem>
#include <memory>
#include <iomanip>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>
#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#else
#include <sys/resource.h>
#endif
#if defined(__APPLE__)
#include <mach/mach_time.h>
const char* gpuiMicrophonePermission(bool request);
#else
const char* gpuiMicrophonePermission(bool){return singz::audioInputBackendSupported()?"granted":"unsupported";}
#endif
namespace {
using namespace singz;
struct Frame { zdsp::analysis::LiveInputFrame analysis{};uint64_t sequence=0,hostTime=0,resets=0;double inferenceMs=0; };
uint64_t hostNow(){
#if defined(__APPLE__)
 mach_timebase_info_data_t t{};mach_timebase_info(&t);return static_cast<uint64_t>(static_cast<long double>(mach_absolute_time())*t.numer/t.denom);
#elif defined(_WIN32)
 LARGE_INTEGER t{},f{};QueryPerformanceCounter(&t);QueryPerformanceFrequency(&f);return static_cast<uint64_t>(static_cast<long double>(t.QuadPart)*1e9L/f.QuadPart);
#else
 return std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
#endif
}
double cpuSeconds(){
#if defined(_WIN32)
 FILETIME created{},ended{},kernel{},user{};if(!GetProcessTimes(GetCurrentProcess(),&created,&ended,&kernel,&user))return 0.;ULARGE_INTEGER k{},u{};k.LowPart=kernel.dwLowDateTime;k.HighPart=kernel.dwHighDateTime;u.LowPart=user.dwLowDateTime;u.HighPart=user.dwHighDateTime;return (k.QuadPart+u.QuadPart)*1e-7;
#else
 rusage usage{};if(getrusage(RUSAGE_SELF,&usage))return 0.;return usage.ru_utime.tv_sec+usage.ru_stime.tv_sec+(usage.ru_utime.tv_usec+usage.ru_stime.tv_usec)*1e-6;
#endif
}
bool positiveId(const std::string& text,uint64_t& result){try{if(text.empty()||!std::all_of(text.begin(),text.end(),[](char c){return c>='0'&&c<='9';}))return false;size_t used=0;const auto value=std::stoull(text,&used);if(used!=text.size()||!value)return false;result=value;return true;}catch(...){return false;}}
bool integer(const std::string& text,uint32_t& result){try{size_t used=0;auto value=std::stoull(text,&used);if(used!=text.size()||value>1023)return false;result=static_cast<uint32_t>(value);return true;}catch(...){return false;}}
}
int run(int argc,char** argv){
 using namespace singz;using singz::tools::jsonString;std::cout<<std::setprecision(17);
 if(argc==2&&std::string(argv[1])=="--permission"){std::cout<<"{\"protocol\":1,\"ok\":true,\"permission\":"<<jsonString(gpuiMicrophonePermission(false))<<",\"supported\":"<<(audioInputBackendSupported()?"true":"false")<<"}\n";return 0;}
 std::string uid,output,model,fixture;uint32_t channel=0,left=0,right=1;bool request=false,monitoring=false,fake=false,testPaused=false;uint64_t requestedGeneration=1;
 for(int i=1;i<argc;++i){std::string key=argv[i];if(key=="--test-paused"){testPaused=true;continue;}if(key=="--request-permission"){request=true;continue;}if(key=="--monitor"){monitoring=true;continue;}if(key=="--test-fake-host"){fake=true;continue;}if(i+1>=argc)return 2;std::string value=argv[++i];if(key=="--generation"){if(!positiveId(value,requestedGeneration))return 2;}else if(key=="--device")uid=value;else if(key=="--output")output=value;else if(key=="--model")model=value;else if(key=="--test-input")fixture=value;else if(key=="--channel"){if(!integer(value,channel))return 2;}else if(key=="--left"){if(!integer(value,left))return 2;}else if(key=="--right"){if(!integer(value,right))return 2;}else return 2;}
 if((!fixture.empty()||fake||testPaused)&&!std::getenv("SINGZ_MUTE"))return 2;if(testPaused&&fixture.empty())return 2;
 const std::string permission=(!fixture.empty()||fake)?"fixture":gpuiMicrophonePermission(request);
 auto failure=[&](const std::string& error){std::cout<<"{\"protocol\":1,\"ok\":false,\"permission\":"<<jsonString(permission)<<",\"error\":"<<jsonString(error)<<"}\n"<<std::flush;};
 if(permission!="granted"&&permission!="fixture"){failure(permission=="required"?"Microphone permission is required":permission=="unsupported"?"Native microphone capture is unavailable on this platform":"Microphone access is blocked in system privacy settings");return 1;}
 std::unique_ptr<AudioMonitorSession> monitor;std::unique_ptr<AudioInput> input;std::unique_ptr<zdsp::analysis::PitchAnalysisModule> detector;
 Frame latest;std::mutex mutex;std::atomic<bool> active{false},fixturePaused{testPaused};std::thread producer;std::string label;double rate=0;uint32_t channels=0;uint64_t generation=requestedGeneration;bool stopped=false;
 std::shared_ptr<CaptureRecording> recording;uint64_t recordingId=0;std::string recordingPath;
 auto recordingReply=[&](bool ok,uint64_t id,const std::string& state,const std::string& error,double seconds=0.,double sampleRate=0.){std::cout<<"{\"protocol\":1,\"ok\":"<<(ok?"true":"false")<<",\"error\":"<<jsonString(error)<<",\"recording\":{\"generation\":"<<generation<<",\"takeId\":"<<id<<",\"state\":"<<jsonString(state)<<",\"path\":"<<jsonString(recordingPath)<<",\"filename\":"<<jsonString(std::filesystem::path(std::u8string(recordingPath.begin(),recordingPath.end())).filename().string())<<",\"seconds\":"<<seconds<<",\"sampleRate\":"<<sampleRate<<"}}\n"<<std::flush;};
 auto finishRecording=[&]{auto take=std::atomic_exchange(&recording,std::shared_ptr<CaptureRecording>{});if(!take)return false;try{
 const auto target=std::filesystem::path(std::u8string(recordingPath.begin(),recordingPath.end()));
 const auto staging=target.parent_path()/(".writing-"+std::to_string(recordingId));
 // Only this invocation's successfully created empty directory is removable.
 // A failed write or publication may leave recoverable audio; never recurse.
 struct EmptyStageGuard{std::filesystem::path path;bool owned=false;~EmptyStageGuard(){if(!owned)return;std::error_code ec;const auto status=std::filesystem::symlink_status(path,ec);if(!ec&&std::filesystem::is_directory(status)&&std::filesystem::is_empty(path,ec)&&!ec)std::filesystem::remove(path,ec);}} cleanup{staging};
 if(!std::filesystem::is_directory(std::filesystem::symlink_status(target.parent_path()))||!std::filesystem::create_directory(staging))throw std::runtime_error("Cannot exclusively stage microphone recording");
 cleanup.owned=true;
 const auto temporary=staging/target.filename();const auto utf8=temporary.u8string();
 const double seconds=take->save(std::string(utf8.begin(),utf8.end()));
 try{std::filesystem::create_hard_link(temporary,target);}catch(...){throw std::runtime_error("Recording destination exists or cannot be published; recoverable WAV: "+std::string(utf8.begin(),utf8.end()));}
 std::filesystem::remove(temporary);std::filesystem::remove(staging);
 recordingReply(true,recordingId,"finished","",seconds,take->rate);return true;
 }catch(const std::exception& error){recordingReply(false,recordingId,"error",error.what());return false;}};

 auto stop=[&]{if(stopped)return true;(void)finishRecording();active.store(false);if(input)input->stop();if(producer.joinable())producer.join();if(detector)detector->cancel(generation);if(monitor&&monitor->status().active){stopped=monitor->end(generation).ok;return stopped;}stopped=true;return true;};
 struct StopGuard{decltype(stop)& cleanup;~StopGuard(){cleanup();}} guard{stop};
 try{
  if(monitoring){
   monitor=fake?std::make_unique<AudioMonitorSession>(createFakeAudioHostBackend(FakeAudioHostOptions{1000000,false,0,0,0.0001F,true})):std::make_unique<AudioMonitorSession>();const auto devices=monitor->enumerate();
   if(uid.empty())uid=devices.defaultInputUid;if(output.empty())output=uid;const AudioHostDeviceInfo* selected=nullptr;for(const auto& d:devices.devices)if(d.uid==uid){selected=&d;break;}
   if(!selected){failure("Selected native input is unavailable");return 1;}label=selected->label;rate=selected->nominalSampleRate;channels=selected->inputChannels;
   AudioMonitorConfig config{uid,output,{channel},{left,right},rate,selected->bufferFrames.preferredFrames,kAudioHostMaxFrames,false};
   const auto result=monitor->begin(config,generation);if(!result.ok){failure(result.message);(void)monitor->end(generation);return 1;}active.store(true);
  }else{
   if(model.empty()){failure("CREPE model is missing; rebuild the native tools");return 1;}
   detector=std::make_unique<zdsp::analysis::PitchAnalysisModule>(zdsp::analysis::PitchAnalysisConfig{zdsp::analysis::PitchDetectorKind::CrepeTiny,model,generation});
   auto consume=[&](const AudioInputBlockView& block){if(!active.load())return;if(auto take=std::atomic_load(&recording))take->append(block);(void)detector->push(block,[&](const zdsp::analysis::AnalysisWindow& window){Frame next{window.analysis,0,(window.start.flags&zdsp::CaptureTimeSampleHostValid)?window.start.sampleHostTime.value:0,window.resetCount,detector->inferenceMs()};std::lock_guard<std::mutex> lock(mutex);next.sequence=latest.sequence+1;latest=next;});};
   if(!fixture.empty()){
    std::ifstream size(fixture,std::ios::binary|std::ios::ate);if(!size||size.tellg()>16*1024*1024){failure("Invalid capture fixture");return 1;}
    auto wav=readWavMono(fixture);if(channel!=0||!wav.ok||wav.channels!=1||wav.samples.empty()||wav.sampleRate<8000){failure("Cannot read capture fixture");return 1;}uid="fixture";label="Native PCM fixture";rate=wav.sampleRate;channels=1;active.store(true);
    producer=std::thread([&,samples=std::move(wav.samples),consume]{uint64_t frame=0,sequence=0;std::vector<float> block(512);const auto origin=std::chrono::steady_clock::now();const auto originNs=hostNow();while(active.load()){if(fixturePaused.load()){std::this_thread::sleep_for(std::chrono::milliseconds(2));continue;}for(size_t i=0;i<block.size();++i)block[i]=samples[(frame+i)%samples.size()];AudioInputBlockView view;view.sampleRate=rate;view.mono=block.data();view.frames=static_cast<uint32_t>(block.size());view.capture={1,generation,sequence++,frame,static_cast<uint64_t>(originNs+frame*1e9/rate),static_cast<uint64_t>(originNs+frame*1e9/rate),AudioInputTimestampQuality::CallbackEstimate,AudioInputDiscontinuityReason::None,AudioInputSourceFrameValid|AudioInputSampleHostTimeValid|AudioInputCallbackHostTimeValid|AudioInputTimestampQualityValid};consume(view);frame+=block.size();std::this_thread::sleep_until(origin+std::chrono::nanoseconds(static_cast<int64_t>(frame*1e9/rate)));}});
   }else{
    std::string error;const auto devices=enumerateAudioInputDevices(&error);if(!error.empty()){failure(error);return 1;}const AudioInputDevice* selected=nullptr;for(const auto& d:devices)if(uid.empty()?d.isDefault:d.uid==uid){selected=&d;break;}if(!selected||channel>=selected->channels){failure("Selected native input or channel is unavailable");return 1;}
    uid=selected->uid;label=selected->label;channels=selected->channels;input=std::make_unique<AudioInput>();active.store(true);const auto result=input->start(AudioInputConfig{uid,channel,32},consume,&devices);if(!result.ok){active.store(false);failure(result.error);return 1;}rate=result.sampleRate;
   }
  }
  auto reply=[&](bool ok,const std::string& error){Frame frame;{std::lock_guard<std::mutex> lock(mutex);frame=latest;}AudioMonitorStatus status;if(monitor)status=monitor->status();const bool running=active.load()&&(monitor?status.active&&status.host.state==AudioHostState::Running:(!input||input->state()==AudioInputState::Running));
   std::cout<<"{\"protocol\":1,\"ok\":"<<(ok?"true":"false")<<",\"error\":"<<jsonString(error)<<",\"permission\":"<<jsonString(permission)<<",\"active\":"<<(running?"true":"false")<<",\"monitoring\":"<<(monitoring?"true":"false")<<",\"fixture\":"<<((fake||!fixture.empty())?"true":"false")<<",\"deviceUid\":"<<jsonString(uid)<<",\"deviceLabel\":"<<jsonString(label)<<",\"sampleRate\":"<<rate<<",\"bufferFrames\":"<<(monitor?status.host.format.nominalBufferFrames:0)<<",\"channel\":"<<channel<<",\"deviceChannels\":"<<channels<<",\"sequence\":"<<(monitor?status.host.callbacks:frame.sequence)<<",\"hostTimeNs\":"<<frame.hostTime<<",\"frameAgeMs\":"<<(frame.hostTime&&hostNow()>=frame.hostTime?(hostNow()-frame.hostTime)/1e6:0.)<<",\"cpuSeconds\":"<<cpuSeconds()<<",\"frequency\":"<<frame.analysis.frequency<<",\"clarity\":"<<frame.analysis.clarity<<",\"rms\":"<<(monitor?status.pre.rms:frame.analysis.rms)<<",\"peak\":"<<(monitor?status.pre.peak:frame.analysis.peak)<<",\"postRms\":"<<status.post.rms<<",\"postPeak\":"<<status.post.peak<<",\"monitorEnabled\":"<<(status.enabled?"true":"false")<<",\"gainDb\":"<<status.gainDb<<",\"resets\":"<<frame.resets<<",\"detector\":"<<jsonString(monitoring?"none":"crepe-tiny")<<",\"inferenceMs\":"<<frame.inferenceMs<<",\"overruns\":"<<(input?input->stats().overruns:0)<<"}\n"<<std::flush;
  };
  reply(true,"");std::string line;while(true){line.clear();char c;while(std::cin.get(c)&&c!='\n'){if(line.size()>=4096){stop();return 2;}line+=c;}if(line.empty()&&!std::cin)break;std::istringstream command(line);std::string action;command>>action;auto end=[&]{command>>std::ws;return command.eof();};if((action=="quit"||action=="stop")&&end()){const bool ok=stop();reply(ok,ok?"":"Native monitor cleanup failed");return ok?0:1;}if(action=="record"||action=="finish"){
 std::string generationText,idText,path;uint64_t expected=0,id=0;command>>generationText>>idText;
 const bool ids=positiveId(generationText,expected)&&positiveId(idText,id);
 if(action=="record")command>>std::quoted(path);
 if(!ids||!end()||expected!=generation||monitoring||!active.load()){recordingReply(false,id,"error","Recording requires the current non-monitor microphone generation");continue;}
 if(action=="finish"){if(!std::atomic_load(&recording)||id!=recordingId){recordingReply(false,id,"error","No matching microphone recording is active");continue;}(void)finishRecording();continue;}
 try{
  const auto target=std::filesystem::path(std::u8string(path.begin(),path.end()));
  const auto filename=target.filename().string();std::error_code ec;const auto existing=std::filesystem::symlink_status(target,ec);
  if(rate<8000||rate>192000||std::atomic_load(&recording)||!target.is_absolute()||!CaptureRecording::validName(filename)||std::filesystem::exists(existing)||(ec&&ec!=std::errc::no_such_file_or_directory)||!std::filesystem::is_directory(std::filesystem::symlink_status(target.parent_path())))throw std::runtime_error("Invalid, existing or overlapping microphone recording destination");
  auto take=std::make_shared<CaptureRecording>();take->filename=filename;recordingPath=path;recordingId=id;std::atomic_store(&recording,take);recordingReply(true,id,"started","");
 }catch(const std::exception& error){recordingReply(false,id,"error",error.what());}
 continue;
}if(action=="status"&&end()){if(input&&input->state()==AudioInputState::Error){reply(false,input->lastError());break;}reply(true,"");continue;}float gain=0;if(action=="gain"&&monitor&&command>>gain&&end()&&std::isfinite(gain)&&gain>=-60&&gain<=0){const auto result=monitor->setGain(generation,gain,std::getenv("SINGZ_MUTE")==nullptr);reply(result.ok,result.message);continue;}reply(false,"Invalid native input command");}
  return stop()?0:1;
 }catch(const std::exception& error){stop();failure(error.what());return 1;}
}
#if defined(_WIN32)
int wmain(int argc,wchar_t** wide){std::vector<std::string> strings;for(int i=0;i<argc;++i){int count=WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,nullptr,0,nullptr,nullptr);if(count<=0)return 2;std::string text(count,'\0');WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,wide[i],-1,text.data(),count,nullptr,nullptr);text.pop_back();strings.push_back(std::move(text));}std::vector<char*> args;for(auto& s:strings)args.push_back(s.data());return run(argc,args.data());}
#else
int main(int argc,char** argv){return run(argc,argv);}
#endif
