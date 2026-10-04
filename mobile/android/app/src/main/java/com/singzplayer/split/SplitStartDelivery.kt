package com.singzplayer.split

/** One bounded retry of an unacknowledged start; old callbacks cannot revive it. */
class SplitStartDelivery {
  private var generation = 0L
  private var pending: Long? = null

  @Synchronized fun begin(): Long {
    generation += 1
    pending = generation
    return generation
  }

  @Synchronized fun acknowledge(request: Long) {
    if (pending == request) pending = null
  }

  @Synchronized fun takeRetry(request: Long): Boolean {
    if (pending != request) return false
    pending = null
    return true
  }

  @Synchronized fun cancel() { pending = null }
}
