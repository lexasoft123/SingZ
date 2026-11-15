#pragma once
#include <zcore/device/audio_input_callback_gate.h>
#include <zcore/device/audio_host_render.h>
#include <zcore/device/audio_input_backend.h>
#include <algorithm>
#include <atomic>
#include <bit>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

namespace singz {
// One bounded recording, independent single writers for raw input and final
// output. Control configures/reaps; callbacks only copy to preallocated storage.
// The object remains alive until both platform producers have been drained.
class DiagnosticCaptureTap {
public:
  struct Result {
    bool active=false, complete=false, ok=false;
    uint64_t id=0, outputFrames=0, inputFrames=0, targetFrames=0;
    uint64_t firstOutputHostNs=0, firstInputHostNs=0;
    uint64_t outputDiscontinuities=0, inputDiscontinuities=0;
    std::string outputPath, inputPath, error;
  };
  ~DiagnosticCaptureTap() { cancel(); }
  void start(uint64_t id, double seconds, uint64_t outputEndpoint,
             const void* inputIdentity, uint32_t inputChannel, const std::string& directory) {
    if (!std::isfinite(seconds) || seconds<=0 || seconds>30 || !outputEndpoint || !inputIdentity || inputChannel>=64)
      throw std::invalid_argument("Invalid diagnostic capture bounds");
    if (worker_.joinable()) {
      if (!done_.load(std::memory_order_acquire)) throw std::runtime_error("A diagnostic capture is already active");
      worker_.join();
    }
    gate_.beginClose();
    while(gate_.inFlight()) std::this_thread::yield();
    result_={}; result_.error.reserve(256); result_.id=id; result_.targetFrames=uint64_t(std::ceil(seconds*48000));
    result_.outputPath=directory+"/pre-alsa.wav"; result_.inputPath=directory+"/capture-input.wav";
    output_.assign(size_t(result_.targetFrames)*2,0); input_.assign(size_t(result_.targetFrames),0);
    outputEndpoint_=outputEndpoint; inputIdentity_=inputIdentity; inputChannel_=inputChannel;
    outputFrames_.store(0); inputFrames_.store(0); firstOutputNs_.store(0); firstInputNs_.store(0);
    outputBoundaries_.store(0); inputBoundaries_.store(0);
    stop_.store(false); done_.store(false); gate_.open();
    try { worker_=std::thread([this,seconds] { finish(seconds); }); }
    catch (...) { gate_.beginClose(); while(gate_.inFlight()) std::this_thread::yield(); done_.store(true); throw; }
  }
  void output(uint64_t endpoint,const AudioHostRenderBlock& block) noexcept {
    AudioInputCallbackScope scope(gate_);
    if(!scope || endpoint!=outputEndpoint_ || block.sampleRate!=48000 || !block.output || block.outputChannels<1 || block.outputChannels>64 || block.frames>block.maximumFrames) return;
    const auto at=outputFrames_.load(std::memory_order_relaxed);
    if(at>=result_.targetFrames) return;
    const auto count=std::min<uint64_t>(block.frames,result_.targetFrames-at);
    for(uint32_t c=0;c<std::min(block.outputChannels,2u);++c) if(!block.output[c]) return;
    for(uint64_t f=0;f<count;++f) for(uint32_t c=0;c<2;++c) {
      const float sample=block.output[std::min(c,block.outputChannels-1)][f];
      output_[size_t(at+f)*2+c]=std::isfinite(sample)?sample:0;
    }
    if(at==0) firstOutputNs_.store(block.outputTimestampValid?block.outputHostTimeNs:block.callbackHostTimeNs,std::memory_order_relaxed);
    if(block.discontinuity) outputBoundaries_.fetch_add(1,std::memory_order_relaxed);
    outputFrames_.store(at+count,std::memory_order_release);
  }
  void input(const void* identity,const AudioInputBusBlock& block,double rate) noexcept {
    AudioInputCallbackScope scope(gate_);
    if(!scope || identity!=inputIdentity_ || rate!=48000 || !block.planes || inputChannel_>=block.channelCount || !block.planes[inputChannel_] || block.frames>block.capacityFrames) return;
    const auto at=inputFrames_.load(std::memory_order_relaxed);
    if(at>=result_.targetFrames) return;
    const auto count=std::min<uint64_t>(block.frames,result_.targetFrames-at);
    for(uint64_t f=0;f<count;++f) { const float sample=block.planes[inputChannel_][f]; input_[at+f]=std::isfinite(sample)?sample:0; }
    if(at==0) firstInputNs_.store(block.firstNs,std::memory_order_relaxed);
    if(block.capture.discontinuity!=AudioInputDiscontinuityReason::None) inputBoundaries_.fetch_add(1,std::memory_order_relaxed);
    inputFrames_.store(at+count,std::memory_order_release);
  }
  Result status() {
    Result result;
    if(done_.load(std::memory_order_acquire)) {
      if(worker_.joinable()) worker_.join();
      result=result_;
    } else { result.id=result_.id; result.targetFrames=result_.targetFrames; result.active=true; }
    result.outputFrames=outputFrames_.load(std::memory_order_acquire);
    result.inputFrames=inputFrames_.load(std::memory_order_acquire);
    result.firstOutputHostNs=firstOutputNs_.load(std::memory_order_relaxed);
    result.firstInputHostNs=firstInputNs_.load(std::memory_order_relaxed);
    result.outputDiscontinuities=outputBoundaries_.load(std::memory_order_relaxed);
    result.inputDiscontinuities=inputBoundaries_.load(std::memory_order_relaxed);
    return result;
  }
  void cancel() noexcept { stop_.store(true); gate_.beginClose(); if(worker_.joinable()) worker_.join(); }
private:
  static void u32(std::FILE* file,uint32_t value) {
    const unsigned char bytes[]{static_cast<unsigned char>(value),static_cast<unsigned char>(value>>8),static_cast<unsigned char>(value>>16),static_cast<unsigned char>(value>>24)};
    if(std::fwrite(bytes,1,4,file)!=4) throw std::runtime_error("Cannot write diagnostic WAV");
  }
  static void wav(const std::string& path,const std::vector<float>& samples,uint64_t frames,uint32_t channels) {
    auto* file=std::fopen(path.c_str(),"wbx"); // Never overwrite an existing file/symlink.
    if(!file) throw std::runtime_error("Cannot create diagnostic WAV");
    try {
      const uint32_t bytes=uint32_t(frames*channels*4);
      if(std::fwrite("RIFF",1,4,file)!=4) throw std::runtime_error("Cannot write diagnostic WAV");
      u32(file,36+bytes); std::fwrite("WAVEfmt ",1,8,file); u32(file,16);
      u32(file,3u | (channels<<16)); u32(file,48000); u32(file,48000*channels*4);
      u32(file,(channels*4) | (32u<<16)); std::fwrite("data",1,4,file); u32(file,bytes);
      for(uint64_t index=0;index<frames*channels;++index) u32(file,std::bit_cast<uint32_t>(samples[index]));
      if(std::fclose(file)!=0) { file=nullptr; throw std::runtime_error("Cannot finish diagnostic WAV"); }
      file=nullptr;
    } catch (...) { if(file) std::fclose(file); std::remove(path.c_str()); throw; }
  }
  void finish(double seconds) noexcept {
    const auto deadline=std::chrono::steady_clock::now()+std::chrono::duration<double>(seconds+2);
    while(!stop_.load(std::memory_order_acquire) && std::chrono::steady_clock::now()<deadline &&
        (outputFrames_.load(std::memory_order_acquire)<result_.targetFrames || inputFrames_.load(std::memory_order_acquire)<result_.targetFrames))
      std::this_thread::sleep_for(std::chrono::milliseconds(5));
    gate_.beginClose(); while(gate_.inFlight()) std::this_thread::yield();
    try {
      result_.complete=true;
      if(stop_.load()) throw std::runtime_error("Diagnostic capture cancelled");
      if(outputFrames_.load()!=result_.targetFrames || inputFrames_.load()!=result_.targetFrames)
        throw std::runtime_error("Diagnostic capture incomplete: output or input stopped");
      wav(result_.outputPath,output_,result_.targetFrames,2);
      try { wav(result_.inputPath,input_,result_.targetFrames,1); }
      catch (...) { std::remove(result_.outputPath.c_str()); throw; }
      result_.ok=true;
    } catch (const std::exception& error) { result_.error=error.what(); }
      catch (...) { result_.error="Diagnostic capture failed"; }
    done_.store(true,std::memory_order_release);
  }
  AudioInputCallbackGate gate_;
  std::thread worker_;
  std::vector<float> output_,input_;
  Result result_;
  uint64_t outputEndpoint_=0;
  const void* inputIdentity_=nullptr;
  uint32_t inputChannel_=0;
  std::atomic<bool> stop_{false},done_{true};
  std::atomic<uint64_t> outputFrames_{0},inputFrames_{0},firstOutputNs_{0},firstInputNs_{0},outputBoundaries_{0},inputBoundaries_{0};
};
}
