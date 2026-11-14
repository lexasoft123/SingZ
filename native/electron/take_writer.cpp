#include "take_writer.h"
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <limits>
#include <stdexcept>
#include <vector>
#if defined(_WIN32)
#include <io.h>
#else
#include <unistd.h>
#endif

namespace singz {
namespace {
static_assert(std::atomic<uint64_t>::is_always_lock_free);
static_assert(std::atomic<uint32_t>::is_always_lock_free);
static_assert(std::atomic<float>::is_always_lock_free);
static_assert(std::atomic<bool>::is_always_lock_free);
static_assert(std::atomic<AudioInputTimestampQuality>::is_always_lock_free);
constexpr uint64_t maxDataBytes = (uint64_t{UINT32_MAX} - 36) & ~uint64_t{1};
void put16(unsigned char* p, uint16_t n) { p[0] = n; p[1] = n >> 8; }
void put32(unsigned char* p, uint32_t n) { put16(p, n); put16(p + 2, n >> 16); }
uint32_t get32(const unsigned char* p) {
  return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
std::array<unsigned char, 44> header(uint32_t rate, uint32_t bytes) {
  std::array<unsigned char, 44> h{};
  std::memcpy(h.data(), "RIFF", 4); put32(h.data() + 4, bytes + 36);
  std::memcpy(h.data() + 8, "WAVEfmt ", 8); put32(h.data() + 16, 16);
  put16(h.data() + 20, 1); put16(h.data() + 22, 1);
  put32(h.data() + 24, rate); put32(h.data() + 28, rate * 2);
  put16(h.data() + 32, 2); put16(h.data() + 34, 16);
  std::memcpy(h.data() + 36, "data", 4); put32(h.data() + 40, bytes);
  return h;
}
bool syncFile(std::FILE* file) {
  if (std::fflush(file)) return false;
#if defined(_WIN32)
  return _commit(_fileno(file)) == 0;
#else
  return fsync(fileno(file)) == 0;
#endif
}
bool patch(std::FILE* file, uint32_t rate, uint64_t frames) {
  const auto h = header(rate, static_cast<uint32_t>(frames * 2));
  return std::fseek(file, 0, SEEK_SET) == 0 &&
      std::fwrite(h.data(), 1, h.size(), file) == h.size() && syncFile(file);
}
std::filesystem::path nativePathFromUtf8(const std::string& path) {
#if defined(_WIN32)
  return std::filesystem::u8path(path);
#else
  // POSIX native paths already use UTF-8 bytes; avoid locale conversion.
  return std::filesystem::path(path);
#endif
}
bool validId(const std::string& id) {
  return !id.empty() && id.size() <= 128 && std::all_of(id.begin(), id.end(), [](unsigned char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
        (c >= '0' && c <= '9') || c == '-' || c == '_';
  });
}
}
long double detail::takeGapFrames(const AudioInputCaptureMetadata& previous, uint32_t previousFrames,
                                 double previousRate, const AudioInputCaptureMetadata& current,
                                 double currentRate) noexcept {
  if (previous.timestampQuality != AudioInputTimestampQuality::Hardware ||
      current.timestampQuality != AudioInputTimestampQuality::Hardware ||
      previousRate != currentRate || !std::isfinite(currentRate) || currentRate <= 0 ||
      current.sampleHostTimeNs < previous.sampleHostTimeNs) return 0;
  const long double durationNs = previousFrames * 1.0e9L / previousRate;
  // Pairwise differences keep nominal-vs-device clock error bounded to one
  // block. Subtract uint64 timestamps first to retain precision at large epochs.
  const long double excessNs = static_cast<long double>(current.sampleHostTimeNs - previous.sampleHostTimeNs) - durationNs;
  const long double thresholdNs = std::max(2.0e6L, durationNs * .5L);
  // Round each detected gap independently: at most half a sample of error per
  // padded gap. No fractional remainder carries into later ordinary blocks.
  const long double gapFrames = excessNs > thresholdNs ? std::round(excessNs * currentRate / 1.0e9L) : 0;
  return gapFrames;
}
struct TakeWriter::Slot {
  uint32_t frames = 0;
  double rate = 0;
  AudioInputCaptureMetadata capture;
};
TakeWriter::TakeWriter(uint32_t blocks, uint32_t frames)
    : capacity_(blocks), maxFrames_(frames) {
  if (blocks < 2 || blocks > 1024 || !frames || frames > 262144)
    throw std::invalid_argument("Invalid take ring dimensions");
  slots_ = std::make_unique<Slot[]>(blocks);
  samples_ = std::make_unique<float[]>(size_t(blocks) * frames);
}
TakeWriter::~TakeWriter() { finish(); }
void TakeWriter::start(const std::string& directory, const std::string& id,
                       uint32_t rate, std::function<bool()> deviceLost) {
  if (thread_.joinable()) throw std::runtime_error("A voice take has not been finished");
  if (directory.empty() || directory.find('\0') != std::string::npos) throw std::invalid_argument("Invalid take directory");
  if (!validId(id)) throw std::invalid_argument("Invalid take id");
  if (!rate || rate > 768000) throw std::invalid_argument("Invalid take sample rate");
  result_ = {};
  path_ = nativePathFromUtf8(directory) / (id + ".wav");
  result_.sampleRate = rate;
  // Exclusive creation prevents an existing take or symlink from being overwritten.
#if defined(_WIN32)
  file_ = _wfopen(path_.c_str(), L"wbx");
#else
  file_ = std::fopen(path_.c_str(), "wbx");
#endif
  if (!file_) throw std::runtime_error("Cannot create voice take WAV");
  const auto utf8Path = path_.u8string();
  result_.path.assign(utf8Path.begin(), utf8Path.end());
  const auto h = header(rate, 0);
  if (std::fwrite(h.data(), 1, h.size(), file_) != h.size() || !syncFile(file_)) {
    std::fclose(file_); file_ = nullptr;
    throw std::runtime_error("Cannot write voice take WAV header");
  }
  write_.store(0); read_.store(0); dropped_.store(0);
  gapPaddedFrames_.store(0); gapPaddedBlocks_.store(0);
  gapUntrustedTimestampBlocks_.store(0); gapRegressions_.store(0); gapOverflow_.store(false);
  firstCaptured_.store(false, std::memory_order_release);
  firstHostNs_.store(0); firstQuality_.store(AudioInputTimestampQuality::Unknown);
  stampSequence_.store(0); stampHost_.store(0); stampFrame_.store(0);
  deviceLost_ = std::move(deviceLost);
  done_.store(false, std::memory_order_release);
  accepting_.store(true, std::memory_order_seq_cst);
  try { thread_ = std::thread([this] { run(); }); }
  catch (...) { closeGate(); std::fclose(file_); file_ = nullptr; done_.store(true); throw; }
}
// Static RT review: bounded sample scan/copy, scalar stores and lock-free
// atomics only. No shared_ptr reclamation, notifications, mutex or OS calls.
bool TakeWriter::append(const AudioInputBlockView& b) noexcept {
  if (!b.mono || !b.frames) return false;
  lastHostNs_.store(b.capture.sampleHostTimeNs, std::memory_order_relaxed);
  float peak = 0; double sum = 0;
  for (uint32_t i = 0; i < b.frames; ++i) {
    const float v = std::isfinite(b.mono[i]) ? b.mono[i] : 0;
    peak = std::max(peak, std::abs(v)); sum += double(v) * v;
  }
  peak_.store(peak, std::memory_order_relaxed);
  meanSquare_.store(static_cast<float>(sum / b.frames), std::memory_order_relaxed);
  producers_.fetch_add(1, std::memory_order_seq_cst);
  if (!accepting_.load(std::memory_order_seq_cst)) {
    producers_.fetch_sub(1, std::memory_order_seq_cst); return false;
  }
  const auto w = write_.load(std::memory_order_relaxed);
  const bool fits = b.frames <= maxFrames_ && w - read_.load(std::memory_order_acquire) < capacity_;
  if (fits) {
    auto& slot = slots_[w % capacity_];
    slot.frames = b.frames; slot.rate = b.sampleRate; slot.capture = b.capture;
    std::memcpy(samples_.get() + (w % capacity_) * maxFrames_, b.mono, size_t(b.frames) * sizeof(float));
    write_.store(w + 1, std::memory_order_release);
  } else dropped_.fetch_add(1, std::memory_order_relaxed);
  producers_.fetch_sub(1, std::memory_order_seq_cst);
  return fits;
}
void TakeWriter::closeGate() noexcept {
  accepting_.store(false, std::memory_order_seq_cst);
  // Only the control/writer side waits; the producer always completes in bounded work.
  while (producers_.load(std::memory_order_seq_cst)) std::this_thread::yield();
}
bool TakeWriter::active() const noexcept { return accepting_.load(std::memory_order_acquire); }
bool TakeWriter::completed() const noexcept { return done_.load(std::memory_order_acquire); }
TakeFirstSample TakeWriter::firstSample() const noexcept {
  if (!firstCaptured_.load(std::memory_order_acquire)) return {};
  return {true, firstHostNs_.load(std::memory_order_relaxed), firstQuality_.load(std::memory_order_relaxed)};
}
TakeInputLevel TakeWriter::level() const noexcept {
  const auto db = [](double linear) { return linear > 1e-6 ? 20 * std::log10(linear) : -120.; };
  return {db(peak_.load(std::memory_order_relaxed)), db(std::sqrt(meanSquare_.load(std::memory_order_relaxed)))};
}
TakeGapStats TakeWriter::gapStats() const noexcept {
  return {gapPaddedFrames_.load(std::memory_order_relaxed),
          gapPaddedBlocks_.load(std::memory_order_relaxed),
          gapUntrustedTimestampBlocks_.load(std::memory_order_relaxed),
          gapRegressions_.load(std::memory_order_relaxed),
          gapOverflow_.load(std::memory_order_relaxed)};
}
void TakeWriter::resetLevel() noexcept { peak_.store(0); meanSquare_.store(0); }
uint64_t TakeWriter::lastSampleHostNs() const noexcept { return lastHostNs_.load(std::memory_order_relaxed); }
TakeFrameStamp TakeWriter::frameStamp() const noexcept {
  for (unsigned attempt = 0; attempt < 8; ++attempt) {
    const auto before = stampSequence_.load(std::memory_order_acquire);
    if (before & 1u) continue;
    const TakeFrameStamp stamp{stampHost_.load(std::memory_order_relaxed),
                               stampFrame_.load(std::memory_order_relaxed)};
    std::atomic_thread_fence(std::memory_order_acquire);
    if (before == stampSequence_.load(std::memory_order_acquire)) return stamp;
  }
  return {};
}
void TakeWriter::resetCaptureTelemetry() noexcept { resetLevel(); lastHostNs_.store(0); }
void TakeWriter::run() noexcept {
  try {
    std::vector<unsigned char> pcm(size_t(maxFrames_) * 2);
    // Allocate once before consuming: all gap writes reuse this bounded zero buffer.
    const std::array<unsigned char, 8192> silence{};
    Slot previous;
    bool havePrevious = false;
    const auto trustworthy = [](AudioInputTimestampQuality q) {
      return q == AudioInputTimestampQuality::Hardware;
    };
    auto flushed = std::chrono::steady_clock::now();
    for (;;) {
      if (deviceLost_ && deviceLost_()) { result_.deviceLost = true; closeGate(); }
      const auto r = read_.load(std::memory_order_relaxed);
      if (r == write_.load(std::memory_order_acquire)) {
        if (!active()) {
          closeGate();
          if (read_.load(std::memory_order_relaxed) == write_.load(std::memory_order_acquire)) break;
          continue;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(2));
      } else {
        const auto& s = slots_[r % capacity_];
        if (s.rate != result_.sampleRate) throw std::runtime_error("Voice take sample rate changed");
        if ((result_.frames + s.frames) * 2 > maxDataBytes)
          throw std::runtime_error("Voice take reached the WAV size limit");
        if (!result_.frames) {
          result_.firstSampleHostNs = s.capture.sampleHostTimeNs;
          result_.firstSampleQuality = s.capture.timestampQuality;
        }
        // Delivery metadata travels through the ring unchanged. Only this writer
        // computes time gaps or writes silence; the capture sink remains bounded.
        const bool trusted = trustworthy(s.capture.timestampQuality);
        if (!trusted) {
          ++result_.gapUntrustedTimestampBlocks;
          gapUntrustedTimestampBlocks_.store(result_.gapUntrustedTimestampBlocks, std::memory_order_relaxed);
        }
        uint64_t padding = 0;
        if (havePrevious && trusted && previous.rate == s.rate) {
          if (s.capture.sampleHostTimeNs < previous.capture.sampleHostTimeNs) {
            ++result_.gapRegressions;
            gapRegressions_.store(result_.gapRegressions, std::memory_order_relaxed);
          } else if (!result_.gapOverflow) {
            const long double frames = detail::takeGapFrames(previous.capture, previous.frames, previous.rate,
                                                             s.capture, s.rate);
            // Reject the whole offending gap and latch off further padding.
            // Keep writing real PCM so a bad clock cannot discard a performance.
            const uint64_t perGapCap = uint64_t(result_.sampleRate) * 2;
            const uint64_t perTakeCap = uint64_t(result_.sampleRate) * 10;
            if (frames > perGapCap || frames > perTakeCap - result_.gapPaddedFrames) {
              result_.gapOverflow = true;
              gapOverflow_.store(true, std::memory_order_relaxed);
            } else {
              padding = static_cast<uint64_t>(frames);
            }
          }
        }
        if ((result_.frames + padding + s.frames) * 2 > maxDataBytes)
          throw std::runtime_error("Voice take reached the WAV size limit");
        if (padding) {
          uint64_t remaining = padding;
          while (remaining) {
            const auto frames = std::min<uint64_t>(remaining, silence.size() / 2);
            const auto written = std::fwrite(silence.data(), 1, size_t(frames) * 2, file_);
            result_.frames += written / 2;
            result_.gapPaddedFrames += written / 2;
            gapPaddedFrames_.store(result_.gapPaddedFrames, std::memory_order_relaxed);
            if (written != frames * 2) throw std::runtime_error("Cannot pad voice take audio (storage full or write failed)");
            remaining -= frames;
          }
          ++result_.gapPaddedBlocks;
          gapPaddedBlocks_.store(result_.gapPaddedBlocks, std::memory_order_relaxed);
        }
        previous = s;
        // Untrusted blocks break the pair; never infer a gap across an estimate.
        havePrevious = trusted;
        const auto* input = samples_.get() + (r % capacity_) * maxFrames_;
        for (uint32_t i = 0; i < s.frames; ++i) {
          const float v = std::isfinite(input[i]) ? std::clamp(input[i], -1.f, 1.f) : 0;
          const auto sample = static_cast<int16_t>(std::clamp(std::lround(double(v) * 32768), -32768L, 32767L));
          put16(pcm.data() + i * 2, static_cast<uint16_t>(sample));
        }
        const auto written = std::fwrite(pcm.data(), 1, size_t(s.frames) * 2, file_);
        if (written >= 2) {
          stampSequence_.fetch_add(1, std::memory_order_acq_rel);
          stampHost_.store(s.capture.sampleHostTimeNs, std::memory_order_relaxed);
          stampFrame_.store(result_.frames, std::memory_order_relaxed);
          stampSequence_.fetch_add(1, std::memory_order_release);
        }
        result_.frames += written / 2;
        if (result_.frames && !firstCaptured_.load(std::memory_order_relaxed)) {
          firstHostNs_.store(result_.firstSampleHostNs, std::memory_order_relaxed);
          firstQuality_.store(result_.firstSampleQuality, std::memory_order_relaxed);
          firstCaptured_.store(true, std::memory_order_release);
        }
        if (written != size_t(s.frames) * 2) throw std::runtime_error("Cannot append voice take audio (storage full or write failed)");
        read_.store(r + 1, std::memory_order_release);
      }
      if (std::chrono::steady_clock::now() - flushed >= std::chrono::seconds(1)) {
        if (!syncFile(file_)) throw std::runtime_error("Cannot flush voice take audio");
        flushed = std::chrono::steady_clock::now();
      }
    }
  } catch (const std::exception& e) { closeGate(); result_.error = e.what(); }
  catch (...) { closeGate(); result_.error = "Voice take writer failed"; }
  // Buffered fwrite can report frames that a later flush could not commit.
  // Reconcile the result with the actual append extent before patching, and
  // discard a torn final sample while keeping all complete sample pairs.
  if (std::fflush(file_) && result_.error.empty()) result_.error = "Cannot flush voice take audio";
  std::error_code extentError;
  const auto size = std::filesystem::file_size(path_, extentError);
  if (!extentError && size >= 44) {
    result_.frames = std::min<uint64_t>(result_.frames, (size - 44) / 2);
    if (size != 44 + result_.frames * 2)
      std::filesystem::resize_file(path_, 44 + result_.frames * 2, extentError);
  }
  if (extentError && result_.error.empty()) result_.error = "Cannot inspect voice take audio extent";
  std::clearerr(file_);
  // Keep the partial WAV even on failure; recovery can repair an unpatched header.
  if (!patch(file_, result_.sampleRate, result_.frames) && result_.error.empty()) result_.error = "Cannot finalize voice take WAV";
  if (std::fclose(file_) && result_.error.empty()) result_.error = "Cannot close voice take WAV";
  file_ = nullptr;
  result_.droppedBlocks = dropped_.load(std::memory_order_relaxed);
  if (result_.gapOverflow && result_.error.empty())
    result_.error = "Voice take timestamp gap exceeds padding limit";
  done_.store(true, std::memory_order_release);
}
TakeWriteResult TakeWriter::finish() {
  closeGate();
  if (thread_.joinable()) thread_.join();
  return result_;
}
void TakeWriter::cancel() {
  const auto r = finish();
  if (!r.path.empty()) std::filesystem::remove(path_);
  result_ = {};
}
TakeWriteResult TakeWriter::recover(const std::string& path) {
  TakeWriteResult result; result.path = path;
  const auto nativePath = nativePathFromUtf8(path);
#if defined(_WIN32)
  auto* f = _wfopen(nativePath.c_str(), L"r+b");
#else
  auto* f = std::fopen(nativePath.c_str(), "r+b");
#endif
  if (!f) throw std::runtime_error("Cannot open voice take for recovery");
  try {
    std::array<unsigned char, 44> h{};
    if (std::fread(h.data(), 1, h.size(), f) != h.size()) throw std::runtime_error("Truncated voice take header");
    result.sampleRate = get32(h.data() + 24);
    const auto expected = header(result.sampleRate, 0);
    if (!result.sampleRate || result.sampleRate > 768000 ||
        std::memcmp(h.data(), expected.data(), 4) ||
        std::memcmp(h.data() + 8, expected.data() + 8, 32))
      throw std::runtime_error("Unsupported voice take WAV header");
    const auto bytes = std::filesystem::file_size(nativePath) - 44;
    if (bytes > maxDataBytes) throw std::runtime_error("Voice take exceeds WAV size limit");
    result.frames = bytes / 2;
    if (bytes % 2) std::filesystem::resize_file(nativePath, 44 + result.frames * 2);
    if (!patch(f, result.sampleRate, result.frames)) throw std::runtime_error("Cannot repair voice take WAV");
    std::fclose(f); return result;
  } catch (...) { std::fclose(f); throw; }
}
} // namespace singz
