#import <AVFoundation/AVFoundation.h>
#import <AudioToolbox/AudioToolbox.h>
#include <stdio.h>
#include <stdlib.h>
static void probe(double rate, double ioSec, UInt32 wantMax) {
  AVAudioSession *s = [AVAudioSession sharedInstance];
  NSError *e = nil;
  [s setCategory:AVAudioSessionCategoryPlayback error:&e];
  if (rate > 0) [s setPreferredSampleRate:rate error:&e];
  if (ioSec > 0) [s setPreferredIOBufferDuration:ioSec error:&e];
  [s setActive:YES error:&e];
  AudioComponentDescription d = {kAudioUnitType_Output, kAudioUnitSubType_RemoteIO, kAudioUnitManufacturer_Apple, 0, 0};
  AudioComponent c = AudioComponentFindNext(NULL, &d);
  AudioUnit u = NULL; AudioComponentInstanceNew(c, &u);
  UInt32 on = 1, off = 0;
  AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Output, 0, &on, sizeof on);
  AudioUnitSetProperty(u, kAudioOutputUnitProperty_EnableIO, kAudioUnitScope_Input, 1, &off, sizeof off);
  AudioStreamBasicDescription f = {0};
  f.mSampleRate = s.sampleRate; f.mFormatID = kAudioFormatLinearPCM;
  f.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked | kAudioFormatFlagIsNonInterleaved;
  f.mBytesPerPacket = 4; f.mFramesPerPacket = 1; f.mBytesPerFrame = 4; f.mChannelsPerFrame = 2; f.mBitsPerChannel = 32;
  OSStatus st = AudioUnitSetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Input, 0, &f, sizeof f);
  UInt32 mx = wantMax; UInt32 sz = sizeof mx;
  OSStatus st2 = AudioUnitSetProperty(u, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &mx, sizeof mx);
  UInt32 before = 0; sz = sizeof before;
  AudioUnitGetProperty(u, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &before, &sz);
  OSStatus init = AudioUnitInitialize(u);
  UInt32 after = 0; sz = sizeof after;
  OSStatus st3 = AudioUnitGetProperty(u, kAudioUnitProperty_MaximumFramesPerSlice, kAudioUnitScope_Global, 0, &after, &sz);
  AudioStreamBasicDescription hw = {0}; sz = sizeof hw;
  AudioUnitGetProperty(u, kAudioUnitProperty_StreamFormat, kAudioUnitScope_Output, 0, &hw, &sz);
  printf("preferred %.0f Hz / %.4f s -> session %.0f Hz, ioBuffer %.4f s (= %.1f frames); setFormat=%d setMax=%d; MaxFramesPerSlice before init=%u, init=%d, after init=%u (get=%d); RemoteIO physical output rate %.0f Hz %u ch\n",
    rate, ioSec, s.sampleRate, s.IOBufferDuration, s.IOBufferDuration * s.sampleRate, (int)st, (int)st2, before, (int)init, after, (int)st3, hw.mSampleRate, hw.mChannelsPerFrame);
  AudioUnitUninitialize(u); AudioComponentInstanceDispose(u);
  [s setActive:NO error:&e];
}
int main(int argc, char **argv) {
  @autoreleasepool {
    probe(0, 0, 4096);      /* what the app does: Playback category, no preferences */
    probe(0, 0, 8192);
    probe(48000, 0.01, 4096);
    probe(44100, 0.01, 4096);
  }
  return 0;
}
