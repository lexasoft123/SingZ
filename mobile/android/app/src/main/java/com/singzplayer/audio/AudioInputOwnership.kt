package com.singzplayer.audio

/** Process-wide lease state. The native core has a second one-owner guard;
 * this layer adds owner/generation semantics for late JS and unplug events. */
class AudioInputOwnership {
  data class Active(val owner: String, val generation: Long, val deviceId: Int)

  private var active: Active? = null
  private var nextGeneration = 1L
  private var invalidated = false

  @Synchronized
  fun acquire(owner: String, deviceId: Int): Active? {
    if (invalidated || owner.isBlank() || active != null) return null
    return Active(owner, nextGeneration++, deviceId).also { active = it }
  }

  @Synchronized
  fun release(owner: String, generation: Long): Active? {
    val held = active ?: return null
    if (held.owner != owner || held.generation != generation) return null
    active = null
    return held
  }

  @Synchronized
  fun removeDevice(deviceId: Int): Active? {
    val held = active ?: return null
    if (held.deviceId != deviceId) return null
    active = null
    return held
  }

  @Synchronized
  fun clear(): Active? = active.also { active = null }

  @Synchronized
  fun current(): Active? = active

  @Synchronized
  fun isCurrent(candidate: Active): Boolean = !invalidated && active == candidate

  /** Closes the lifecycle gate immediately, before executor teardown. */
  @Synchronized
  fun invalidate(): Active? {
    invalidated = true
    return active.also { active = null }
  }

  @Synchronized
  fun isInvalidated(): Boolean = invalidated
}
