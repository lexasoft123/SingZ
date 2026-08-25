// singz-analyze — the core's detectors as a command-line tool: the desktop's
// way in (spawned by main like whisper-cli; docs/PHONE-STANDALONE.md, Phase
// 4c) and the parity harness's oracle (tests compare its output with the TS
// detectors' on the same samples). One implementation, every platform.
//
//   singz-analyze input-devices
//   singz-analyze live-input --device-uid <uid> --channel <zero-based>
//                            [--frames <analysis-window>] [--latency]
//                            [--duration <seconds>]
//   singz-analyze melody --f32 <mono float32 file> --sr <rate> [--raw]
//   singz-analyze melody --wav <file> [--raw]        (any channel count; folded)
//   singz-analyze key --inst <a.wav> [--inst <b.wav> ...] [--bass <c.wav>]
//   singz-analyze courts --wav <f.wav> [--lo <hz>] [--hi <hz>]
//                        [--bass-wav <b.wav>] [--vocals-wav <v.wav>]
//                        [--word <s>:<e> ...]                    (extractors)
//   singz-analyze beats --drums <d.wav> [--inst <a.wav> ...] [--vocals <v.wav>]
//                        [--bass <b.wav>] [--line <sec> ...]         (staged debug)
//   singz-analyze courtsjudge --wav <harm.wav> --bpm <x> [--bpb <n>] [--t0 <s>]
//                        [--dur <s>] [--bass-wav <b>] [--vocals-wav <v>]
//                        [--word <s>:<e> ...] [--ml-beats <csv>]        (courts)
//                        [--runs <t:sec:label,...>] [--voice <t:gap,...>]
//                        [--seam <t,...>]        (synthetic evidence; skips audio)
//
// Prints one JSON object on stdout. Floats are printed with 9 significant
// digits, which round-trips float32 exactly — the parity harness compares
// values, not text.
#include <cstdio>
#include <cstdlib>
#include <algorithm>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cmath>
#include <cstring>
#include <limits>
#include <mutex>
#include <deque>
#include <string>
#include <thread>
#include <vector>

#if defined(__APPLE__)
#include <fcntl.h>
#include <mach/mach_time.h>
#include <poll.h>
#include <unistd.h>
#elif defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#endif

#include "../audio_input.h"
#include "../resample.h"
#include "../analysis.h"
#include "../beat_this.h"
#include "../beats.h"
#include "../courts.h"
#include "../melody.h"
#include "../wav.h"

static std::vector<float> readF32(const std::string& path) {
  std::vector<float> out;
  std::FILE* f = std::fopen(path.c_str(), "rb");
  if (f == nullptr) return out;
  std::fseek(f, 0, SEEK_END);
  const long bytes = std::ftell(f);
  std::fseek(f, 0, SEEK_SET);
  if (bytes > 0) {
    out.resize(static_cast<size_t>(bytes) / sizeof(float));
    const size_t got = std::fread(out.data(), sizeof(float), out.size(), f);
    out.resize(got);
  }
  std::fclose(f);
  return out;
}

static void printFloats(const std::vector<float>& v) {
  std::printf("[");
  for (size_t i = 0; i < v.size(); i++) std::printf(i ? ",%.9g" : "%.9g", static_cast<double>(v[i]));
  std::printf("]");
}

// The neural grid's token format, shared by --ml <file> (the parity
// harness's path) and the analyze subcommand's --ml-stdin (the desktop's:
// main writes the grid when its own model run finishes, which is what lets
// melody and key start before the lattice exists). Empty text = no grid,
// deliberately: a packless desktop closes stdin with nothing.
struct StdinAux {
  std::vector<double> lineStarts;
  std::vector<std::pair<double, double>> words;
};

static std::string readMlText(const std::string& text, singz::MlGrid& g, StdinAux* aux = nullptr) {
  if (text.find_first_not_of(" \t\r\n") == std::string::npos) return "empty";
  size_t pos = 0;
    const auto token = [&](std::string& t) {
      while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) pos++;
      const size_t start = pos;
      while (pos < text.size() && !std::isspace(static_cast<unsigned char>(text[pos]))) pos++;
      t.assign(text, start, pos - start);
      return !t.empty();
    };
    const auto number = [&](double& v) {
      std::string t;
      if (!token(t)) return false;
      char* end = nullptr;
      v = std::strtod(t.c_str(), &end);
      return end == t.c_str() + t.size() && std::isfinite(v);
    };
    const auto array = [&](std::vector<double>& into) -> std::string {
      double count = 0;
      if (!number(count) || count < 0) return "bad count";
      into.resize(static_cast<size_t>(count));
      for (size_t i = 0; i < into.size(); i++)
        if (!number(into[i])) return "short array";
      return "";
    };
    std::string key;
    bool sawFps = false;
    while (token(key)) {
      std::string err;
      if (key == "fps") {
        double v = 0;
        if (!number(v)) return "bad fps";
        g.fps = static_cast<int>(v);
        sawFps = true;
      } else if (key == "beats") err = array(g.beats);
      else if (key == "downbeats") err = array(g.downbeats);
      else if (key == "beatProb") err = array(g.beatProb);
      else if (key == "downbeatProb") err = array(g.downbeatProb);
      else if (key == "lineStarts" && aux != nullptr) err = array(aux->lineStarts);
      else if (key == "words" && aux != nullptr) {
        // `words <n> <v> ...` — n counts VALUES (start,end per word)
        std::vector<double> flat;
        err = array(flat);
        if (err.empty() && flat.size() % 2 != 0) err = "odd word values";
        if (err.empty())
          for (size_t i2 = 0; i2 + 1 < flat.size(); i2 += 2) aux->words.push_back({flat[i2], flat[i2 + 1]});
      }
      else return "unknown section " + key;
      if (!err.empty()) return err + " in " + key;
    }
  if (!sawFps && !(g.beats.empty() && g.beatProb.empty() && g.downbeats.empty() && g.downbeatProb.empty()))
    return "no fps line";
  if (!sawFps) return "no-grid";
  return "";
}

static void onProgress(void*, const char* stage, float frac) {
  std::fprintf(stderr, "progress %s %.3f\n", stage, static_cast<double>(frac));
}

static std::string jsonString(const std::string& value) {
  std::string out;
  out.reserve(std::min<size_t>(value.size() + 2, 8194));
  out.push_back('"');
  // Driver strings are bounded before escaping so hostile device metadata
  // cannot turn this tiny protocol into an unbounded allocation.
  size_t count = std::min<size_t>(value.size(), 8192);
  // Do not cut a UTF-8 scalar in half at the protocol bound. CoreAudio gives
  // us valid CFString UTF-8; stepping back over continuation bytes keeps the
  // bounded prefix valid JSON text as well.
  if (count < value.size())
    while (count > 0 && (static_cast<unsigned char>(value[count]) & 0xc0) == 0x80) --count;
  static const char hex[] = "0123456789abcdef";
  for (size_t i = 0; i < count; ++i) {
    const unsigned char c = static_cast<unsigned char>(value[i]);
    if (c == '"' || c == '\\') {
      out.push_back('\\');
      out.push_back(static_cast<char>(c));
    } else if (c == '\b') out += "\\b";
    else if (c == '\f') out += "\\f";
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if (c < 0x20) {
      out += "\\u00";
      out.push_back(hex[c >> 4]);
      out.push_back(hex[c & 15]);
    } else {
      out.push_back(static_cast<char>(c));
    }
  }
  out.push_back('"');
  return out;
}

static bool unsignedArgument(const char* text, uint32_t& value) {
  if (!text || !*text || *text == '-') return false;
  errno = 0;
  char* end = nullptr;
  const unsigned long parsed = std::strtoul(text, &end, 10);
  if (errno || *end || parsed > std::numeric_limits<uint32_t>::max()) return false;
  value = static_cast<uint32_t>(parsed);
  return true;
}

static volatile std::sig_atomic_t liveInputStop = 0;
static void stopLiveInput(int) { liveInputStop = 1; }

#if defined(__APPLE__) || defined(_WIN32)
static uint64_t monotonicHostTimeNs() {
#if defined(__APPLE__)
  static const double nsPerTick = [] {
    mach_timebase_info_data_t timebase{};
    return mach_timebase_info(&timebase) == KERN_SUCCESS && timebase.denom
               ? static_cast<double>(timebase.numer) / timebase.denom
               : 0.0;
  }();
  return nsPerTick > 0 ? static_cast<uint64_t>(mach_absolute_time() * nsPerTick) : 0;
#else
  LARGE_INTEGER frequency{}, now{};
  if (!QueryPerformanceFrequency(&frequency) || frequency.QuadPart <= 0 ||
      !QueryPerformanceCounter(&now))
    return 0;
  const uint64_t ticks = static_cast<uint64_t>(now.QuadPart);
  const uint64_t rate = static_cast<uint64_t>(frequency.QuadPart);
  return ticks / rate * 1000000000ull +
         ticks % rate * 1000000000ull / rate;
#endif
}
#endif

class NdjsonWriter {
 public:
  NdjsonWriter() {
#if defined(__APPLE__)
    std::signal(SIGPIPE, SIG_IGN);
    const int flags = fcntl(STDOUT_FILENO, F_GETFL, 0);
    if (flags >= 0) fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK);
#elif defined(_WIN32)
    outputHandle_ = GetStdHandle(STD_OUTPUT_HANDLE);
    if (!outputHandle_ || outputHandle_ == INVALID_HANDLE_VALUE) {
      fail(3);
    } else if (GetFileType(outputHandle_) == FILE_TYPE_PIPE) {
      DWORD mode = PIPE_NOWAIT;
      if (!SetNamedPipeHandleState(outputHandle_, &mode, nullptr, nullptr)) {
        // Never fall through to a potentially blocking WriteFile when the
        // inherited pipe cannot be put in bounded nonblocking mode.
        outputHandle_ = INVALID_HANDLE_VALUE;
        fail(3);
      }
    }
#endif
    thread_ = std::thread([this] { run(); });
  }

  ~NdjsonWriter() { close(); }

  bool enqueue(std::string line) {
    line.push_back('\n');
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (stopRequested_.load(std::memory_order_acquire) || closing_ ||
          queue_.size() >= kMaximumLines) {
        fail(2);
        return false;
      }
      queue_.push_back(std::move(line));
    }
    ready_.notify_one();
    return true;
  }

  void close(std::vector<std::string> finalLines = {}) {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (closing_ && !thread_.joinable()) return;
      if (!closing_) {
        closing_ = true;
        // Live capture frames are disposable telemetry. On shutdown replace
        // queued frames with only the terminal protocol records so EOF,
        // SIGTERM, or a dead parent cannot prolong teardown indefinitely.
        queue_.clear();
        for (std::string& line : finalLines) {
          line.push_back('\n');
          queue_.push_back(std::move(line));
        }
        closeDeadlineNs_.store(steadyNanos() + kWriteDeadlineNs,
                               std::memory_order_release);
      }
    }
    ready_.notify_one();
    if (thread_.joinable()) thread_.join();
  }

  bool stopRequested() const { return stopRequested_.load(std::memory_order_acquire); }

  const char* failureMessage() const {
    switch (failure_.load(std::memory_order_acquire)) {
      case 1: return "live-input: stdout was closed";
      case 2: return "live-input: stdout consumer is too slow";
      case 3: return "live-input: stdout write failed";
      default: return "";
    }
  }

 private:
  static constexpr size_t kMaximumLines = 256;
  static constexpr int64_t kWriteDeadlineNs = 500000000;

  static int64_t steadyNanos() {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
  }

  void fail(int code) {
    int expected = 0;
    failure_.compare_exchange_strong(expected, code, std::memory_order_acq_rel);
    stopRequested_.store(true, std::memory_order_release);
    ready_.notify_one();
  }

  bool writeLine(const std::string& line) {
#if defined(__APPLE__)
    size_t offset = 0;
    const int64_t lineDeadline = steadyNanos() + kWriteDeadlineNs;
    while (offset < line.size()) {
      const int64_t closeDeadline = closeDeadlineNs_.load(std::memory_order_acquire);
      const int64_t deadline = closeDeadline > 0
                                   ? std::min(lineDeadline, closeDeadline)
                                   : lineDeadline;
      if (steadyNanos() >= deadline) {
        fail(2);
        return false;
      }
      const ssize_t written = ::write(STDOUT_FILENO, line.data() + offset, line.size() - offset);
      if (written > 0) {
        offset += static_cast<size_t>(written);
        continue;
      }
      if (written < 0 && errno == EINTR) continue;
      if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
        pollfd output{STDOUT_FILENO, POLLOUT, 0};
        const int64_t remainingMs = std::max<int64_t>(
            1, std::min<int64_t>(100, (deadline - steadyNanos()) / 1000000));
        const int polled = poll(&output, 1, static_cast<int>(remainingMs));
        if (polled < 0 && errno != EINTR) {
          fail(3);
          return false;
        }
        continue;
      }
      fail(written < 0 && errno == EPIPE ? 1 : 3);
      return false;
    }
    return true;
#elif defined(_WIN32)
    if (!outputHandle_ || outputHandle_ == INVALID_HANDLE_VALUE) {
      fail(3);
      return false;
    }
    size_t offset = 0;
    const int64_t lineDeadline = steadyNanos() + kWriteDeadlineNs;
    while (offset < line.size()) {
      const int64_t closeDeadline = closeDeadlineNs_.load(std::memory_order_acquire);
      const int64_t deadline = closeDeadline > 0
                                   ? std::min(lineDeadline, closeDeadline)
                                   : lineDeadline;
      if (steadyNanos() >= deadline) {
        fail(2);
        return false;
      }
      DWORD written = 0;
      const DWORD wanted = static_cast<DWORD>(
          std::min<size_t>(line.size() - offset, std::numeric_limits<DWORD>::max()));
      if (WriteFile(outputHandle_, line.data() + offset, wanted, &written, nullptr)) {
        if (written > 0) {
          offset += written;
          continue;
        }
      } else {
        const DWORD error = GetLastError();
        if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED) {
          fail(1);
          return false;
        }
        if (error != ERROR_NO_DATA && error != ERROR_PIPE_BUSY) {
          fail(3);
          return false;
        }
      }
      std::this_thread::sleep_for(std::chrono::milliseconds(2));
    }
    return true;
#else
    if (std::fwrite(line.data(), 1, line.size(), stdout) != line.size() ||
        std::fflush(stdout) != 0) {
      fail(errno == EPIPE ? 1 : 3);
      return false;
    }
    return true;
