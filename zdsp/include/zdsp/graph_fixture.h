#pragma once

#include "zdsp/types.h"

namespace zdsp {

inline constexpr uint32_t kGraphFixtureFormatVersion = 1;
inline constexpr uint32_t kGraphFixtureMaximumNodes = 256;
inline constexpr uint32_t kGraphFixtureMaximumStateBytesPerNode = 1024 * 1024;
inline constexpr uint32_t kGraphFixtureMaximumTotalStateBytes = 8 * 1024 * 1024;
struct TypeId { uint64_t high; uint64_t low; };
struct GraphNodeRecord {
  NodeId node;
  TypeId type;
  uint32_t typeVersion;
  uint32_t flags;
  ByteView opaqueState;
};
struct GraphDocumentView {
  uint32_t formatVersion;
  const GraphNodeRecord* nodes;
  uint32_t nodeCount;
};
struct GraphFixtureRequirements {
  uint32_t nodeCount;
  uint32_t stateBytes;
};
struct GraphFixtureDecodeStorage {
  GraphNodeRecord* nodes;
  uint32_t nodeCapacity;
  MutableByteView states;
};
// Deterministic little-endian fixture envelope. Product project persistence is
// a control-domain JSON adapter and does not enter zdsp_runtime. Source,
// destination and out-parameter objects must be pairwise disjoint. Out values
// are published only when the operation succeeds; malformed, alias and
// insufficient-storage failures leave them untouched.
[[nodiscard]] ZDSP_INTERNAL_API Status encodeGraphFixture(
    const GraphDocumentView& document,
    MutableByteView output,
    uint32_t* bytesWritten) noexcept;
[[nodiscard]] ZDSP_INTERNAL_API Status decodeGraphFixture(
    ByteView encoded,
    GraphFixtureDecodeStorage storage,
    GraphFixtureRequirements* requirements,
    GraphDocumentView* document) noexcept;

}  // namespace zdsp
