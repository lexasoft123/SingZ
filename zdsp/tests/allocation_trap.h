#pragma once

#include <cstdint>

namespace zdsp::test {

void resetAllocationTrap() noexcept;
void setAllocationTrapEnabled(bool enabled) noexcept;
[[nodiscard]] std::uint64_t trappedAllocationCount() noexcept;
[[nodiscard]] std::uint64_t trappedAllocationBytes() noexcept;

}  // namespace zdsp::test
