package com.singzplayer.audio

/**
 * Two-phase synchronous stop boundary. The active token remains installed
 * while [stopNative] runs and is released only after native positively
 * confirms teardown. A false result or exception deliberately leaves the
 * lease recoverable, so the same owner/generation can retry.
 *
 * Calls are serialized by AudioInputModule's control executor. We must not
 * hold AudioInputOwnership's monitor while invoking native stop: native stop
 * joins the delivery thread, whose final listener can call isCurrent().
 */
class AudioInputStopController(
  private val ownership: AudioInputOwnership,
  private val stopNative: () -> Boolean
) {
  fun stop(owner: String, generation: Long): AudioInputOwnership.Active? {
    val held = ownership.current() ?: return null
    if (held.owner != owner || held.generation != generation) return null
    if (!stopNative()) return null
    return ownership.release(owner, generation)
  }
}
