// Compare the generated steady-state traversal with its upstream automation path.
#include "../src/runtime/builtin_nodes.cpp"
#include <array>
#include <bit>
#include <cassert>
#include <cstdio>

int main() {
    using namespace zdsp;
    // Independent CRT oracle: changing the common helper also changes both
    // processing paths below, so their agreement alone cannot verify it.
    const auto checkEncoding = [](uint32_t bits) {
        const float value = std::bit_cast<float>(bits);
        const bool finite = std::isfinite(value);
        for (const auto initial : {0U, UINT32_MAX - 1, UINT32_MAX}) {
            BuiltinState state{};
            state.nonFinite = initial;
            const auto result = finiteSample(value, &state);
            assert(std::bit_cast<uint32_t>(result) == (finite ? bits : 0U));
            assert(state.nonFinite == initial + uint32_t(!finite && initial != UINT32_MAX));
        }
    };
    for (uint32_t sign : {0U, 0x80000000U})
        for (uint32_t exponent = 0; exponent < 256; ++exponent) {
            for (uint32_t mantissa = 0; mantissa < 512; ++mantissa)
                checkEncoding(sign | (exponent << 23) | (mantissa << 14));
            checkEncoding(sign | (exponent << 23) | 0x7fffffU);
            checkEncoding(sign | (exponent << 23) | 1U);
        }
    constexpr std::array<uint32_t, 12> patterns{0,          0x80000000, 0x3d4ccccd, 0xbd4ccccd,
                                                0x7f800000, 0xff800000, 0x7fc12345, 0x7f812345,
                                                1,          0x80000001, 0x7f7fffff, 0xff7fffff};
    uint32_t cases = 0;
    for (const bool limiter : {false, true})
        for (const auto channels : {1U, 2U, 8U, 64U})
            for (const auto frames : {0U, 1U, 7U, 128U, 256U})
                for (const auto initial : {0U, UINT32_MAX - 3, UINT32_MAX})
                    for (const float value : {0.0f, 0.5f, 0.98f, 2.0f}) {
                        std::array<std::array<float, 256>, 64> input{}, actual{}, expected{};
                        std::array<const float*, 64> read{};
                        std::array<float*, 64> write{}, reference{};
                        for (uint32_t channel = 0; channel < channels; ++channel) {
                            read[channel] = input[channel].data();
                            write[channel] = actual[channel].data();
                            reference[channel] = expected[channel].data();
                            for (uint32_t frame = 0; frame < 256; ++frame)
                                input[channel][frame] = std::bit_cast<float>(
                                    patterns[(frame + channel) % patterns.size()]);
                        }
                        BuiltinState a{}, b{};
                        a.config.node = b.config.node = {1};
                        a.currentValue = b.currentValue = value;
                        a.nonFinite = b.nonFinite = initial;
                        ConstAudioBusView in{read.data(), channels, {frames}, {256}, nullptr};
                        MutableAudioBusView out{write.data(), channels, {frames}, {256}};
                        MutableAudioBusView ref{reference.data(), channels, {frames}, {256}};
                        ProcessContext context{};
                        context.frames = {frames};
                        const auto process = limiter ? processLimiter : processGain;
                        process(&a, &context, &in, out);
                        // An event for another node selects the unchanged upstream
                        // loop without altering this processor's gain or threshold.
                        ParameterEvent unrelated{};
                        unrelated.node = {2};
                        context.parameters = &unrelated;
                        context.parameterCount = 1;
                        process(&b, &context, &in, ref);
                        assert(a.nonFinite == b.nonFinite);
                        assert(a.currentValue == b.currentValue);
                        for (uint32_t channel = 0; channel < channels; ++channel)
                            for (uint32_t frame = 0; frame < 256; ++frame)
                                assert(std::bit_cast<uint32_t>(actual[channel][frame]) ==
                                       std::bit_cast<uint32_t>(expected[channel][frame]));
                        ++cases;
                    }
    std::printf("SingZ planar builtins: %u exact output/diagnostic comparisons passed\n", cases);
}
