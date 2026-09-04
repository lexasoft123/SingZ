package com.singzplayer.playback

/**
 * Which native playback generations the Android bridge answers for, and
 * what a fail-closed event must retire.
 *
 * The core keeps at most two generations alive at once: the song that is
 * rendering and, from the claim of a swap candidate until the seam lands,
 * the replacement prepared FROM it. Cancelling or unloading the candidate
 * alone leaves the song playing — that is the core's contract for a
 * candidate JavaScript gives up on — so a focus loss or route change that
 * retired only the newest generation silenced the candidate and let the
 * song keep rendering under lost focus; and giving a candidate up released
 * the focus it had inherited while the song played on with none. This
 * ledger is the one account of both generations. The module reads its
 * verdicts and touches AudioManager and the core; nothing else in the
 * module remembers a generation. It is pure so the rules are testable
 * without a device (NativePlaybackGenerationLedgerTest).
 *
 * Focus is granted to a generation at configureOutputSession. A candidate
 * never configures a session of its own, so its claim moves the focus to
 * it and giving it up moves the focus back.
 */
class NativePlaybackGenerationLedger {
  /** The newest generation claimed: the song, or a swap candidate. */
  @Volatile var current = 0L
    private set

  /** The song a claimed candidate was prepared from, until either is
   *  unloaded. The core answers the unload of a generation a landed swap
   *  replaced as an acknowledgement, and JavaScript sends exactly that
   *  after every landing — which is how this side learns the song's number
   *  changed. */
  @Volatile var outgoing = 0L
    private set

  @Volatile var focusGeneration = 0L
    private set

  @Volatile var focusOwned = false
    private set

  class FailClosed(val targets: List<Long>, val releaseFocus: Boolean)

  fun ownsFocus(generation: Long): Boolean = focusOwned && focusGeneration == generation

  /** The claim for `generation` succeeded; `from` is the generation it was
   *  prepared from, 0 for a fresh song. A candidate inherits the focus of
   *  the song it replaces — at the claim, before the prepare verdict, so a
   *  refusal takes the same road back as an abandoned candidate. */
  @Synchronized
  fun claimed(generation: Long, from: Long) {
    if (from != 0L && current != 0L && current != generation) {
      outgoing = current
      if (ownsFocus(current)) focusGeneration = generation
    } else {
      outgoing = 0
    }
    current = generation
  }

  @Synchronized
  fun focusGranted(generation: Long) {
    focusGeneration = generation
    focusOwned = true
  }

  /** One generation retired by JavaScript. `songRemains` is what the core's
   *  answer said — a candidate it cancelled by name is answered with the
   *  live session's state, a teardown with unloaded/stopped/terminal — and
   *  it is the only way to tell a candidate given up on from the song
   *  itself unloaded while this side still remembers the generation the
   *  seam replaced (the acknowledgement rides the next poll, which can be
   *  the two-second idle one). Returns true when the system focus request
   *  is to be abandoned: only when the generation that owned the focus is
   *  gone with no song left to hand it to. */
  @Synchronized
  fun unloaded(generation: Long, songRemains: Boolean): Boolean {
    if (generation <= 0) return false
    if (generation == outgoing) {
      // The seam landed, or the song was retired behind its candidate:
      // either way the candidate is the song now, and already holds focus.
      outgoing = 0
    } else if (generation == current) {
      if (songRemains && outgoing != 0L) {
        // A candidate given up on hands the focus it inherited back to the
        // song that is still playing.
        current = outgoing
        outgoing = 0
        if (ownsFocus(generation)) focusGeneration = current
      } else {
        // The song itself is gone, whatever this side still remembered
        // behind it; the last generation standing takes the focus down.
        current = 0
        outgoing = 0
      }
    }
    return releaseFocus(generation)
  }

  /** Focus released for a generation that stays claimed (a retaining
   *  unload keeps the decoded lanes and the generation with them). */
  @Synchronized
  fun releaseFocus(generation: Long): Boolean {
    if (!ownsFocus(generation)) return false
    focusOwned = false
    focusGeneration = 0
    return true
  }

  /** Every generation, newest first, and whether the focus request is to
   *  be abandoned. The ledger forgets them here: nothing survives a
   *  fail-closed event, and a generation it retired twice would only be
   *  cancelled twice. */
  @Synchronized
  fun failClosed(): FailClosed {
    val targets = listOf(current, outgoing).filter { it > 0 }.distinct()
    val release = focusOwned
    current = 0
    outgoing = 0
    focusOwned = false
    focusGeneration = 0
    return FailClosed(targets, release)
  }
}
