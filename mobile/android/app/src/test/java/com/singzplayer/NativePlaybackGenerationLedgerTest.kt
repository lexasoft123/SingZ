package com.singzplayer

import com.singzplayer.playback.NativePlaybackGenerationLedger
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The fail-closed rules of the Android bridge, off the device. Each case is
 * a sequence the phone actually runs: the claim/focus/unload calls in the
 * order JavaScript makes them, then a focus loss or a route change.
 */
class NativePlaybackGenerationLedgerTest {
  private fun playingSong(ledger: NativePlaybackGenerationLedger, generation: Long) {
    ledger.claimed(generation, 0)
    ledger.focusGranted(generation)
  }

  @Test
  fun aFocusLossDuringAnArmedSwapRetiresTheSongAndTheCandidate() {
    val ledger = NativePlaybackGenerationLedger()
    playingSong(ledger, 7)
    ledger.claimed(8, 7)
    val verdict = ledger.failClosed()
    // Newest first: the candidate, then the song still rendering behind it —
    // cancelling the candidate alone leaves the song playing.
    assertEquals(listOf(8L, 7L), verdict.targets)
    assertTrue(verdict.releaseFocus)
    assertEquals(0L, ledger.current)
    assertEquals(0L, ledger.outgoing)
    assertFalse(ledger.focusOwned)
  }

  @Test
  fun aCandidateInheritsFocusAtItsClaimAndHandsItBackWhenGivenUp() {
    val ledger = NativePlaybackGenerationLedger()
    playingSong(ledger, 7)
    ledger.claimed(8, 7)
    assertTrue(ledger.ownsFocus(8))
    assertFalse(ledger.ownsFocus(7))
    // Refused, failed or abandoned: the candidate is unloaded, the song is
    // still the song, and the focus request is NOT abandoned.
    assertFalse(ledger.unloaded(8, songRemains = true))
    assertEquals(7L, ledger.current)
    assertEquals(0L, ledger.outgoing)
    assertTrue(ledger.ownsFocus(7))
    // Only the song's own unload takes the focus down.
    assertTrue(ledger.unloaded(7, songRemains = false))
    assertEquals(0L, ledger.current)
    assertFalse(ledger.focusOwned)
  }

  @Test
  fun aLandedSeamIsAcknowledgedByUnloadingTheReplacedGeneration() {
    val ledger = NativePlaybackGenerationLedger()
    playingSong(ledger, 7)
    ledger.claimed(8, 7)
    // The acknowledgement carries the LIVE state: the core answers an unload
    // of the generation a landed swap replaced with the session's own state,
    // which is running.
    assertFalse(ledger.unloaded(7, songRemains = true))
    assertEquals(8L, ledger.current)
    assertEquals(0L, ledger.outgoing)
    assertTrue(ledger.ownsFocus(8))
    // A later focus loss retires the replacement alone; the old number is
    // not cancelled a second time.
    val verdict = ledger.failClosed()
    assertEquals(listOf(8L), verdict.targets)
    assertTrue(verdict.releaseFocus)
  }

  @Test
  fun aSongUnloadedBeforeItsSeamWasAcknowledgedReleasesFocus() {
    val ledger = NativePlaybackGenerationLedger()
    playingSong(ledger, 7)
    ledger.claimed(8, 7)
    // The seam landed and the singer left the player before the next poll
    // carried the acknowledgement: the core tears 8 down (7 was retired at
    // the seam) and says so. This is NOT a candidate given up on — the
    // focus must go down with the song, not to a generation that is gone.
    assertTrue(ledger.unloaded(8, songRemains = false))
    assertFalse(ledger.focusOwned)
    assertEquals(0L, ledger.current)
    assertEquals(0L, ledger.outgoing)
    assertEquals(emptyList<Long>(), ledger.failClosed().targets)
  }

  @Test
  fun aFreshClaimForgetsTheGenerationsBeforeIt() {
    val ledger = NativePlaybackGenerationLedger()
    playingSong(ledger, 7)
    ledger.claimed(8, 7)
    // Next song: claimed from nothing. Whatever the swap left is not this
    // claim's to retire; its focus arrives at configureOutputSession.
    ledger.claimed(9, 0)
    assertEquals(9L, ledger.current)
    assertEquals(0L, ledger.outgoing)
    ledger.focusGranted(9)
    assertEquals(listOf(9L), ledger.failClosed().targets)
  }

  @Test
  fun aRetainingUnloadReleasesFocusAndKeepsTheGeneration() {
    val ledger = NativePlaybackGenerationLedger()
    playingSong(ledger, 7)
    assertTrue(ledger.releaseFocus(7))
    assertFalse(ledger.focusOwned)
    // The decoded lanes are still held under generation 7, so backgrounding
    // and module teardown must still find it.
    assertEquals(listOf(7L), ledger.failClosed().targets)
  }

  @Test
  fun nothingClaimedIsNothingToRetire() {
    val ledger = NativePlaybackGenerationLedger()
    val verdict = ledger.failClosed()
    assertEquals(emptyList<Long>(), verdict.targets)
    assertFalse(verdict.releaseFocus)
    assertFalse(ledger.unloaded(0, songRemains = false))
    assertFalse(ledger.unloaded(3, songRemains = true))
  }
}
