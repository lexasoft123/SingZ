#include <zcore/routing/audio_diagnostics.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <vector>
#if defined(__GNUC__)
#define NOINLINE __attribute__((noinline))
#else
#define NOINLINE
#endif
NOINLINE void observe(zcore::routing::AudioEnergyMeter* meters,unsigned count,
                      std::span<float* const> planes,double rate) noexcept {
    for(unsigned index=0;index<count;++index) meters[index].observe(planes,256,rate);
}
int main(int argc,char** argv) {
    const double rate=argc>1?std::strtod(argv[1],nullptr):48000.;
    std::array<std::array<float,256>,8> samples{};
    std::array<float*,8> planes{};
    for(unsigned c=0;c<samples.size();++c) {
        planes[c]=samples[c].data();
        for(unsigned f=0;f<256;++f) samples[c][f]=float(.2*std::sin(f*(.13+.019*c)));
    }
    constexpr unsigned trials=100000;
    std::vector<uint64_t> times(trials);
    for(unsigned channels:{2u,8u}) for(unsigned count:{0u,1u,2u,3u,5u}) {
        std::array<zcore::routing::AudioEnergyMeter,5> meters;
        for(unsigned index=0;index<10000;++index) observe(meters.data(),count,{planes.data(),channels},rate);
        for(auto& time:times) {
            const auto begin=std::chrono::steady_clock::now();
            observe(meters.data(),count,{planes.data(),channels},rate);
            time=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-begin).count();
        }
        std::sort(times.begin(),times.end());
        std::printf("channels=%u meters=%u block=256 trials=%u median=%llu ns p99=%llu ns p99_budget=%.4f%%\n",
            channels,count,trials,(unsigned long long)times[trials/2],(unsigned long long)times[trials*99/100],
            times[trials*99/100]/(256*1e9/rate)*100);
        if(count && !meters[0].snapshot().available) return 2;
    }
}
