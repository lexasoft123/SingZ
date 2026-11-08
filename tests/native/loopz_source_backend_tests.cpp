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
  std::atomic<bool> fail{false};
  static bool render(void* context, const AudioHostRenderBlock& block) noexcept {
    auto& self = *static_cast<Renderer*>(context);
    // Producer time may not masquerade as physical presentation time.
    CHECK(!block.outputTimestampValid && !block.outputTimestampHardware);
    CHECK(!block.outputClockMaster && block.frames == 256 && block.sampleRate == 48000);
    self.calls.fetch_add(1);
    for (uint32_t ch = 0; ch < 2; ++ch)
      for (uint32_t frame = 0; frame < block.frames; ++frame) block.output[ch][frame] = float(ch + 1) * 0.25f;
    return !self.fail.load();
  }
};
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
  for (unsigned i = 0; i < 200 && renderer.calls.load() < 6; ++i)
    std::this_thread::sleep_for(std::chrono::milliseconds(2));
  CHECK(renderer.calls.load() >= 6);
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
  CHECK(renderer.calls.load() <= before + 1);
  producer->stop();
  const auto stoppedCalls = renderer.calls.load();
  std::this_thread::sleep_for(std::chrono::milliseconds(10));
  CHECK(renderer.calls.load() == stoppedCalls);
  CHECK(!source->history->read(at, 48000, {output, 64}, 64, first).online);
  CHECK(conflicting->open(config, Renderer::render, &renderer).ok);
  CHECK(conflicting->start().ok);
  std::this_thread::sleep_for(std::chrono::milliseconds(8));
  // Reopening cannot resurrect the old timestamp epoch.
  CHECK(source->history->read(at, 48000, {output, 64}, 64, first).missingFrames == 64);
  conflicting->stop();
  // Failed renderer output cannot be advertised as valid source history.
  renderer.fail.store(true);
  CHECK(producer->open(config, Renderer::render, &renderer).ok);
  CHECK(producer->start().ok);
  std::this_thread::sleep_for(std::chrono::milliseconds(12));
  CHECK(producer->status().renderFailures > 0);
  CHECK(!source->history->status().online);
  producer->stop();
  std::puts("LoopZ native source fanout/lease/stop/restart passed");
}