#endif
  }

  void run() {
    for (;;) {
      std::string line;
      {
        std::unique_lock<std::mutex> lock(mutex_);
        ready_.wait(lock, [&] { return closing_ || !queue_.empty(); });
        if (queue_.empty()) {
          if (closing_) break;
          continue;
        }
        line = std::move(queue_.front());
        queue_.pop_front();
      }
      if (!writeLine(line)) break;
    }
  }

  mutable std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<std::string> queue_;
  bool closing_ = false;
  std::atomic<bool> stopRequested_{false};
  std::atomic<int> failure_{0};
  std::atomic<int64_t> closeDeadlineNs_{0};
  std::thread thread_;
#if defined(_WIN32)
  HANDLE outputHandle_ = INVALID_HANDLE_VALUE;
#endif
};

template <size_t N, typename... Args>
static std::string jsonLine(const char (&format)[N], Args... args) {
  const int needed = std::snprintf(nullptr, 0, format, args...);
  if (needed <= 0 || needed > 65536) return {};
  std::vector<char> text(static_cast<size_t>(needed) + 1);
  std::snprintf(text.data(), text.size(), format, args...);
  return std::string(text.data(), static_cast<size_t>(needed));
}

static int printInputDevices(std::vector<singz::AudioInputDevice> devices,
                             const std::string& error) {
  if (devices.size() > 256) devices.resize(256);
  std::printf("{\"version\":1,\"devices\":[");
  for (size_t i = 0; i < devices.size(); ++i) {
    const singz::AudioInputDevice& device = devices[i];
    const double sampleRate = std::isfinite(device.sampleRate) && device.sampleRate > 0
                                  ? device.sampleRate
                                  : 0;
    std::printf("%s{\"uid\":%s,\"label\":%s,\"isDefault\":%s,\"sampleRate\":%.17g,"
                "\"channels\":%u,\"channelLabels\":[",
                i ? "," : "", jsonString(device.uid).c_str(),
                jsonString(device.label).c_str(), device.isDefault ? "true" : "false",
                sampleRate, device.channels);
    const size_t labels = std::min<size_t>(device.channelLabels.size(), 4096);
    for (size_t channel = 0; channel < labels; ++channel)
      std::printf("%s%s", channel ? "," : "",
                  jsonString(device.channelLabels[channel]).c_str());
    std::printf("]}");
  }
  std::printf("]");
  if (!error.empty()) std::printf(",\"error\":%s", jsonString(error).c_str());
  std::printf("}\n");
  std::fflush(stdout);
  return error.empty() ? 0 : 1;
}

static int inputDevicesCommand(int argc) {
  if (argc != 2) {
    std::fprintf(stderr, "input-devices: no arguments expected\n");
    return 2;
  }
  std::string error;
  return printInputDevices(singz::enumerateAudioInputDevices(&error), error);
}

struct LiveContinuityState {
  bool haveBlock = false;
  uint64_t expectedSequence = 0;
  uint64_t lastHostTime = 0;
  size_t lastFrames = 0;
  singz::AudioInputTimestampQuality timestampQuality =
      singz::AudioInputTimestampQuality::Unknown;
};

struct LiveContinuityObservation {
  bool sequenceGap = false;
  bool hostTimeGap = false;
  bool timestampQualityChanged = false;
  uint64_t expectedSequence = 0;
  uint64_t droppedAttempts = 0;
};

constexpr double kLiveInputMinFrequencyHz = 70.0;
constexpr uint32_t kMaxLiveInputAnalysisFrames = 8192;

struct LiveInputAnalysisPlan {
  uint32_t frames = 0;
  uint32_t hopFrames = 0;
  double minFrequencyHz = kLiveInputMinFrequencyHz;
  double deviceSampleRate = 0;
  double analysisSampleRate = 0;
  uint32_t resamplerLatencyFrames = 0;
};

static bool makeLiveInputAnalysisPlan(double sampleRate, bool explicitFrames,
                                      uint32_t requestedFrames,
                                      LiveInputAnalysisPlan& plan,
                                      std::string& error) {
  if (!std::isfinite(sampleRate) || sampleRate <= 0) {
    error = "live-input: negotiated sample rate is invalid";
    return false;
  }
  const double roundedDeviceRate = std::round(sampleRate);
  if (roundedDeviceRate < 1 || roundedDeviceRate > 1000000 ||
      std::fabs(sampleRate - roundedDeviceRate) > 0.001) {
    error = jsonLine("live-input: unsupported non-integral sample rate %.17g",
                     sampleRate);
    return false;
  }
  plan.deviceSampleRate = sampleRate;
  plan.analysisSampleRate = std::min(sampleRate, 48000.0);
  const int deviceRate = static_cast<int>(roundedDeviceRate);
  const int analysisRate = static_cast<int>(std::llround(plan.analysisSampleRate));
  const double requiredDouble =
      std::ceil(2.0 * plan.analysisSampleRate / kLiveInputMinFrequencyHz);
  if (!std::isfinite(requiredDouble) ||
      requiredDouble > kMaxLiveInputAnalysisFrames) {
    error = jsonLine(
        "live-input: sample rate %.17g needs more than %u analysis frames "
        "to cover %.9g Hz",
        plan.analysisSampleRate, kMaxLiveInputAnalysisFrames,
        kLiveInputMinFrequencyHz);
    return false;
  }
  const uint32_t requiredFrames = static_cast<uint32_t>(requiredDouble);
  if (explicitFrames) {
    if (requestedFrames < requiredFrames) {
      error = jsonLine(
          "live-input: --frames %u is too short for %.9g Hz at %.17g Hz; "
          "use at least %u",
          requestedFrames, kLiveInputMinFrequencyHz,
          plan.analysisSampleRate, requiredFrames);
      return false;
    }
    plan.frames = requestedFrames;
  } else {
    plan.frames = 128;
    while (plan.frames < requiredFrames &&
           plan.frames < kMaxLiveInputAnalysisFrames)
      plan.frames *= 2;
    if (plan.frames < requiredFrames) {
      error = "live-input: could not derive a bounded analysis window";
      return false;
    }
  }
  // Overlap consecutive windows so low notes get the longer context they
  // need without slowing UI updates to one full window. For the common
  // 44.1/48/96/192 kHz rates this is a roughly 10-12 ms cadence.
  plan.hopFrames = std::max<uint32_t>(128, plan.frames / 4);
  plan.hopFrames = std::min(plan.hopFrames, plan.frames);
  if (deviceRate != analysisRate) {
    singz::Resampler latencyProbe(deviceRate, analysisRate, 1);
    plan.resamplerLatencyFrames = static_cast<uint32_t>(
        std::max<int64_t>(0, latencyProbe.latencyOutFrames()));
  }
  return true;
}

static std::string liveInputAnalysisMetadataFields(
    const LiveInputAnalysisPlan& plan) {
  return jsonLine(
      "\"analysisFrames\":%u,\"analysisHopFrames\":%u,"
      "\"minFrequencyHz\":%.9g,\"deviceSampleRate\":%.17g,"
      "\"analysisSampleRate\":%.17g,\"resamplerLatencyFrames\":%u,"
      "\"resamplerLatencyMs\":%.9g,\"analysisWindowMs\":%.9g,"
      "\"analysisCadenceMs\":%.9g",
      plan.frames, plan.hopFrames, plan.minFrequencyHz,
      plan.deviceSampleRate, plan.analysisSampleRate,
      plan.resamplerLatencyFrames,
      1000.0 * plan.resamplerLatencyFrames / plan.analysisSampleRate,
      1000.0 * plan.frames / plan.analysisSampleRate,
      1000.0 * plan.hopFrames / plan.analysisSampleRate);
}

class LiveInputAnalysisStream {
 public:
  explicit LiveInputAnalysisStream(const LiveInputAnalysisPlan& plan)
      : plan_(plan) {
    output_.reserve(16384);
    reset();
  }

  void reset() {
    output_.clear();
    latencyFramesRemaining_ = plan_.resamplerLatencyFrames;
    if (plan_.deviceSampleRate != plan_.analysisSampleRate) {
      resampler_ = std::make_unique<singz::Resampler>(
          static_cast<int>(std::llround(plan_.deviceSampleRate)),
          static_cast<int>(std::llround(plan_.analysisSampleRate)), 1);
    } else {
      resampler_.reset();
    }
  }

  size_t append(const float* mono, uint32_t frames,
                std::vector<float>& pending) {
    if (!resampler_) {
      pending.insert(pending.end(), mono, mono + frames);
      return frames;
    }
    output_.clear();
    resampler_->process(mono, frames, output_);
    const size_t skipped = std::min<size_t>(latencyFramesRemaining_, output_.size());
    latencyFramesRemaining_ -= static_cast<uint32_t>(skipped);
    pending.insert(pending.end(), output_.begin() + skipped, output_.end());
    return output_.size() - skipped;
  }

 private:
  LiveInputAnalysisPlan plan_;
  std::unique_ptr<singz::Resampler> resampler_;
  std::vector<float> output_;
  uint32_t latencyFramesRemaining_ = 0;
};

static std::string liveInputReadyLine(double sampleRate, uint32_t channel,
                                      const LiveInputAnalysisPlan& plan) {
  const std::string metadata = liveInputAnalysisMetadataFields(plan);
  return jsonLine(
      "{\"version\":1,\"type\":\"ready\",\"state\":\"running\","
      "\"sampleRate\":%.17g,\"channel\":%u,\"frames\":%u,%s}",
      sampleRate, channel, plan.frames, metadata.c_str());
}

static void printLiveInputUsage(FILE* stream) {
  std::fprintf(
      stream,
      "usage: singz-analyze live-input --device-uid <uid> --channel "
      "<zero-based> [--frames <128..8192>] [--latency] "
      "[--duration <seconds>]\n"
      "       The default analysis window is derived after device start to "
      "cover 70 Hz; explicit windows that cannot cover 70 Hz are rejected.\n"
      "       Device audio above 48 kHz uses an anti-aliased 48 kHz analyzer "
      "tap; raw AudioInput blocks stay at the native device rate.\n");
}

static LiveContinuityObservation observeContinuity(
    LiveContinuityState& state, const singz::AudioInputBlockView& block, double sampleRate) {
  LiveContinuityObservation observation;
  observation.expectedSequence = state.expectedSequence;
  observation.sequenceGap = state.haveBlock && block.sequence != state.expectedSequence;
  observation.timestampQualityChanged =
      state.haveBlock && block.timestampQuality != state.timestampQuality;
  if (observation.sequenceGap)
    observation.droppedAttempts = block.sequence > state.expectedSequence
                                      ? block.sequence - state.expectedSequence
                                      : 1;
  // A quality transition deliberately changes the timestamp source. It is an
  // analysis boundary, but comparing its new origin with the previous source
  // would misreport that boundary as a device timing discontinuity.
  if (state.haveBlock && !observation.timestampQualityChanged && sampleRate > 0) {
    const long double expectedHost =
        state.lastHostTime + 1000000000.0L * state.lastFrames / sampleRate;
    // Below one callback duration, so even a missing hardware callback that
    // never attempted a ring push is detected by host time alone.
    const long double tolerance = std::max<long double>(
        2000000.0L, 0.5L * 1000000000.0L * state.lastFrames / sampleRate);
    observation.hostTimeGap = block.sampleHostTimeNs <= state.lastHostTime ||
                              std::fabs(static_cast<long double>(block.sampleHostTimeNs) -
                                        expectedHost) > tolerance;
  }
  state.haveBlock = true;
  state.expectedSequence = block.sequence + 1;
  state.lastHostTime = block.sampleHostTimeNs;
  state.lastFrames = block.frames;
  state.timestampQuality = block.timestampQuality;
  return observation;
}

static bool needsLiveAnalysisReset(const LiveContinuityObservation& observation) {
  return observation.sequenceGap || observation.hostTimeGap ||
         observation.timestampQualityChanged;
}

#if defined(SINGZ_CORE_TESTS)
static int inputDevicesFixtureCommand(int argc) {
  if (argc != 2) return 2;
  singz::AudioInputDevice fixture;
  fixture.uid = "fixture:stable-uid";
  fixture.label = "Fixture interface";
  fixture.isDefault = true;
  fixture.sampleRate = 48000;
  fixture.channels = 24;
  for (uint32_t channel = 1; channel <= fixture.channels; ++channel)
    fixture.channelLabels.push_back("Channel " + std::to_string(channel));
  return printInputDevices({fixture}, {});
}

static int liveInputAnalysisPlanFixture() {
  const struct {
    double rate;
    double analysisRate;
    uint32_t frames;
    uint32_t hop;
    uint32_t latency;
  } cases[] = {{44100, 44100, 2048, 512, 0},
               {48000, 48000, 2048, 512, 0},
               {96000, 48000, 2048, 512, 48},
               {192000, 48000, 2048, 512, 48}};
  std::string error;
  for (const auto& item : cases) {
    LiveInputAnalysisPlan candidate;
    if (!makeLiveInputAnalysisPlan(item.rate, false, 0, candidate, error) ||
        candidate.analysisSampleRate != item.analysisRate ||
        candidate.frames != item.frames || candidate.hopFrames != item.hop ||
        candidate.resamplerLatencyFrames != item.latency)
      return 1;
  }
  LiveInputAnalysisPlan rejected;
  error.clear();
  if (makeLiveInputAnalysisPlan(48000, true, 1024, rejected, error) ||
      error.find("too short") == std::string::npos)
    return 1;
  LiveInputAnalysisPlan plan;
  error.clear();
  if (!makeLiveInputAnalysisPlan(48000, false, 0, plan, error)) return 1;
  LiveInputAnalysisPlan resetPlan;
  if (!makeLiveInputAnalysisPlan(192000, false, 0, resetPlan, error)) return 1;
  LiveInputAnalysisStream resetStream(resetPlan);
  std::vector<float> resetInput(512, 0.25f), beforeReset, afterReset;
  resetStream.append(resetInput.data(), 512, beforeReset);
  resetStream.reset();
  resetStream.append(resetInput.data(), 512, afterReset);
  if (beforeReset != afterReset) return 1;
  const std::string metadata = liveInputAnalysisMetadataFields(plan);
  std::printf("%s\n", liveInputReadyLine(48000, 2, plan).c_str());
  std::printf(
      "{\"version\":1,\"type\":\"latency\",\"samples\":500,%s}\n",
      metadata.c_str());
  std::printf(
      "{\"version\":1,\"type\":\"analysis-plan-fixture\","
      "\"rates\":[44100,48000,96000,192000],"
      "\"plans\":[{\"deviceSampleRate\":44100,\"analysisSampleRate\":44100,"
      "\"frames\":2048,\"hop\":512},{\"deviceSampleRate\":48000,"
      "\"analysisSampleRate\":48000,\"frames\":2048,\"hop\":512},"
      "{\"deviceSampleRate\":96000,\"analysisSampleRate\":48000,"
      "\"frames\":2048,\"hop\":512,\"resamplerLatencyFrames\":48},"
      "{\"deviceSampleRate\":192000,\"analysisSampleRate\":48000,"
      "\"frames\":2048,\"hop\":512,\"resamplerLatencyFrames\":48}],"
      "\"explicitShortRejected\":true}\n");
  return 0;
}

