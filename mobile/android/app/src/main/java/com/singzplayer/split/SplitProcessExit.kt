package com.singzplayer.split

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build

/** Android's exit history is evidence, not a guess from a frozen heartbeat. */
object SplitProcessExit {
  data class Exit(
    val pid: Int,
    val processName: String,
    val timestampMs: Long,
    val reason: String,
    val status: Int,
    val description: String?,
    val pssKb: Long,
    val rssKb: Long
  )

  fun recover(job: JobStore.Job, processName: String, exits: List<Exit>): JobStore.Job {
    if (job.state != JobStore.STATE_DECODING && job.state != JobStore.STATE_SPLITTING) return job
    // Old records have no process identity: never attribute another run's death.
    if (job.processPid <= 0 || job.runStartedAtMs <= 0) return job
    val exit = exits.filter {
      it.pid == job.processPid && it.processName == processName &&
        it.timestampMs >= maxOf(job.runStartedAtMs, job.updatedAtMs)
    }.maxByOrNull { it.timestampMs } ?: return job
    val stage = job.stage.ifEmpty { job.state }
    val detail = exit.description?.takeIf { it.isNotBlank() }?.let { " — $it" } ?: ""
    val error = "Android stopped the split during $stage: ${exit.reason} " +
      "(status ${exit.status}, PSS ${exit.pssKb / 1024} MB, RSS ${exit.rssKb / 1024} MB)$detail"
    // A view of the durable record, not a write from the player process: the
    // service remains the only writer, and a racing Resume cannot be overwritten.
    return job.copy(state = JobStore.STATE_FAILED, error = error)
  }

  fun recover(context: Context, job: JobStore.Job): JobStore.Job {
    if (Build.VERSION.SDK_INT < 30 || job.processPid <= 0 ||
      (job.state != JobStore.STATE_DECODING && job.state != JobStore.STATE_SPLITTING)) return job
    return try {
      val manager = context.getSystemService(ActivityManager::class.java)
      val exits = manager.getHistoricalProcessExitReasons(context.packageName, job.processPid, 16)
        .map { Exit(it.pid, it.processName, it.timestamp, reasonName(it.reason),
          it.status, it.description, it.pss, it.rss) }
      recover(job, "${context.packageName}:split", exits)
    } catch (_: Exception) {
      // Some OEMs omit exit history; retain the ordinary heartbeat fallback.
      job
    }
  }

  private fun reasonName(reason: Int): String = when (reason) {
    ApplicationExitInfo.REASON_LOW_MEMORY -> "low memory"
    ApplicationExitInfo.REASON_CRASH_NATIVE -> "native crash"
    ApplicationExitInfo.REASON_CRASH -> "application crash"
    ApplicationExitInfo.REASON_ANR -> "application not responding"
    ApplicationExitInfo.REASON_SIGNALED -> "process signal"
    ApplicationExitInfo.REASON_EXCESSIVE_RESOURCE_USAGE -> "excessive resource usage"
    ApplicationExitInfo.REASON_USER_REQUESTED -> "stopped by the user or system"
    ApplicationExitInfo.REASON_USER_STOPPED -> "user stopped"
    ApplicationExitInfo.REASON_EXIT_SELF -> "process exited"
    ApplicationExitInfo.REASON_INITIALIZATION_FAILURE -> "process initialization failed"
    ApplicationExitInfo.REASON_PERMISSION_CHANGE -> "permission changed"
    ApplicationExitInfo.REASON_DEPENDENCY_DIED -> "process dependency died"
    ApplicationExitInfo.REASON_OTHER -> "system termination"
    else -> "exit reason $reason"
  }
}
