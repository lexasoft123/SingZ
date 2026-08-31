#pragma once

#include <atomic>
#include <cstdint>

#include <zcore/device/audio_input_callback_gate.h>
#include <zcore/device/audio_host_render.h>

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

struct IosAudioHostSessionSignals {
  std::atomic<uint32_t> pending{0};
  std::atomic<uint64_t> routeGeneration{1};
  AudioHostTerminalCauseLatch firstTerminalCause{};
  AudioInputCallbackGate observerAdmission{};
  void (*testObserve)(void*, IosAudioHostNotificationEdge) noexcept{nullptr};
  void* testContext{nullptr};
};

inline bool iosAudioHostCallbackTerminal(
    const IosAudioHostSessionSignals* signals) noexcept {
  return signals == nullptr || signals->firstTerminalCause.hasCause() ||
         signals->pending.load(std::memory_order_acquire) != 0;
}

bool publishIosAudioHostSessionChange(IosAudioHostSessionSignals* signals,
                                      uint32_t cause) noexcept;
void closeIosAudioHostSessionNotifications(
    IosAudioHostSessionSignals* signals) noexcept;
void waitForIosAudioHostSessionNotifications(
    const IosAudioHostSessionSignals* signals) noexcept;

}  // namespace singz::detail
