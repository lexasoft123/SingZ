#include "native/playback/loopz_source_backend.h"
#include <array>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <thread>
#define CHECK(v) do { if (!(v)) { std::fprintf(stderr, "failed %d: %s\n", __LINE__, #v); std::abort(); } } while (false)
using namespace singz;
struct Renderer {
  std::atomic<uint64_t> calls{0};
  std::atomic<bool> fail{false}, holdNext{false}, blocked{false}, release{false};
  std::atomic<uint64_t> holdOnCall{6};
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<Renderer*>(context);
    // Producer time may not masquerade as physical presentation time.
    CHECK(!block.outputTimestampValid && !block.outputTimestampHardware);
    CHECK(!block.outputClockMaster && block.frames == 256 && block.sampleRate == 48000);
    const auto call = self.calls.fetch_add(1) + 1;
    if (call == self.holdOnCall.load() || self.holdNext.load()) {
      self.blocked.store(true, std::memory_order_release);
      while (!self.release.load(std::memory_order_acquire)) std::this_thread::yield();
      self.blocked.store(false, std::memory_order_release);
    }
    for (uint32_t ch = 0; ch < 2; ++ch)
      for (uint32_t frame = 0; frame < block.frames; ++frame) block.output[ch][frame] = float(ch + 1) * 0.25f;
    return !self.fail.load();
  }
};
template<class Predicate>
bool waitUntil(Predicate ready, std::chrono::milliseconds timeout = std::chrono::seconds(2)) {
  const auto deadline = std::chrono::steady_clock::now() + timeout;
  while (!ready()) {
    if (std::chrono::steady_clock::now() >= deadline) return false;
    std::this_thread::sleep_for(std::chrono::milliseconds(1));
  }
  return true;
}
int main() {
  auto source = std::make_shared<LoopZSongSource>();
  auto producer = createLoopZSourceBackend(source);
  auto conflicting = createLoopZSourceBackend(source);
  Renderer renderer;
  AudioHostConfig bad; bad.inputDeviceUid = "mic"; bad.inputChannels = {0};
  CHECK(!producer->open(bad, Renderer::render, &renderer).ok);
  AudioHostConfig config; config.requestedSampleRate = 48000;
  CHECK(producer->open(config, Renderer::render, &renderer).ok);
  CHECK(!conflicting->open(config, Renderer::render, &renderer).ok);
  CHECK(producer->start().ok);
  CHECK(waitUntil([&] { return renderer.blocked.load(std::memory_order_acquire); }));
  // Deterministic publication-race negative control: the sixth callback has
  // entered, but cannot publish until the test releases its renderer gate.
  CHECK(renderer.calls.load() == 6);
  const auto publishedSix = [&] {
    const auto history = source->history->status();
    return history.online && history.callbacks >= 6;
  };
  CHECK(source->history->status().callbacks == 5);
  CHECK(!waitUntil(publishedSix, std::chrono::milliseconds(20)));
  renderer.release.store(true, std::memory_order_release);
  CHECK(waitUntil(publishedSix));
  // Park the next callback before reading. Wall-clock scheduling may advance
  // production arbitrarily during this thread's fanout checks otherwise.
  renderer.release.store(false, std::memory_order_release);
  renderer.holdNext.store(true, std::memory_order_release);
  CHECK(waitUntil([&] { return renderer.blocked.load(std::memory_order_acquire); }));
  const auto history = source->history->status();
  CHECK(history.online && history.callbacks >= 6);
  std::array<float, 64> left{}, right{}, secondLeft{}, secondRight{};
  std::array<float*, 2> output{left.data(), right.data()}, other{secondLeft.data(), secondRight.data()};
  loopz::AudioReadCursor first, second;
  // Exact aligned current-block reads do not need interpolation lookahead.
  const uint64_t at = history.lastHostNs;
  const auto a = source->history->read(at, 48000, {output, 64}, 64, first);
  const auto b = source->history->read(at, 48000, {other, 64}, 64, second);
  CHECK(a.online && b.online && a.missingFrames == 0 && b.missingFrames == 0);
  CHECK(left == secondLeft && right == secondRight);
  CHECK(left[32] > 0.24f && right[32] > 0.49f);
  // Neither reader invokes the destructive renderer or advances its frame.
  const auto before = renderer.calls.load();
  for (unsigned i = 0; i < 10; ++i)
    source->history->read(at, 48000, {output, 64}, 64, first);
  CHECK(renderer.calls.load() == before);
  renderer.holdNext.store(false, std::memory_order_release);
  renderer.release.store(true, std::memory_order_release);
  producer->stop();
  const auto stoppedCalls = renderer.calls.load();
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  CHECK(renderer.calls.load() == stoppedCalls);
  CHECK(!source->history->read(at, 48000, {output, 64}, 64, first).online);
  CHECK(conflicting->open(config, Renderer::render, &renderer).ok);
  const auto beforeRestart = source->history->status().callbacks;
  CHECK(conflicting->start().ok);
  CHECK(waitUntil([&] {
    const auto history = source->history->status();
    return history.online && history.callbacks > beforeRestart;
  }));
  // Reopening cannot resurrect the old timestamp epoch.
  CHECK(source->history->read(at, 48000, {output, 64}, 64, first).missingFrames == 64);
  conflicting->stop();
  // Failed renderer output cannot be advertised as valid source history.
  renderer.fail.store(true);
  CHECK(producer->open(config, Renderer::render, &renderer).ok);
  CHECK(producer->start().ok);
  CHECK(waitUntil([&] { return producer->status().renderFailures > 0; }));
  CHECK(!source->history->status().online);
  producer->stop();
  std::puts("LoopZ native source fanout/lease/stop/restart passed");
}
