#include "native/electron/take_writer.h"
#include "allocation_trap.h"
#include <atomic>
#include <chrono>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <vector>
#include <type_traits>

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
