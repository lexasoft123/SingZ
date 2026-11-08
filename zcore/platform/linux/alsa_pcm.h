#pragma once

#include <alsa/asoundlib.h>
#include <poll.h>

#include <atomic>
#include <memory>
#include <string>
#include <vector>

#include <zcore/device/audio_host.h>

namespace singz::detail {

struct AlsaEndpoint {
  AudioHostDeviceInfo info;
  std::string pcm;
};

std::vector<AlsaEndpoint> alsaEndpoints();
void alsaUniqueDefaults(std::vector<AlsaEndpoint>& endpoints) noexcept;
uint64_t alsaMonotonicNs() noexcept;
uint64_t alsaClockId(const std::string& uid) noexcept;
struct AlsaCaptureSnapshot {
  snd_pcm_uframes_t available{0};
  snd_htimestamp_t time{};
};
uint64_t alsaTimespecMonotonicNs(const snd_htimestamp_t& time) noexcept;
uint64_t alsaCaptureFirstSampleNs(const AlsaCaptureSnapshot& snapshot,
    uint32_t rate, uint32_t bufferFrames, uint64_t previousTimestampNs,
    uint64_t previousFirstSampleNs) noexcept;
struct AlsaPlaybackSnapshot {
  snd_pcm_state_t state{SND_PCM_STATE_RUNNING};
  snd_pcm_uframes_t available{0};
  snd_htimestamp_t time{};
  snd_pcm_sframes_t delay{0};
};
// Delay above bufferFrames can be valid ALSA pipeline latency, but is outside
// the supported presentation budget and intentionally yields no estimate.
uint64_t alsaPlaybackOutputHostNs(const AlsaPlaybackSnapshot& snapshot,
    uint32_t rate, uint32_t bufferFrames, uint64_t previousTimestampNs,
    uint64_t previousOutputHostNs) noexcept;
uint32_t alsaDecode(const unsigned char* source, float* target, uint32_t samples,
                snd_pcm_format_t format) noexcept;
uint32_t alsaEncode(const float* source, unsigned char* target, uint32_t samples,
                snd_pcm_format_t format) noexcept;

// Prepared on the control thread. One worker exclusively owns all PCM I/O;
// stop only writes the eventfd and joins before closing any descriptors.
struct AlsaPcm final {
  ~AlsaPcm();
  AlsaPcm() = default;
  AlsaPcm(const AlsaPcm&) = delete;
  AlsaPcm& operator=(const AlsaPcm&) = delete;
  bool open(const std::string& name, bool capture, uint32_t channelsNeeded,
            uint32_t rate, uint32_t period, uint32_t maximumFrames,
            std::string& error);
  void close() noexcept;
  void wake() noexcept;
  void clearWake() noexcept;
  int wait() noexcept;
  uint32_t sampleBytes() const noexcept;
  snd_pcm_t* handle{nullptr};
  snd_pcm_format_t sampleFormat{SND_PCM_FORMAT_UNKNOWN};
  uint32_t channels{0}, rate{0}, period{0}, buffer{0};
  int wakeFd{-1};
  std::vector<pollfd> descriptors;
};

using AlsaCapturePush = bool (*)(void*, const float*, uint32_t, uint32_t,
                                 uint64_t, uint64_t) noexcept;
enum class AlsaCaptureOperation { Timestamp, Read, Prepare, Start };
class __attribute__((visibility("hidden"))) AlsaCaptureRoute;

// A direction lease: subscribing does not start callbacks. Capture adapters
// and duplex hosts share one physical capture endpoint and bounded slots.
class __attribute__((visibility("hidden"))) AlsaCaptureLease final {
 public:
  AlsaCaptureLease(const AlsaCaptureLease&) = delete;
  AlsaCaptureLease& operator=(const AlsaCaptureLease&) = delete;
  AlsaCaptureLease(AlsaCaptureLease&&) = delete;
  AlsaCaptureLease& operator=(AlsaCaptureLease&&) = delete;
  ~AlsaCaptureLease();
  bool start(std::string& error);
  void stop() noexcept;
  int failure() const noexcept;
  uint32_t channels() const noexcept;
  uint32_t period() const noexcept;
  uint32_t bufferFrames() const noexcept;
  uint64_t nonFiniteSamples() const noexcept;
#if defined(SINGZ_CORE_TESTS)
  void setOperationsForTests(
      snd_pcm_sframes_t (*)(void*, AlsaCaptureOperation, void*, snd_pcm_uframes_t),
      void* context);
#endif
 private:
  AlsaCaptureLease() = default;
  friend std::unique_ptr<AlsaCaptureLease> acquireAlsaCapture(
      const std::string&, const std::string&, uint32_t, uint32_t, uint32_t,
      AlsaCapturePush, void*, std::string&);
  std::shared_ptr<AlsaCaptureRoute> route_;
  uint32_t slot_{0};
};

std::unique_ptr<AlsaCaptureLease> acquireAlsaCapture(
    const std::string& uid, const std::string& pcm, uint32_t channelsNeeded,
    uint32_t rate, uint32_t period, AlsaCapturePush push, void* context,
    std::string& error);

enum class AlsaOutputRecoveryOperation { Prepare, Write, Start };
#if defined(SINGZ_CORE_TESTS)
using AlsaWriteForTest = snd_pcm_sframes_t (*)(void*, const void*, snd_pcm_uframes_t);
using AlsaOutputRecoveryForTest = snd_pcm_sframes_t (*)(
    void*, AlsaOutputRecoveryOperation, const void*, snd_pcm_uframes_t);
using AlsaOutputStatusForTest = int (*)(void*, AlsaPlaybackSnapshot&);
// Named ALSA plugins are allowed only at this private test seam. Production
// resolves opaque inventory UIDs to direct hardware endpoints.
std::unique_ptr<AudioHostBackend> makeAlsaAudioHostForTests(
    std::string outputPcm, std::string inputPcm = {},
    AlsaWriteForTest write = nullptr, void* writeContext = nullptr,
    AlsaOutputRecoveryForTest recover = nullptr,
    AlsaOutputStatusForTest status = nullptr);
#endif

}  // namespace singz::detail
