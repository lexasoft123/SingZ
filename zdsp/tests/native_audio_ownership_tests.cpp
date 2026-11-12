#include "native/electron/native_audio_ownership.h"

#include <atomic>
#include <cstdio>
#include <cstdlib>
#include <thread>

#define CHECK(expression)                                                      \
  do {                                                                         \
    if (!(expression)) {                                                       \
      std::fprintf(stderr, "CHECK failed at %s:%d: %s\n", __FILE__, __LINE__, \
                   #expression);                                               \
      std::abort();                                                            \
    }                                                                          \
  } while (false)

int main() {
  singz::NativeAudioOwnership ownership;
  using Kind = singz::NativeAudioOwnerKind;
  using Result = singz::NativeAudioAcquireResult;

  CHECK(ownership.acquire(Kind::Capture, 1) == Result::Acquired);
  CHECK(ownership.acquire(Kind::Playback, 2) == Result::Busy);
  CHECK(ownership.release(Kind::Capture, 1));

  // A seam re-keys the playback lease from the replaced generation to its
  // candidate in one step: the kind never changes hands, another kind can
  // never slip in between, and the old generation can no longer release it.
  CHECK(ownership.acquire(Kind::Playback, 5) == Result::Acquired);
  CHECK(!ownership.rekey(Kind::Playback, 6, 7));   // 6 does not hold it
  CHECK(!ownership.rekey(Kind::Capture, 5, 7));    // wrong kind
  CHECK(!ownership.rekey(Kind::Playback, 5, 5));   // not a move
  CHECK(!ownership.rekey(Kind::Playback, 5, 0));   // no generation
  CHECK(ownership.rekey(Kind::Playback, 5, 7));
  CHECK(ownership.snapshot().kind == Kind::Playback);
  CHECK(ownership.snapshot().generation == 7);
  CHECK(ownership.acquire(Kind::Capture, 8) == Result::Busy);
  CHECK(!ownership.release(Kind::Playback, 5));
  CHECK(ownership.release(Kind::Playback, 7));
  CHECK(ownership.snapshot().kind == Kind::None);

  std::atomic<bool> go{false};
  std::atomic<uint32_t> acquired{0};
  auto race = [&](Kind kind, uint64_t generation) {
    while (!go.load(std::memory_order_acquire)) std::this_thread::yield();
    if (ownership.acquire(kind, generation) == Result::Acquired)
      acquired.fetch_add(1, std::memory_order_relaxed);
  };
  std::thread capture(race, Kind::Capture, 10);
  std::thread playback(race, Kind::Playback, 12);
  go.store(true, std::memory_order_release);
  capture.join();
  playback.join();
  CHECK(acquired.load(std::memory_order_relaxed) == 1);
  const auto winner = ownership.snapshot();
  CHECK(winner.kind != Kind::None && winner.generation != 0);
  const Kind loser = winner.kind == Kind::Playback ? Kind::Capture : Kind::Playback;
  CHECK(ownership.acquire(loser, 12) == Result::Busy);
  CHECK(ownership.release(winner.kind, winner.generation));
  CHECK(ownership.snapshot().kind == Kind::None);
  CHECK(ownership.acquire(Kind::None, 1) == Result::InvalidGeneration);
  CHECK(ownership.acquire(Kind::Capture, 0) == Result::InvalidGeneration);
  singz::NativeAudioOwnership shared(true);
  CHECK(shared.acquire(Kind::Capture, 1) == Result::Acquired);
  CHECK(shared.acquire(Kind::Playback, 2) == Result::Acquired);
  CHECK(!shared.release(Kind::Capture, 4));
  CHECK(shared.rekey(Kind::Capture, 1, 4));
  CHECK(shared.release(Kind::Playback, 2));
  CHECK(shared.snapshot().kind == Kind::Capture);
  CHECK(shared.release(Kind::Capture, 4));
  CHECK(shared.acquire(Kind::Playback, 3) == Result::Acquired);
  CHECK(shared.release(Kind::Playback, 3));
  return 0;
}
