#include "native/electron/take_writer.h"
#include "allocation_trap.h"
#include "third_party/zcore/zcore/platform/macos/audio_input_macos_render.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
#include <type_traits>
#include <random>

namespace {
void require(bool condition, const char* message) { if (!condition) throw std::runtime_error(message); }
std::string utf8Path(const std::filesystem::path& path) {
  const auto utf8 = path.u8string();
  return {utf8.begin(), utf8.end()};
}
std::filesystem::path nativePath(const std::string& utf8) {
  return std::filesystem::path(std::u8string(utf8.begin(), utf8.end()));
}
std::vector<unsigned char> bytes(const std::string& path) {
  std::ifstream f(nativePath(path), std::ios::binary);
  return {std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>()};
}
uint32_t le32(const unsigned char* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
void waitFor(const std::atomic<bool>& flag) {
  const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!flag.load() && std::chrono::steady_clock::now() < end) std::this_thread::yield();
  require(flag.load(), "writer did not reach test barrier");
}
singz::AudioInputBlockView block(const std::vector<float>& pcm, double rate = 48000) {
  singz::AudioInputBlockView b;
  b.mono = pcm.data(); b.frames = static_cast<uint32_t>(pcm.size()); b.sampleRate = rate;
  b.capture.sampleHostTimeNs = 9876543210123456ULL;
  b.capture.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
  // Compatibility aliases intentionally disagree: typed metadata is authoritative.
  b.sampleHostTimeNs = 3;
  return b;
}
void roundtrip(const std::filesystem::path& dir) {
  singz::TakeWriter writer(512, 4800);
  std::vector<float> pcm(4800);
  for (size_t i = 0; i < pcm.size(); ++i) pcm[i] = (int(i % 65536) - 2400) / 32768.f;
  writer.start(utf8Path(dir), "forty-seconds", 48000);
  require(!writer.firstSample().captured, "first sample published before any audio");
  auto b = block(pcm);
  for (int i = 0; i < 400; ++i) require(writer.append(b), "40 second take dropped a block");
  const auto firstDeadline = std::chrono::steady_clock::now() + std::chrono::seconds(1);
  while (!writer.firstSample().captured && std::chrono::steady_clock::now() < firstDeadline) std::this_thread::yield();
  const auto liveFirst = writer.firstSample();
  require(writer.active() && !writer.completed() && liveFirst.captured &&
          liveFirst.hostNs == b.capture.sampleHostTimeNs && liveFirst.quality == b.capture.timestampQuality,
          "first sample timestamp must be available during recording before finish");
  const auto result = writer.finish();
  require(result.error.empty(), "40 second writer error");
  require(result.frames == 40 * 48000 && result.frames > 30 * 48000, "take was capped at 30 seconds");
  require(result.droppedBlocks == 0 && result.sampleRate == 48000, "round trip metadata");
  require(result.firstSampleHostNs == b.capture.sampleHostTimeNs && result.firstSampleQuality == b.capture.timestampQuality, "first sample provenance");
  const auto wav = bytes(result.path);
  require(wav.size() == 44 + result.frames * 2, "WAV byte size");
  require(le32(wav.data() + 4) == wav.size() - 8 && le32(wav.data() + 40) == result.frames * 2, "WAV header lengths");
  require(le32(wav.data() + 24) == 48000 && wav[22] == 1 && wav[34] == 16, "mono PCM16 format");
  for (size_t i = 0; i < result.frames; ++i) {
    const auto actual = static_cast<int16_t>(uint16_t(wav[44 + i * 2]) | uint16_t(wav[45 + i * 2]) << 8);
    require(actual == static_cast<int16_t>(int(i % pcm.size()) - 2400), "sample-exact round trip");
  }
  // Incomplete kill -9 file: empty header lengths and half of a final PCM sample.
  const auto crashed = utf8Path(dir / "crashed.wav");
  auto damaged = wav;
  for (int i = 4; i < 8; ++i) damaged[i] = 0;
  for (int i = 40; i < 44; ++i) damaged[i] = 0;
  damaged.resize(wav.size() - 503);
  { std::ofstream f(nativePath(crashed), std::ios::binary); f.write(reinterpret_cast<const char*>(damaged.data()), damaged.size()); }
  const auto recovered = singz::TakeWriter::recover(crashed);
  require(recovered.frames == (damaged.size() - 44) / 2 && recovered.frames > 30 * 48000, "recovery trusted unfinished header or capped take");
  const auto repaired = bytes(crashed);
  require(repaired.size() == 44 + recovered.frames * 2 && le32(repaired.data() + 40) == recovered.frames * 2, "recovery did not repair/truncate header");
  require(std::equal(repaired.begin() + 44, repaired.end(), wav.begin() + 44), "recovery altered valid PCM");
  // Recovery is idempotent and supports a sixty-minute take without loading PCM.
  const auto hour = utf8Path(dir / "hour.wav");
  std::filesystem::copy_file(nativePath(crashed), nativePath(hour));
  std::filesystem::resize_file(nativePath(hour), 44ULL + 3600ULL * 48000 * 2);
  require(singz::TakeWriter::recover(hour).frames == 3600ULL * 48000, "60 minute recovery");
  require(singz::TakeWriter::recover(crashed).frames == recovered.frames, "recovery idempotence");
}
void overflow(const std::filesystem::path& dir) {
  singz::TakeWriter writer(2, 8);
  std::atomic<bool> entered{false}, release{false};
  writer.start(utf8Path(dir), "overflow", 48000, [&] {
    entered.store(true);
    while (!release.load()) std::this_thread::yield();
    return false;
  });
  waitFor(entered);
  const std::vector<float> pcm{0, .5f, -.5f, 1, -1, 2, -2, 0};
  const auto b = block(pcm);
  zdsp::test::resetAllocationTrap();
  zdsp::test::setAllocationTrapEnabled(true);
  const bool first = writer.append(b), second = writer.append(b);
  const auto start = std::chrono::steady_clock::now();
  const bool third = writer.append(b);
  const auto elapsed = std::chrono::steady_clock::now() - start;
  zdsp::test::setAllocationTrapEnabled(false);
  const auto allocations = zdsp::test::trappedAllocationCount();
  release.store(true);
  const auto result = writer.finish();
  require(first && second && !third, "full ring must reject new block");
  require(elapsed < std::chrono::milliseconds(100), "overflow blocked producer");
  require(allocations == 0, "append allocated on sink");
  require(result.droppedBlocks == 1 && result.frames == 16, "overflow count or drain incorrect");
  const auto level = writer.level();
  require(std::abs(level.peakDb - 20 * std::log10(2)) < .001 && std::isfinite(level.rmsDb), "input level");
  writer.resetLevel(); require(writer.level().peakDb == -120 && writer.level().rmsDb == -120, "silence clamp");
  const auto wav = bytes(result.path);
  require(wav[44 + 3 * 2] == 255 && wav[45 + 3 * 2] == 127 && wav[45 + 4 * 2] == 128, "PCM saturation");
}
void liveFrameStamp(const std::filesystem::path& dir) {
  singz::TakeWriter writer(512, 480);
  std::atomic<bool> entered{false}, release{false}, done{false};
  writer.start(utf8Path(dir), "live-frame-stamp", 48000, [&] {
    entered.store(true);
    while (!release.load()) std::this_thread::yield();
    return false;
  });
  waitFor(entered);
  const std::vector<float> pcm(480, .25f);
  auto b = block(pcm); constexpr uint64_t origin = 10000000000ull;
  for (uint64_t i = 0; i < 400; ++i) {
    b.capture.sampleHostTimeNs = origin + i * 10000000;
    require(writer.append(b), "anchor fixture dropped a block");
  }
  singz::TakeWriteResult result;
  std::thread finisher([&] { release.store(true); result = writer.finish(); done.store(true); });
  bool coherent = true;
  do {
    const auto stamp = writer.frameStamp();
    if (stamp.hostNs)
      coherent = coherent && stamp.hostNs >= origin &&
          stamp.takeFrame == (stamp.hostNs - origin) * 48 / 1000000;
  } while (!done.load());
  finisher.join();
  require(coherent, "live frame stamp mixed a file cursor with another block timestamp");
  require(result.error.empty() && result.frames == 400 * 480, "anchor fixture lost PCM");
}
void concurrentFinish(const std::filesystem::path& dir) {
  singz::TakeWriter writer(16, 8);
  const std::vector<float> pcm(8, .125f);
  const auto b = block(pcm);
  for (int iteration = 0; iteration < 50; ++iteration) {
    writer.start(utf8Path(dir), "race-" + std::to_string(iteration), 48000);
    std::atomic<bool> stop{false};
    std::atomic<uint64_t> accepted{0};
    std::thread producer([&] {
      while (!stop.load()) if (writer.append(b)) accepted.fetch_add(1);
    });
    while (accepted.load() < 16) std::this_thread::yield();
    const auto result = writer.finish();
    stop.store(true); producer.join();
    require(result.error.empty() && result.frames == accepted.load() * 8,
            "finish lost an in-flight accepted block");
    require(bytes(result.path).size() == 44 + result.frames * 2, "concurrent finish WAV size");
  }
}

void deliveredTimestamp(const std::filesystem::path& dir) {
  singz::TakeWriter writer(8, 8);
  const std::vector<float> pcm(8, .25f);
  auto b = block(pcm);
  require(writer.lastSampleHostNs() == 0, "latest sample timestamp must start empty");
  require(!writer.append(b), "capture without an active take must not record");
  require(writer.lastSampleHostNs() == b.capture.sampleHostTimeNs,
          "open capture must publish the typed latest sample timestamp without a take");
  writer.start(utf8Path(dir), "timestamp", 48000);
  b.capture.sampleHostTimeNs += 2000000;
  require(writer.append(b), "timestamp take initial append");
  require(writer.lastSampleHostNs() == b.capture.sampleHostTimeNs, "latest sample timestamp during take");
  b.capture.sampleHostTimeNs += 2000000;
  require(writer.append(b), "timestamp take second append");
  require(writer.lastSampleHostNs() == b.capture.sampleHostTimeNs, "latest sample timestamp did not advance");
  writer.finish();
  require(writer.lastSampleHostNs() == b.capture.sampleHostTimeNs, "finished take lost latest sample timestamp");
  writer.resetCaptureTelemetry();
  require(writer.lastSampleHostNs() == 0, "new capture retained a stale latest timestamp");
}

void unicodePaths(const std::filesystem::path& root) {
#if defined(_WIN32)
  // Exercise native wide Windows paths independently of the active ANSI code page.
  const auto dir = root / std::filesystem::path(L"\u041f\u0440\u043e\u0444\u0438\u043b\u044c-\u97f3\u697d");
  static_assert(std::is_same_v<std::filesystem::path::value_type, wchar_t>);
#else
  const auto dir = root / std::filesystem::path(u8"\u041f\u0440\u043e\u0444\u0438\u043b\u044c-\u97f3\u697d");
#endif
  std::filesystem::create_directory(dir);
  singz::TakeWriter writer(8, 8);
  const std::vector<float> pcm(8, .25f);
  writer.start(utf8Path(dir), "unicode", 48000);
  require(writer.append(block(pcm)), "Unicode path append");
  const auto result = writer.finish();
  require(result.error.empty() && result.frames == 8 && result.path == utf8Path(dir / "unicode.wav"),
          "Unicode path create/extent/UTF-8 return path");
  const auto audio = bytes(result.path);
  require(audio.size() == 60 && le32(audio.data() + 40) == 16, "Unicode path WAV output");
  // Unpatch the header and tear the final sample; recover must use the same native path.
  { std::fstream f(dir / "unicode.wav", std::ios::binary | std::ios::in | std::ios::out);
    f.seekp(40); const char zero[4]{}; f.write(zero, 4); }
  std::filesystem::resize_file(dir / "unicode.wav", 59);
  const auto recovered = singz::TakeWriter::recover(result.path);
  require(recovered.frames == 7 && std::filesystem::file_size(dir / "unicode.wav") == 58,
          "Unicode path recovery/truncate");
  writer.start(utf8Path(dir), "unicode-cancel", 48000);
  require(writer.append(block(pcm)), "Unicode cancellation append");
  writer.cancel();
  require(!std::filesystem::exists(dir / "unicode-cancel.wav"), "Unicode cancellation failed to remove take");
}

int16_t sampleAt(const std::vector<unsigned char>& wav, size_t frame) {
  require(44 + frame * 2 + 1 < wav.size(), "timeline sample missing");
  return static_cast<int16_t>(uint16_t(wav[44 + frame * 2]) | uint16_t(wav[45 + frame * 2]) << 8);
}
uint64_t atFrame(uint64_t frame) {
  return 9876543210123456ULL + static_cast<uint64_t>(std::llround(frame * 1.0e9L / 48000));
}
void forwardGap(const std::filesystem::path& dir) {
  singz::TakeWriter writer(16, 512);
  std::atomic<bool> entered{false}, release{false};
  // Block the consumer after its buffers are allocated to prove append only
  // journals metadata: gap computation and padding must wait for the writer.
  writer.start(utf8Path(dir), "gap", 48000, [&] {
    entered.store(true);
    while (!release.load()) std::this_thread::yield();
    return false;
  });
  waitFor(entered);
  const std::vector<float> before(512, .25f), after(32, -.5f);
  auto a = block(before), b = block(after);
  a.capture.sampleHostTimeNs = atFrame(0);
  b.capture.sampleHostTimeNs = atFrame(512 + 1440);
  zdsp::test::resetAllocationTrap(); zdsp::test::setAllocationTrapEnabled(true);
  auto c = b; c.capture.sampleHostTimeNs = atFrame(512 + 1440 + 32);
  const bool acceptedA = writer.append(a), acceptedB = writer.append(b), acceptedC = writer.append(c);
  zdsp::test::setAllocationTrapEnabled(false);
  const auto allocations = zdsp::test::trappedAllocationCount();
  const auto queued = writer.gapStats();
  release.store(true);
  const auto result = writer.finish();
  require(acceptedA && acceptedB && acceptedC && allocations == 0, "gap append allocated or rejected");
  require(queued.gapPaddedFrames == 0 && queued.gapPaddedBlocks == 0, "sink performed gap padding");
  require(result.error.empty() && result.frames == 512 + 1440 + 64, "30ms gap lost elapsed frames");
  require(result.gapPaddedFrames == 1440 && result.gapPaddedBlocks == 1 && !result.gapOverflow,
          "30ms gap padding stats");
  require(result.firstSampleHostNs == atFrame(0), "gap shifted placement anchor");
  const auto stamp = writer.frameStamp();
  require(stamp.hostNs == c.capture.sampleHostTimeNs && stamp.takeFrame == 512 + 1440 + 32,
          "anchor cursor omitted gap padding or paired a frame with another block's host time");
  const auto stats = writer.gapStats();
  require(stats.gapPaddedFrames == result.gapPaddedFrames && stats.gapPaddedBlocks == 1,
          "live gap stats disagree with result");
  const auto wav = bytes(result.path);
  for (size_t i = 0; i < result.frames; ++i)
    require(sampleAt(wav, i) == (i < 512 ? 8192 : i < 1952 ? 0 : -16384),
            "post-gap audio shifted against reference timeline");
  // Crash recovery must preserve padded data even with an unpatched header.
  { std::fstream f(nativePath(result.path), std::ios::binary | std::ios::in | std::ios::out);
    const char zero[4]{}; f.seekp(4); f.write(zero, 4); f.seekp(40); f.write(zero, 4); }
  const auto recovered = singz::TakeWriter::recover(result.path);
  require(recovered.frames == result.frames && bytes(result.path) == wav, "padded crash recovery lost timeline");
  writer.start(utf8Path(dir), "gap-reset", 48000);
  const auto reset = writer.gapStats();
  require(reset.gapPaddedFrames == 0 && reset.gapPaddedBlocks == 0 && !reset.gapOverflow,
          "new take retained gap stats");
  writer.finish();
}
void gapJitter(const std::filesystem::path& dir) {
  singz::TakeWriter writer(16, 480);
  const std::vector<float> pcm(480, .25f);
  writer.start(utf8Path(dir), "jitter", 48000);
  auto b = block(pcm);
  const uint64_t times[] = {0, 11000000, 20500000, 35000000, 43500000};
  // +/- jitter and exactly half a previous 10ms block (5ms) must not pad.
  for (auto ns : times) { b.capture.sampleHostTimeNs = atFrame(0) + ns; require(writer.append(b), "jitter append"); }
  const auto r = writer.finish();
  require(r.error.empty() && r.frames == 5 * 480 && r.gapPaddedFrames == 0 && r.gapRegressions == 0,
          "clock jitter changed PCM length");
  // Small callbacks use the 2ms floor instead of their half-duration.
  singz::TakeWriter shortWriter(8, 32);
  shortWriter.start(utf8Path(dir), "jitter-short", 48000);
  const std::vector<float> shortPcm(32, .25f); auto small = block(shortPcm);
  small.capture.sampleHostTimeNs = atFrame(0); require(shortWriter.append(small), "short jitter first");
  small.capture.sampleHostTimeNs = atFrame(32 + 95); require(shortWriter.append(small), "short jitter second");
  const auto sr = shortWriter.finish();
  require(sr.frames == 64 && sr.gapPaddedFrames == 0, "2ms jitter floor padded");
}
void gapUnknown(const std::filesystem::path& dir) {
  singz::TakeWriter writer(16, 480);
  const std::vector<float> pcm(480, .25f);
  writer.start(utf8Path(dir), "unknown-gap", 48000);
  auto b = block(pcm);
  for (int i = 0; i < 4; ++i) {
    b.capture.sampleHostTimeNs = atFrame(i * 1920);
    b.capture.timestampQuality = i == 1 || i == 2 ? singz::AudioInputTimestampQuality::Unknown : singz::AudioInputTimestampQuality::Hardware;
    require(writer.append(b), "unknown append");
  }
  const auto r = writer.finish();
  require(r.error.empty() && r.frames == 1920 && r.gapPaddedFrames == 0 && r.gapUntrustedTimestampBlocks == 2,
          "untrustworthy timestamp pair padded or uncounted");
  require(writer.gapStats().gapUntrustedTimestampBlocks == 2, "unknown telemetry");
}
void gapBackward(const std::filesystem::path& dir) {
  singz::TakeWriter writer(16, 480);
  const std::vector<float> pcm(480, -.5f);
  writer.start(utf8Path(dir), "backward-gap", 48000);
  auto b = block(pcm);
  for (auto frame : {4800, 2400, 2880, 4800}) {
    b.capture.sampleHostTimeNs = atFrame(frame); require(writer.append(b), "backward append");
  }
  const auto r = writer.finish();
  require(r.error.empty() && r.frames == 3360 && r.gapRegressions == 1 && r.gapPaddedFrames == 1440,
          "backward timestamp deleted audio or uncounted");
  require(writer.gapStats().gapRegressions == 1, "regression telemetry");
  const auto wav = bytes(r.path);
  for (size_t i = 0; i < r.frames; ++i)
    require(sampleAt(wav, i) == (i >= 1440 && i < 2880 ? 0 : -16384), "backward jump altered PCM");
}
void gapCaps(const std::filesystem::path& dir) {
  const std::vector<float> pcm(480, .25f);
  // The offending gap is rejected, all real audio remains, and even a later
  // small gap cannot resume padding after overflow.
  for (bool total : {false, true}) {
    singz::TakeWriter writer(32, 480);
    writer.start(utf8Path(dir), total ? "gap-total-cap" : "gap-single-cap", 48000);
    auto b = block(pcm); uint64_t cursor = 0;
    b.capture.sampleHostTimeNs = atFrame(cursor); require(writer.append(b), "cap initial append");
    const int gaps = total ? 7 : 2;
    for (int i = 0; i < gaps; ++i) {
      cursor += 480 + (total ? (i < 6 ? 96000 : 1440) : (i == 0 ? 96048 : 1440));
      b.capture.sampleHostTimeNs = atFrame(cursor); require(writer.append(b), "cap append");
    }
    const auto r = writer.finish();
    const uint64_t padded = total ? 480000 : 0;
    require(r.gapOverflow && !r.error.empty(), "gap overflow must mark partial error");
    require(r.gapPaddedFrames == padded && r.gapPaddedBlocks == (total ? 5 : 0) &&
            r.frames == (gaps + 1) * 480 + padded, "padding exceeded cap or lost captured audio");
    require(writer.gapStats().gapOverflow, "gap overflow telemetry");
  }
  // A hostile epoch jump must be rejected before converting to a frame integer.
  singz::TakeWriter writer(8, 480);
  writer.start(utf8Path(dir), "gap-huge", 48000);
  auto b = block(pcm); b.capture.sampleHostTimeNs = 0; require(writer.append(b), "huge first");
  b.capture.sampleHostTimeNs = UINT64_MAX; require(writer.append(b), "huge second");
  const auto r = writer.finish();
  require(r.gapOverflow && r.frames == 960 && r.gapPaddedFrames == 0, "huge host gap overflowed arithmetic");
}
void gapLong(const std::filesystem::path& dir) {
  singz::TakeWriter writer(1024, 4800);
  writer.start(utf8Path(dir), "gap-sixty-seconds", 48000);
  const std::vector<float> pcm(4800, .25f);
  auto b = block(pcm); std::mt19937 random(73);
  uint64_t cursor = 0, padded = 0;
  std::vector<int16_t> reference;
  reference.reserve(65 * 48000);
  for (int i = 0; i < 600; ++i) {
    if (i % 30 == 15) {
      const auto gap = (60 + random() % 61) * 48;
      padded += gap; cursor += gap; reference.insert(reference.end(), gap, 0);
    }
    b.capture.sampleHostTimeNs = atFrame(cursor);
    require(writer.append(b), "long synthetic take dropped block");
    cursor += 4800; reference.insert(reference.end(), 4800, 8192);
  }
  const auto r = writer.finish();
  require(r.error.empty() && r.frames == cursor && r.frames == 60 * 48000 + padded &&
          r.gapPaddedFrames == padded && r.gapPaddedBlocks == 20, "60s random gaps lost elapsed timeline");
  const auto wav = bytes(r.path);
  for (size_t i = 0; i < reference.size(); ++i) require(sampleAt(wav, i) == reference[i], "random gap reference alignment");
}
void appendEventually(singz::TakeWriter& writer, const singz::AudioInputBlockView& b) {
  const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(10);
  // Retry the same block under synthetic producer pressure: no input time or
  // audio is omitted. Production append remains bounded and nonblocking.
  while (!writer.append(b)) {
    require(!writer.completed() && std::chrono::steady_clock::now() < deadline, "synthetic writer stopped draining");
    std::this_thread::sleep_for(std::chrono::microseconds(50));
  }
}
void gapEstimated(const std::filesystem::path& dir) {
  singz::TakeWriter writer(1024, 480);
  const std::vector<float> pcm(480, .25f);
  writer.start(utf8Path(dir), "estimate-jitter", 48000);
  auto b = block(pcm);
  b.capture.timestampQuality = singz::AudioInputTimestampQuality::CallbackEstimate;
  for (uint64_t i = 0; i < 1000; ++i) {
    // Callback-entry estimates can be late and then catch up with no real gap.
    b.capture.sampleHostTimeNs = static_cast<uint64_t>(static_cast<int64_t>(atFrame(i * 480)) +
        (i == 0 ? 0 : i % 2 ? -3000000 : 3000000));
    appendEventually(writer, b);
  }
  const auto r = writer.finish();
  require(r.error.empty() && r.frames == 480000 && r.gapPaddedFrames == 0 && !r.gapOverflow,
          "callback-estimate scheduling jitter padded audio");
  require(r.gapUntrustedTimestampBlocks == 1000 && writer.gapStats().gapUntrustedTimestampBlocks == 1000,
          "callback-estimate blocks must be counted as untrusted");
}
void gapHardwareJitter(const std::filesystem::path& dir) {
  singz::TakeWriter writer(1024, 96);
  const std::vector<float> pcm(96, .25f);
  writer.start(utf8Path(dir), "hardware-small-jitter", 48000);
  auto b = block(pcm);
  for (uint64_t i = 0; i < 1000; ++i) {
    // Adjacent jitter can vary by 0.8ms; both signs remain below the 2ms floor.
    const int64_t jitter = i == 0 ? 0 : i % 2 ? -400000 : 400000;
    b.capture.sampleHostTimeNs = static_cast<uint64_t>(static_cast<int64_t>(atFrame(i * 96)) + jitter);
    appendEventually(writer, b);
  }
  const auto r = writer.finish();
  require(r.error.empty() && r.frames == 96000 && r.gapPaddedFrames == 0 &&
          r.gapPaddedBlocks == 0 && !r.gapOverflow && r.gapUntrustedTimestampBlocks == 0,
          "submillisecond hardware jitter padded audio");
}
void gapClockDrift(bool withGap) {
  constexpr uint64_t totalFrames = 3600ULL * 48000, gapAt = 3000ULL * 48000;
  for (uint32_t blockFrames : {32, 512}) for (int ppm : {100, -100}) {
    const long double realRate = 48000.0L * (1 + ppm / 1.0e6L);
    singz::AudioInputCaptureMetadata previous;
    previous.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
    previous.sampleHostTimeNs = atFrame(0);
    uint64_t writtenFrames = blockFrames, padded = 0, paddedBlocks = 0;
    // Drive EVERY block of a sixty-minute take through the exact stateless
    // production policy, without allocating or writing an hour of synthetic PCM.
    for (uint64_t cursor = blockFrames; cursor < totalFrames; cursor += blockFrames) {
      auto current = previous; ++current.sequence;
      current.sampleHostTimeNs = atFrame(0) + static_cast<uint64_t>(std::llround(cursor * 1.0e9L / realRate)) +
          (withGap && cursor >= gapAt ? 30000000 : 0);
      const auto gap = static_cast<uint64_t>(singz::detail::takeGapFrames(previous, blockFrames, 48000, current, 48000));
      if (gap) ++paddedBlocks;
      padded += gap; writtenFrames += blockFrames + gap; previous = current;
    }
    require(padded == (withGap ? 1440 : 0) && paddedBlocks == (withGap ? 1 : 0) &&
            writtenFrames == totalFrames + (withGap ? 1440 : 0),
            withGap ? "hour drift swallowed or inflated minute-50 gap" : "hour clock drift inserted false gaps");
  }
}
void gapThresholds(const std::filesystem::path& dir) {
  // 96-frame blocks have an exactly integral 2ms duration, and 480-frame blocks
  // use the exactly integral 5ms half-duration threshold. +1ns must cross it.
  for (uint32_t frames : {96, 480}) for (uint64_t extraNs : {0, 1}) {
    singz::TakeWriter writer(8, 480);
    const std::vector<float> pcm(frames, .25f);
    writer.start(utf8Path(dir), "threshold-" + std::to_string(frames) + "-" + std::to_string(extraNs), 48000);
    auto b = block(pcm); b.capture.sampleHostTimeNs = atFrame(0);
    require(writer.append(b), "threshold first append");
    const uint64_t durationNs = frames * 1000000000ULL / 48000;
    const uint64_t thresholdNs = std::max<uint64_t>(2000000, durationNs / 2);
    b.capture.sampleHostTimeNs += durationNs + thresholdNs + extraNs;
    require(writer.append(b), "threshold second append");
    const auto r = writer.finish();
    const uint64_t wanted = extraNs ? thresholdNs * 48000 / 1000000000 : 0;
    require(r.error.empty() && r.gapPaddedFrames == wanted && r.frames == frames * 2 + wanted &&
            r.gapPaddedBlocks == (extraNs ? 1 : 0), "gap threshold boundary or rounding");
  }
  // Fractional sample rounding is local to each real gap, not a running debt.
  singz::AudioInputCaptureMetadata previous, current;
  previous.timestampQuality = current.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
  previous.sampleHostTimeNs = atFrame(0);
  for (int i = 0; i < 100; ++i) {
    current.sampleHostTimeNs = previous.sampleHostTimeNs + 10000000 + 30010000; // 1440.48 missing frames.
    require(singz::detail::takeGapFrames(previous, 480, 48000, current, 48000) == 1440,
            "fractional gap rounding carried into another gap");
    previous = current;
  }
}
void gapMacReplacementSilence(const std::filesystem::path& dir) {
  singz::TakeWriter writer(16, 512);
  writer.start(utf8Path(dir), "mac-replacement-silence", 48000);
  std::vector<float> shortPcm(32, .25f), grownPcm(512, -.5f);
  auto b = block(shortPcm);
  for (uint64_t i = 0; i < 3; ++i) {
    b.capture.sequence = i; b.capture.sourceFrame = i * 32;
    b.capture.sampleHostTimeNs = atFrame(i * 32);
    require(writer.append(b), "mac small append");
  }
  // zCore 0f66fc1 renderCallback first calls these real portable helpers,
  // then resolveAudioInputTimestamp and push_ with THIS callback's timestamp.
  // Its -10874 replacement is 512 silent frames at frame 96, not a stale
  // pre-drop timestamp or an omitted callback (audio_input_transport.h contract).
  singz::detail::MacInputRenderRecovery recovery;
  std::atomic<uint64_t> drops{0};
  const auto disposition = singz::detail::observeMacInputRender(
      singz::detail::kMacInputTooManyFrames, atFrame(96), recovery, drops);
  require(disposition == singz::detail::MacInputRenderDisposition::Drop &&
          singz::detail::prepareMacInputRenderBlock(disposition, grownPcm.data(), 512),
          "zCore render-drop replacement contract");
  b = block(grownPcm); b.capture.sequence = 3; b.capture.sourceFrame = 96;
  b.capture.sampleHostTimeNs = atFrame(96); b.capture.callbackHostTimeNs = atFrame(96) + 1000000;
  require(writer.append(b), "mac replacement append");
  std::fill(grownPcm.begin(), grownPcm.end(), -.5f);
  b.capture.sequence = 4; b.capture.sourceFrame = 608; b.capture.sampleHostTimeNs = atFrame(608);
  require(writer.append(b), "mac following append");
  const auto r = writer.finish();
  require(r.error.empty() && drops.load() == 1 && r.frames == 1120 && r.gapPaddedFrames == 0 &&
          r.gapPaddedBlocks == 0 && !r.gapOverflow, "mac replacement silence double-padded");
  const auto wav = bytes(r.path);
  for (size_t i = 0; i < r.frames; ++i)
    require(sampleAt(wav, i) == (i < 96 ? 8192 : i < 608 ? 0 : -16384), "mac replacement timeline alignment");
}

void gapRateBoundary(const std::filesystem::path& dir) {
  singz::TakeWriter writer(16, 480);
  const std::vector<float> pcm(480, .25f);
  writer.start(utf8Path(dir), "rate-boundary", 48000);
  auto b = block(pcm); b.capture.sampleHostTimeNs = atFrame(0);
  require(writer.append(b), "rate boundary initial append");
  b.sampleRate = 44100; b.capture.sampleHostTimeNs = atFrame(48000 * 30);
  require(writer.append(b), "rate boundary changed append");
  const auto r = writer.finish();
  // A canonical PCM WAV has one rate. The established error path preserves its
  // valid prefix; a timestamp from a different rate must never become a gap.
  require(!r.error.empty() && r.frames == 480 && r.gapPaddedFrames == 0 && !r.gapOverflow,
          "rate boundary inferred padding or corrupted fixed-rate WAV");
}

void gapRealtimePolicy() {
  std::ifstream file(SINGZ_TAKE_WRITER_SOURCE, std::ios::binary);
  std::string source{std::istreambuf_iterator<char>(file), std::istreambuf_iterator<char>()};
  // The same policy applies to Windows checkouts with CRLF line endings.
  source.erase(std::remove(source.begin(), source.end(), '\r'), source.end());
  const auto begin = source.find("bool TakeWriter::append(");
  const auto end = source.find("\nvoid TakeWriter::closeGate", begin);
  require(begin != std::string::npos && end != std::string::npos, "RT append policy source missing");
  // Pin the reviewed journal body: this work must add no sink work at all.
  uint64_t hash = 14695981039346656037ULL;
  for (size_t i = begin; i < end; ++i) { hash ^= static_cast<unsigned char>(source[i]); hash *= 1099511628211ULL; }
  require(hash == 9275722600944028370ULL, "take append RT body changed: review and update policy fingerprint");
}

void lifecycle(const std::filesystem::path& dir) {
  singz::TakeWriter writer(8, 8);
  std::atomic<bool> lost{false};
  const std::vector<float> pcm(8, .25f);
  writer.start(utf8Path(dir), "lost", 48000, [&] { return lost.load(); });
  require(writer.append(block(pcm)), "initial device-loss block");
  lost.store(true);
  const auto end = std::chrono::steady_clock::now() + std::chrono::seconds(3);
  while (!writer.completed() && std::chrono::steady_clock::now() < end) std::this_thread::yield();
  require(writer.completed(), "device loss must automatically finalize");
  const auto r = writer.finish();
  require(r.deviceLost && r.frames == 8 && r.error.empty() && !writer.active(), "device loss preservation");
  require(le32(bytes(r.path).data() + 40) == 16, "device loss header");
  bool refused = false;
  try { writer.start(utf8Path(dir), "lost", 48000); } catch (...) { refused = true; }
  require(refused && bytes(r.path).size() == 60, "existing take overwritten");
  refused = false;
  try { writer.start(utf8Path(dir), "../escape", 48000); } catch (...) { refused = true; }
  require(refused, "take id traversal accepted");
  writer.start(utf8Path(dir), "cancelled", 48000);
  require(!writer.firstSample().captured, "new take retained previous first sample");
  require(writer.append(block(pcm)), "cancel append"); writer.cancel();
  require(!std::filesystem::exists(dir / "cancelled.wav"), "cancel left audio");
  writer.start(utf8Path(dir), "rate-change", 48000);
  require(writer.append(block(pcm, 44100)), "rate-change append");
  const auto mismatch = writer.finish();
  require(!mismatch.error.empty() && mismatch.frames == 0, "sample rate change silently accepted");
}
}
int main(int argc, char** argv) {
  const auto dir = std::filesystem::temp_directory_path() / ("singz-take-writer-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
  std::filesystem::create_directory(dir);
  try {
    const std::string which = argc > 1 ? argv[1] : "all";
    if (which == "all" || which == "gap") forwardGap(dir);
    if (which == "all" || which == "gap-jitter") gapJitter(dir);
    if (which == "all" || which == "gap-unknown") gapUnknown(dir);
    if (which == "all" || which == "gap-backward") gapBackward(dir);
    if (which == "all" || which == "gap-caps") gapCaps(dir);
    if (which == "all" || which == "gap-long") gapLong(dir);
    if (which == "all" || which == "gap-estimated") gapEstimated(dir);
    if (which == "all" || which == "gap-hardware-jitter") gapHardwareJitter(dir);
    if (which == "all" || which == "gap-drift") gapClockDrift(false);
    if (which == "all" || which == "gap-drift-gap") gapClockDrift(true);
    if (which == "all" || which == "gap-thresholds") gapThresholds(dir);
    if (which == "all" || which == "gap-mac-silence") gapMacReplacementSilence(dir);
    if (which == "all" || which == "gap-rate") gapRateBoundary(dir);
    if (which == "all" || which == "gap-rt") gapRealtimePolicy();
    if (which == "all" || which == "live-anchor") liveFrameStamp(dir);
    if (which == "all" || which == "roundtrip") roundtrip(dir);
    if (which == "all" || which == "overflow") overflow(dir);
    if (which == "all" || which == "lifecycle") lifecycle(dir);
    if (which == "all" || which == "concurrent") concurrentFinish(dir);
    if (which == "all" || which == "timestamp") deliveredTimestamp(dir);
    if (which == "all" || which == "unicode") unicodePaths(dir);
    std::filesystem::remove_all(dir);
    std::cout << "PASS take_writer_tests " << which << '\n'; return 0;
  } catch (const std::exception& e) {
    std::cerr << "FAIL " << e.what() << '\n'; std::filesystem::remove_all(dir); return 1;
  }
}
