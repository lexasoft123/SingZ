// Advances every real AudioHistory publication (including its atomic sample
// tags, clock history and half-second rate estimator) for the whole duration.
// Rendered checkpoint blocks measure the real stereo cached FIR/phase-table path.
#include <loopz/audio_history.hpp>
#include <loopz/audio_resampler.hpp>
#include <loopz/runtime/estimated_output_timeline.hpp>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#define CHECK(v) do { if(!(v)) { std::fprintf(stderr,"failed %d: %s\n",__LINE__,#v); std::abort(); } } while(false)
int main(int argc,char** argv) {
    std::setvbuf(stdout,nullptr,_IOLBF,0);
    const double hours=argc>1?std::strtod(argv[1],nullptr):48.;
    const double ppm=argc>2?std::strtod(argv[2],nullptr):50.;
    CHECK(hours>0 && hours<=48 && std::abs(ppm)<=300);
    constexpr uint32_t blockFrames=256, period=4096;
    constexpr uint64_t origin=1000000000;
    constexpr long double pi=3.1415926535897932384626433832795L;
    const long double deviceRate=48000*(1+static_cast<long double>(ppm)*1e-6L);
    const uint64_t blocks=uint64_t(hours*3600*48000/256);
    loopz::AudioHistory history(2,32768,loopz::ResamplingFilter::LinearPhase,true);
    loopz::runtime::detail::EstimatedOutputTimeline timeline;
    loopz::AudioReadCursor cursor;
    std::array<std::array<float,period>,2> waves{};
    for(uint32_t frame=0;frame<period;++frame) {
        waves[0][frame]=float(.2L*std::sin(2*pi*85*frame/period+.217L));
        waves[1][frame]=float(.14L*std::sin(2*pi*853*frame/period+.217L)+.14L*std::sin(2*pi*1365*frame/period+.217L));
    }
    std::array<std::array<float,blockFrames>,2> input{},output{};
    const std::array<const float*,2> in{input[0].data(),input[1].data()};
    const std::array<float*,2> out{output[0].data(),output[1].data()};
    std::array<double,2> referenceEnergy{},renderedEnergy{},errorEnergy{};
    uint64_t sourceFrame=0,verified=0;
    for(uint64_t callback=0;callback<blocks;++callback) {
        const uint64_t frame=callback*blockFrames;
        const uint64_t now=origin+uint64_t(static_cast<long double>(frame)*1e9L/deviceRate);
        const uint64_t raw=now+uint64_t(1024*1e9L/deviceRate);
        for(;;) {
            const uint64_t due=origin+uint64_t(static_cast<long double>(sourceFrame)*1e9L/48000);
            const uint64_t jitter=(sourceFrame/blockFrames%7)*30000;
            if(due+jitter>now) break;
            for(uint32_t f=0;f<blockFrames;++f) for(unsigned c=0;c<2;++c) input[c][f]=waves[c][(sourceFrame+f)%period];
            CHECK(history.append({in,blockFrames},blockFrames,due,48000,double(sourceFrame),true));
            sourceFrame+=blockFrames;
        }
        const auto selected=timeline.observe(frame,raw,blockFrames,48000,false);
        if(callback<std::min<uint64_t>(187500,blocks/4) || callback%1024) continue;
        const auto requested=selected.ns-uint64_t(1792*1e9L/48000);
        const auto read=history.read(requested,selected.hz,{out,blockFrames},blockFrames,cursor);
        CHECK(read.online && read.missingFrames==0);
        for(uint32_t f=0;f<blockFrames;++f) {
            const long double position=(static_cast<long double>(requested-origin)*48000/1e9L)+static_cast<long double>(f)*48000/selected.hz;
            const long double phase=std::fmod(position,static_cast<long double>(period));
            const std::array<double,2> reference{
                double(.2L*std::sin(2*pi*85*phase/period+.217L)),
                double(.14L*std::sin(2*pi*853*phase/period+.217L)+.14L*std::sin(2*pi*1365*phase/period+.217L))};
            for(unsigned c=0;c<2;++c) {
                const double error=output[c][f]-reference[c];
                referenceEnergy[c]+=reference[c]*reference[c];
                renderedEnergy[c]+=double(output[c][f])*output[c][f];
                errorEnergy[c]+=error*error;
            }
        }
        ++verified;
    }
    const auto stats=history.readDiagnostics();
    CHECK(verified>0 && history.status().discontinuities==0);
    CHECK(stats.expiredSampleReads==0 && stats.unpublishedSampleReads==0 && stats.racingSampleReads==0 && stats.absentSampleReads==0);
    std::printf("Real stereo AudioHistory: %.1f h, %+.0f ppm independent device, %llu published frames, %llu checkpoints, slot rejections=0, final read-minus-write=%lld\n",hours,ppm,(unsigned long long)sourceFrame,(unsigned long long)verified,(long long)stats.readMinusWriteFrames);
    for(unsigned c=0;c<2;++c) {
        const double snr=10*std::log10(referenceEnergy[c]/errorEnergy[c]);
        const double gain=10*std::log10(renderedEnergy[c]/referenceEnergy[c]);
        std::printf("  %s: SNR %.2f dB, energy gain %.6f dB\n",c?"9996 + 15996 Hz":"996 Hz",snr,gain);
        CHECK(snr>75 && std::abs(gain)<.001);
    }
    std::printf("  phaseTable=%llu cachedExact=%llu tiledExact=%llu coefficientTableConstructions=%llu\n",(unsigned long long)stats.resampler.blocks[1],(unsigned long long)stats.resampler.blocks[2],(unsigned long long)stats.resampler.blocks[4],(unsigned long long)stats.resampler.coefficientTableConstructions);
}
