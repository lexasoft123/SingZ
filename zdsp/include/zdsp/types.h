#pragma once

#include <stddef.h>
#include <stdint.h>

// These C++ contracts are linked within one product build. Keep their symbols
// local when an owning static archive is folded into a shared product binary;
// a future shared/plugin boundary gets a separate versioned C export surface.
#if defined(__clang__) || defined(__GNUC__)
#define ZDSP_INTERNAL_API __attribute__((visibility("hidden")))
#else
#define ZDSP_INTERNAL_API
#endif

namespace zdsp {

struct SampleRateHz { double value; };
struct FrameCount { uint32_t value; };
struct FrameLength { uint64_t value; };
struct FramePosition { uint64_t value; };
struct HostTimeNs { uint64_t value; };
struct LatencyFrames { uint32_t value; };
struct LatencyNs { int64_t value; };
struct ClockDomainId { uint64_t value; };
struct StreamGeneration { uint64_t value; };
struct RouteGeneration { uint64_t value; };
struct NodeId { uint64_t value; };
struct ParameterId { uint32_t value; };

enum class StatusCode : uint32_t {
  Ok = 0,
  InvalidArgument,
  UnsupportedFormat,
  InsufficientStorage,
  CapacityExceeded,
  VersionMismatch,
  MalformedData,
};

struct Status { StatusCode code; uint32_t detail; };
constexpr Status okStatus() noexcept { return {StatusCode::Ok, 0}; }
constexpr bool succeeded(Status status) noexcept { return status.code == StatusCode::Ok; }

struct ByteView { const uint8_t* data; uint32_t size; };
struct MutableByteView { uint8_t* data; uint32_t capacity; };

}  // namespace zdsp
