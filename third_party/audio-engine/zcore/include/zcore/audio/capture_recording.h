#pragma once
#include <zcore/device/audio_input.h>
#include <algorithm>
#include <cmath>
#include <fstream>
#include <filesystem>
#include <mutex>
#include <stdexcept>
#include <string>
#include <vector>
namespace singz {
// Delivery/control domain only. Bounded raw mono PCM, before resampling or ML.
// Shared ownership keeps the recording valid while capture is stopped/replaced.
struct CaptureRecording {
  std::mutex mutex;
  std::vector<int16_t> pcm;
  std::string filename;
  double rate=0;
  bool finished=false;
  CaptureRecording(){pcm.reserve(30*48000);}
  static bool validName(const std::string& name) {
    return name.size()<=180&&name.starts_with("SingZ-microphone-")&&name.ends_with(".wav")&&
      std::all_of(name.begin(),name.end(),[](unsigned char c){return (c>='a'&&c<='z')||(c>='A'&&c<='Z')||(c>='0'&&c<='9')||c=='-'||c=='_'||c=='.';});
  }
  void append(const AudioInputBlockView& block) {
    std::lock_guard<std::mutex> lock(mutex);
    if(finished||!block.mono||!block.frames||!std::isfinite(block.sampleRate)||block.sampleRate<=0||block.sampleRate>192000)return;
    if(!rate)rate=block.sampleRate;
    if(rate!=block.sampleRate){finished=true;return;}
    size_t limit=static_cast<size_t>(30*rate), count=std::min<size_t>(block.frames,limit-pcm.size());
    for(size_t i=0;i<count;++i){float x=std::isfinite(block.mono[i])?block.mono[i]:0;pcm.push_back(static_cast<int16_t>(std::clamp(x,-1.f,1.f)*32767));}
    if(pcm.size()==limit)finished=true;
  }
  double save(const std::string& path) {
    std::lock_guard<std::mutex> lock(mutex);finished=true;
    if(pcm.empty()||rate<=0)throw std::runtime_error("No microphone audio was recorded");
    std::ofstream file(std::filesystem::path(std::u8string(path.begin(),path.end())),std::ios::binary);
    auto u32=[&](uint32_t n){char b[4]={char(n),char(n>>8),char(n>>16),char(n>>24)};file.write(b,4);};
    auto u16=[&](uint16_t n){char b[2]={char(n),char(n>>8)};file.write(b,2);};
    uint32_t bytes=static_cast<uint32_t>(pcm.size()*2), hz=static_cast<uint32_t>(rate);
    file.write("RIFF",4);u32(36+bytes);file.write("WAVEfmt ",8);u32(16);u16(1);u16(1);u32(hz);u32(hz*2);u16(2);u16(16);file.write("data",4);u32(bytes);
    for(auto sample:pcm)u16(static_cast<uint16_t>(sample));
    file.close();if(!file)throw std::runtime_error("Could not save microphone WAV");
    return pcm.size()/rate;
  }
};
}
