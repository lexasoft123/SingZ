#pragma once

#include "zdsp/types.h"

namespace zdsp {

// A caller-owned monotonic region. Construction and allocation happen on the
// control domain; callback code only dereferences the prepared objects.
struct RealtimeArena {
  uint8_t* data;
  size_t capacity;
  size_t used;
};

struct ArenaCheckpoint { size_t used; };

[[nodiscard]] ZDSP_INTERNAL_API Status initializeArena(
    RealtimeArena* arena, MutableByteView storage) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API ArenaCheckpoint checkpoint(
    const RealtimeArena& arena) noexcept;
ZDSP_INTERNAL_API void rewindArena(RealtimeArena* arena,
                                   ArenaCheckpoint checkpoint) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API void* arenaAllocate(
    RealtimeArena* arena, size_t size, size_t alignment) noexcept;

template <typename T>
[[nodiscard]] T* arenaArray(RealtimeArena* arena, size_t count) noexcept {
  if (count != 0 && count > static_cast<size_t>(-1) / sizeof(T)) return nullptr;
  return static_cast<T*>(arenaAllocate(arena, count * sizeof(T), alignof(T)));
}

}  // namespace zdsp
