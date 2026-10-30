// Exercise the exact generated SDK translation unit, including its private
// containment helper and the unchanged scalar reference used by delay nodes.
#include "../src/runtime/graph_runner.cpp"
#include <array>
#include <bit>
#include <cassert>
#include <cstdio>
#include <utility>

int main() {
    constexpr std::array<uint32_t, 12> patterns{0x00000000, 0x80000000, 0x3d4ccccd, 0xbd4ccccd,
                                                0x7f800000, 0xff800000, 0x7fc12345, 0x7f812345,
                                                0x00000001, 0x80000001, 0x7f7fffff, 0xff7fffff};
    uint32_t cases = 0;
    for (const auto frames : {0U,  1U,  2U,  3U,  4U,   7U,   8U,   15U,  16U,  31U,
                              32U, 63U, 64U, 65U, 127U, 128U, 255U, 256U, 257U, 513U})
        for (const auto& offsets :
             {std::pair{0U, 768U}, std::pair{0U, 0U}, std::pair{0U, 1U}, std::pair{1U, 0U}})
            for (const auto initial : {0U, 1U, UINT32_MAX - 3, UINT32_MAX})
                for (const bool counted : {false, true}) {
                    std::array<float, 2048> actual, expected;
                    for (size_t index = 0; index < actual.size(); ++index)
                        actual[index] = expected[index] =
                            std::bit_cast<float>(patterns[index % patterns.size()]);
                    auto oldCount = initial, newCount = initial;
                    for (uint32_t frame = 0; frame < frames; ++frame)
                        expected[offsets.second + frame] = zdsp::contained(
                            expected[offsets.first + frame], counted ? &oldCount : nullptr);
                    zdsp::copyContained(actual.data() + offsets.first,
                                        actual.data() + offsets.second, frames,
                                        counted ? &newCount : nullptr);
                    assert(newCount == oldCount);
                    for (size_t index = 0; index < actual.size(); ++index)
                        assert(std::bit_cast<uint32_t>(actual[index]) ==
                               std::bit_cast<uint32_t>(expected[index]));
                    ++cases;
                }
    std::printf("SingZ containment: %u exact bit/count comparisons, including overlap, "
                "signed zero, subnormals, infinities, NaNs and saturated diagnostics\n",
                cases);
}
