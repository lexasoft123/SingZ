#pragma once

#include <cstdint>

namespace zdsp::test {

void resetAllocationTrap() noexcept;
void setAllocationTrapEnabled(bool enabled) noexcept;
[[nodiscard]] std::uint64_t trappedAllocationCount() noexcept;

}  // namespace zdsp::test
