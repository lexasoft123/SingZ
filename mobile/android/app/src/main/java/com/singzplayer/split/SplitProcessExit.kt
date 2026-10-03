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

  /** OS access and Android reason-code translation only; common TS owns
   *  attempt matching, terminal-state policy and failure formatting. */
  fun read(context: Context, pid: Int): List<Exit> {
    if (Build.VERSION.SDK_INT < 30 || pid <= 0) return emptyList()
    return try {
      val manager = context.getSystemService(ActivityManager::class.java)
      manager.getHistoricalProcessExitReasons(context.packageName, pid, 16)
        .map { Exit(it.pid, it.processName, it.timestamp, reasonName(it.reason),
          it.status, it.description, it.pss, it.rss) }
    } catch (_: Exception) {
      // Some OEMs omit exit history; common TS retains the heartbeat fallback.
      emptyList()
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
