package com.singzplayer.split

/** Rate-limit repeated percentages, never a new stage or completion. */
class SplitProgressGate {
  private var lastStage = ""
  private var lastSentAtMs = 0L

  fun shouldSend(stage: String, frac: Float, nowMs: Long): Boolean {
    if (stage == lastStage && frac < 1f && nowMs - lastSentAtMs <= 250) return false
    lastStage = stage
    lastSentAtMs = nowMs
    return true
  }
}