static int liveInputAnalysisThroughputFixture() {
  constexpr double toneHz = 82.4068892282175;
  constexpr double seconds = 0.5;
  const int rates[] = {44100, 48000, 96000, 192000};
  std::printf("{\"version\":1,\"type\":\"analysis-throughput-fixture\","
              "\"rates\":[");
  for (size_t rateIndex = 0; rateIndex < std::size(rates); ++rateIndex) {
    const int rate = rates[rateIndex];
    LiveInputAnalysisPlan plan;
    std::string error;
    if (!makeLiveInputAnalysisPlan(rate, false, 0, plan, error) ||
        plan.analysisSampleRate > 48000 || plan.frames > 2048 ||
        plan.hopFrames < 512)
      return 1;
    LiveInputAnalysisStream stream(plan);
    std::vector<float> pending;
    pending.reserve(plan.frames + 16384u);
    std::vector<float> block(512);
    size_t analyses = 0;
    bool finite = true;
    const int totalFrames = static_cast<int>(rate * seconds);
    const auto began = std::chrono::steady_clock::now();
    for (int offset = 0; offset < totalFrames; offset += 512) {
      const int count = std::min(512, totalFrames - offset);
      for (int i = 0; i < count; ++i)
        block[static_cast<size_t>(i)] = static_cast<float>(
            0.5 * std::sin(2.0 * M_PI * toneHz * (offset + i) / rate));
      stream.append(block.data(), static_cast<uint32_t>(count), pending);
      while (pending.size() >= plan.frames) {
        const singz::LiveInputFrame frame = singz::analyzeLiveInput(
            pending.data(), plan.frames, plan.analysisSampleRate,
            plan.minFrequencyHz);
        finite = finite && std::isfinite(frame.frequency) &&
                 std::isfinite(frame.clarity) && std::isfinite(frame.rms) &&
                 std::isfinite(frame.dbfs);
        pending.erase(pending.begin(), pending.begin() + plan.hopFrames);
        ++analyses;
      }
    }
    const double elapsedMs = std::chrono::duration<double, std::milli>(
                                 std::chrono::steady_clock::now() - began)
                                 .count();
    if (!finite || analyses < 20 || elapsedMs > 10000) return 1;
    std::printf(
        "%s{\"deviceSampleRate\":%d,\"analysisSampleRate\":%.17g,"
        "\"frames\":%u,\"hop\":%u,\"analyses\":%zu,"
        "\"elapsedMs\":%.9g}",
        rateIndex ? "," : "", rate, plan.analysisSampleRate, plan.frames,
        plan.hopFrames, analyses, elapsedMs);
  }
  std::printf("],\"budgetFramesMax\":2048,\"budgetAnalysisRateMax\":48000}\n");
  return 0;
}

#if defined(__APPLE__) || defined(_WIN32)
static int ndjsonWriterFailureFixture(bool closedPipe) {
#if defined(__APPLE__)
  int descriptors[2] = {-1, -1};
  if (pipe(descriptors) != 0) return 2;
  if (closedPipe) {
    close(descriptors[0]);
    descriptors[0] = -1;
  } else {
    const int flags = fcntl(descriptors[1], F_GETFL, 0);
    if (flags < 0 || fcntl(descriptors[1], F_SETFL, flags | O_NONBLOCK) < 0) return 2;
    const std::string fill(4096, 'x');
    while (write(descriptors[1], fill.data(), fill.size()) > 0) {}
    if (errno != EAGAIN && errno != EWOULDBLOCK) return 2;
  }
  if (dup2(descriptors[1], STDOUT_FILENO) < 0) return 2;
  close(descriptors[1]);
  NdjsonWriter writer;
  const auto began = std::chrono::steady_clock::now();
  writer.close({"{\"version\":1,\"type\":\"fixture\"}"});
  const auto elapsed = std::chrono::steady_clock::now() - began;
  if (descriptors[0] >= 0) close(descriptors[0]);
#else
  HANDLE readPipe = nullptr, writePipe = nullptr;
  if (!CreatePipe(&readPipe, &writePipe, nullptr, 4096)) return 2;
  DWORD mode = PIPE_NOWAIT;
  if (!SetNamedPipeHandleState(writePipe, &mode, nullptr, nullptr)) {
    CloseHandle(readPipe);
    CloseHandle(writePipe);
    return 2;
  }
  const HANDLE originalOutput = GetStdHandle(STD_OUTPUT_HANDLE);
  if (!SetStdHandle(STD_OUTPUT_HANDLE, writePipe)) {
    CloseHandle(readPipe);
    CloseHandle(writePipe);
    return 2;
  }
  if (closedPipe) {
    CloseHandle(readPipe);
    readPipe = nullptr;
  } else {
    const char fill[4096] = {};
    DWORD written = 0;
    SetLastError(ERROR_SUCCESS);
    while (WriteFile(writePipe, fill, sizeof(fill), &written, nullptr) && written > 0) {}
    const DWORD fillError = written == 0 ? ERROR_NO_DATA : GetLastError();
    if (fillError != ERROR_NO_DATA && fillError != ERROR_PIPE_BUSY) {
      SetStdHandle(STD_OUTPUT_HANDLE, originalOutput);
      CloseHandle(readPipe);
      CloseHandle(writePipe);
      return 2;
    }
  }
  NdjsonWriter writer;
  const auto began = std::chrono::steady_clock::now();
  writer.close({"{\"version\":1,\"type\":\"fixture\"}"});
  const auto elapsed = std::chrono::steady_clock::now() - began;
  SetStdHandle(STD_OUTPUT_HANDLE, originalOutput);
  if (readPipe) CloseHandle(readPipe);
  CloseHandle(writePipe);
#endif
  const int expected = closedPipe ? 1 : 2;
  const bool matchedFailure =
      (expected == 1 && std::strstr(writer.failureMessage(), "closed")) ||
      (expected == 2 && std::strstr(writer.failureMessage(), "slow"))
#if defined(_WIN32)
      // A closed anonymous pipe in PIPE_NOWAIT mode may report zero-byte
      // progress rather than ERROR_BROKEN_PIPE. It is still bounded by the
      // same deadline; accept the resulting slow-consumer classification.
      || (closedPipe && std::strstr(writer.failureMessage(), "slow"))
#endif
      ;
  return writer.stopRequested() &&
                 std::chrono::duration_cast<std::chrono::milliseconds>(elapsed).count() < 1500 &&
                 matchedFailure
             ? 0
             : 1;
}
#endif

static int liveInputDiscontinuityFixture() {
  LiveContinuityState state;
  float fixtureSamples[128] = {};
  singz::AudioInputBlockView first;
  first.sequence = 0;
  first.sampleHostTimeNs = 1000000000;
  first.mono = fixtureSamples;
  first.frames = 128;
  singz::AudioInputBlockView afterGap = first;
  afterGap.sequence = 2;
  afterGap.sampleHostTimeNs += 2 * 2666667;
  (void)observeContinuity(state, first, 48000);
  const LiveContinuityObservation gap = observeContinuity(state, afterGap, 48000);
  std::vector<float> pending(64, 1);
  if (gap.sequenceGap || gap.hostTimeGap) pending.clear();
  if (!gap.sequenceGap || !gap.hostTimeGap || !pending.empty()) return 1;
  std::printf("{\"version\":1,\"type\":\"overrun\",\"count\":%llu}\n",
              static_cast<unsigned long long>(gap.droppedAttempts));
  std::printf("{\"version\":1,\"type\":\"discontinuity\","
              "\"sequenceGap\":true,\"hostTimeGap\":true,\"pendingReset\":true}\n");
  return 0;
}

static int liveInputTimestampProvenanceFixture() {
  LiveInputAnalysisPlan plan;
  std::string error;
  if (!makeLiveInputAnalysisPlan(48000, false, 0, plan, error)) return 1;
  LiveInputAnalysisStream stream(plan);
  LiveContinuityState continuity;
  std::vector<float> samples(plan.frames, 0.0f);
  std::vector<float> pending;
  uint64_t pendingHostTime = 0;
  struct EmittedWindow {
    uint64_t hostTimeNs;
    singz::AudioInputTimestampQuality quality;
  };
  std::vector<EmittedWindow> emitted;

  const auto consume = [&](const singz::AudioInputBlockView& block) {
    const LiveContinuityObservation observation =
        observeContinuity(continuity, block, plan.deviceSampleRate);
    if (needsLiveAnalysisReset(observation)) {
      pending.clear();
      pendingHostTime = 0;
      stream.reset();
    }
    const bool pendingWasEmpty = pending.empty();
    const size_t appended = stream.append(block.mono, block.frames, pending);
    if (pendingWasEmpty && appended > 0) pendingHostTime = block.sampleHostTimeNs;
    while (pending.size() >= plan.frames) {
      emitted.push_back({pendingHostTime, block.timestampQuality});
      pending.erase(pending.begin(), pending.begin() + plan.hopFrames);
      pendingHostTime += static_cast<uint64_t>(
          1000000000.0 * plan.hopFrames / plan.analysisSampleRate);
    }
    return observation;
  };

  singz::AudioInputBlockView estimate;
  estimate.sequence = 0;
  estimate.sampleHostTimeNs = 1000000000ull;
  estimate.timestampQuality = singz::AudioInputTimestampQuality::CallbackEstimate;
  estimate.sampleRate = 48000;
  estimate.mono = samples.data();
  estimate.frames = 960;
  (void)consume(estimate);
  estimate.sequence = 1;
  estimate.sampleHostTimeNs = 1020000000ull;
  (void)consume(estimate);
  if (pending.size() != 1920 || !emitted.empty()) return 1;

  singz::AudioInputBlockView hardware = estimate;
  hardware.sequence = 2;
  // Expected continuation is 1.040 s. The 1 ms shift is inside the old
  // 10 ms host-gap tolerance, proving provenance—not gap detection—resets.
  hardware.sampleHostTimeNs = 1041000000ull;
  hardware.timestampQuality = singz::AudioInputTimestampQuality::Hardware;
  hardware.frames = plan.frames;
  const LiveContinuityObservation toHardware = consume(hardware);

  singz::AudioInputBlockView fallback = hardware;
  fallback.sequence = 3;
  fallback.sampleHostTimeNs = 1084666667ull;
  fallback.timestampQuality = singz::AudioInputTimestampQuality::CallbackEstimate;
  const LiveContinuityObservation toEstimate = consume(fallback);

  const bool valid = toHardware.timestampQualityChanged &&
      !toHardware.sequenceGap && !toHardware.hostTimeGap &&
      toEstimate.timestampQualityChanged &&
      !toEstimate.sequenceGap && !toEstimate.hostTimeGap &&
      emitted.size() == 2 &&
      emitted[0].hostTimeNs == hardware.sampleHostTimeNs &&
      emitted[0].quality == singz::AudioInputTimestampQuality::Hardware &&
      emitted[1].hostTimeNs == fallback.sampleHostTimeNs &&
      emitted[1].quality == singz::AudioInputTimestampQuality::CallbackEstimate;
  if (!valid) return 1;
  std::printf(
      "{\"version\":1,\"type\":\"timestamp-provenance\","
      "\"estimateToHardwareReset\":true,\"hardwareWindowHostTimeNs\":%llu,"
      "\"hardwareToEstimateReset\":true,\"estimateWindowHostTimeNs\":%llu,"
      "\"sequenceDiscontinuities\":0,\"hostDiscontinuities\":0}\n",
      static_cast<unsigned long long>(emitted[0].hostTimeNs),
      static_cast<unsigned long long>(emitted[1].hostTimeNs));
  return 0;
}
#endif

