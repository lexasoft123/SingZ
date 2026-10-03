package com.singzplayer

import com.singzplayer.split.JobStore
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test

class SplitRecoveryTest {
  private val running = JobStore.Job(
    JobStore.STATE_SPLITTING, "/song.mp3", "/project", "/model.onnx", 44100,
    2, 20, null, 1200, processPid = 41, runStartedAtMs = 1000, stage = "load-model")

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
    } finally { dir.deleteRecursively() }
  }
}
