#pragma once

#include "shared_audio_service.h"
#include <zcore/device/audio_input_backend.h>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace singz {
struct MicrophoneMixChannel {
  uint32_t channel = 0;
  float gain = .1F;
  bool muted = false;
  float pan = 0;
};
struct MicrophoneMixConfig {
  std::string deviceUid;
  std::vector<MicrophoneMixChannel> channels;
  uint32_t delayFrames = 1024;
  // Empty: add microphones to the existing shared output. Nonempty: relay
  // only captured audio to this separate output; the song stays on the shared
  // device (e.g. FLOW 8 USB return -> hardware main -> HDMI).
  std::string outputDeviceUid;
};
struct MicrophoneMixResult { bool ok; std::string error; };
struct MicrophoneMixMissingFrames {
  uint64_t invalidRequest = 0, offline = 0, anchorUnavailable = 0;
  uint64_t clockMapping = 0, resamplingSupport = 0, generationChanged = 0;
};
// One control-thread snapshot per mono capture channel. Live fields are
// independent atomic observations, not a coherent cross-source snapshot.
// History misses exclude render silence emitted without a history read.
struct MicrophoneMixSourceDiagnostics {
  uint32_t channel = 0;
  bool historyOnline = false;
  uint64_t historyCallbacks = 0, historyDiscontinuities = 0;
  // Valid positive-count PCM discarded for Unknown timestamp quality. These
  // count received data, not missing hardware frames or an exact overrun count.
  uint64_t unanchoredBlocks = 0, unanchoredFrames = 0;
  double measuredRate = 0;
  uint64_t lastHostNs = 0, publishedEndHostNs = 0;
  MicrophoneMixMissingFrames missingFramesByReason;
  uint64_t unpublishedSampleReads = 0, expiredSampleReads = 0;
  uint64_t racingSampleReads = 0, absentSampleReads = 0;
  uint64_t verifiedClockSteps = 0, maximumVerifiedClockStepNs = 0;
};
struct MicrophoneMixStatus {
  bool active = false;
  uint64_t callbacks = 0, missingFrames = 0, failures = 0;
  double sampleRate = 0;
  std::string error;
  std::vector<MicrophoneMixSourceDiagnostics> diagnostics;
};
// Control calls are serialized. Stop drains the shared/relay output callback
// before joining capture and reclaiming histories and the prepared graph.
class MicrophoneMixSession final {
 public:
  using InputFactory = std::unique_ptr<AudioInputBackend> (*)();
  using OutputFactory = std::unique_ptr<AudioHostBackend> (*)();
  explicit MicrophoneMixSession(SharedAudioService& service,
      InputFactory inputFactory = createPlatformAudioInputBackend,
      OutputFactory outputFactory = createPlatformAudioHostBackend);
  ~MicrophoneMixSession();
  MicrophoneMixResult start(const MicrophoneMixConfig& config);
  void stop() noexcept;
  MicrophoneMixStatus status();
 private:
  struct Impl;
  std::unique_ptr<Impl> impl_;
};
} // namespace singz
