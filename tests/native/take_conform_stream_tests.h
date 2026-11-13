#pragma once
#include "take_conform_fixture.h"
#include <thread>
#include <iostream>
#include <cmath>
#if defined(__unix__) || defined(__APPLE__)
#include <sys/resource.h>
#endif
namespace stream_tests {
inline void check(bool condition,const char *message) {if(!condition)throw std::runtime_error(message);}
struct Paths {std::string input{singz::conformFixturePath()},output{singz::conformFixturePath()};~Paths(){std::error_code e;std::filesystem::remove(input,e);std::filesystem::remove(output,e);}};
inline void generate(const std::string &path,uint32_t seconds,uint32_t rate) {
  const uint64_t frames=uint64_t(seconds)*rate,bytes=frames*2;check(bytes<=UINT32_MAX-36,"Fixture RIFF overflow");
  singz_v2_reference::writeTakeConformWav(path,{rate,{}});
  std::fstream file(path,std::ios::binary|std::ios::in|std::ios::out);
  auto put=[&](int at,uint32_t value){char b[]{char(value),char(value>>8),char(value>>16),char(value>>24)};file.seekp(at);file.write(b,4);};
  put(4,static_cast<uint32_t>(bytes+36));put(40,static_cast<uint32_t>(bytes));file.seekp(44);
  std::vector<char> second(rate*2);
  for(uint32_t i=0;i<rate;++i){const int16_t s=static_cast<int16_t>(10000*std::sin(i*440*2*3.141592653589793/rate));second[i*2]=char(s);second[i*2+1]=char(uint16_t(s)>>8);}
  for(uint32_t i=0;i<seconds;++i)file.write(second.data(),second.size());
  check(bool(file),"Cannot generate streaming fixture");
}
inline singz::TakeConformRequest request(uint32_t seconds,uint32_t rate,uint32_t outputRate) {
  singz::TakeConformRequest r;r.outputRate=outputRate;r.songDurationProjectFrames=uint64_t(seconds)*outputRate;
  r.settings={{0,2}};r.effects={{"pitch-follow",true,0,false}};
  r.anchors={{0,0},{uint64_t(seconds)*rate,double(seconds)*rate*0.75}};return r;
}
inline double peakRss() {
#if defined(__unix__) || defined(__APPLE__)
  rusage usage{};getrusage(RUSAGE_SELF,&usage);
#if defined(__APPLE__)
  return double(usage.ru_maxrss)/(1024*1024);
#else
  return double(usage.ru_maxrss)/1024;
#endif
#else
  return 0;
#endif
}
inline void benchmark(uint32_t seconds,uint32_t rate,uint32_t outputRate) {
  Paths paths;generate(paths.input,seconds,rate);auto r=request(seconds,rate,outputRate);
  const auto start=std::chrono::steady_clock::now();const auto result=singz::conformTakeFile(paths.input,paths.output,r);
  check(result.signalsmithPasses==1,"Long take must go through the continuous DSP pass");
  check(std::filesystem::file_size(paths.output)==44+result.durationFrames*2,"Progressive WAV extent/header mismatch");
  const double rss=peakRss();std::cout<<seconds<<" seconds at "<<rate<<" -> "<<outputRate<<": "<<std::chrono::duration<double>(std::chrono::steady_clock::now()-start).count()<<" s, peak RSS "<<rss<<" MiB\n";
  check(rss<16,"Streaming conform peak RSS exceeds 16 MiB");
}
inline void failures() {
  {
    Paths paths;generate(paths.input,1,48000);auto r=request(1,48000,192000);
    r.startPositionSec=20000;r.songDurationProjectFrames=uint64_t(36000)*192000;
    bool typed=false;try{singz::conformTakeFile(paths.input,paths.output,r);}
    catch(const singz::TakeConformError &e){typed=e.code()==singz::TakeConformFailure::MemoryBudget && std::string(e.what()).find("RIFF")!=std::string::npos;}
    check(typed && !std::filesystem::exists(paths.output),"RIFF admission must return memory-budget with detail and remove temp");
  }
  {
    Paths paths;generate(paths.input,1,48000);auto r=request(1,48000,192000);
    r.songDurationProjectFrames=uint64_t(4*3600)*192000;
    const auto shortLane=singz::conformTakeFile(paths.input,paths.output,r);
    check(shortLane.durationFrames==144000 && std::filesystem::file_size(paths.output)==288044,"Song duration must not allocate or limit a short placed WAV");
  }
  for(int failure=0;failure<3;++failure) {
    Paths paths;generate(paths.input,30,48000);auto r=request(30,48000,48000);
    std::atomic<bool> cancel{false},done{false};std::string error;singz::TakeConformFailure code=singz::TakeConformFailure::TakeTooLong;
    std::thread worker([&]{try{singz::conformTakeFile(paths.input,paths.output,r,&cancel);}catch(const singz::TakeConformError&e){error=e.what();code=e.code();}done.store(true);});
    bool observed=false;
    for(unsigned i=0;i<30000 && !done.load();++i){std::error_code ignored;const auto bytes=std::filesystem::file_size(paths.output,ignored);
      if(!ignored && bytes>65536){observed=true;break;}std::this_thread::sleep_for(std::chrono::milliseconds(1));}
    if(failure==0)cancel.store(true);
    else if(failure==1)std::filesystem::resize_file(paths.input,44+96000);
    else {std::fstream corrupt(paths.input,std::ios::binary|std::ios::in|std::ios::out);corrupt.put('X');}
    worker.join();check(observed,"Did not observe an in-flight progressive WAV write");
    check(!error.empty() && !std::filesystem::exists(paths.output),"Cancellation/corruption left a temporary WAV");
    check(code==(failure==0?singz::TakeConformFailure::Cancelled:singz::TakeConformFailure::ConformError),"Incorrect structured cancellation/corruption error");
  }
}
} // namespace stream_tests
