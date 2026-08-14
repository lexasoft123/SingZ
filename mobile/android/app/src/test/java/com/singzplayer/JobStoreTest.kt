package com.singzplayer

import com.singzplayer.split.JobStore
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The split job's cross-process record, held to its contract on the JVM:
 * round-trip fidelity, atomic replacement, the read side's tolerance of
 * absence and garbage, and touch()'s refusal to pulse a settled job. The
 * kill-mid-write path itself is proven on-device (mobile/tests/
 * split-android.cjs); what a plain filesystem can prove lives here.
 */
class JobStoreTest {
  @get:Rule val tempFolder = TemporaryFolder()

  private fun tmp(): File = tempFolder.newFolder()

  private fun job(state: String = JobStore.STATE_SPLITTING) = JobStore.Job(
    state = state,
    srcPath = "/data/x/song.wav",
    projectDir = "My song",
    modelPath = "/data/x/model.onnx",
    srcRate = 44100,
    chunksDone = 3,
    totalChunks = 7,
    error = null,
    updatedAtMs = 1_000L
  )

  @Test
  fun roundTripKeepsEveryField() {
    val dir = tmp()
    JobStore.write(dir, job())
    assertEquals(job(), JobStore.read(dir))
  }

  @Test
  fun errorFieldSurvivesOnlyWhenPresent() {
    val dir = tmp()
    JobStore.write(dir, job(JobStore.STATE_FAILED).copy(error = "stalled"))
    assertEquals("stalled", JobStore.read(dir)?.error)
    JobStore.write(dir, job())
    assertNull(JobStore.read(dir)?.error)
  }

  @Test
  fun writeReplacesAtomically_noPartLeftBehind() {
    val dir = tmp()
    JobStore.write(dir, job())
    JobStore.write(dir, job().copy(chunksDone = 4))
    assertEquals(4L, JobStore.read(dir)?.chunksDone)
    assertTrue("no .part after a completed write", !File(dir, "job.json.part").exists())
  }

  @Test
  fun missingAndTornDocsReadAsNull() {
    val dir = tmp()
    assertNull(JobStore.read(dir))
    File(dir, "job.json").writeText("{ not json")
    assertNull(JobStore.read(dir))
  }

  @Test
  fun touchPulsesOnlyActiveStates() {
    val dir = tmp()
    JobStore.write(dir, job().copy(updatedAtMs = 1L))
    JobStore.touch(dir)
    val active = JobStore.read(dir)!!
    assertTrue("active job pulsed", active.updatedAtMs > 1L)
    assertEquals("pulse must not disturb progress", 3L, active.chunksDone)

    JobStore.write(dir, job(JobStore.STATE_DONE).copy(updatedAtMs = 5L))
    JobStore.touch(dir)
    assertEquals("a settled job must not look alive", 5L, JobStore.read(dir)?.updatedAtMs)
  }

  @Test
  fun touchOnNothingIsANoop() {
    JobStore.touch(tmp()) // must neither throw nor create a doc
  }
}
