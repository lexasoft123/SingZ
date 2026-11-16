#pragma once

#include <array>
#include <atomic>
#include <cstdint>

namespace singz {

// Small host-time adaptation of the DAW presentation history (7e4fd5a0,
// 0e998a76): inline retained storage, atomic scalar payloads, bounded seqlock
// reads and explicit missing coverage. No engine/count-in proof machinery.
struct PlaybackPresentationEntry {
  uint64_t hostTimeNs{0};
  uint32_t frames{0};
  double sampleRate{0};
  double projectFrame{0};
  double rate{0}; // Project frames per output frame; zero while parked.
  double transposeSemitones{0};
  uint64_t generation{0}, continuousFrame{0};
  uint64_t seekCount{0}, loopCount{0};
  bool paused{false};
  // A callback containing an interior wrap/landing is not affine. Retain its
  // event token, but never invent a position inside that callback.
  bool nonAffine{false};
};

struct PlaybackPresentationQuery {
  bool found{false};
  double projectFrame{0}, songSeconds{0}, rate{0}, sampleRate{0};
  uint64_t generation{0}, latestGeneration{0}, discontinuitySerial{0};
  // Unlike discontinuitySerial, this never changes for an affine graph seam.
  uint64_t faultSerial{0};
  uint64_t mappingStartHostNs{0};
  double mappingStartSongSeconds{0};
  double transposeSemitones{0};
  bool paused{false}, nonAffine{false};
  uint64_t outputLatencyFrames{0}, graphLatencyFrames{0};
};

// One callback writer; readers never touch ordinary writer state. append is
// fixed-work, allocation-free and lock-free. query retries at most eight times
// and NEVER extrapolates outside committed callback coverage. At 48 kHz/32
// frames the ring retains 2.7 seconds; older queries explicitly miss. Consumers
// must retain the first query's discontinuitySerial, rather than waiting until
// a long take ends to query an entry that might already have been evicted.
class PlaybackPresentationHistory final {
public:
  static constexpr uint32_t kCapacity = 4096;
  bool append(const PlaybackPresentationEntry &) noexcept;
  PlaybackPresentationQuery query(uint64_t hostTimeNs) const noexcept;

private:
  struct AtomicEntry {
    std::atomic<uint64_t> host{0}, generation{0}, seeks{0}, loops{0}, serial{0}, continuous{0};
    std::atomic<uint64_t> faultSerial{0}, mappingHost{0};
    std::atomic<double> mappingSeconds{0};
    std::atomic<uint32_t> frames{0}, flags{0};
    std::atomic<double> sampleRate{0}, project{0}, rate{0}, transpose{0};
    void store(const PlaybackPresentationEntry &, uint64_t) noexcept;
    PlaybackPresentationEntry load() const noexcept;
  };
  std::array<AtomicEntry, kCapacity> entries_{};
  std::atomic<uint64_t> sequence_{0};
  std::atomic<uint32_t> head_{0}, count_{0};
  uint32_t writerHead_{0}, writerCount_{0};
  uint64_t writerSerial_{0};
  uint64_t writerFaultSerial_{0}, mappingHost_{0};
  double mappingSeconds_{0};
  PlaybackPresentationEntry previous_{};
};

} // namespace singz
