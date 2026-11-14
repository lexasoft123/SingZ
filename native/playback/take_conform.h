#pragma once
#include <atomic>
#include <filesystem>
#include <cstdint>
#include <string>
#include <stdexcept>
#include <vector>

namespace singz {
inline constexpr const char *kTakeConformVersion = "take-conform-3";
inline constexpr uint64_t kTakeConformMaximumSeconds = 4u * 60u * 60u;
enum class TakeConformFailure { TakeTooLong, MemoryBudget, ConformError, Cancelled, PathTooLong };
inline const char *takeConformFailureCode(TakeConformFailure code) noexcept {
  switch (code) {
    case TakeConformFailure::TakeTooLong: return "take-too-long";
    case TakeConformFailure::MemoryBudget: return "memory-budget";
    case TakeConformFailure::PathTooLong: return "path-too-long";
    case TakeConformFailure::Cancelled: return "cancelled";
    default: return "conform-error";
  }
}
class TakeConformError : public std::runtime_error {
 public:
  TakeConformError(TakeConformFailure code, const std::string &detail): std::runtime_error(detail), code_(code) {}
  TakeConformFailure code() const noexcept { return code_; }
 private:
  TakeConformFailure code_;
};
struct TakeConformAnchor { uint64_t takeFrame; double projectFrame; };
struct TakeConformSetting { uint64_t takeFrame; double transposeSemitones; };
struct TakeConformEffect {
  std::string id{"pitch-follow"};
  bool enabled{true};
  double manualOffsetSemitones{0};
  bool preserveFormants{false};
};
struct TakeConformRequest {
  // Both coordinates are at the raw WAV rate; song duration is at outputRate.
  std::vector<TakeConformAnchor> anchors;
  std::vector<TakeConformSetting> settings;
  std::vector<TakeConformEffect> effects;
  uint64_t songDurationProjectFrames{0};
  double startPositionSec{0}, userOffsetSec{0};
  uint32_t outputRate{48000};
};
struct TakeConformStreamResult {
  uint64_t durationFrames{0};
  uint32_t inputLatencyFrames{0}, outputLatencyFrames{0};
  uint32_t signalsmithPasses{0};
  uint64_t processedBlocks{0};
};
// Normalises Windows drive/UNC/relative paths before adding the wide-API
// extended-length namespace. Returned lane paths keep that namespace.
// Pure Windows formatter shared by IO and portable path regressions. Input is
// absolute; the IO wrapper resolves current-drive/relative paths first.
std::wstring takeConformWindowsPath(const std::wstring &);
std::filesystem::path takeConformFilePath(const std::string &);
// Offline, bounded-block file-to-file render. The destination must be a fresh
// temporary path: exceptions/cancellation close and remove it. Header patch and
// fsync complete before return; the cache owner atomically renames it afterwards.
// The peak scan is a separate bounded read pass to preserve v2 normalisation.
TakeConformStreamResult conformTakeFile(const std::string &inputPath,
    const std::string &temporaryOutputPath, const TakeConformRequest &,
    const std::atomic<bool> *cancel = nullptr);
} // namespace singz
