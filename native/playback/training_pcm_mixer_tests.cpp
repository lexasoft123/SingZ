#include "training_pcm_mixer.h"
#include <cassert>
#include <limits>
#include <iostream>
using namespace singz;
int main() {
  TrainingPcmMixer mixer;
  float left[256]{}, right[256]{};
  float* outputs[]{left,right};
  AudioHostRenderBlock block;
  block.output=outputs; block.outputChannels=2; block.frames=256;
  block.sampleRate=48000; block.callbackHostTimeNs=1000000000;
  assert(!mixer.schedule({{std::numeric_limits<float>::quiet_NaN()}},1,48000,block.callbackHostTimeNs,1));
  assert(!mixer.schedule({{1},{1,2}},1,48000,block.callbackHostTimeNs,1));
  assert(!mixer.schedule({{1}},0,48000,block.callbackHostTimeNs,1));
  assert(!mixer.canSchedule(48*1024*1024,2));
  for(unsigned i=0;i<40;++i) {
    assert(mixer.schedule({{1,0.5f}},i+1,48000,block.callbackHostTimeNs,1));
    std::fill_n(left,256,0); std::fill_n(right,256,0);
    assert(mixer.render(block)); assert(left[0]==1); assert(right[1]==0.5f);
  }
  // Mono is replicated, stereo remains separate; rendering is additive.
  assert(mixer.schedule({{0.5f},{0.25f}},100,48000,block.callbackHostTimeNs,1));
  left[0]=0.1f; right[0]=0.2f; mixer.render(block);
  assert(std::abs(left[0]-0.6f)<0.0001); assert(std::abs(right[0]-0.45f)<0.0001);
  // Gain affects an already queued voice and stale cancellation cannot retire it.
  assert(mixer.schedule({std::vector<float>(1000,1)},101,48000,block.callbackHostTimeNs,1));
  mixer.setGain(101,0.5); mixer.cancel(999);
  std::fill_n(left,256,0); mixer.render(block); assert(left[0]==0.5);
  mixer.cancel(101); std::fill_n(left,256,0); mixer.render(block);
  assert(left[0]==0.5); assert(left[239]>0); assert(left[240]==0);
  // Late callback wall time does not skip PCM once a voice has started.
  std::vector<float> ramp(1024); for(size_t i=0;i<ramp.size();++i) ramp[i]=i/1024.0f;
  assert(mixer.schedule({ramp},150,48000,block.callbackHostTimeNs,1));
  std::fill_n(left,256,0); mixer.render(block); assert(left[255]==255/1024.0f);
  block.callbackHostTimeNs += 12000000; // 12ms wall gap but exactly256 rendered frames.
  std::fill_n(left,256,0); mixer.render(block); assert(left[0]==256/1024.0f);
  mixer.cancel(150); mixer.render(block);
  // Future cues cancel without output; all32 slots must become reusable.
  for(unsigned i=0;i<32;++i) assert(mixer.schedule({{1}},200,48000,2000000000,1));
  assert(!mixer.schedule({{1}},201,48000,2000000000,1));
  mixer.cancel(999); assert(!mixer.canSchedule(1,1));
  mixer.cancel(200); std::fill_n(left,256,0); mixer.render(block); assert(left[0]==0);
  assert(mixer.canSchedule(1,1));
  // Three18MB planes fit; a fourth exceeds aggregate64MiB. Oversized
  // admission is checked without copying/allocating the next plane.
  for(unsigned i=0;i<3;++i) assert(mixer.schedule({std::vector<float>(4500000)},300,48000,2000000000,0));
  assert(!mixer.canSchedule(4500000,1));
  mixer.cancel(300); mixer.render(block); assert(mixer.canSchedule(4500000,1));
  mixer.clearQuiesced();
  std::cout << "training PCM mixer regressions passed\n";
}
