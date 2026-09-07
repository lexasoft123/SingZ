package com.singzplayer

import org.junit.Assert.assertThrows
import org.junit.Test

class DurablePreferenceWriteTest {
  @Test
  fun committedWriteReturnsNormally() {
    DurablePreferenceWrite.requireCommitted(true)
  }

  @Test
  fun failedCommitIsPropagated() {
    assertThrows(IllegalStateException::class.java) {
      DurablePreferenceWrite.requireCommitted(false)
    }
  }
}
