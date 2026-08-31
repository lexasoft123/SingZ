#pragma once

#include <atomic>
#include <cstdint>

#include <zcore/device/audio_input_callback_gate.h>
#include <zcore/device/audio_host_render.h>

#if defined(__GNUC__) || defined(__clang__)
#define SINGZ_ZCORE_IOS_SESSION_LOCAL __attribute__((visibility("hidden")))
#else
#define SINGZ_ZCORE_IOS_SESSION_LOCAL
#endif

namespace singz::detail {

enum IosAudioHostSessionChange : uint32_t {
  IosAudioHostRouteChanged = 1u << 0,
  IosAudioHostInterrupted = 1u << 1,
  IosAudioHostMediaServicesLost = 1u << 2,
  IosAudioHostMediaServicesReset = 1u << 3,
};

enum class IosAudioHostNotificationEdge : uint32_t {
  Entered,
  TerminalCausePublished,
  PendingPublished,
  GenerationPublished,
};

struct SINGZ_ZCORE_IOS_SESSION_LOCAL IosAudioHostSessionSignals {
  std::atomic<uint32_t> pending{0};
  std::atomic<uint64_t> routeGeneration{1};
  AudioHostTerminalCauseLatch firstTerminalCause{};
  AudioInputCallbackGate observerAdmission{};
  void (*testObserve)(void*, IosAudioHostNotificationEdge) noexcept{nullptr};
  void* testContext{nullptr};
};

SINGZ_ZCORE_IOS_SESSION_LOCAL inline bool iosAudioHostCallbackTerminal(
    const IosAudioHostSessionSignals* signals) noexcept {
  return signals == nullptr || signals->firstTerminalCause.hasCause() ||
         signals->pending.load(std::memory_order_acquire) != 0;
}

SINGZ_ZCORE_IOS_SESSION_LOCAL bool publishIosAudioHostSessionChange(
    IosAudioHostSessionSignals* signals, uint32_t cause) noexcept;
SINGZ_ZCORE_IOS_SESSION_LOCAL void closeIosAudioHostSessionNotifications(
    IosAudioHostSessionSignals* signals) noexcept;
SINGZ_ZCORE_IOS_SESSION_LOCAL void waitForIosAudioHostSessionNotifications(
    const IosAudioHostSessionSignals* signals) noexcept;

}  // namespace singz::detail

#undef SINGZ_ZCORE_IOS_SESSION_LOCAL
