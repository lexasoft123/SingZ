package com.singzplayer.split

import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import org.json.JSONObject

/**
 * The split job's cross-process record: job.json in the job dir, written by
 * the :split service and read by the app process (and by tests over run-as,
 * which is the decode-safe probe). Every write is atomic + fsynced — the doc
 * may be one chunk behind after a kill but never torn, and the engine treats
 * chunksDone as a HINT anyway (tail.bin is the resume authority).
 */
object JobStore {
  const val STATE_DECODING = "decoding"
  const val STATE_SPLITTING = "splitting"
  const val STATE_DONE = "done"
  const val STATE_CANCELLED = "cancelled"
  const val STATE_FAILED = "failed"

  data class Job(
    val state: String,
    val srcPath: String,
    val projectDir: String,
    val modelPath: String,
    val srcRate: Int,
    val chunksDone: Long,
    val totalChunks: Long,
    val error: String?,
    val updatedAtMs: Long,
    val processPid: Int = 0,
    val runStartedAtMs: Long = 0,
    val stage: String = ""
  )

  fun file(dir: File): File = File(dir, "job.json")

  fun read(dir: File): Job? {
    val text = try { file(dir).readText() } catch (_: Exception) { return null }
    return try {
      val o = JSONObject(text)
      Job(
        state = o.optString("state", ""),
        srcPath = o.optString("srcPath", ""),
        projectDir = o.optString("projectDir", ""),
        modelPath = o.optString("modelPath", ""),
        srcRate = o.optInt("srcRate", 0),
        chunksDone = o.optLong("chunksDone", 0),
        totalChunks = o.optLong("totalChunks", 0),
        error = if (o.has("error")) o.optString("error") else null,
        updatedAtMs = o.optLong("updatedAtMs", 0),
        processPid = o.optInt("processPid", 0),
        runStartedAtMs = o.optLong("runStartedAtMs", 0),
        stage = o.optString("stage", "")
      )
    } catch (_: Exception) {
      null
    }
  }

  /** The liveness pulse: bump updatedAtMs while the job is genuinely active.
   *  Read and write inside one lock hold — a racing chunk update must never
   *  be written back stale. */
  @Synchronized
  fun touch(dir: File) {
    val cur = read(dir) ?: return
    if (cur.state != STATE_DECODING && cur.state != STATE_SPLITTING) return
    try {
      write(dir, cur.copy(updatedAtMs = System.currentTimeMillis()))
    } catch (_: Exception) {
      // a missed pulse only delays the app's verdict, never corrupts it
    }
  }

  /** Stage evidence survives a missing Messenger event or a native crash. */
  @Synchronized
  fun setStage(dir: File, stage: String) {
    val cur = read(dir) ?: return
    if (cur.state != STATE_DECODING && cur.state != STATE_SPLITTING) return
    if (cur.stage == stage) return
    try {
      write(dir, cur.copy(stage = stage, updatedAtMs = System.currentTimeMillis()))
    } catch (_: Exception) {
      // Diagnostics must not stop an otherwise healthy split.
    }
  }

  // Synchronized: the watchdog (main thread) can write a failure while the
  // worker is mid-chunk-update — two writers on one .part path would tear it.
  @Synchronized
  fun write(dir: File, job: Job) {
    dir.mkdirs()
    val part = File(dir, "job.json.part")
    FileOutputStream(part).use { out ->
      val o = JSONObject()
      o.put("version", 1)
      o.put("state", job.state)
      o.put("srcPath", job.srcPath)
      o.put("projectDir", job.projectDir)
      o.put("modelPath", job.modelPath)
      o.put("srcRate", job.srcRate)
      o.put("chunksDone", job.chunksDone)
      o.put("totalChunks", job.totalChunks)
      if (job.error != null) o.put("error", job.error)
      o.put("updatedAtMs", job.updatedAtMs)
      o.put("processPid", job.processPid)
      o.put("runStartedAtMs", job.runStartedAtMs)
      o.put("stage", job.stage)
      out.write(o.toString().toByteArray())
      out.fd.sync()
    }
    if (!part.renameTo(file(dir))) throw IOException("could not replace job.json")
  }
}
