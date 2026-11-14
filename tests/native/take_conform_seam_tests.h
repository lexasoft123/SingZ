#pragma once
#include "take_conform_fixture.h"
#include <iostream>
#include <cmath>
namespace seam_tests {
inline void check(bool value,const char *message){if(!value)throw std::runtime_error(message);}
inline void bursts() {
  using namespace singz;constexpr int rate=48000,n=960,edge=96;
  const auto project=[](double t){return 1+(t<=4?t:4+(t-4)*.5);};
  TakeConformPcm tone{rate,std::vector<int16_t>(rate*8)},pulses=tone;
  for(double t:{1.,3.9,4.1,7.}) {
    for(int i=0;i<n;++i) {
      const double env=std::min({1.,double(i)/edge,double(n-1-i)/edge});
      const double w=env<1?.5-.5*std::cos(3.141592653589793*env):1;
      tone.samples[std::llround(t*rate)+i]=static_cast<int16_t>(std::floor(12000*w*std::sin(2*3.141592653589793*1000*i/rate)+.5));
    }
    pulses.samples[std::llround((t+.01)*rate)]=30000;
  }
  TakeConformRequest r;r.anchors={{0,48000},{192000,240000},{384000,336000}};
  r.settings={{0,0},{192000,0}};r.effects={{"pitch-follow",true,0,false}};
  r.startPositionSec=1;r.outputRate=rate;r.songDurationProjectFrames=rate*20;
  const auto rendered=conformTakePcm(tone,r),impulses=conformTakePcm(pulses,r);
  for(double t:{1.,3.9,4.1,7.}) {
    const double expected=project(t+.01);double energy=0,moment=0,ie=0,im=0;int peak=0;
    for(int i=std::llround((expected-.07)*rate);i<std::llround((expected+.07)*rate);++i) {
      const double a=rendered.pcm.samples[i],b=impulses.pcm.samples[i];energy+=a*a;moment+=i*a*a;ie+=b*b;im+=i*b*b;
      if(std::abs(b)>std::abs(impulses.pcm.samples[peak]))peak=i;
    }
    check(energy>0 && ie>0,"Seam fixture must contain energy");
    const double centroid=moment/energy/rate,error=(centroid-expected)*1000;
    check(std::abs(error)<3,"20-ms 1-kHz burst centroid exceeds measured fixture bound of 3 ms");
    check(std::abs(double(peak)/rate-expected)*1000<=1 && std::abs(im/ie/rate-expected)*1000<=1,"Impulse latency compensation across seam exceeds 1 ms");
    if(t==1)check(std::abs((centroid-(expected+.005))*1000)>3,"Five-ms wrong expectation must fail the burst centroid gate");
    std::cout<<"seam take "<<t<<" burst centroid "<<error<<" ms; impulse centroid "<<(im/ie/rate-expected)*1000<<" ms; peak "<<(double(peak)/rate-expected)*1000<<" ms\n";
  }
}
}
