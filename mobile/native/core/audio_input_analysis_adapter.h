#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <functional>
#include <memory>
#include <vector>

#include "audio_input.h"

namespace singz {

struct LiveInputAnalysisWindow {
  uint64_t startSequence = 0;
  uint64_t endSequence = 0;
  uint64_t sampleHostTimeStartNs = 0;
  uint64_t sampleHostTimeEndNs = 0;  // exclusive end of the 2048-frame window
  uint64_t callbackHostTimeNs = 0;   // callback that supplied the final sample
  AudioInputTimestampQuality timestampQuality =
      AudioInputTimestampQuality::Unknown;
  double sampleRate = 0;
  LiveInputFrame analysis;
};

// Delivery-thread adapter from variable raw hardware blocks to the fixed
// 2048/512 live-analysis contract. Its pending window is a fixed circular
// buffer: no growing vector and no O(n) erase/memmove. Resampling and YIN stay
// off the hardware callback.
class LiveInputAnalysisAdapter {
 public:
  using Sink = std::function<void(const LiveInputAnalysisWindow&)>;

  LiveInputAnalysisAdapter();
  ~LiveInputAnalysisAdapter();
  LiveInputAnalysisAdapter(const LiveInputAnalysisAdapter&) = delete;
  LiveInputAnalysisAdapter& operator=(const LiveInputAnalysisAdapter&) = delete;

  bool push(const AudioInputBlockView& block, const Sink& sink);
  void reset();
  size_t bufferedFrames() const { return size_; }
  uint64_t resets() const { return resets_; }
  uint64_t emittedWindows() const { return emitted_; }
  /** Decaying peak of the raw capture, before any gain. */
  float capturePeak() const { return peakFollower_; }
  /** Gain applied to the most recent window; 1 means it was left untouched. */
  float appliedGain() const { return appliedGain_; }

  // Live capture arrives at a level the DEVICE chooses, and the detector
  // downstream gates on an ABSOLUTE rms (0.01, mirroring yinPitchInfo). Those
  // two facts are incompatible. Measured 2026-08-28, both phones through the
  // same VOICE_PERFORMANCE preset, which by design applies no automatic gain:
  // a realme RMX5051's SINGING VOICE peaked at −39.2 dBFS, which is 25 dB
  // below what a Xiaomi 23049PCD8G's ROOM produced sitting idle (−14.2). The
  // realme cleared the detector's gate on 7 windows out of 2495, and its
  // singer was told to sing louder; shouting into it reached −34.
  //
  // So the window is normalized to the level the detector was calibrated for
  // rather than the gate being retuned per phone. YIN is scale-invariant, so
  // this changes WHETHER a window is analysed, never the pitch it reports.
  // Gain is boost-only, which keeps an already-hot device on the untouched
  // path bit-for-bit.
  static constexpr float kTargetPeak = 0.25f;      // −12 dBFS
  static constexpr float kMaximumGain = 100.0f;    // +40 dB
  static constexpr float kPeakDecay = 0.995f;      // ~2.1 s at a 512-frame hop, 48 kHz
  // There was a kSilencePeak here, guarding against lifting hiss. The voicing
  // gate subsumes it: the gain is only ever computed while voicing_ is true,
  // which requires rawRms >= kVoicingCloseRms, and peakFollower_ >= rawRms, so
  // the follower can never be near a silence floor at that point. It was
  // removed rather than left as a constant no test could pin.