static int liveInputCommand(int argc, char** argv) {
  singz::AudioInputConfig config;
  uint32_t requestedAnalysisFrames = 0;
  LiveInputAnalysisPlan analysisPlan;
  bool haveUid = false, haveChannel = false;
  bool haveAnalysisFrames = false;
  bool measureLatency = false;
  double durationSeconds = 0;
  for (int i = 2; i < argc; ++i) {
    const std::string argument = argv[i];
    if (argument == "--help") {
      printLiveInputUsage(stdout);
      return 0;
    }
    if ((argument == "--device-uid" || argument == "--channel" ||
         argument == "--frames" || argument == "--duration") &&
        i + 1 >= argc) {
      std::fprintf(stderr, "live-input: %s needs a value\n", argument.c_str());
      return 2;
    }
    if (argument == "--device-uid") {
      config.deviceUid = argv[++i];
      haveUid = true;
    } else if (argument == "--channel") {
      if (!unsignedArgument(argv[++i], config.channel)) {
        std::fprintf(stderr, "live-input: --channel wants a zero-based integer\n");
        return 2;
      }
      haveChannel = true;
    } else if (argument == "--frames") {
      if (!unsignedArgument(argv[++i], requestedAnalysisFrames) ||
          requestedAnalysisFrames < 128 ||
          requestedAnalysisFrames > kMaxLiveInputAnalysisFrames) {
        std::fprintf(stderr, "live-input: --frames must be between 128 and 8192\n");
        return 2;
      }
      haveAnalysisFrames = true;
    } else if (argument == "--latency") {
      measureLatency = true;
    } else if (argument == "--duration") {
      char* end = nullptr;
      durationSeconds = std::strtod(argv[++i], &end);
      if (!end || *end || !std::isfinite(durationSeconds) ||
          durationSeconds <= 0 || durationSeconds > 3600) {
        std::fprintf(stderr,
                     "live-input: --duration must be between 0 and 3600 seconds\n");
        return 2;
      }
    } else {
      std::fprintf(stderr, "live-input: unknown argument %s\n", argument.c_str());
      return 2;
    }
  }
  if (!haveUid || !haveChannel || config.deviceUid.empty()) {
    std::fprintf(stderr, "live-input: --device-uid and --channel are required\n");
    return 2;
  }

#if !defined(__APPLE__) && !defined(_WIN32)
  std::fprintf(stderr, "live-input: audio input is unsupported on this platform\n");
  return 3;
#endif

  liveInputStop = 0;
  std::signal(SIGINT, stopLiveInput);
  std::signal(SIGTERM, stopLiveInput);
  NdjsonWriter writer;
  std::atomic<bool> ready{false};
  std::vector<float> pending;
  std::unique_ptr<LiveInputAnalysisStream> analysisStream;
  uint64_t pendingHostTime = 0;
  uint64_t frameSequence = 0;
  double activeRate = 0;
  LiveContinuityState continuity;
  std::vector<double> callbackToSinkMs;
  std::vector<double> sampleHostToSinkMs;
  std::vector<uint32_t> callbackFrames;
#if defined(__APPLE__) || defined(_WIN32)
  if (measureLatency) (void)monotonicHostTimeNs();  // initialize off delivery
#endif

  singz::AudioInput input;
  const singz::AudioInputResult started = input.start(
      config, [&](const singz::AudioInputBlockView& block) {
        if (!ready.load(std::memory_order_acquire)) return;
#if defined(__APPLE__) || defined(_WIN32)
        if (measureLatency) {
          const uint64_t deliveredAt = monotonicHostTimeNs();
          if (block.callbackHostTimeNs && deliveredAt >= block.callbackHostTimeNs)
            callbackToSinkMs.push_back(
                (deliveredAt - block.callbackHostTimeNs) / 1000000.0);
          if (block.sampleHostTimeNs && deliveredAt >= block.sampleHostTimeNs)
            sampleHostToSinkMs.push_back(
                (deliveredAt - block.sampleHostTimeNs) / 1000000.0);
          callbackFrames.push_back(block.frames);
        }
#endif
        const LiveContinuityObservation observed =
            observeContinuity(continuity, block, activeRate);
        const bool sequenceGap = observed.sequenceGap;
        const bool hostGap = observed.hostTimeGap;
        const bool discontinuity = sequenceGap || hostGap;
        if (needsLiveAnalysisReset(observed)) {
          pending.clear();
          pendingHostTime = 0;
          if (analysisStream) analysisStream->reset();
        }
        if (discontinuity) {
          if (sequenceGap) {
            writer.enqueue(jsonLine(
                "{\"version\":1,\"type\":\"overrun\",\"count\":%llu,"
                "\"expectedSequence\":%llu,\"actualSequence\":%llu}",
                static_cast<unsigned long long>(observed.droppedAttempts),
                static_cast<unsigned long long>(observed.expectedSequence),
                static_cast<unsigned long long>(block.sequence)));
          }
          writer.enqueue(jsonLine(
              "{\"version\":1,\"type\":\"discontinuity\",\"sequenceGap\":%s,"
              "\"hostTimeGap\":%s,\"sequence\":%llu,\"hostTimeNs\":%llu}",
              sequenceGap ? "true" : "false", hostGap ? "true" : "false",
              static_cast<unsigned long long>(block.sequence),
              static_cast<unsigned long long>(block.sampleHostTimeNs)));
        }
        if (writer.stopRequested()) return;
        const bool pendingWasEmpty = pending.empty();
        const size_t appended =
            analysisStream ? analysisStream->append(block.mono, block.frames, pending) : 0;
        if (pendingWasEmpty && appended > 0)
          pendingHostTime = block.sampleHostTimeNs;
        while (pending.size() >= analysisPlan.frames) {
          const singz::LiveInputFrame analysis = singz::analyzeLiveInput(
              pending.data(), analysisPlan.frames,
              analysisPlan.analysisSampleRate,
              analysisPlan.minFrequencyHz);
          const double frequency = std::isfinite(analysis.frequency) ? analysis.frequency : 0;
          const double clarity = std::isfinite(analysis.clarity) ? analysis.clarity : 0;
          const double rms = std::isfinite(analysis.rms) ? analysis.rms : 0;
          const double dbfs = std::isfinite(analysis.dbfs) ? analysis.dbfs : -120;
          if (!writer.enqueue(jsonLine(
                  "{\"version\":1,\"type\":\"frame\",\"sequence\":%llu,"
                  "\"hostTimeNs\":%llu,\"frequency\":%.9g,\"clarity\":%.9g,"
                  "\"rms\":%.9g,\"dbfs\":%.9g}",
                  static_cast<unsigned long long>(frameSequence++),
                  static_cast<unsigned long long>(pendingHostTime), frequency,
                  clarity, rms, dbfs)))
            return;
          pending.erase(pending.begin(),
                        pending.begin() + analysisPlan.hopFrames);
          pendingHostTime += static_cast<uint64_t>(
              1000000000.0 * analysisPlan.hopFrames /
              analysisPlan.analysisSampleRate);
        }
      });
  if (!started.ok) {
    std::fprintf(stderr, "live-input: %s\n", started.error.c_str());
    const std::string errorLine = jsonLine(
        "{\"version\":1,\"type\":\"error\",\"state\":%s,\"message\":%s}",
        jsonString(singz::audioInputStateName(started.state)).c_str(),
        jsonString(started.error).c_str());
    writer.close({errorLine});
    return started.state == singz::AudioInputState::Unsupported ? 3 : 1;
  }
  activeRate = started.sampleRate;
  std::string planError;
  if (!makeLiveInputAnalysisPlan(activeRate, haveAnalysisFrames,
                                 requestedAnalysisFrames, analysisPlan,
                                 planError)) {
    ready.store(false, std::memory_order_release);
    input.stop();
    std::fprintf(stderr, "%s\n", planError.c_str());
    writer.close({jsonLine(
        "{\"version\":1,\"type\":\"error\",\"state\":\"stopped\","
        "\"message\":%s}",
        jsonString(planError).c_str())});
    return 2;
  }
  pending.reserve(analysisPlan.frames + 16384u);
  analysisStream = std::make_unique<LiveInputAnalysisStream>(analysisPlan);
  if (!writer.enqueue(liveInputReadyLine(activeRate, started.channel,
                                         analysisPlan))) {
    ready.store(false, std::memory_order_release);
    input.stop();
    writer.close();
    return 1;
  }
  ready.store(true, std::memory_order_release);

  uint64_t reportedOverruns = 0;
  std::string runtimeError;
  const auto stopAt = durationSeconds > 0
                          ? std::chrono::steady_clock::now() +
                                std::chrono::duration<double>(durationSeconds)
                          : std::chrono::steady_clock::time_point::max();
  while (!liveInputStop && !writer.stopRequested()) {
#if defined(__APPLE__)
    pollfd descriptor{STDIN_FILENO, POLLIN | POLLHUP, 0};
    const int polled = poll(&descriptor, 1, 100);
    if (polled > 0 && (descriptor.revents & (POLLIN | POLLHUP | POLLERR | POLLNVAL))) {
      char byte = 0;
      if (descriptor.revents & POLLNVAL || read(STDIN_FILENO, &byte, 1) <= 0 ||
          descriptor.revents & (POLLHUP | POLLERR))
        liveInputStop = 1;
      else
        liveInputStop = 1;
    }
#else
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
#endif
    if (std::chrono::steady_clock::now() >= stopAt) liveInputStop = 1;
    const uint64_t overruns = input.stats().overruns;
    if (overruns != reportedOverruns) {
      writer.enqueue(jsonLine(
          "{\"version\":1,\"type\":\"overrun\",\"count\":%llu,\"cumulative\":true}",
          static_cast<unsigned long long>(overruns)));
      reportedOverruns = overruns;
    }
    if (input.state() == singz::AudioInputState::Error) {
      runtimeError = input.lastError();
      break;
    }
  }
  ready.store(false, std::memory_order_release);
  input.stop();
  const singz::AudioInputStats stats = input.stats();
  std::vector<std::string> terminalLines;
  if (!runtimeError.empty()) {
    terminalLines.push_back(jsonLine(
        "{\"version\":1,\"type\":\"error\",\"state\":\"error\",\"message\":%s}",
        jsonString(runtimeError).c_str()));
  }
  if (measureLatency && !callbackToSinkMs.empty() && !callbackFrames.empty()) {
    const auto percentile = [](std::vector<double> values, double p) {
      std::sort(values.begin(), values.end());
      return values[static_cast<size_t>(
          std::floor((values.size() - 1) * p))];
    };
    const uint32_t minCallbackFrames =
        *std::min_element(callbackFrames.begin(), callbackFrames.end());
    const uint32_t maxCallbackFrames =
        *std::max_element(callbackFrames.begin(), callbackFrames.end());
    const double callbackP95 = percentile(callbackToSinkMs, 0.95);
    const bool accepted = callbackToSinkMs.size() >= 500 && callbackP95 <= 3.0;
    std::string sampleHostSummary = "null";
    if (!sampleHostToSinkMs.empty()) {
      sampleHostSummary = jsonLine(
          "{\"p50\":%.9g,\"p95\":%.9g,\"p99\":%.9g,\"max\":%.9g}",
          percentile(sampleHostToSinkMs, 0.50),
          percentile(sampleHostToSinkMs, 0.95),
          percentile(sampleHostToSinkMs, 0.99),
          *std::max_element(sampleHostToSinkMs.begin(), sampleHostToSinkMs.end()));
    }
    const std::string analysisMetadata =
        liveInputAnalysisMetadataFields(analysisPlan);
    terminalLines.push_back(jsonLine(
        "{\"version\":1,\"type\":\"latency\",\"samples\":%zu,"
        "\"minimumSamples\":500,"
        "\"callbackFramesMin\":%u,\"callbackFramesMax\":%u,"
        "\"blockDurationMs\":%.9g,\"callbackToSinkMs\":{"
        "\"first\":%.9g,\"p50\":%.9g,\"p95\":%.9g,\"p99\":%.9g,"
        "\"max\":%.9g,\"acceptanceP95Ms\":3,\"accepted\":%s},"
        "\"sampleHostToSinkMs\":%s,%s}",
        callbackToSinkMs.size(), minCallbackFrames, maxCallbackFrames,
        1000.0 * minCallbackFrames / activeRate,
        callbackToSinkMs.front(),
        percentile(callbackToSinkMs, 0.50), callbackP95,
        percentile(callbackToSinkMs, 0.99),
        *std::max_element(callbackToSinkMs.begin(), callbackToSinkMs.end()),
        accepted ? "true" : "false", sampleHostSummary.c_str(),
        analysisMetadata.c_str()));
  }
  terminalLines.push_back(jsonLine(
      "{\"version\":1,\"type\":\"ended\",\"state\":\"stopped\","
      "\"deliveredBlocks\":%llu,\"deliveredFrames\":%llu,\"overruns\":%llu}",
      static_cast<unsigned long long>(stats.deliveredBlocks),
      static_cast<unsigned long long>(stats.deliveredFrames),
      static_cast<unsigned long long>(stats.overruns)));
  writer.close(std::move(terminalLines));
  if (writer.stopRequested()) std::fprintf(stderr, "%s\n", writer.failureMessage());
  return runtimeError.empty() && !writer.stopRequested() ? 0 : 1;
}

