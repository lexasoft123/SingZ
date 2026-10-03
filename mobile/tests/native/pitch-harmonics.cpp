#include "../../ios/FolderAccess/PitchHarmonics.h"
#include <array>
#include <cassert>
#include <cmath>
#include <random>
#include <cstdio>
int main() {
 std::array<float,1024> pcm{};
 auto tone=[&](double f,double fundamental,double second,double fifth) {
  for(size_t i=0;i<pcm.size();++i) { double p=2*3.141592653589793*f*i/16000;
   pcm[i]=fundamental*std::sin(p)+second*std::sin(2*p)+fundamental*.5*std::sin(3*p)+fifth*std::sin(5*p); }
 };
 tone(196,.05,.4,.04);
 auto corrected=singz::pitch::correctHarmonic(pcm.data(),1024,16000,392,392,.85);
 assert(std::abs(1200*std::log2(corrected/196))<10);
 tone(220,.025,.06,.28);
 corrected=singz::pitch::correctHarmonic(pcm.data(),1024,16000,0,1100,.9);
 assert(std::abs(1200*std::log2(corrected/220))<10);
 for(double hz : {55.,73.4,146.8,196.,220.,440.,880.}) {
  tone(hz,.15,.05,.015);
  assert(singz::pitch::correctHarmonic(pcm.data(),1024,16000,hz,hz,.9)==hz);
 }
 tone(440,.2,0,0);
 assert(singz::pitch::correctHarmonic(pcm.data(),1024,16000,440,440,.9)==440);
 std::mt19937 random(42);std::normal_distribution<float> noise(0,1);
 for(int trial=0;trial<100;++trial) {
  for(auto& v:pcm)v=noise(random)*.02;
  assert(singz::pitch::correctHarmonic(pcm.data(),1024,16000,0,1100,.8)==0);
 }
 tone(220,.1,.2,.5);
 assert(singz::pitch::correctHarmonic(pcm.data(),1024,16000,0,1100,.49)==0);
 assert(singz::pitch::correctHarmonic(pcm.data(),1024,16000,230,1100,.9)==230);
 std::puts("pitch harmonic checks passed");
}
