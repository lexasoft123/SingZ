#include "training_pcm_mixer.h"
#include <cassert>
#include <limits>
#include <iostream>
using namespace singz;
int main() {
  {
    TrainingPcmMixer cues;
    float pcm[32]{}; float* channels[]{pcm};
    AudioHostRenderBlock resumed; resumed.output=channels; resumed.outputChannels=1;
    resumed.frames=resumed.maximumFrames=32; resumed.sampleRate=48000;
    // One existing short cue survives a whole-second startup outage. A cue
    // scheduled after the transaction keeps its new wall-time deadline.
    assert(cues.schedule({std::vector<float>(32,.5f)},1,48000,1001000000ULL,1));
    cues.prepareForBufferResume(1000000000ULL);
    assert(cues.schedule({std::vector<float>(32,.25f)},2,48000,2000000000ULL,1));
    resumed.callbackHostTimeNs=2000000000ULL;
    cues.render(resumed); assert(pcm[0]==.25f && pcm[31]==.25f);
    std::fill_n(pcm,32,0); resumed.callbackHostTimeNs+=666667;
    cues.render(resumed); assert(pcm[0]==0 && pcm[31]==.5f);
  }
  {
    TrainingPcmMixer cue;
    std::vector<float> ramp(256); for(size_t i=0;i<ramp.size();++i) ramp[i]=i/1024.f;
    assert(cue.schedule({ramp},1,48000,1000000000ULL,1));
    float pcm[32]{}; float* channels[]{pcm};
    AudioHostRenderBlock b; b.output=channels; b.outputChannels=1;
    b.frames=b.maximumFrames=32; b.sampleRate=48000; b.callbackHostTimeNs=1000000000ULL;
    cue.render(b); assert(pcm[31]==31/1024.f);
    cue.prepareForBufferResume(1000666667ULL);
    std::fill_n(pcm,32,0); b.callbackHostTimeNs=2000000000ULL;
    cue.render(b); assert(pcm[0]==32/1024.f && pcm[31]==63/1024.f);
  }
  TrainingPcmMixer mixer;
  assert(!mixer.active());
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
    assert(mixer.active());
    std::fill_n(left,256,0); std::fill_n(right,256,0);
    assert(mixer.render(block)); assert(std::abs(left[0]-0.89125094f)<0.000001); assert(std::abs(right[1]-0.44562547f)<0.000001);
    assert(!mixer.active());
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
  std::vector<float> ramp(1024); for(size_t i=0;i<ramp.size();++i) ramp[i]=i/2048.0f;
  assert(mixer.schedule({ramp},150,48000,block.callbackHostTimeNs,1));
  std::fill_n(left,256,0); mixer.render(block); assert(left[255]==255/2048.0f);
  block.callbackHostTimeNs += 12000000; // 12ms wall gap but exactly256 rendered frames.
  std::fill_n(left,256,0); mixer.render(block); assert(left[0]==256/2048.0f);
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
  // Excess volume is capped uniformly; the quiet sample and stereo balance
  // retain their ratios. Live gain changes obey the same peak budget.
  assert(mixer.schedule({{0.8f,0.2f},{0.4f,0.1f}},400,48000,block.callbackHostTimeNs,2));
  std::fill_n(left,256,0); std::fill_n(right,256,0); mixer.render(block);
  assert(std::abs(left[0]-0.89125094f)<0.000001);
  assert(std::abs(left[1]/left[0]-0.25f)<0.000001);
  assert(std::abs(right[0]/left[0]-0.5f)<0.000001);
  assert(mixer.schedule({std::vector<float>(1024,0.8f)},401,48000,block.callbackHostTimeNs,0.5));
  mixer.setGain(401,8);
  std::fill_n(left,256,0); mixer.render(block);
  assert(std::abs(left[0]-0.89125094f)<0.000001);
  mixer.clearQuiesced();
  // Takes use streamed storage; short training cues retain their original
  // duration cap and host-time scheduling semantics.
  assert(!mixer.schedule({std::vector<float>(8000*121)},500,8000,block.callbackHostTimeNs,1));
  std::cout << "training PCM mixer regressions passed\n";
}