  // The lift is for the DETECTOR's calibration, never for the decision of
  // whether there is anything to detect. `analyzeLiveInput`'s own rms gate was
  // doing double duty as the live path's noise gate, and normalizing ahead of
  // it removed that: a faint tonal room noise — a fan, coil whine, 100 Hz
  // mains — comes back as a confident pitch that the single-note tracker can
  // hold for its full 1.5 s and lock a target nobody sang. YIN's clarity
  // cannot stand in for this; it measures periodicity, which is exactly what
  // a steady tone has.
  //
  // So voicing is decided on the UNSCALED window, and with hysteresis rather
  // than one threshold. A single floor is a cliff: measured on a tonal room
  // 20 dB over its own hiss, −56 dBFS gave 0/197 windows a pitch and −54 gave
  // 197/197 at full confidence. Three and a half decibels is not a margin a
  // room stays on the right side of — a fan starting, or the phone set down
  // on a table instead of held, walks straight across it.
  //
  // The two edges come from the field log of the quietest phone we have seen
  // (a realme RMX5051): its room peaked at −57.5 dBFS rms over three seconds
  // of ambient, and its voice reached −39.2. Opening at −50 sits 7.5 dB above
  // that room and 11 dB below that voice. Latching takes kVoicingOnsetWindows
  // in a row, so a single loud sample cannot open the gate on its own.
  //
  // RELEASE is the half that actually protects a session, and getting it wrong
  // wasted a review round. Closing only below kVoicingCloseRms means the gate
  // latches open — and every training prompt opens it by design, the moment
  // the singer sings — so the open threshold governs nothing but a cold
  // adapter. Measured on exactly that mistake: a 118 Hz tonal room at −52.7
  // dBFS following one sung note gave 273/273 windows a confident pitch for
  // three seconds, which is 1.5 s from locking a note nobody sang. So the gate
  // also closes on the sustained ABSENCE of the open condition: once the level
  // has been under kVoicingOpenRms for kVoicingReleaseWindows in a row, it
  // shuts. That leaves a ~270 ms tail, far under the tracker's 1.5 s hold,
  // and still lets a note that dips briefly ride through.
  static constexpr double kVoicingOpenRms = 0.0032;   // −50 dBFS
  static constexpr double kVoicingCloseRms = 0.0018;  // −55 dBFS
  static constexpr int kVoicingOnsetWindows = 3;      // ~32 ms at a 512 hop
  static constexpr int kVoicingReleaseWindows = 30;   // ~320 ms at a 512 hop
  // The detector keeps its own 0.01 rms gate, and it runs on the SCALED
  // window — so the peak-derived gain alone does not guarantee a window that
  // passed the gate is actually analysed. Note this branch deliberately does
  // NOT normalize to kTargetPeak: it scales by whatever clears the detector,
  // so a clicky window can peak above 1.0 (bounded ~6.7 for real audio, which
  // analyzeLiveInput sums in double and does not clamp). Measured: a −6 dBFS bump followed
  // by a steady −45 dBFS voice left that voice unpitched for 2.74 s while the
  // follower unwound. The gain is therefore also floored at whatever clears
  // the detector, which is bounded (rawRms ≥ kVoicingCloseRms by then, so this
  // ratio never exceeds ~6.7) and cannot approach the cap.
  static constexpr double kDetectorGateRms = 0.012;

  static constexpr size_t analysisFrames() { return 2048; }
  static constexpr size_t hopFrames() { return 512; }

 private:
  void configure(const AudioInputBlockView& block);
  LiveInputFrame analyzeWindow();
  void append(float sample, uint64_t sequence, uint64_t callbackHostTimeNs,
              const Sink& sink);
  uint64_t hostTimeForOutputFrame(uint64_t frame) const;

  static constexpr size_t kCapacity = 2048;
  std::array<float, kCapacity> samples_{};
  std::array<uint64_t, kCapacity> sequences_{};
  std::array<uint64_t, kCapacity> callbackTimes_{};
  std::array<float, kCapacity> contiguous_{};
  size_t read_ = 0;
  size_t size_ = 0;
  uint64_t firstOutputFrame_ = 0;
  uint64_t nextOutputFrame_ = 0;
  uint64_t streamHostTimeNs_ = 0;
  uint64_t expectedSequence_ = 0;
  bool haveSequence_ = false;
  AudioInputTimestampQuality timestampQuality_ =
      AudioInputTimestampQuality::Unknown;
  int sourceRate_ = 0;
  int analysisRate_ = 0;
  int64_t latencyToDrop_ = 0;
  std::unique_ptr<class Resampler> resampler_;
  std::vector<float> converted_;
  uint64_t resets_ = 0;
  uint64_t emitted_ = 0;
  std::array<float, kCapacity> scaled_{};
  float peakFollower_ = 0.0f;
  float appliedGain_ = 1.0f;
  bool voicing_ = false;
  int onsetWindows_ = 0;
  int releaseWindows_ = 0;
};

}  // namespace singz
