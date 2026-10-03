package com.singzplayer

import com.singzplayer.split.JobStore
import com.singzplayer.split.SplitProcessExit
import com.singzplayer.split.SplitProgressGate
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class SplitRecoveryTest {
  private val process = "com.lexasoft.singz:split"
  private val running = JobStore.Job(
    JobStore.STATE_SPLITTING, "/song.mp3", "/project", "/model.onnx", 44100,
    2, 20, null, 1200, processPid = 41, runStartedAtMs = 1000, stage = "load-model")

  private fun exit(pid: Int = 41, name: String = process, at: Long = 1300) =
    SplitProcessExit.Exit(pid, name, at, "native crash", 11, "SIGSEGV", 256 * 1024, 300 * 1024)

  @Test fun `model loading immediately after resample is never suppressed`() {
    val gate = SplitProgressGate()
    assertTrue(gate.shouldSend("resample", 0f, 1000))
    assertTrue(gate.shouldSend("load-model", 0f, 1001))
    assertFalse(gate.shouldSend("load-model", 0f, 1100))
    assertTrue(gate.shouldSend("split", 0f, 1101))
  }

  @Test fun `repeat progress is throttled but completion and later progress pass`() {
    val gate = SplitProgressGate()
    assertTrue(gate.shouldSend("resample", 0f, 0))
    assertFalse(gate.shouldSend("resample", 0.5f, 250))
    assertTrue(gate.shouldSend("resample", 0.5f, 251))
    assertTrue(gate.shouldSend("resample", 1f, 252))
  }

  @Test fun `native death returns actionable failure without waiting ninety seconds`() {
    val recovered = SplitProcessExit.recover(running, process, listOf(exit()))
    assertEquals(JobStore.STATE_FAILED, recovered.state)
    assertTrue(recovered.error!!.contains("during load-model: native crash"))
    assertTrue(recovered.error!!.contains("status 11, PSS 256 MB, RSS 300 MB"))
    assertTrue(recovered.error!!.contains("SIGSEGV"))
    assertEquals(running.updatedAtMs, recovered.updatedAtMs) // failure counted once
    assertEquals(running.chunksDone, recovered.chunksDone) // resume tail is retained
    assertEquals(JobStore.STATE_SPLITTING, running.state) // no mutation of the record
  }

  @Test fun `another process or previous run cannot fail a current split`() {
    for (unrelated in listOf(exit(pid = 42), exit(name = "com.lexasoft.singz"),
      exit(at = 999), exit(at = 1199))) {
      assertEquals(running, SplitProcessExit.recover(running, process, listOf(unrelated)))
    }
    val resumed = running.copy(runStartedAtMs = 2000, updatedAtMs = 2000)
    assertEquals(resumed, SplitProcessExit.recover(resumed, process, listOf(exit())))
  }

  @Test fun `old documents and terminal verdicts are left alone`() {
    for (job in listOf(running.copy(processPid = 0), running.copy(runStartedAtMs = 0),
      running.copy(state = JobStore.STATE_DONE), running.copy(state = JobStore.STATE_CANCELLED),
      running.copy(state = JobStore.STATE_FAILED, error = "Splitting stalled"))) {
      assertEquals(job, SplitProcessExit.recover(job, process, listOf(exit())))
    }
    assertEquals(running, SplitProcessExit.recover(running, process, emptyList()))
  }

  @Test fun `the newest matching exit supplies the reason`() {
    val older = exit().copy(reason = "low memory", timestampMs = 1250)
    val recovered = SplitProcessExit.recover(running, process, listOf(older, exit()))
    assertTrue(recovered.error!!.contains("native crash"))
  }

  @Test fun `process identity and stage survive heartbeat writes and relaunch`() {
    val dir = Files.createTempDirectory("singz-job").toFile()
    try {
      JobStore.write(dir, running)
      assertEquals(running, JobStore.read(dir))
      JobStore.setStage(dir, "split")
      JobStore.touch(dir)
      val job = JobStore.read(dir)!!
      assertEquals(41, job.processPid)
      assertEquals(1000L, job.runStartedAtMs)
      assertEquals("split", job.stage)
      assertEquals(2L, job.chunksDone)
      JobStore.write(dir, job.copy(state = JobStore.STATE_FAILED, error = "stalled"))
      JobStore.setStage(dir, "chunk")
      assertEquals("split", JobStore.read(dir)!!.stage)
    } finally { dir.deleteRecursively() }
  }

  @Test fun `version one job without new fields still reads`() {
    val dir = Files.createTempDirectory("singz-old-job").toFile()
    try {
      JobStore.file(dir).writeText("""{"version":1,"state":"splitting","srcPath":"/song.mp3", "updatedAtMs":1200}""")
      val job = JobStore.read(dir)!!
      assertEquals(0, job.processPid)
      assertEquals(0L, job.runStartedAtMs)
      assertEquals("", job.stage)
      assertEquals(job, SplitProcessExit.recover(job, process, listOf(exit())))
    } finally { dir.deleteRecursively() }
  }
}
