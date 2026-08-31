#include "allocation_trap.h"

#include <atomic>
#include <cstddef>
#include <cstdlib>
#include <new>

#if defined(_WIN32)
#include <malloc.h>
#endif

namespace {

std::atomic<bool> trapAllocations{false};
std::atomic<std::uint64_t> trappedAllocations{0};

void noteAllocation() noexcept {
  if (trapAllocations.load(std::memory_order_relaxed)) {
    trappedAllocations.fetch_add(1, std::memory_order_relaxed);
  }
}

[[nodiscard]] std::size_t normalizedSize(std::size_t size) noexcept {
  return size == 0 ? 1 : size;
}

[[nodiscard]] void* allocateUnaligned(std::size_t size) noexcept {
  noteAllocation();
  return std::malloc(normalizedSize(size));
}

[[nodiscard]] void* allocateAligned(std::size_t size,
                                    std::size_t alignment) noexcept {
  noteAllocation();
#if defined(_WIN32)
  return _aligned_malloc(normalizedSize(size), alignment);
#else
  void* value = nullptr;
  if (posix_memalign(&value, alignment, normalizedSize(size)) != 0) {
    return nullptr;
  }
  return value;
#endif
}

void releaseUnaligned(void* value) noexcept { std::free(value); }

void releaseAligned(void* value) noexcept {
#if defined(_WIN32)
  _aligned_free(value);
#else
  std::free(value);
#endif
}

}  // namespace

namespace zdsp::test {

void resetAllocationTrap() noexcept {
  trappedAllocations.store(0, std::memory_order_relaxed);
}

void setAllocationTrapEnabled(bool enabled) noexcept {
  trapAllocations.store(enabled, std::memory_order_release);
}

std::uint64_t trappedAllocationCount() noexcept {
  return trappedAllocations.load(std::memory_order_acquire);
}

}  // namespace zdsp::test

void* operator new(std::size_t size) {
  if (void* value = allocateUnaligned(size)) return value;
  throw std::bad_alloc();
}

void* operator new[](std::size_t size) {
  if (void* value = allocateUnaligned(size)) return value;
  throw std::bad_alloc();
}

void* operator new(std::size_t size, const std::nothrow_t&) noexcept {
  return allocateUnaligned(size);
}

void* operator new[](std::size_t size, const std::nothrow_t&) noexcept {
  return allocateUnaligned(size);
}

void* operator new(std::size_t size, std::align_val_t alignment) {
  if (void* value = allocateAligned(size, static_cast<std::size_t>(alignment))) {
    return value;
  }
  throw std::bad_alloc();
}

void* operator new[](std::size_t size, std::align_val_t alignment) {
  if (void* value = allocateAligned(size, static_cast<std::size_t>(alignment))) {
    return value;
  }
  throw std::bad_alloc();
}

void* operator new(std::size_t size, std::align_val_t alignment,
                   const std::nothrow_t&) noexcept {
  return allocateAligned(size, static_cast<std::size_t>(alignment));
}

void* operator new[](std::size_t size, std::align_val_t alignment,
                     const std::nothrow_t&) noexcept {
  return allocateAligned(size, static_cast<std::size_t>(alignment));
}

void operator delete(void* value) noexcept { releaseUnaligned(value); }
void operator delete[](void* value) noexcept { releaseUnaligned(value); }
void operator delete(void* value, std::size_t) noexcept {
  releaseUnaligned(value);
}
void operator delete[](void* value, std::size_t) noexcept {
  releaseUnaligned(value);
}
void operator delete(void* value, const std::nothrow_t&) noexcept {
  releaseUnaligned(value);
}
void operator delete[](void* value, const std::nothrow_t&) noexcept {
  releaseUnaligned(value);
}

void operator delete(void* value, std::align_val_t) noexcept {
  releaseAligned(value);
}
void operator delete[](void* value, std::align_val_t) noexcept {
  releaseAligned(value);
}
void operator delete(void* value, std::size_t, std::align_val_t) noexcept {
  releaseAligned(value);
}
void operator delete[](void* value, std::size_t, std::align_val_t) noexcept {
  releaseAligned(value);
}
void operator delete(void* value, std::align_val_t,
                     const std::nothrow_t&) noexcept {
  releaseAligned(value);
}
void operator delete[](void* value, std::align_val_t,
                       const std::nothrow_t&) noexcept {
  releaseAligned(value);
}