int main(int argc, char** argv) {
  if (argc < 2) {
    printLiveInputUsage(stderr);
    std::fprintf(stderr,
                 "       singz-analyze melody --f32 <path> --sr <rate> [--raw]\n");
    return 2;
  }
  const std::string cmd = argv[1];
  if (cmd == "input-devices") return inputDevicesCommand(argc);
#if defined(SINGZ_CORE_TESTS)
  if (cmd == "input-devices-fixture") return inputDevicesFixtureCommand(argc);
  if (cmd == "live-input-analysis-plan-fixture" && argc == 2)
    return liveInputAnalysisPlanFixture();
  if (cmd == "live-input-analysis-throughput-fixture" && argc == 2)
    return liveInputAnalysisThroughputFixture();
#if defined(__APPLE__) || defined(_WIN32)
  if (cmd == "ndjson-writer-closed-fixture" && argc == 2)
    return ndjsonWriterFailureFixture(true);
  if (cmd == "ndjson-writer-blocked-fixture" && argc == 2)
    return ndjsonWriterFailureFixture(false);
#endif
  if (cmd == "live-input-discontinuity-fixture" && argc == 2)
    return liveInputDiscontinuityFixture();
  if (cmd == "live-input-timestamp-provenance-fixture" && argc == 2)
    return liveInputTimestampProvenanceFixture();
#endif
  if (cmd == "live-input") return liveInputCommand(argc, argv);
  std::string f32, wav;
  double sr = 44100;
  bool raw = false;
  for (int i = 2; i < argc; i++) {
    if (std::strcmp(argv[i], "--f32") == 0 && i + 1 < argc) f32 = argv[++i];
    else if (std::strcmp(argv[i], "--wav") == 0 && i + 1 < argc) wav = argv[++i];
    else if (std::strcmp(argv[i], "--sr") == 0 && i + 1 < argc) sr = std::atof(argv[++i]);
    else if (std::strcmp(argv[i], "--raw") == 0) raw = true;
  }
  if (cmd == "analyze") {
    // The whole analysis in ONE child — melody, key and beats, each opt-in:
    //   singz-analyze analyze [--melody [--raw]] [--key] [--beats]
    //     [--vocals v] [--drums d] [--bass b] [--inst a]...
    //     [--line t]... [--word s:e]... [--ml file | --ml-stdin]
    // Every stem file is read ONCE and shared by every detector that wants
    // it. --ml-stdin is the desktop's lattice hand-off: melody and key run
    // while the caller's own model is still working, and the beats stage
    // blocks on stdin only when it is actually reached — the caller writes
    // the token-format grid (or closes stdin empty on a packless machine)
    // whenever its render finishes. Output is one JSON object with a
    // sub-object per requested part, production fields only; the staged
    // debug stays with the plain `beats` subcommand, which the parity
    // harness drives.
    bool wantMelody = false, wantKey = false, wantBeats = false, raw = false, mlStdin = false;
    std::string drumsPath, bassPath, vocalsPath, mlPath;
    std::vector<std::string> instPaths;
    std::vector<double> lineStarts;
    std::vector<std::pair<double, double>> words;
    for (int i = 2; i < argc; i++) {
      const std::string a = argv[i];
      const auto pathArg = [&](std::string& into) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "analyze: %s needs a value\n", a.c_str());
          std::exit(2);
        }
        into = argv[++i];
      };
      if (a == "--melody") wantMelody = true;
      else if (a == "--key") wantKey = true;
      else if (a == "--beats") wantBeats = true;
      else if (a == "--raw") raw = true;
      else if (a == "--ml-stdin") mlStdin = true;
      else if (a == "--drums") pathArg(drumsPath);
      else if (a == "--bass") pathArg(bassPath);
      else if (a == "--vocals") pathArg(vocalsPath);
      else if (a == "--ml") pathArg(mlPath);
      else if (a == "--inst") {
        std::string p2;
        pathArg(p2);
        instPaths.push_back(p2);
      } else if (a == "--line") {
        // strtod with a full-token check, like `beats` — atof's silent 0.0
        // is the trap that subcommand's comment already documents
        std::string v;
        pathArg(v);
        char* end = nullptr;
        const double t = std::strtod(v.c_str(), &end);
        if (end != v.c_str() + v.size() || !std::isfinite(t)) {
          std::fprintf(stderr, "analyze: --line wants a number, got %s\n", v.c_str());
          return 2;
        }
        lineStarts.push_back(t);
      } else if (a == "--word") {
        std::string w;
        pathArg(w);
        const size_t colon = w.find(':');
        char* e1 = nullptr;
        char* e2 = nullptr;
        const double ws = colon == std::string::npos ? 0 : std::strtod(w.c_str(), &e1);
        const double we = colon == std::string::npos ? 0 : std::strtod(w.c_str() + colon + 1, &e2);
        if (colon == std::string::npos || e1 != w.c_str() + colon || *e2 != '\0' ||
            !std::isfinite(ws) || !std::isfinite(we)) {
          std::fprintf(stderr, "analyze: --word wants <start>:<end>, got %s\n", w.c_str());
          return 2;
        }
        words.push_back({ws, we});
      } else {
        std::fprintf(stderr, "analyze: unknown argument %s\n", a.c_str());
        return 2;
      }
    }
    if (!wantMelody && !wantKey && !wantBeats) {
      std::fprintf(stderr, "analyze: nothing requested (--melody/--key/--beats)\n");
      return 2;
    }
    if (wantMelody && vocalsPath.empty()) {
      std::fprintf(stderr, "analyze: --melody needs --vocals\n");
      return 2;
    }
    if (wantBeats && drumsPath.empty()) {
      std::fprintf(stderr, "analyze: --beats needs --drums\n");
      return 2;
    }
    if (wantKey && instPaths.empty() && bassPath.empty()) {
      std::fprintf(stderr, "analyze: --key needs --inst or --bass\n");
      return 2;
    }

    // one read per file, shared by every consumer
    const auto load = [&](const std::string& path, singz::AnalysisStem& into) {
      singz::MonoWav w = singz::readWavMono(path);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
        std::exit(1);
      }
      into.mono = std::move(w.samples);
      into.sampleRate = w.sampleRate;
    };
    singz::AnalysisStem drums, bass, vocals;
    std::vector<singz::AnalysisStem> inst(instPaths.size());
    if (!drumsPath.empty()) load(drumsPath, drums);
    if (!bassPath.empty()) load(bassPath, bass);
    if (!vocalsPath.empty()) load(vocalsPath, vocals);
    for (size_t i = 0; i < instPaths.size(); i++) load(instPaths[i], inst[i]);

    // One JSON line PER PART, flushed as each detector finishes — the
    // caller adopts the melody seconds before the beats stage has even
    // received its lattice. A single end-of-run object would hold the pitch
    // strip hostage to the model render (measured: melody adoption went
    // 0.5 s -> 4.9 s that way).
    if (wantMelody) {
      singz::Progress progress;
      progress.cb = onProgress;
      const singz::MelodyTrack t =
          singz::trackMelody(vocals.mono.data(), vocals.mono.size(), vocals.sampleRate, &progress);
      std::printf("{\"melody\":{\"detVersion\":%d,\"hopSec\":%.17g,\"frames\":%zu,\"f0\":",
                  singz::kPitchDetectVersion, t.hopSec, t.f0.size());
      printFloats(t.f0);
      if (raw) {
        std::printf(",\"raw\":");
        printFloats(t.raw);
        std::printf(",\"rms\":");
        printFloats(t.rms);
      }
      std::printf("}}\n");
      std::fflush(stdout);
    }

    if (wantKey) {
      const singz::KeyGuess k = singz::estimateKeyFromStems(inst, bassPath.empty() ? nullptr : &bass);
      if (!k.ok) std::printf("{\"key\":{\"detVersion\":%d,\"key\":null}}\n", singz::kKeyDetectVersion);
      else
        std::printf("{\"key\":{\"detVersion\":%d,\"key\":{\"pc\":%d,\"minor\":%s}}}\n",
                    singz::kKeyDetectVersion, k.pc, k.minor ? "true" : "false");
      std::fflush(stdout);
    }

    if (wantBeats) {
      // The lattice, from wherever the caller put it — read HERE, not at
      // startup: with --ml-stdin the melody and key above have already run
      // and printed their progress while the caller's model was still busy.
      singz::MlGrid ml;
      bool haveMl = false;
      if (!mlPath.empty()) {
        std::FILE* f = std::fopen(mlPath.c_str(), "rb");
        if (f) {
          std::string text;
          char chunk[65536];
          size_t n;
          while ((n = std::fread(chunk, 1, sizeof chunk, f)) > 0) text.append(chunk, n);
          std::fclose(f);
          haveMl = readMlText(text, ml).empty();
        }
      } else if (mlStdin) {
        std::string text;
        char chunk[65536];
        size_t n;
        while ((n = std::fread(chunk, 1, sizeof chunk, stdin)) > 0) text.append(chunk, n);
        StdinAux late;
        const std::string err = readMlText(text, ml, &late);
        haveMl = err.empty();
        if (!haveMl && err != "empty" && err != "no-grid") {
          std::fprintf(stderr, "analyze: --ml-stdin grid unusable: %s\n", err.c_str());
          return 2;
        }
        // the lyric aux is only KNOWN late — lyrics load while melody and
        // key already run — so it rides stdin beside the lattice and wins
        // over whatever argv carried at spawn
        if (!late.lineStarts.empty()) lineStarts = late.lineStarts;
        if (!late.words.empty()) words = late.words;
      }
      singz::BeatAux aux;
      aux.inst = &inst;
      if (!vocalsPath.empty()) aux.vocals = &vocals;
      if (!bassPath.empty()) aux.bass = &bass;
      aux.lineStarts = lineStarts;
      aux.words = words;
      if (haveMl) aux.ml = &ml;
      singz::BeatDebug d;
      const singz::BeatGrid grid = singz::detectBeats(drums, aux, d);
      std::printf("{\"beats\":{\"detVersion\":%d,\"ok\":%s,", singz::kBeatDetectVersion,
                  grid.ok ? "true" : "false");
      std::printf("\"bpm\":%.17g,\"beatsPerBar\":%d,\"downbeat\":%d,\"hasDownbeats\":%s,", grid.bpm,
                  grid.beatsPerBar, grid.downbeat, grid.hasDownbeats ? "true" : "false");
      std::printf("\"beatsSec\":[");
      for (size_t i = 0; i < grid.beats.size(); i++) std::printf("%s%.17g", i ? "," : "", grid.beats[i]);
      std::printf("],\"downbeats\":[");
      for (size_t i = 0; i < grid.downbeats.size(); i++) std::printf("%s%d", i ? "," : "", grid.downbeats[i]);
      std::printf("],\"suspectAt\":[");
      for (size_t i = 0; i < grid.suspectAt.size(); i++)
        std::printf("%s%.17g", i ? "," : "", grid.suspectAt[i]);
      std::printf("]}}\n");
      std::fflush(stdout);
    }

    return 0;
  }
  if (cmd == "mlmix") {
    // Dev/eval: the Beat This input as the CORE renders it (sumStemsTo22k),
    // raw float32 mono 22.05 kHz — the render-study's core leg, and the
    // reference for any desktop switch off Chromium's render.
    if (argc < 4) {
      std::fprintf(stderr, "usage: singz-analyze mlmix <out.f32> <stem> [<stem>...]\n");
      return 2;
    }
    std::vector<std::string> stems;
    for (int i = 3; i < argc; i++) stems.emplace_back(argv[i]);
    std::string err;
    const std::vector<float> mix = singz::sumStemsTo22k(stems, err);
    if (!err.empty()) {
      std::fprintf(stderr, "mlmix: %s\n", err.c_str());
      return 1;
    }
    FILE* f = std::fopen(argv[2], "wb");
    if (!f) {
      std::fprintf(stderr, "mlmix: cannot write %s\n", argv[2]);
      return 1;
    }
    const size_t wrote = std::fwrite(mix.data(), sizeof(float), mix.size(), f);
    std::fclose(f);
    if (wrote != mix.size()) {
      std::fprintf(stderr, "mlmix: short write\n");
      return 1;
    }
    std::printf("{\"samples\":%zu,\"sr\":22050}\n", mix.size());
    return 0;
  }

  if (cmd == "melody") {
    std::vector<float> mono;
    if (!wav.empty()) {
      singz::MonoWav w = singz::readWavMono(wav);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", wav.c_str(), w.error.c_str());
        return 1;
      }
      mono = std::move(w.samples);
      sr = w.sampleRate;
    } else {
      mono = readF32(f32);
    }
    if (mono.empty()) {
      std::fprintf(stderr, "could not read %s\n", (wav.empty() ? f32 : wav).c_str());
      return 1;
    }
    singz::Progress progress;
    progress.cb = onProgress;
    const singz::MelodyTrack t = singz::trackMelody(mono.data(), mono.size(), sr, &progress);
    std::printf("{\"detVersion\":%d,\"hopSec\":%.17g,\"frames\":%zu,\"f0\":", singz::kPitchDetectVersion, t.hopSec,
                t.f0.size());
    printFloats(t.f0);
    if (raw) {
      std::printf(",\"raw\":");
      printFloats(t.raw);
      std::printf(",\"rms\":");
      printFloats(t.rms);
    }
    std::printf("}\n");
    return 0;
  }
  if (cmd == "key") {
    // The harmonic stems, in the order the caller names them — the TS sums
    // `inst` into one chord layer and asks `bass` for roots.
    std::vector<singz::AnalysisStem> inst;
    singz::AnalysisStem bassStem;
    bool haveBass = false;
    for (int i = 2; i < argc; i++) {
      const bool isInst = std::strcmp(argv[i], "--inst") == 0;
      const bool isBass = std::strcmp(argv[i], "--bass") == 0;
      // Strict, like `beats` and `courts`: a lenient loop here would be the
      // same trap in the subcommand that ALREADY takes --bass.
      if (!(isInst || isBass)) {
        std::fprintf(stderr, "key: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "key: %s needs a path\n", argv[i]);
        return 2;
      }
      const std::string path = argv[++i];
      singz::MonoWav w = singz::readWavMono(path);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
        return 1;
      }
      singz::AnalysisStem st;
      st.mono = std::move(w.samples);
      st.sampleRate = w.sampleRate;
      if (isInst) inst.push_back(std::move(st));
      else {
        bassStem = std::move(st);
        haveBass = true;
      }
    }
    const singz::KeyGuess k = singz::estimateKeyFromStems(inst, haveBass ? &bassStem : nullptr);
    if (!k.ok) {
      std::printf("{\"detVersion\":%d,\"key\":null}\n", singz::kKeyDetectVersion);
      return 0;
    }
    std::printf("{\"detVersion\":%d,\"key\":{\"pc\":%d,\"minor\":%s}}\n", singz::kKeyDetectVersion, k.pc,
                k.minor ? "true" : "false");
    return 0;
  }
  if (cmd == "beats") {
    /**
     * `--ml <file>`: the neural lattice, in a whitespace-token format rather
     * than the runner's JSON — the core has no JSON parser and does not want
     * one here, and this side of the gate must hold the SAME doubles as the
     * TypeScript side, not a re-rounded copy of them.
     *
     *   fps <v>
     *   beats <n> <v> ...          downbeats <n> <v> ...
     *   beatProb <n> <v> ...       downbeatProb <n> <v> ...
     *
     * A section may be omitted; absent is the TS's `undefined`, which is what
     * the detector branches on. The harness writes each value with JS's
     * `String(x)` (shortest round-trip) and this reads it with strtod
     * (correctly rounded), so every value is bit-identical on both sides —
     * the one property a %.17g hop through Foundation would NOT give us.
     */
    const auto readMlFile = [](const std::string& path, singz::MlGrid& g) -> std::string {
      std::FILE* f = std::fopen(path.c_str(), "rb");
      if (!f) return "cannot open " + path;
      std::string text;
      char chunk[65536];
      size_t n;
      while ((n = std::fread(chunk, 1, sizeof chunk, f)) > 0) text.append(chunk, n);
      std::fclose(f);
      return readMlText(text, g);
    };
    // The tracker's staged debug, named exactly as analysis.ts's own `debug`
    // object names each field — the harness compares stage by stage, so a
    // divergence points at the stage that caused it, not just the song.
    singz::AnalysisStem drums;
    singz::AnalysisStem vocals;
    singz::AnalysisStem bass;
    std::vector<singz::AnalysisStem> inst;
    std::vector<double> lineStarts;
    std::vector<std::pair<double, double>> words;
    singz::MlGrid ml;
    bool haveDrums = false, haveVocals = false, haveBass = false, haveMl = false;
    for (int i = 2; i < argc; i++) {
      if (std::strcmp(argv[i], "--ml") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "beats: --ml needs a path\n");
          return 2;
        }
        const std::string err = readMlFile(argv[++i], ml);
        if (!err.empty()) {
          std::fprintf(stderr, "beats: --ml %s\n", err.c_str());
          return 2;
        }
        haveMl = true;
        continue;
      }
      if (std::strcmp(argv[i], "--word") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "beats: --word needs <start>:<end>\n");
          return 2;
        }
        const std::string w = argv[++i];
        const size_t colon = w.find(':');
        char* e1 = nullptr;
        char* e2 = nullptr;
        const double a = colon == std::string::npos ? 0 : std::strtod(w.c_str(), &e1);
        const double b = colon == std::string::npos ? 0 : std::strtod(w.c_str() + colon + 1, &e2);
        if (colon == std::string::npos || e1 != w.c_str() + colon || *e2 != '\0' ||
            !std::isfinite(a) || !std::isfinite(b)) {
          std::fprintf(stderr, "beats: --word wants <start>:<end>, got %s\n", w.c_str());
          return 2;
        }
        words.push_back({a, b});
        continue;
      }
      if (std::strcmp(argv[i], "--line") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "beats: --line needs a value\n");
          return 2;
        }
        // strtod, not atof: atof returns 0.0 for anything unparseable, so a
        // typo'd or shell-mangled time silently became a line start at t=0 —
        // the same silent-argument hazard the unknown-flag check above exists
        // to remove, one line below it.
        const char* raw = argv[++i];
        char* end = nullptr;
        const double v = std::strtod(raw, &end);
        if (end == raw || *end != '\0' || !std::isfinite(v)) {
          std::fprintf(stderr, "beats: --line wants a number, got %s\n", raw);
          return 2;
        }
        lineStarts.push_back(v);
        continue;
      }
      const bool isDrums = std::strcmp(argv[i], "--drums") == 0;
      const bool isInst = std::strcmp(argv[i], "--inst") == 0;
      const bool isVocals = std::strcmp(argv[i], "--vocals") == 0;
      const bool isBass = std::strcmp(argv[i], "--bass") == 0;
      // FATAL, not skipped. A flag this loop does not recognise used to fall
      // through in silence, so `--bass x.wav` ran the TypeScript with a bass
      // stem and this side without one — and the vote stages would then
      // diverge in a shape that reads exactly like a bug in the port.
      if (!(isDrums || isInst || isVocals || isBass)) {
        std::fprintf(stderr, "beats: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "beats: %s needs a path\n", argv[i]);
        return 2;
      }
      const std::string path = argv[++i];
      singz::MonoWav w = singz::readWavMono(path);
      if (!w.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
        return 1;
      }
      singz::AnalysisStem st;
      st.mono = std::move(w.samples);
      st.sampleRate = w.sampleRate;
      if (isDrums) {
        drums = std::move(st);
        haveDrums = true;
      } else if (isVocals) {
        vocals = std::move(st);
        haveVocals = true;
      } else if (isBass) {
        bass = std::move(st);
        haveBass = true;
      } else {
        inst.push_back(std::move(st));
      }
    }
    if (!haveDrums) {
      std::fprintf(stderr, "beats needs --drums\n");
      return 2;
    }
    singz::BeatDebug d;
    singz::BeatAux aux;
    aux.inst = &inst;  // the fill stems double as the harmonic layer
    if (haveVocals) aux.vocals = &vocals;
    if (haveBass) aux.bass = &bass;
    aux.lineStarts = lineStarts;
    aux.words = words;
    if (haveMl) {
      ml.ok = true;
      aux.ml = &ml;
    }
    // The whole pipeline, as detectBeats runs it — tracker, vote, head
    // backcast, sanitize — so what is printed below is the grid itself and not
    // an intermediate the harness would have to reassemble.
    const singz::BeatGrid grid = singz::detectBeats(drums, aux, d);
    const bool ok = grid.ok;
    std::printf("{\"detVersion\":%d,\"ok\":%s,\"frames\":%d,\"drumPeaks\":%d,\"peaks\":%d,",
                singz::kBeatDetectVersion, ok ? "true" : "false", d.frames, d.drumPeaks, d.peaks);
    std::printf("\"fluxSum\":%.17g,\"fluxMean\":%.17g,", d.fluxSum, d.fluxMean);
    // The tracker's own stages, each OMITTED when it did not reach that group.
    // Two ways to miss one: the ML fork can return before the tracker entirely
    // (the bare-mix path, the waltz adoption), or the tracker can refuse part
    // way — a song that dies at the flux gate has no tau. The TS just leaves
    // its keys unwritten in both cases, and printing the zero defaults instead
    // would put a measured-looking 0 against that absence, which the harness
    // must read as a divergence and which would be one only in the report.
    if (d.hasTau)
      std::printf("\"windows\":%d,\"tau\":%.17g,\"consistency\":%.17g,", d.windows, d.tau, d.consistency);
    // The octave near-tie window and the model's own ambivalence that widened
    // it. Its own flag because the TS writes the key even for a song with no
    // octave candidate at all.
    if (d.hasOctaveTie)
      std::printf("\"octaveTie\":{\"win\":%.17g,\"mlBimodal\":%.17g},", d.octaveTieWin,
                  d.octaveTieMlBimodal);
    if (d.hasChosen) {
      std::printf("\"chosenBpm\":%.17g,", d.chosenBpm);
      std::printf("\"support\":%.17g,\"activeFrac\":%.17g,\"steadiness\":%.17g,\"rough\":%.17g,", d.support,
                  d.activeFrac, d.steadiness, d.rough);
    }
    if (d.hasLattice) std::printf("\"beats\":%d,\"medSec\":%.17g,", d.beats, d.medSec);
    // beatsPerBar off the GRID, like medSec and beats.length — the debug copy
    // is recorded before the return and the TS side reads the return.
    std::printf("\"beatsPerBar\":%d,\"activeBeats\":%d,\"segments\":%d,\"acAt3\":%.17g,\"acAt4\":%.17g,",
                grid.beatsPerBar, d.activeBeats, d.segments, d.acAt3, d.acAt4);
    // `beatsSec` is the GRID's now, not the tracker's — the backcast can
    // rebuild the head, and that is precisely what wants comparing.
    std::printf("\"gridBeats\":%d,\"beatsSec\":[", static_cast<int>(grid.beats.size()));
    for (size_t i = 0; i < grid.beats.size(); i++) std::printf("%s%.17g", i ? "," : "", grid.beats[i]);
    std::printf("],");
    {
      const char* why = d.headWhy == singz::BeatDebug::HeadWhy::noAnchor ? "no stable anchor"
                        : d.headWhy == singz::BeatDebug::HeadWhy::headOk  ? "head ok"
                        : d.headWhy == singz::BeatDebug::HeadWhy::judged  ? "judged"
                                                                         : "";
      std::printf("\"headWhy\":\"%s\",", why);
      if (d.headWhy == singz::BeatDebug::HeadWhy::headOk)
        std::printf("\"headOk\":{\"anchor\":%d,\"at\":%.17g,\"first\":%.17g},", d.headAnchor, d.headAt,
                    d.headFirst);
      if (d.headWhy == singz::BeatDebug::HeadWhy::judged) {
        std::printf("\"headJudged\":{\"anchor\":%d,\"at\":%.17g,\"unsteady\":%s,\"missing\":%s,\"onsets\":%d,"
                    "\"onsetsTrusted\":%s",
                    d.headAnchor, d.headAt, d.headUnsteady ? "true" : "false", d.headMissing ? "true" : "false",
                    d.headOnsetCount, d.headOnsetsTrusted ? "true" : "false");
        if (d.headHasVerdict)
          std::printf(",\"headTracked\":%s,\"replace\":%s", d.headTracked ? "true" : "false",
                      d.headReplace ? "true" : "false");
        if (d.headWalkEmpty) std::printf(",\"walk\":\"empty\"");
        std::printf("},");
      }
      if (d.hasHeadOnsets) {
        std::printf("\"headOnsets\":{\"per\":%.17g,\"periodic\":%d,\"of\":%d,\"t\":[", d.headOnsetsPer,
                    d.headOnsetsPeriodic, d.headOnsetsOf);
        for (size_t i = 0; i < d.headOnsetsT.size(); i++) std::printf("%s%.17g", i ? "," : "", d.headOnsetsT[i]);
        std::printf("]},");
      }
      if (d.hasHeadBackcast)
        std::printf("\"headBackcast\":{\"replaced\":%d,\"added\":%d,\"snapped\":%d,\"phase\":\"%s\"},",
                    d.headBackcastReplaced, d.headBackcastAdded, d.headBackcastSnapped,
                    d.headBackcastChords ? "chords" : "carried");
      std::printf("\"suspectAt\":[");
      for (size_t i = 0; i < grid.suspectAt.size(); i++) std::printf("%s%.17g", i ? "," : "", grid.suspectAt[i]);
      std::printf("],");
    }
    // hasDownbeats carries the TS's `undefined`-vs-`[]` distinction (see the
    // struct) — the desktop runner adopts this object as the production grid,
    // so the marker has to cross with it.
    std::printf("\"hasDownbeats\":%s,", grid.hasDownbeats ? "true" : "false");
    std::printf("\"bpm\":%.17g,\"downbeat\":%d,\"downbeats\":[", grid.bpm, grid.downbeat);
    for (size_t i = 0; i < grid.downbeats.size(); i++) std::printf("%s%d", i ? "," : "", grid.downbeats[i]);
    std::printf("],\"phaseCuts\":[");
    for (size_t i = 0; i < d.phaseCuts.size(); i++) std::printf("%s%d", i ? "," : "", d.phaseCuts[i]);
    std::printf("],");
    if (d.hasHarmGain)
      std::printf("\"harmGain\":{\"plain\":%.17g,\"cut\":%.17g},", d.harmGainPlain, d.harmGainCut);
    if (d.hasSanitized)
      std::printf("\"sanitized\":{\"before\":%d,\"after\":%d},", d.sanitizedBefore, d.sanitizedAfter);
    std::printf("\"segCues\":[");
    for (size_t i = 0; i < d.segCues.size(); i++)
      {
        std::printf("%s{\"a\":%d,\"b\":%d,\"rot\":%d,\"conf\":%.17g,\"cues\":[", i ? "," : "", d.segCues[i].a,
                    d.segCues[i].b, d.segCues[i].rot, d.segCues[i].conf);
        for (size_t j = 0; j < d.segCues[i].cues.size(); j++) {
          std::printf("%s[", j ? "," : "");
          for (size_t k = 0; k < d.segCues[i].cues[j].size(); k++)
            std::printf("%s%.17g", k ? "," : "", d.segCues[i].cues[j][k]);
          std::printf("]");
        }
        std::printf("]}");
      }
    std::printf("],\"spanOk\":[");
    for (size_t i = 0; i < d.spanOk.size(); i++)
      std::printf("%s{\"a\":%d,\"b\":%d,\"ok\":%s}", i ? "," : "", d.spanOk[i].a, d.spanOk[i].b,
                  d.spanOk[i].ok ? "true" : "false");
    std::printf("],\"voids\":[");
    for (size_t i = 0; i < d.voids.size(); i++)
      std::printf("%s{\"aSec\":%.17g,\"bSec\":%.17g,\"leading\":%s,\"trailing\":%s,\"filled\":%s}", i ? "," : "",
                  d.voids[i].aSec, d.voids[i].bSec, d.voids[i].leading ? "true" : "false",
                  d.voids[i].trailing ? "true" : "false", d.voids[i].filled ? "true" : "false");
    std::printf("],");
    if (d.fillApplied)
      std::printf("\"fill\":{\"alpha\":%.17g,\"dTop\":%.17g,\"iTop\":%.17g,\"instMaxima\":%d,\"gSum\":%.17g},",
                  d.fillAlpha, d.fillDTop, d.fillITop, d.fillInstMaxima, d.fillGSum);
    else if (d.fillSkipped)
      std::printf("\"fill\":{\"skipped\":true,\"instMaxima\":%d},", d.fillInstMaxima);
    else
      std::printf("\"fill\":null,");
    // `null`, not `[]`: `c.octaves?.length` must come out undefined so it
    // compares equal to the TS's unwritten key, and an empty array would
    // report 0 against nothing.
    if (!d.hasOctaves) {
      std::printf("\"octaves\":null,");
    } else {
      std::printf("\"octaves\":[");
      for (size_t i = 0; i < d.octaves.size(); i++) {
        const singz::BeatDebug::Octave& o = d.octaves[i];
        std::printf("%s{\"bpm\":%.17g,\"support\":%.17g,\"steadiness\":%.17g,\"alternation\":%.17g,"
                    "\"rough\":%.17g,\"prior\":%.17g,\"score\":%.17g}",
                    i ? "," : "", o.bpm, o.support, o.steadiness, o.alternation, o.rough, o.prior, o.score);
      }
      std::printf("],");
    }
    // ---- the neural lattice's stages, each written only when the TS writes
    // its key: an absent field and a zeroed one are different evidence, and
    // the harness compares "was it written" before it compares a number.
    std::printf("\"lattice\":");
    if (d.lattice.empty()) std::printf("null,");
    else std::printf("\"%s\",", d.lattice.c_str());
    if (d.hasMlDouble)
      std::printf("\"mlDouble\":{\"bpm0\":%.17g,\"gain\":%.17g,\"multiLevel\":%.17g,\"doubled\":%s},",
                  d.mlDoubleBpm0, d.mlDoubleGain, d.mlDoubleMultiLevel, d.mlDoubleDoubled ? "true" : "false");
    if (d.hasMlLattice)
      std::printf("\"mlLattice\":{\"bpm0\":%.17g,\"doubled\":%s,\"steadyFrac\":%.17g,\"wins\":%d},",
                  d.mlLatticeBpm0, d.mlLatticeDoubled ? "true" : "false", d.mlLatticeSteadyFrac, d.mlLatticeWins);
    if (!d.mlReject.empty()) std::printf("\"mlReject\":\"%s\",", d.mlReject.c_str());
    if (d.hasMlNormalized)
      std::printf("\"mlNormalized\":{\"from\":%d,\"to\":%d,\"medSec\":%.17g},", d.mlNormalizedFrom,
                  d.mlNormalizedTo, d.mlNormalizedMedSec);
    if (d.hasMlView)
      std::printf("\"mlView\":{\"ratio\":%.17g,\"scoreA\":%d,\"scoreB\":%d,\"picked\":%d},", d.mlViewRatio,
                  d.mlViewScoreA, d.mlViewScoreB, d.mlViewPicked);
    if (!d.mlSplice.empty()) {
      std::printf("\"mlSplice\":[");
      for (size_t i = 0; i < d.mlSplice.size(); i++) {
        const singz::BeatDebug::MlSplice& r = d.mlSplice[i];
        std::printf("%s{\"aSec\":%.17g,\"bSec\":%.17g,\"removed\":%d,\"added\":%d,\"why\":\"%s\"", i ? "," : "",
                    r.aSec, r.bSec, r.removed, r.added, r.why.c_str());
        if (r.hasCarry) std::printf(",\"ca\":%d,\"cb\":%d", r.ca, r.cb);
        std::printf("}");
      }
      std::printf("],");
    }
    if (!d.mlSeams.empty()) {
      std::printf("\"mlSeams\":[");
      for (size_t i = 0; i < d.mlSeams.size(); i++) std::printf("%s%d", i ? "," : "", d.mlSeams[i]);
      std::printf("],");
    }
    if (!d.spanPhase.empty()) {
      std::printf("\"spanPhase\":[");
      for (size_t i = 0; i < d.spanPhase.size(); i++) {
        const singz::BeatDebug::SpanPhase& r = d.spanPhase[i];
        std::printf("%s{\"aSec\":%.17g,\"bSec\":%.17g,\"rot\":%d,\"margin\":%.17g}", i ? "," : "", r.aSec,
                    r.bSec, r.rot, r.margin);
      }
      std::printf("],");
    }
    // The courts' own record. `abstained` is their answer when nothing could
    // testify; `changed` is the TS's `courted !== det0`, which decides whether
    // the whole adoption block downstream ran at all.
    if (d.hasV20)
      std::printf("\"v20\":{\"abstained\":%s,\"changed\":%s,\"cands\":%d,\"halfBar\":%s,\"applied\":%d},",
                  d.v20.abstained ? "true" : "false", d.v20.changed ? "true" : "false", d.v20.cands,
                  d.v20.halfBar ? "true" : "false", static_cast<int>(d.v20.applied.size()));
    if (d.headAfterHalve) {
      const singz::BeatDebug& h = *d.headAfterHalve;
      const char* hw = h.headWhy == singz::BeatDebug::HeadWhy::noAnchor ? "no stable anchor"
                       : h.headWhy == singz::BeatDebug::HeadWhy::headOk  ? "head ok"
                       : h.headWhy == singz::BeatDebug::HeadWhy::judged  ? "judged"
                                                                        : "";
      std::printf("\"headAfterHalve\":{\"headWhy\":\"%s\",\"backcast\":", hw);
      if (h.hasHeadBackcast)
        std::printf("{\"replaced\":%d,\"added\":%d,\"snapped\":%d,\"phase\":\"%s\"}}, ",
                    h.headBackcastReplaced, h.headBackcastAdded, h.headBackcastSnapped,
                    h.headBackcastChords ? "chords" : "carried");
      else std::printf("null},");
    }
    std::printf("\"reject\":");
    if (d.reject.empty()) std::printf("null}\n");
    else std::printf("\"%s\"}\n", d.reject.c_str());
    return 0;
  }
  if (std::strcmp(argv[1], "courts") == 0) {
    // The courts' extractor layer on ONE stem, dumped in full. Values, not a
    // digest: the whole reason this subcommand exists is that the layer runs
    // on libm rather than on arithmetic the porting rules can pin, so a
    // checksum that happened to collide would hide exactly the failure it is
    // here to find.
    std::string path, bassPath, vocalsPath;
    std::vector<std::pair<double, double>> words;
    double lo = 55, hi = 2000;
    for (int i = 2; i < argc; i++) {
      const bool isWav = std::strcmp(argv[i], "--wav") == 0;
      const bool isBassWav = std::strcmp(argv[i], "--bass-wav") == 0;
      const bool isVocalsWav = std::strcmp(argv[i], "--vocals-wav") == 0;
      if (std::strcmp(argv[i], "--word") == 0) {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "courts: --word needs <start>:<end>\n");
          return 2;
        }
        const char* raw = argv[++i];
        char* end = nullptr;
        const double a = std::strtod(raw, &end);
        if (end == raw || *end != ':') {
          std::fprintf(stderr, "courts: --word wants <start>:<end>, got %s\n", raw);
          return 2;
        }
        const char* raw2 = end + 1;
        char* end2 = nullptr;
        const double b2 = std::strtod(raw2, &end2);
        if (end2 == raw2 || *end2 != '\0' || !std::isfinite(a) || !std::isfinite(b2)) {
          std::fprintf(stderr, "courts: --word wants <start>:<end>, got %s\n", raw);
          return 2;
        }
        words.push_back({a, b2});
        continue;
      }
      const bool isLo = std::strcmp(argv[i], "--lo") == 0;
      const bool isHi = std::strcmp(argv[i], "--hi") == 0;
      if (!(isWav || isBassWav || isVocalsWav || isLo || isHi)) {
        std::fprintf(stderr, "courts: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "courts: %s needs a value\n", argv[i]);
        return 2;
      }
      if (isWav) {
        path = argv[++i];
      } else if (isBassWav) {
        bassPath = argv[++i];
      } else if (isVocalsWav) {
        vocalsPath = argv[++i];
      } else {
        // strtod with full consumption, same as --line: std::atof turns a
        // mistyped band into 0.0 and analyses [0,2000) while reporting
        // success, which during a band-by-band comparison reads as a
        // divergence in the port. Verified: `--lo abc` used to exit 0.
        const char* raw = argv[++i];
        char* end = nullptr;
        const double v = std::strtod(raw, &end);
        if (end == raw || *end != '\0' || !std::isfinite(v)) {
          std::fprintf(stderr, "courts: %s wants a number, got %s\n", isLo ? "--lo" : "--hi", raw);
          return 2;
        }
        if (isLo) lo = v;
        else hi = v;
      }
    }
    if (path.empty()) {
      std::fprintf(stderr, "courts needs --wav\n");
      return 2;
    }
    singz::MonoWav w = singz::readWavMono(path);
    if (!w.ok) {
      std::fprintf(stderr, "could not read %s: %s\n", path.c_str(), w.error.c_str());
      return 1;
    }
    singz::AnalysisStem st;
    st.mono = std::move(w.samples);
    st.sampleRate = w.sampleRate;
    const std::vector<float> at44 = singz::monoAt44kPublic(st);
    const std::vector<float> x = singz::to22k(at44);
    const std::vector<std::vector<float>> ch = singz::chromaFrames(x, lo, hi);
    const singz::RmsEnvelope env = singz::rmsEnvelope(x);
    std::printf("{\"to22kLen\":%zu,\"chromaFrames\":%zu,\"rmsFrames\":%zu,\"rmsP95\":%.17g,\"fps\":%.17g,",
                x.size(), ch.size(), env.rms.size(), env.p95, env.fps);
    std::printf("\"chroma\":[");
    for (size_t f = 0; f < ch.size(); f++) {
      std::printf("%s[", f ? "," : "");
      // %.17g, not %.9g. 9 significant digits round-trips a float32 as a
      // VALUE, but the two sides render the halfway case differently — JS
      // toPrecision rounds half away from zero, C's %g rounds half to even —
      // so 22.64453125 printed as 22.6445313 against 22.6445312 read as a
      // divergence in three of six stems when nothing had diverged at all.
      // 17 digits is the exact double, and JSON.parse returns it exactly.
      for (size_t k = 0; k < 12; k++) std::printf("%s%.17g", k ? "," : "", static_cast<double>(ch[f][k]));
      std::printf("]");
    }
    std::printf("],\"beatSync\":[");
    {
      // A synthetic beat grid, so the harness can compare beatSyncChroma —
      // the one extractor with a deliberate deviation from the TS (a negative
      // frame index, which C++ skips where JS would throw) and, until now,
      // the one with no gate over it at all. Half-second beats over the whole
      // file: the point is to exercise the averaging and the L2 normalise,
      // not to be musical.
      std::vector<double> beats;
      const double dur = static_cast<double>(x.size()) / 22050.0;
      for (double t = 0; t < dur; t += 0.5) beats.push_back(t);
      const std::vector<std::vector<float>> bs = singz::beatSyncChroma(ch, beats);
      for (size_t f = 0; f < bs.size(); f++) {
        std::printf("%s[", f ? "," : "");
        for (size_t k = 0; k < 12; k++) std::printf("%s%.17g", k ? "," : "", static_cast<double>(bs[f][k]));
        std::printf("]");
      }
    }
    // ONE assembly, not two. This block used to hand-build the same
    // Ch/Cb/chordRuns and rmsEnvelope->vocalEvidence->formSeams pipeline that
    // buildCourtEvidence now owns — so the parity gate watched a copy of the
    // real function rather than the function. Calling it here gates it and
    // retires the duplicate in one move.
    std::printf("],");
    {
      std::vector<double> beats;
      const double dur = static_cast<double>(x.size()) / 22050.0;
      for (double t = 0; t < dur; t += 0.5) beats.push_back(t);

      std::vector<singz::AnalysisStem> harm;
      harm.push_back(st);
      singz::AnalysisStem bassStem, vocalStem;
      singz::CourtSources src;
      src.harm = &harm;
      if (!bassPath.empty()) {
        singz::MonoWav bw = singz::readWavMono(bassPath);
        if (!bw.ok) {
          std::fprintf(stderr, "could not read %s: %s\n", bassPath.c_str(), bw.error.c_str());
          return 1;
        }
        bassStem.mono = std::move(bw.samples);
        bassStem.sampleRate = bw.sampleRate;
        src.bass = &bassStem;
      }
      if (!vocalsPath.empty()) {
        singz::MonoWav vw = singz::readWavMono(vocalsPath);
        if (!vw.ok) {
          std::fprintf(stderr, "could not read %s: %s\n", vocalsPath.c_str(), vw.error.c_str());
          return 1;
        }
        vocalStem.mono = std::move(vw.samples);
        vocalStem.sampleRate = vw.sampleRate;
        src.vocals = &vocalStem;
      }
      src.words = words;

      singz::CourtGrid det;
      // 0.5 s beats -> 120 bpm, so `sec` below is len * 0.5 exactly.
      det.bpm = 120;
      det.beats = beats;
      const singz::CourtEvidence ev = singz::buildCourtEvidence(det, src);

      std::printf("\"chordRuns\":[");
      for (size_t i2 = 0; i2 < ev.runs.size(); i2++)
        std::printf("%s{\"name\":\"%s\",\"t\":%.17g,\"sec\":%.17g}", i2 ? "," : "", ev.runs[i2].c.c_str(),
                    ev.runs[i2].t, ev.runs[i2].sec);
      std::printf("],\"voice\":[");
      for (size_t i2 = 0; i2 < ev.voice.size(); i2++) {
        std::printf("%s{\"t\":%.17g,\"gapSec\":", i2 ? "," : "", ev.voice[i2].t);
        const double g = ev.voice[i2].gapSec;
        if (std::isinf(g)) std::printf("%s}", g > 0 ? "1e999" : "-1e999");
        else std::printf("%.17g}", g);
      }
      std::printf("],\"seams\":[");
      for (size_t i2 = 0; i2 < ev.seams.size(); i2++) std::printf("%s%.17g", i2 ? "," : "", ev.seams[i2]);
      // seams is closed by the `],"rms":[` that follows — do NOT close it here.
    }
    std::printf("],\"rms\":[");
    for (size_t f = 0; f < env.rms.size(); f++)
      std::printf("%s%.17g", f ? "," : "", static_cast<double>(env.rms[f]));
    std::printf("]}\n");
    return 0;
  }

  if (std::strcmp(argv[1], "mlgrid") == 0) {
    // The Beat This! runner with its two graph calls REPLAYED from recordings
    // rather than run. The host has no ONNX Runtime, and it does not need one
    // to gate this: every way the port can be wrong — the reflect padding, the
    // hop arithmetic, the chunk starts, the keep_first ordering, the border
    // trim, the peak picking, the dedupe, the downbeat snap, the rounding —
    // lives on this side of the model. eval/mlgrid-parity.mjs feeds this the
    // tensors scripts/beat_runner_onnx.py actually fed ORT, and compares what
    // comes back. The graphs themselves are proved on-device, where they run.
    std::string f32Path, spectPath, chunkBeatPath, chunkDownPath, framesOut, logitsOut;
    std::string logitsBeatPath, logitsDownPath;
    for (int i = 2; i < argc; i++) {
      const bool isF32 = std::strcmp(argv[i], "--f32") == 0;
      const bool isSpect = std::strcmp(argv[i], "--spect") == 0;
      const bool isCb = std::strcmp(argv[i], "--chunk-beat") == 0;
      const bool isCd = std::strcmp(argv[i], "--chunk-down") == 0;
      const bool isFramesOut = std::strcmp(argv[i], "--frames-out") == 0;
      const bool isLogitsOut = std::strcmp(argv[i], "--logits-out") == 0;
      const bool isLb = std::strcmp(argv[i], "--logits-beat") == 0;
      const bool isLd = std::strcmp(argv[i], "--logits-down") == 0;
      if (!(isF32 || isSpect || isCb || isCd || isFramesOut || isLogitsOut || isLb || isLd)) {
        std::fprintf(stderr, "mlgrid: unknown argument %s\n", argv[i]);
        return 2;
      }
      if (i + 1 >= argc) {
        std::fprintf(stderr, "mlgrid: %s needs a value\n", argv[i]);
        return 2;
      }
      if (isF32) f32Path = argv[++i];
      else if (isSpect) spectPath = argv[++i];
      else if (isCb) chunkBeatPath = argv[++i];
      else if (isCd) chunkDownPath = argv[++i];
      else if (isFramesOut) framesOut = argv[++i];
      else if (isLb) logitsBeatPath = argv[++i];
      else if (isLd) logitsDownPath = argv[++i];
      else logitsOut = argv[++i];
    }

    // Postprocess-only mode: logits straight in, no framing and no chunks. The
    // real song reaches none of the postprocessor's edges — measured on the
    // sample, 89 peaks with not one adjacent pair, so the dedupe never merges;
    // no logit within 65 of the sigmoid clip; no exact zero; no snap tie. Every
    // one of those is a live branch that a real input simply does not visit, so
    // the fixture feeds them directly. Same reasoning as eval/beats/fixtures.mjs.
    if (!logitsBeatPath.empty() || !logitsDownPath.empty()) {
      if (logitsBeatPath.empty() || logitsDownPath.empty()) {
        std::fprintf(stderr, "mlgrid: --logits-beat and --logits-down go together\n");
        return 2;
      }
      const std::vector<float> lb = readF32(logitsBeatPath);
      const std::vector<float> ld = readF32(logitsDownPath);
      if (lb.empty() || lb.size() != ld.size()) {
        std::fprintf(stderr, "mlgrid: logit rows are %zu and %zu floats\n", lb.size(), ld.size());
        return 1;
      }
      singz::MlGrid g;
      singz::postprocess(lb, ld, g.beats, g.downbeats);
      g.beatProb.reserve(lb.size());
      g.downbeatProb.reserve(ld.size());
      for (const float v : lb) g.beatProb.push_back(singz::sigmoidProb(v));
      for (const float v : ld) g.downbeatProb.push_back(singz::sigmoidProb(v));
      g.ok = true;
      std::fprintf(stderr, "mlgrid: postprocess-only, %zu frames, %zu beats, %zu downbeats\n",
                   lb.size(), g.beats.size(), g.downbeats.size());
      std::printf("%s\n", singz::mlGridJson(g).c_str());
      return 0;
    }

    if (f32Path.empty() || spectPath.empty() || chunkBeatPath.empty() || chunkDownPath.empty()) {
      std::fprintf(stderr,
                   "usage: singz-analyze mlgrid --f32 <in> --spect <spect.f32> "
                   "--chunk-beat <b.f32> --chunk-down <d.f32> [--frames-out <p>] "
                   "[--logits-out <prefix>]\n");
      return 2;
    }

    const std::vector<float> signal = readF32(f32Path);
    if (signal.empty()) {
      std::fprintf(stderr, "mlgrid: could not read %s\n", f32Path.c_str());
      return 1;
    }
    int nFrames = 0;
    const std::vector<float> frames = singz::frameSignal(signal, nFrames);
    if (!framesOut.empty()) {
      FILE* fo = std::fopen(framesOut.c_str(), "wb");
      if (!fo) {
        std::fprintf(stderr, "mlgrid: could not write %s\n", framesOut.c_str());
        return 1;
      }
      std::fwrite(frames.data(), sizeof(float), frames.size(), fo);
      std::fclose(fo);
    }

    const std::vector<float> spect = readF32(spectPath);
    if (spect.size() != static_cast<size_t>(nFrames) * 128) {
      std::fprintf(stderr, "mlgrid: spect has %zu floats, this port framed %d rows (%zu)\n",
                   spect.size(), nFrames, static_cast<size_t>(nFrames) * 128);
      return 1;
    }
    const std::vector<float> cb = readF32(chunkBeatPath);
    const std::vector<float> cd = readF32(chunkDownPath);
    const size_t chunkLen = static_cast<size_t>(singz::kBeatThisChunk);
    if (cb.size() % chunkLen != 0 || cb.size() != cd.size()) {
      std::fprintf(stderr, "mlgrid: chunk logits are %zu/%zu floats, not whole %zu-frame rows\n",
                   cb.size(), cd.size(), chunkLen);
      return 1;
    }
    const size_t recorded = cb.size() / chunkLen;

    // Replay in call order. A port that asked for a different NUMBER of chunks,
    // or in the other order, would silently line up against the wrong logits —
    // so the count is checked against the recording afterwards, and the
    // callback refuses to run off the end.
    size_t call = 0;
    singz::BeatThisModels models;
    models.logmel = [](const std::vector<float>&, int) { return std::vector<float>(); };
    models.model = [&](const std::vector<float>&, std::vector<float>& b, std::vector<float>& d) {
      if (call >= recorded) return false;
      b.assign(cb.begin() + static_cast<long>(call * chunkLen),
               cb.begin() + static_cast<long>((call + 1) * chunkLen));
      d.assign(cd.begin() + static_cast<long>(call * chunkLen),
               cd.begin() + static_cast<long>((call + 1) * chunkLen));
      call++;
      return true;
    };

    std::vector<float> beatLogits, downLogits;
    if (!singz::runChunks(spect, nFrames, models, beatLogits, downLogits, nullptr)) {
      std::fprintf(stderr, "mlgrid: runChunks failed after %zu of %zu recorded chunks\n", call,
                   recorded);
      return 1;
    }
    if (call != recorded) {
      std::fprintf(stderr, "mlgrid: replayed %zu chunks, the recording has %zu\n", call, recorded);
      return 1;
    }
    if (!logitsOut.empty()) {
      for (int which = 0; which < 2; which++) {
        const std::vector<float>& v = which == 0 ? beatLogits : downLogits;
        const std::string p = logitsOut + (which == 0 ? "-beat.f32" : "-down.f32");
        FILE* fo = std::fopen(p.c_str(), "wb");
        if (!fo) {
          std::fprintf(stderr, "mlgrid: could not write %s\n", p.c_str());
          return 1;
        }
        std::fwrite(v.data(), sizeof(float), v.size(), fo);
        std::fclose(fo);
      }
    }

    singz::MlGrid grid;
    singz::postprocess(beatLogits, downLogits, grid.beats, grid.downbeats);
    grid.beatProb.reserve(beatLogits.size());
    grid.downbeatProb.reserve(downLogits.size());
    for (const float v : beatLogits) grid.beatProb.push_back(singz::sigmoidProb(v));
    for (const float v : downLogits) grid.downbeatProb.push_back(singz::sigmoidProb(v));
    grid.ok = true;
    std::fprintf(stderr, "mlgrid: %d frames, %zu chunks, %zu beats, %zu downbeats\n", nFrames,
                 recorded, grid.beats.size(), grid.downbeats.size());
    std::printf("%s\n", singz::mlGridJson(grid).c_str());
    return 0;
  }

  // ---- the courts, judged on a stated grid ---------------------------------
  //
  // The evidence side already has a gate (`courts`); this is the deciding
  // side. The grid is UNIFORM and built from --bpm/--bpb/--t0/--dur rather
  // than passed as hundreds of times on a command line: both sides construct
  // it by the same arithmetic, so what is being compared is the courts, not a
  // serialisation. Real stems still supply the evidence, so the chord runs
  // the courts weigh are the real ones.
  if (cmd == "courtsjudge") {
    std::string harmPath, bassPath, vocalsPath, mlBeatsCsv;
    std::string runsCsv, voiceCsv, seamCsv;
    double bpm = 0, t0 = 0, dur = 0;
    int bpb = 4;
    std::vector<std::pair<double, double>> words;
    for (int i = 2; i < argc; i++) {
      const std::string a = argv[i];
      auto need = [&](const char* what) -> const char* {
        if (i + 1 >= argc) {
          std::fprintf(stderr, "courtsjudge: %s needs a value\n", what);
          std::exit(2);
        }
        return argv[++i];
      };
      if (a == "--wav") harmPath = need("--wav");
      else if (a == "--bass-wav") bassPath = need("--bass-wav");
      else if (a == "--vocals-wav") vocalsPath = need("--vocals-wav");
      else if (a == "--bpm") bpm = std::atof(need("--bpm"));
      else if (a == "--bpb") bpb = std::atoi(need("--bpb"));
      else if (a == "--t0") t0 = std::atof(need("--t0"));
      else if (a == "--dur") dur = std::atof(need("--dur"));
      else if (a == "--ml-beats") mlBeatsCsv = need("--ml-beats");
      // Synthetic evidence, for the branches no real stem in the corpus
      // reaches (the cadence and sibling courts). When --runs is given the
      // audio is not read at all: what is under test is the deciding side,
      // and the extractors have their own gate.
      else if (a == "--runs") runsCsv = need("--runs");
      else if (a == "--voice") voiceCsv = need("--voice");
      else if (a == "--seam") seamCsv = need("--seam");
      else if (a == "--word") {
        const std::string w = need("--word");
        const size_t colon = w.find(':');
        if (colon == std::string::npos) {
          std::fprintf(stderr, "courtsjudge: --word wants <start>:<end>, got %s\n", w.c_str());
          return 2;
        }
        words.push_back({std::atof(w.substr(0, colon).c_str()), std::atof(w.substr(colon + 1).c_str())});
      } else {
        std::fprintf(stderr, "courtsjudge: unknown argument %s\n", a.c_str());
        return 2;
      }
    }
    const bool synthetic = !runsCsv.empty();
    if (bpm <= 0 || (harmPath.empty() && !synthetic)) {
      std::fprintf(stderr, "courtsjudge needs --bpm, and --wav unless --runs is given\n");
      return 2;
    }
    singz::AnalysisStem harmStem;
    if (!synthetic) {
      singz::MonoWav hw = singz::readWavMono(harmPath);
      if (!hw.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", harmPath.c_str(), hw.error.c_str());
        return 1;
      }
      harmStem.mono = std::move(hw.samples);
      harmStem.sampleRate = hw.sampleRate;
      if (dur <= 0) {
        dur = static_cast<double>(harmStem.mono.size()) / static_cast<double>(harmStem.sampleRate);
      }
    }
    if (dur <= 0) {
      std::fprintf(stderr, "courtsjudge needs --dur when --runs replaces the audio\n");
      return 2;
    }

    // The uniform grid. `t + i * per`, not a running sum: an accumulator
    // would drift differently once the two languages' roundings diverged,
    // and the point here is that both sides hold the SAME lattice.
    singz::CourtGrid det;
    det.bpm = bpm;
    det.beatsPerBar = bpb;
    det.downbeat = 0;
    {
      const double per = 60.0 / bpm;
      for (int i = 0;; i++) {
        const double t = t0 + i * per;
        if (t > dur) break;
        det.beats.push_back(t);
      }
    }

    singz::CourtEvidence ev;
    if (synthetic) {
      // "t:sec:label,..." / "t:gap,..." / "t,..." — the same three strings the
      // harness parses on its side, so both hold the identical pack.
      const auto fields = [](const std::string& row, char sep) {
        std::vector<std::string> out;
        size_t at = 0;
        for (;;) {
          const size_t k = row.find(sep, at);
          out.push_back(row.substr(at, k == std::string::npos ? std::string::npos : k - at));
          if (k == std::string::npos) break;
          at = k + 1;
        }
        return out;
      };
      for (const std::string& row : fields(runsCsv, ',')) {
        if (row.empty()) continue;
        const std::vector<std::string> f = fields(row, ':');
        if (f.size() < 3) {
          std::fprintf(stderr, "courtsjudge: --runs wants t:sec:label, got %s\n", row.c_str());
          return 2;
        }
        ev.runs.push_back({std::atof(f[0].c_str()), std::atof(f[1].c_str()), f[2]});
      }
      for (const std::string& row : fields(voiceCsv, ',')) {
        if (row.empty()) continue;
        const std::vector<std::string> f = fields(row, ':');
        if (f.size() < 2) continue;
        ev.voice.push_back({std::atof(f[0].c_str()), std::atof(f[1].c_str())});
      }
      for (const std::string& row : fields(seamCsv, ',')) {
        if (row.empty()) continue;
        ev.seams.push_back(std::atof(row.c_str()));
      }
      ev.words = words;
    }

    std::vector<singz::AnalysisStem> harm;
    // MOVED, not copied: harmStem holds the whole decoded stem, and the copy
    // is the very one CourtSources' header warns about a few lines below its
    // own pointer members. harmStem is dead after this.
    harm.push_back(std::move(harmStem));
    singz::AnalysisStem bassStem, vocalStem;
    singz::CourtSources src;
    src.harm = &harm;
    if (!bassPath.empty() && !synthetic) {
      singz::MonoWav bw = singz::readWavMono(bassPath);
      if (!bw.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", bassPath.c_str(), bw.error.c_str());
        return 1;
      }
      bassStem.mono = std::move(bw.samples);
      bassStem.sampleRate = bw.sampleRate;
      src.bass = &bassStem;
    }
    if (!vocalsPath.empty() && !synthetic) {
      singz::MonoWav vw = singz::readWavMono(vocalsPath);
      if (!vw.ok) {
        std::fprintf(stderr, "could not read %s: %s\n", vocalsPath.c_str(), vw.error.c_str());
        return 1;
      }
      vocalStem.mono = std::move(vw.samples);
      vocalStem.sampleRate = vw.sampleRate;
      src.vocals = &vocalStem;
    }
    src.words = words;

    if (!synthetic) ev = singz::buildCourtEvidence(det, src);
    if (!mlBeatsCsv.empty()) {
      std::vector<double> mlBeats;
      size_t at = 0;
      while (at < mlBeatsCsv.size()) {
        const size_t comma = mlBeatsCsv.find(',', at);
        const std::string tok = mlBeatsCsv.substr(at, comma == std::string::npos ? std::string::npos : comma - at);
        if (!tok.empty()) mlBeats.push_back(std::atof(tok.c_str()));
        if (comma == std::string::npos) break;
        at = comma + 1;
      }
      bool ok = false;
      const singz::MlLevel lvl = singz::mlLevelStats(mlBeats, ok);
      ev.ml = lvl;
      ev.hasMl = ok;
    }

    singz::CourtsDbg cdbg;
    const singz::CourtGrid ruled = singz::applyCourts(det, ev, cdbg);
    const std::vector<singz::ChordRun> cps = singz::changePoints(ev.runs, 0.9);
    const std::vector<double> bars = singz::barTimes(det);

    auto printGrid = [](const char* name, const singz::CourtGrid& g) {
      std::printf("\"%s\":{\"bpm\":%.17g,\"beatsPerBar\":%d,\"downbeat\":%d,\"beats\":[", name, g.bpm,
                  g.beatsPerBar, g.downbeat);
      for (size_t i = 0; i < g.beats.size(); i++) std::printf("%s%.17g", i ? "," : "", g.beats[i]);
      std::printf("],\"downbeats\":[");
      for (size_t i = 0; i < g.downbeats.size(); i++) std::printf("%s%d", i ? "," : "", g.downbeats[i]);
      std::printf("]}");
    };
    std::printf("{\"lattice\":%zu,\"runs\":%zu,", det.beats.size(), ev.runs.size());
    std::printf("\"hasMl\":%s,", ev.hasMl ? "true" : "false");
    if (ev.hasMl) std::printf("\"ml\":{\"bpm\":%.17g,\"uni\":%.17g},", ev.ml.bpm, ev.ml.uni);
    std::printf("\"abstained\":%s,", cdbg.abstained ? "true" : "false");
    std::printf("\"oct\":%s,", cdbg.oct.empty() ? "null" : cdbg.oct.c_str());
    std::printf("\"dbl\":%s,", cdbg.dbl.empty() ? "null" : cdbg.dbl.c_str());
    std::printf("\"cands\":%d,\"halfBar\":%s,", cdbg.cands, cdbg.halfBar ? "true" : "false");
    std::printf("\"cadenceCensus\":%s,",
                cdbg.cadenceCensus.empty() ? "{}" : cdbg.cadenceCensus.c_str());
    std::printf("\"plan\":%s,", cdbg.plan.empty() ? "null" : cdbg.plan.c_str());
    std::printf("\"applied\":[");
    for (size_t i = 0; i < cdbg.applied.size(); i++) {
      std::printf("%s{\"t\":%.17g,\"L\":%d,\"why\":\"%s\",\"gain\":%.17g}", i ? "," : "",
                  cdbg.applied[i].t, cdbg.applied[i].L, cdbg.applied[i].why.c_str(),
                  cdbg.applied[i].gain);
    }
    std::printf("],\"changePoints\":[");
    for (size_t i = 0; i < cps.size(); i++) {
      std::printf("%s{\"t\":%.17g,\"sec\":%.17g,\"c\":\"%s\"}", i ? "," : "", cps[i].t, cps[i].sec,
                  cps[i].c.c_str());
    }
    std::printf("],\"barTimes\":[");
    for (size_t i = 0; i < bars.size(); i++) std::printf("%s%.17g", i ? "," : "", bars[i]);
    std::printf("],");
    printGrid("ruled", ruled);
    std::printf("}\n");
    return 0;
  }

  std::fprintf(stderr, "unknown command %s\n", cmd.c_str());
  return 2;
}
