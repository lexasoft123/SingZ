#pragma once

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#include <utility>

namespace singz::detail {

// Owns the one off-RT timestamp sampler independently of the Oboe pair
// coordinator. Oboe's onErrorBeforeClose path may synchronously drain this
// owner without acquiring the pair or application-operation mutexes.
//
// stoppedThroughEpoch_ is deliberately monotonic. It closes the race where
// before-close runs just before start publishes the sampler thread: a start
// for an already-stopped epoch is rejected instead of querying a stream which
// Oboe is about to close.
class AndroidAudioHostSamplerOwner final {
 public:
  AndroidAudioHostSamplerOwner() = default;
  AndroidAudioHostSamplerOwner(const AndroidAudioHostSamplerOwner&) = delete;
  AndroidAudioHostSamplerOwner& operator=(
      const AndroidAudioHostSamplerOwner&) = delete;

  ~AndroidAudioHostSamplerOwner() { stopAndJoin(UINT64_MAX); }

  template <typename Function>
  bool start(uint64_t epoch, Function&& function) {
    if (epoch == 0) return false;
    std::lock_guard<std::mutex> lock(mutex_);
    if (thread_.joinable() || epoch <= stoppedThroughEpoch_) return false;
    stop_.store(0, std::memory_order_release);
    epoch_ = epoch;
    try {
      thread_ = std::thread(
          [this, body = std::forward<Function>(function)]() mutable {
            body(stop_);
          });
    } catch (...) {
      stop_.store(1, std::memory_order_release);
      epoch_ = 0;
      return false;
    }
    return true;
  }

  // Safe and idempotent from the Oboe error callback, public stop, and the
  // teardown worker. The sampler body never takes mutex_, so holding it while
  // joining cannot form a join cycle. Returning proves every query issued by
  // this epoch has completed.
  void stopAndJoin(uint64_t epoch) noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (epoch > stoppedThroughEpoch_) stoppedThroughEpoch_ = epoch;
    if (thread_.joinable() && epoch != UINT64_MAX && epoch_ > epoch) return;
    stop_.store(1, std::memory_order_release);
    if (thread_.joinable() && thread_.get_id() != std::this_thread::get_id() &&
        (epoch == UINT64_MAX || epoch_ <= epoch)) {
      thread_.join();
      epoch_ = 0;
    }
  }

  [[nodiscard]] bool runningFor(uint64_t epoch) const noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    return thread_.joinable() && epoch_ == epoch &&
           stop_.load(std::memory_order_acquire) == 0;
  }

 private:
  mutable std::mutex mutex_;
  std::thread thread_;
  std::atomic<uint32_t> stop_{1};
  uint64_t epoch_{0};
  uint64_t stoppedThroughEpoch_{0};
};

}  // namespace singz::detail
