#include "zdsp/realtime_arena.h"

#include <stdint.h>

namespace zdsp {

Status initializeArena(RealtimeArena* arena, MutableByteView storage) noexcept {
  if (arena == nullptr || (storage.capacity != 0 && storage.data == nullptr))
    return {StatusCode::InvalidArgument, 1};
  *arena = {storage.data, storage.capacity, 0};
  return okStatus();
}

ArenaCheckpoint checkpoint(const RealtimeArena& arena) noexcept {
  return {arena.used};
}

void rewindArena(RealtimeArena* arena, ArenaCheckpoint value) noexcept {
  if (arena != nullptr && value.used <= arena->capacity) arena->used = value.used;
}

void* arenaAllocate(RealtimeArena* arena, size_t size, size_t alignment) noexcept {
  if (arena == nullptr || alignment == 0 ||
      (alignment & (alignment - 1)) != 0 || size == 0) return nullptr;
  const uintptr_t base = reinterpret_cast<uintptr_t>(arena->data);
  if (arena->used > arena->capacity || base > UINTPTR_MAX - arena->used)
    return nullptr;
  const uintptr_t current = base + arena->used;
  if (current > UINTPTR_MAX - (alignment - 1)) return nullptr;
  const uintptr_t aligned = (current + alignment - 1) & ~(alignment - 1);
  const size_t padding = static_cast<size_t>(aligned - current);
  if (padding > arena->capacity - arena->used ||
      size > arena->capacity - arena->used - padding) return nullptr;
  arena->used += padding + size;
  return reinterpret_cast<void*>(aligned);
}

}  // namespace zdsp
