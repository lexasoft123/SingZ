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
    val updatedAtMs: Long
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
        updatedAtMs = o.optLong("updatedAtMs", 0)
      )
    } catch (_: Exception) {
      null
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
      out.write(o.toString().toByteArray())
      out.fd.sync()
    }
    if (!part.renameTo(file(dir))) throw IOException("could not replace job.json")
  }
}
