// Long control-state trajectory with real timestamp mapping/resampling at
// checkpoints. The reader/tables are immutable between calls: rendering hours
// of discarded PCM cannot update them. Every servo callback is still executed.
#include <loopz/runtime/estimated_output_timeline.hpp>
#include <zcore/routing/sample_clock.h>
#include <zcore/routing/audio_resampler.h>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <limits>

#define CHECK(v) do { if (!(v)) { std::fprintf(stderr,"failed line %d: %s\n",__LINE__,#v); std::abort(); } } while(false)
namespace {
constexpr uint32_t frames=256, capacity=32768, period=4096;
constexpr long double pi=3.1415926535897932384626433832795L;
struct Ring {
    uint64_t end=0, rejected=0, wrongTags=0;
    std::array<uint64_t,capacity> tags{};
    std::array<std::array<float,period>,4> waves{};
    static constexpr std::array<unsigned,4> bins{85,512,853,1365};
    Ring() { tags.fill(UINT64_MAX); for(unsigned c=0;c<4;++c) for(unsigned f=0;f<period;++f)
        waves[c][f]=float(.2L*std::sin(2*pi*bins[c]*f/period+.217L)); }
    void append() { for(uint32_t i=0;i<frames;++i) tags[(end+i)%capacity]=end+i; end+=frames; }
    static zcore::routing::ResampleFrame read(const void* opaque,uint64_t frame,std::span<float> values) noexcept {
        auto& self=*const_cast<Ring*>(static_cast<const Ring*>(opaque));
        if(frame>=self.end || self.end-frame>capacity) { ++self.rejected; return {false,0}; }
        if(self.tags[frame%capacity]!=frame) { ++self.wrongTags; return {false,0}; }
        for(size_t c=0;c<values.size();++c) values[c]=self.waves[c][frame%period];
        return {true,uint32_t(values.size())};
    }
};
}
int main(int argc,char** argv) {
    std::setvbuf(stdout,nullptr,_IOLBF,0);
    const double hours=argc>1?std::strtod(argv[1],nullptr):48.;
    CHECK(hours>0 && hours<=48);
    const uint64_t blocks=uint64_t(hours*3600*48000/frames);
    for(double bias : {0.,1.,-1.,50.,-100.,300.}) {
        if(argc>2 && bias!=std::strtod(argv[2],nullptr)) continue;
        loopz::runtime::detail::EstimatedOutputTimeline servo;
        zcore::routing::SampleClockHistory clock(64);
        zcore::routing::AudioResampler reader;
        zcore::routing::ResampleDiagnostics diagnostics;
        Ring ring;
        constexpr uint64_t origin=1000000000;
        double maximumPhaseFrames=0, minimumDistance=1e9, maximumDistance=-1e9;
        std::array<double,4> referenceEnergy{}, renderedEnergy{}, errorEnergy{};
        std::array<std::array<float,frames>,4> output{};
        std::array<float*,4> planes{};
        for(unsigned c=0;c<4;++c) planes[c]=output[c].data();
        uint64_t verified=0;
        const double devicePpm=std::abs(bias)>1?bias:0;
        const long double deviceRate=48000*(1+static_cast<long double>(devicePpm)*1e-6L);
        uint64_t sourceFrame=0;
        double maximumQueueError=0;
        for(uint64_t block=0;block<blocks;++block) {
            const uint64_t frame=block*frames;
            const uint64_t now=origin+uint64_t(static_cast<long double>(frame)*1e9L/deviceRate);
            const uint64_t raw=now+uint64_t(1024*1e9L/deviceRate);
            // CPU-paced source and independently paced USB output. Source
            // wakeups are delayed by 0..200 us (below its 2 ms reanchor limit).
            // The real producer stamps its scheduled due time, not wake time.
            for(;;) {
                const uint64_t due=origin+uint64_t(static_cast<long double>(sourceFrame)*1e9L/48000);
                const uint64_t jitter=devicePpm==0?0:(sourceFrame/frames%7)*30000;
                if(due+jitter>now) break;
                CHECK(clock.append(sourceFrame,due,true,48000,48000));
                ring.append(); sourceFrame+=frames;
            }
            auto selected=servo.observe(frame,raw,frames,48000,false);
            // Deliberately destroy the fractional ns once per period, or add a
            // persistent +/-1 ppm rate-estimator bias. The timestamp DLL must
            // bound phase against raw observations rather than integrate it.
            if(bias==0) servo.projectedFractionNs=0;
            else if(std::abs(bias)<=1) { servo.previousHz*=1+bias*1e-6; selected.hz=servo.previousHz; }
            if(block<std::min<uint64_t>(187500,blocks/4)) continue;
            const double phaseFrames=double(((static_cast<long double>(servo.projectedNs)-raw)+servo.projectedFractionNs)*48000/1e9L);
            maximumPhaseFrames=std::max(maximumPhaseFrames,std::abs(phaseFrames));
            // All 32.4M callbacks advance the live servo, anchor journal and
            // tagged ring. Full 256-frame PCM is rendered every 1024 callbacks.
            if(block%1024) continue;
            const uint64_t requested=selected.ns-uint64_t(1792*1e9L/48000);
            const auto point=clock.locate(clock.snapshot(),requested,0,48000,48000);
            CHECK(point.valid);
            const auto missing=reader.read({point.frame,point.offset,point.rate,selected.hz,false,48000,&diagnostics},
                {planes,frames},frames,Ring::read,&ring);
            CHECK(missing==0 && ring.wrongTags==0 && ring.rejected==0);
            const long double sourcePosition=static_cast<long double>(point.frame)+point.offset;
            const double distance=double(sourcePosition-ring.end);
            const long double idealPosition=(static_cast<long double>(raw-origin)-1792*1e9L/48000)*48000/1e9L;
            maximumQueueError=std::max(maximumQueueError,double(std::abs(sourcePosition-idealPosition)));
            minimumDistance=std::min(minimumDistance,distance);
            maximumDistance=std::max(maximumDistance,distance);
            for(unsigned c=0;c<4;++c) for(uint32_t f=0;f<frames;++f) {
                const long double position=static_cast<long double>(point.frame%period)+point.offset+
                    static_cast<long double>(f)*point.rate/selected.hz;
                const double expected=double(.2L*std::sin(2*pi*Ring::bins[c]*position/period+.217L));
                const double error=output[c][f]-expected;
                referenceEnergy[c]+=expected*expected;
                renderedEnergy[c]+=double(output[c][f])*output[c][f];
                errorEnergy[c]+=error*error;
            }
            ++verified;
        }
        std::printf("%.1f h, bias=%+.0f ppm (%s), callbacks=%llu, rendered checkpoints=%llu, phase<=%.6f frames, distance=[%.6f,%.6f], wrongTags=%llu\n",
            hours,bias,bias==0?"integer-ns truncation each period":std::abs(bias)<=1?"persistent rate bias":"independent USB clock + CPU scheduler jitter",(unsigned long long)blocks,
            (unsigned long long)verified,maximumPhaseFrames,minimumDistance,maximumDistance,(unsigned long long)ring.wrongTags);
        std::printf("  maximum continuous queue-position error=%.6f frames\n",maximumQueueError);
        CHECK(maximumPhaseFrames<1 && maximumQueueError<1);
        // The published end moves in whole producer periods. With independent
        // clocks, phase necessarily traverses 0..256 frames; the simulated
        // wakeup jitter adds at most 8.64 frames. This is bounded publication
        // granularity, not an accumulating queue drift.
        CHECK(maximumDistance-minimumDistance<(devicePpm==0?1:270));
        for(unsigned c=0;c<4;++c) {
            const double snr=10*std::log10(referenceEnergy[c]/std::max(errorEnergy[c],1e-300));
            const double gain=10*std::log10(renderedEnergy[c]/referenceEnergy[c]);
            std::printf("  %.2f Hz: SNR %.2f dB, level %.6f dB\n",double(Ring::bins[c])*48000/period,snr,gain);
            CHECK(snr>75 && std::abs(gain)<.001);
        }
        CHECK(verified>0);
        const auto paths=diagnostics.snapshot();
        std::printf("  direct=%llu phaseTable=%llu cachedExact=%llu convolution=%llu tiledExact=%llu tableMisses=%llu tableConstructions=%llu\n",
            (unsigned long long)paths.blocks[0], (unsigned long long)paths.blocks[1],
            (unsigned long long)paths.blocks[2], (unsigned long long)paths.blocks[3], (unsigned long long)paths.blocks[4],
            (unsigned long long)paths.tableMisses,(unsigned long long)paths.coefficientTableConstructions);
    }
}
