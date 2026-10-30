// Offline gain/limiter microbenchmark, separate from installed audio acceptance.
#include "../src/runtime/builtin_nodes.cpp"
#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cstdio>
#include <vector>

int main() {
    using namespace zdsp;
    for (const bool limiter : {false, true})
        for (const unsigned channels : {2U, 32U, 64U})
            for (const unsigned frames : {128U, 240U, 256U})
                for (const bool invalid : {false, true}) {
                    std::vector<float> input(size_t(channels) * frames);
                    std::vector<float> output(input.size());
                    std::array<const float*, 64> read{};
                    std::array<float*, 64> write{};
                    for (unsigned channel = 0; channel < channels; ++channel) {
                        read[channel] = input.data() + size_t(channel) * frames;
                        write[channel] = output.data() + size_t(channel) * frames;
                        for (unsigned frame = 0; frame < frames; ++frame)
                            input[size_t(channel) * frames + frame] =
                                invalid && (frame + channel) % 101 == 0
                                    ? std::bit_cast<float>(0x7f812345U)
                                    : float(.75 * std::sin(frame * .031 + channel));
                    }
                    BuiltinState state{};
                    state.config.node = {1};
                    state.currentValue = .5f;
                    ConstAudioBusView in{read.data(), channels, {frames}, {frames}, nullptr};
                    MutableAudioBusView out{write.data(), channels, {frames}, {frames}};
                    ProcessContext context{};
                    context.frames = {frames};
                    const auto process = limiter ? processLimiter : processGain;
                    std::array<double, 32> times{};
                    for (unsigned batch = 0; batch < 40; ++batch) {
                        const auto begin = std::chrono::steady_clock::now();
                        for (unsigned iteration = 0; iteration < 128; ++iteration)
                            process(&state, &context, &in, out);
                        const auto elapsed = std::chrono::duration<double, std::micro>(
                                                 std::chrono::steady_clock::now() - begin)
                                                 .count();
                        if (batch >= 8)
                            times[batch - 8] = elapsed / 128;
                    }
                    std::sort(times.begin(), times.end());
                    uint64_t hash = 14695981039346656037ULL;
                    for (float sample : output) {
                        hash ^= std::bit_cast<uint32_t>(sample);
                        hash *= 1099511628211ULL;
                    }
                    std::printf("{\"limiter\":%s,\"channels\":%u,\"frames\":%u,"
                                "\"invalid\":%s,\"medianUs\":%.4f,\"nonFinite\":%u,"
                                "\"hash\":\"%llu\"}\n",
                                limiter ? "true" : "false", channels, frames,
                                invalid ? "true" : "false", (times[15] + times[16]) / 2,
                                state.nonFinite, static_cast<unsigned long long>(hash));
                }
}
