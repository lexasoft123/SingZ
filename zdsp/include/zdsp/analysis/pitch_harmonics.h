#pragma once
#include <array>
#include <algorithm>
#include <cmath>
#include <cstddef>

namespace singz::pitch {
struct Periodicity { double frequency = 0; double confidence = 0; };
// A causal 64 ms window. Select the shortest strong period, avoiding longer
// multiples of the same period. No exercise target or previous pitch is used.
inline bool hasFundamental(const std::array<double,1024>& pcm, double frequency, double rate) {
  auto amplitude = [&](double hz) {
    const double angle=2*3.141592653589793*hz/rate;
    const double cosine=std::cos(angle), sine=std::sin(angle);
    double c=1,s=0,real=0,imaginary=0;
    for (size_t i=0;i<pcm.size();++i) {
      const double weight=0.5-0.5*std::cos(2*3.141592653589793*i/(pcm.size()-1));
      real+=pcm[i]*weight*c; imaginary+=pcm[i]*weight*s;
      const double next=c*cosine-s*sine; s=s*cosine+c*sine; c=next;
    }
    return std::hypot(real,imaginary);
  };
  std::array<double,6> harmonics{};
  for(int k=1;k<=6;++k) harmonics[k-1]=amplitude(frequency*k);
  const double maximum=*std::max_element(harmonics.begin(),harmonics.end());
  if (maximum<=1e-8 || harmonics[0]<maximum*.025 || harmonics[2]<maximum*.04 || harmonics[4]<maximum*.04) return false;
  // Require narrow harmonic peaks, rather than broad car-noise energy at
  // subharmonic frequencies. Odd harmonics disambiguate doubled periods.
  for(int k : {1,3,5}) {
    const double background=std::max(amplitude(frequency*(k-.25)),amplitude(frequency*(k+.25)));
    if (harmonics[k-1]<3*background) return false;
  }
  return true;
}
inline Periodicity periodicity(const float* pcm, size_t frames, double rate) {
  if (!pcm || frames != 1024 || rate != 16000) return {};
  std::array<double, 1024> centered{};
  double mean = 0; for (size_t i=0;i<frames;++i) mean += pcm[i]; mean /= frames;
  for (size_t i=0;i<frames;++i) centered[i] = pcm[i]-mean;
  std::array<double, 294> scores{};
  for (size_t lag=14;lag<293;++lag) {
    double cross=0,left=0,right=0;
    for (size_t i=0;i<frames-lag;++i) {
      const double a=centered[i], b=centered[i+lag];
      cross+=a*b; left+=a*a; right+=b*b;
    }
    scores[lag]=cross/std::max(1e-12,std::sqrt(left*right));
  }
  double maximum=0;
  for (size_t lag=16;lag<292;++lag)
    if (scores[lag]>scores[lag-1] && scores[lag]>=scores[lag+1]) maximum=std::max(maximum,scores[lag]);
  for (size_t lag=16;lag<292;++lag) {
    if (scores[lag]<0.94 || scores[lag]<maximum-0.01 ||
        scores[lag]<=scores[lag-1] || scores[lag]<scores[lag+1]) continue;
    const double denominator=scores[lag-1]-2*scores[lag]+scores[lag+1];
    const double offset=std::abs(denominator)>1e-12
      ? std::clamp(0.5*(scores[lag-1]-scores[lag+1])/denominator,-0.5,0.5) : 0;
    const double frequency=rate/(lag+offset);
    if (!hasFundamental(centered,frequency,rate)) continue;
    return {frequency,scores[lag]};
  }
  return {};
}
inline bool isHigherHarmonic(double neuralHz, double periodicHz) {
  if (!(neuralHz>0 && periodicHz>0)) return false;
  const double ratio=neuralHz/periodicHz, harmonic=std::round(ratio);
  return harmonic>=2 && harmonic<=6 && std::abs(1200*std::log2(ratio/harmonic))<=65;
}
inline double correctHarmonic(const float* pcm, size_t frames, double rate,
                             double currentHz, double fullPeakHz, double fullPeakConfidence) {
  if (fullPeakConfidence<0.5) return currentHz;
  const auto periodic=periodicity(pcm,frames,rate);
  if (!isHigherHarmonic(fullPeakHz,periodic.frequency)) return currentHz;
  // Preserve ordinary CREPE estimates. Rescue only an overtone or a rejected
  // out-of-range overtone, never turn uncertain noise into an accepted pitch.
  if (currentHz>0 && !isHigherHarmonic(currentHz,periodic.frequency)) return currentHz;
  // A longer multiple of a real period must not win merely because it
  // correlates a little better under vibrato/noise. Demand a material gain
  // over the neural period before changing the register.
  const size_t neuralLag=static_cast<size_t>(std::round(rate/fullPeakHz));
  if (neuralLag<1 || neuralLag>=frames) return currentHz;
  double mean=0; for(size_t i=0;i<frames;++i) mean+=pcm[i]; mean/=frames;
  double neuralPeriodScore=-1;
  const size_t radius=std::max<size_t>(2,std::ceil(neuralLag*0.06));
  for(size_t lag=neuralLag>radius ? neuralLag-radius : 1; lag<=std::min(frames-1,neuralLag+radius);++lag) {
    double cross=0,left=0,right=0;
    for(size_t i=0;i<frames-lag;++i) {
      const double a=pcm[i]-mean,b=pcm[i+lag]-mean;
      cross+=a*b;left+=a*a;right+=b*b;
    }
    neuralPeriodScore=std::max(neuralPeriodScore,cross/std::max(1e-12,std::sqrt(left*right)));
  }
  if (periodic.confidence-neuralPeriodScore<0.02) return currentHz;
  return periodic.frequency;
}
}
