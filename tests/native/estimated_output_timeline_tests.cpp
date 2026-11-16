#include <loopz/runtime/estimated_output_timeline.hpp>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#define CHECK(v) do { if(!(v)) { std::fprintf(stderr,"failed %d: %s\n",__LINE__,#v); std::abort(); } } while(false)
int main() {
    loopz::runtime::detail::EstimatedOutputTimeline timeline;
    constexpr uint64_t origin=1000000000000000ULL;
    constexpr long double rate=48000*1.000075L;
    constexpr std::array<int64_t,4> jitter{20000,-30000,0,10000};
    uint64_t counter=0, shift=0;
    bool adjusted=false;
    for(uint64_t callback=0;callback<10000;++callback) {
        const bool explicitBoundary=callback==3000;
        if(explicitBoundary) shift+=100000000;
        if(callback==5000) counter=0; // Counter restart without a supplied flag.
        if(callback==7000) shift+=5000000; // Unflagged timestamp step exceeds the local bound.
        const uint64_t raw=origin+uint64_t(callback*256*1e9L/rate)+shift+jitter[callback%jitter.size()];
        const auto result=timeline.observe(counter,raw,256,48000,explicitBoundary);
        CHECK(std::isfinite(result.hz) && result.hz>=48000*.995 && result.hz<=48000*1.005);
        CHECK(std::abs(timeline.phaseErrorNs)<=2000000);
        if(callback==0 || callback==3000 || callback==5000 || callback==7000) {
            CHECK(result.ns==raw && result.hz==48000);
            CHECK(timeline.projectedFractionNs==0 && timeline.phaseErrorNs==0);
        } else if(result.hz!=48000) adjusted=true;
        counter+=256;
    }
    CHECK(adjusted);
    CHECK(timeline.observe(counter,origin,256,0,false).hz==0);
    const auto fresh=timeline.observe(counter,origin+1,256,48000,false);
    CHECK(fresh.ns==origin+1 && fresh.hz==48000);
    std::puts("Estimated output timeline: 75 ppm drift, packet jitter, explicit reanchor, counter restart and timestamp step passed");
}
