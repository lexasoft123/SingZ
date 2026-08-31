#include "zdsp/graph_fixture.h"

#include <string.h>

namespace zdsp {
namespace {
constexpr uint8_t kMagic[4] = {'Z', 'D', 'G', 'F'};
constexpr uint32_t kHeaderSize = 16;
constexpr uint32_t kNodeHeaderSize = 40;
struct ByteRange {
  uintptr_t begin;
  uintptr_t end;
  bool empty;
};
bool byteRange(const void* data, size_t size, ByteRange* range) noexcept {
  if (range == nullptr) return false;
  if (size == 0) {
    *range = {0, 0, true};
    return true;
  }
  if (data == nullptr) return false;
  const uintptr_t begin = reinterpret_cast<uintptr_t>(data);
  if (size > UINTPTR_MAX - begin) return false;
  *range = {begin, begin + size, false};
  return true;
}
bool rangesOverlap(const ByteRange& first, const ByteRange& second) noexcept {
  return !first.empty && !second.empty &&
         first.begin < second.end && second.begin < first.end;
}
bool multipliedSize(uint32_t count, size_t itemSize, size_t* result) noexcept {
  if (result == nullptr ||
      (itemSize != 0 && count > SIZE_MAX / itemSize)) return false;
  *result = static_cast<size_t>(count) * itemSize;
  return true;
}
bool optionalByteRange(const void* data, size_t size,
                       ByteRange* range) noexcept {
  if (data == nullptr) {
    if (range == nullptr) return false;
    *range = {0, 0, true};
    return true;
  }
  return byteRange(data, size, range);
}
bool put32(MutableByteView output, uint32_t* cursor, uint32_t value) noexcept {
  if (*cursor > output.capacity || output.capacity - *cursor < 4) return false;
  for (uint32_t i = 0; i < 4; ++i) output.data[*cursor + i] = uint8_t(value >> (i * 8));
  *cursor += 4; return true;
}
bool put64(MutableByteView output, uint32_t* cursor, uint64_t value) noexcept {
  if (*cursor > output.capacity || output.capacity - *cursor < 8) return false;
  for (uint32_t i = 0; i < 8; ++i) output.data[*cursor + i] = uint8_t(value >> (i * 8));
  *cursor += 8; return true;
}
bool get32(ByteView input, uint32_t* cursor, uint32_t* value) noexcept {
  if (*cursor > input.size || input.size - *cursor < 4) return false;
  *value = 0; for (uint32_t i = 0; i < 4; ++i) *value |= uint32_t(input.data[*cursor + i]) << (i * 8);
  *cursor += 4; return true;
}
bool get64(ByteView input, uint32_t* cursor, uint64_t* value) noexcept {
  if (*cursor > input.size || input.size - *cursor < 8) return false;
  *value = 0; for (uint32_t i = 0; i < 8; ++i) *value |= uint64_t(input.data[*cursor + i]) << (i * 8);
  *cursor += 8; return true;
}
Status inspect(ByteView encoded, GraphFixtureRequirements* requirements) noexcept {
  if (requirements == nullptr || encoded.data == nullptr || encoded.size < kHeaderSize ||
      memcmp(encoded.data, kMagic, sizeof(kMagic)) != 0) return {StatusCode::MalformedData, 1};
  uint32_t cursor = 4, version = 0, count = 0, headerReserved = 0;
  if (!get32(encoded, &cursor, &version) || !get32(encoded, &cursor, &count) ||
      !get32(encoded, &cursor, &headerReserved)) return {StatusCode::MalformedData, 2};
  if (version != kGraphFixtureFormatVersion) return {StatusCode::VersionMismatch, version};
  if (headerReserved != 0) return {StatusCode::MalformedData, 3};
  if (count > kGraphFixtureMaximumNodes) return {StatusCode::CapacityExceeded, count};
  if (count > (encoded.size - cursor) / kNodeHeaderSize) return {StatusCode::MalformedData, 4};
  uint32_t stateBytes = 0;
  for (uint32_t node = 0; node < count; ++node) {
    uint64_t ignored64 = 0;
    uint32_t ignored32 = 0, stateSize = 0, reserved = 0;
    if (!get64(encoded, &cursor, &ignored64) || !get64(encoded, &cursor, &ignored64) ||
        !get64(encoded, &cursor, &ignored64) || !get32(encoded, &cursor, &ignored32) ||
        !get32(encoded, &cursor, &ignored32) || !get32(encoded, &cursor, &stateSize) ||
        !get32(encoded, &cursor, &reserved)) return {StatusCode::MalformedData, node + 10};
    if (reserved != 0 || stateSize > kGraphFixtureMaximumStateBytesPerNode ||
        stateBytes > kGraphFixtureMaximumTotalStateBytes - stateSize ||
        cursor > encoded.size || encoded.size - cursor < stateSize) {
      return {StatusCode::MalformedData, node + 10};
    }
    stateBytes += stateSize;
    cursor += stateSize;
  }
  if (cursor != encoded.size) return {StatusCode::MalformedData, 0xffffu};
  *requirements = {count, stateBytes};
  return okStatus();
}
}  // namespace

Status encodeGraphFixture(const GraphDocumentView& document, MutableByteView output,
                          uint32_t* bytesWritten) noexcept {
  if (bytesWritten == nullptr || document.formatVersion != kGraphFixtureFormatVersion ||
      document.nodeCount > kGraphFixtureMaximumNodes ||
      (document.nodeCount != 0 && document.nodes == nullptr)) return {StatusCode::InvalidArgument, 1};
  const uint32_t formatVersion = document.formatVersion;
  const uint32_t nodeCount = document.nodeCount;
  const GraphNodeRecord* const nodes = document.nodes;
  ByteRange documentRange{}, bytesWrittenRange{}, outputStorageRange{};
  if (!byteRange(&document, sizeof(document), &documentRange) ||
      !byteRange(bytesWritten, sizeof(*bytesWritten), &bytesWrittenRange) ||
      !optionalByteRange(output.data, output.capacity, &outputStorageRange) ||
      rangesOverlap(bytesWrittenRange, documentRange) ||
      rangesOverlap(bytesWrittenRange, outputStorageRange)) {
    return {StatusCode::InvalidArgument, 2};
  }

  uint64_t required = kHeaderSize;
  uint32_t totalState = 0;
  for (uint32_t i = 0; i < nodeCount; ++i) {
    const uint32_t stateSize = nodes[i].opaqueState.size;
    if ((stateSize != 0 && nodes[i].opaqueState.data == nullptr) ||
        stateSize > kGraphFixtureMaximumStateBytesPerNode ||
        totalState > kGraphFixtureMaximumTotalStateBytes - stateSize) {
      return {StatusCode::CapacityExceeded, i + 1};
    }
    totalState += stateSize;
    required += kNodeHeaderSize + stateSize;
  }
  size_t nodeBytes = 0;
  ByteRange nodeRange{};
  if (!multipliedSize(nodeCount, sizeof(GraphNodeRecord), &nodeBytes) ||
      !byteRange(nodes, nodeBytes, &nodeRange) || required > UINT32_MAX ||
      rangesOverlap(bytesWrittenRange, nodeRange)) {
    return {StatusCode::InvalidArgument, 3};
  }
  if (output.data != nullptr &&
      (rangesOverlap(outputStorageRange, documentRange) ||
       rangesOverlap(outputStorageRange, nodeRange))) {
    return {StatusCode::InvalidArgument, 4};
  }
  for (uint32_t i = 0; i < nodeCount; ++i) {
    ByteRange stateRange{};
    if (!byteRange(nodes[i].opaqueState.data, nodes[i].opaqueState.size,
                   &stateRange) ||
        rangesOverlap(bytesWrittenRange, stateRange) ||
        rangesOverlap(outputStorageRange, stateRange)) {
      return {StatusCode::InvalidArgument, i + 10};
    }
  }
  if (output.data == nullptr || required > output.capacity) {
    return {StatusCode::InsufficientStorage, 1};
  }
  memcpy(output.data, kMagic, sizeof(kMagic)); uint32_t cursor = 4;
  put32(output, &cursor, formatVersion); put32(output, &cursor, nodeCount); put32(output, &cursor, 0);
  for (uint32_t i = 0; i < nodeCount; ++i) {
    const auto& node = nodes[i];
    put64(output, &cursor, node.node.value); put64(output, &cursor, node.type.high); put64(output, &cursor, node.type.low);
    put32(output, &cursor, node.typeVersion); put32(output, &cursor, node.flags);
    put32(output, &cursor, node.opaqueState.size); put32(output, &cursor, 0);
    if (node.opaqueState.size != 0) { memmove(output.data + cursor, node.opaqueState.data, node.opaqueState.size); cursor += node.opaqueState.size; }
  }
  *bytesWritten = cursor; return okStatus();
}

Status decodeGraphFixture(ByteView encoded, GraphFixtureDecodeStorage storage,
                          GraphFixtureRequirements* requirements,
                          GraphDocumentView* document) noexcept {
  if (requirements == nullptr || document == nullptr) return {StatusCode::InvalidArgument, 1};
  GraphFixtureRequirements inspected{};
  const Status valid = inspect(encoded, &inspected);
  if (!succeeded(valid)) return valid;
  size_t nodeStorageBytes = 0;
  ByteRange encodedRange{}, nodeRange{}, stateRange{}, requirementsRange{},
      documentRange{};
  if (!multipliedSize(storage.nodeCapacity, sizeof(GraphNodeRecord),
                      &nodeStorageBytes) ||
      !byteRange(encoded.data, encoded.size, &encodedRange) ||
      !optionalByteRange(storage.nodes, nodeStorageBytes, &nodeRange) ||
      !optionalByteRange(storage.states.data, storage.states.capacity,
                         &stateRange) ||
      !byteRange(requirements, sizeof(*requirements), &requirementsRange) ||
      !byteRange(document, sizeof(*document), &documentRange) ||
      rangesOverlap(encodedRange, nodeRange) ||
      rangesOverlap(encodedRange, stateRange) ||
      rangesOverlap(encodedRange, requirementsRange) ||
      rangesOverlap(encodedRange, documentRange) ||
      rangesOverlap(nodeRange, stateRange) ||
      rangesOverlap(nodeRange, requirementsRange) ||
      rangesOverlap(nodeRange, documentRange) ||
      rangesOverlap(stateRange, requirementsRange) ||
      rangesOverlap(stateRange, documentRange) ||
      rangesOverlap(requirementsRange, documentRange)) {
    return {StatusCode::InvalidArgument, 2};
  }
  if (inspected.nodeCount > storage.nodeCapacity ||
      (inspected.nodeCount != 0 && storage.nodes == nullptr) ||
      inspected.stateBytes > storage.states.capacity ||
      (inspected.stateBytes != 0 && storage.states.data == nullptr)) {
    return {StatusCode::InsufficientStorage, inspected.nodeCount};
  }
  uint32_t cursor = kHeaderSize, stateCursor = 0;
  for (uint32_t i = 0; i < inspected.nodeCount; ++i) {
    auto& node = storage.nodes[i]; uint32_t stateSize = 0, reserved = 0;
    get64(encoded, &cursor, &node.node.value); get64(encoded, &cursor, &node.type.high);
    get64(encoded, &cursor, &node.type.low); get32(encoded, &cursor, &node.typeVersion);
    get32(encoded, &cursor, &node.flags); get32(encoded, &cursor, &stateSize);
    get32(encoded, &cursor, &reserved);
    if (stateSize != 0) memmove(storage.states.data + stateCursor, encoded.data + cursor, stateSize);
    node.opaqueState = {stateSize == 0 ? nullptr : storage.states.data + stateCursor, stateSize};
    stateCursor += stateSize; cursor += stateSize;
  }
  const GraphDocumentView decoded{kGraphFixtureFormatVersion, storage.nodes,
                                  inspected.nodeCount};
  *requirements = inspected;
  *document = decoded;
  return okStatus();
}

}  // namespace zdsp
