package com.singzplayer.split

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.Message
import android.os.Messenger
import android.os.RemoteException
import android.os.SystemClock
import android.util.Log
import com.singzplayer.MainActivity
import com.singzplayer.R
import java.io.File
import java.io.IOException
import kotlin.concurrent.thread

/**
 * The split job runner, in its own :split process so a memory kill can never
 * take the player down (bring-up measured 1.27 GB RSS on the session alone —
 * lmkd took the whole app on a 2 GB device). One job at a time. job.json in
 * filesDir/split-job is the truth the app process reads — atomic + fsynced,
 * and after DONE it stays behind so a relaunched app can still adopt the
 * stems (the doc is the handoff, not the event).
 *
 * Watchdog = the desktop chunk-pace rule: the first chunk gets 5 minutes
 * (session load included), after that 8x the rolling median of chunk times,
 * floored at 30 s. ORT's Run() cannot be interrupted, so a stall is answered
 * by persisting state=failed and killing our own process — the engine's
 * persisted tail turns the next start into a resume, not a loss.
 */
class SplitService : Service() {
  companion object {
    const val ACTION_START = "com.singzplayer.split.START"
    const val ACTION_CANCEL = "com.singzplayer.split.CANCEL"
    const val EXTRA_SRC = "src"
    const val EXTRA_MODEL = "model"
    const val EXTRA_PROJECT_DIR = "projectDir"
    const val EXTRA_RESUME = "resume"
    // Test seam: shrink the first-chunk cap so the watchdog path is drivable
    // in minutes-long CI, not hours. 0 = the real 5-minute default.
    const val EXTRA_WATCHDOG_CAP_MS = "watchdogCapMs"

    const val MSG_REGISTER = 1
    const val MSG_PROGRESS = 2
    const val MSG_STATE = 3

    private const val CHANNEL_ID = "split"
    private const val NOTIF_ID = 41
    private const val TAG = "SingzSplit"
    private const val DEFAULT_FIRST_CAP_MS = 5 * 60_000L

    /** Same six, same order, as kStemNames in split_engine.cpp. */
    val STEMS = arrayOf("drums", "bass", "other", "vocals", "guitar", "piano")

    fun jobDir(ctx: Context): File = File(ctx.filesDir, "split-job")
  }

  private val handler = Handler(Looper.getMainLooper())
  private val clients = ArrayList<Messenger>()
  private val messenger = Messenger(Handler(Looper.getMainLooper()) { msg ->
    if (msg.what == MSG_REGISTER) {
      // Dedupe by binder: the module rebinds fresh on every attach, and a
      // same-process binder stays valid across unbind — appending blindly
      // would double every event to JS.
      msg.replyTo?.let { m ->
        synchronized(clients) {
          if (clients.none { it.binder == m.binder }) clients.add(m)
        }
      }
      true
    } else false
  })

  @Volatile private var jobActive = false
  @Volatile private var cancelRequested = false
  private var firstCapMs = DEFAULT_FIRST_CAP_MS

  // Watchdog state lives on the worker thread except the armed Runnable.
  private val chunkDurations = ArrayDeque<Long>()
  private var lastChunkAt = 0L
  private val watchdog = Runnable { onStalled() }
  /** The app decides "is the service alive?" by whether job.json's
   *  updatedAtMs keeps moving. Chunks can be minutes apart on a slow phone
   *  and the engine reports nothing inside one, so the pulse rides a CLOCK,
   *  not callbacks — the file freezes only when this process is dead. */
  private val pulse = object : Runnable {
    override fun run() {
      if (!jobActive) return
      JobStore.touch(jobDir(this@SplitService))
      handler.postDelayed(this, 5_000)
    }
  }

  override fun onBind(intent: Intent?): IBinder = messenger.binder

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_CANCEL -> {
        if (jobActive) {
          cancelRequested = true
          // The worker may still be inside ensureLoaded — an external fun on
          // an unloaded lib throws on THIS thread and takes :split down with
          // no cleanup. The flag alone suffices then (re-asserted from the
          // listener once the engine runs).
          if (SingzCore.isLoaded()) SingzCore.cancelSplit()
          postNotification("Cancelling…", 0, 0, indeterminate = true)
        } else {
          stopSelf() // a stray cancel must not leave a started service idling
        }
      }
      ACTION_START -> {
        if (jobActive) {
          // One job at a time; the app checks splitStatus before starting.
          sendState("busy", null)
        } else {
          val src = intent.getStringExtra(EXTRA_SRC)
          val model = intent.getStringExtra(EXTRA_MODEL)
          if (src == null || model == null) {
            stopSelf()
          } else {
            jobActive = true
            cancelRequested = false
            firstCapMs = intent.getLongExtra(EXTRA_WATCHDOG_CAP_MS, 0L)
              .let { if (it > 0) it else DEFAULT_FIRST_CAP_MS }
            startInForeground()
            handler.removeCallbacks(pulse)
            handler.postDelayed(pulse, 5_000)
            val projectDir = intent.getStringExtra(EXTRA_PROJECT_DIR) ?: ""
            val wantResume = intent.getBooleanExtra(EXTRA_RESUME, false)
            thread(name = "singz-split-job") { runJob(src, model, projectDir, wantResume) }
          }
        }
      }
    }
    return START_NOT_STICKY
  }

  private fun runJob(src: String, model: String, projectDir: String, wantResume: Boolean) {
    val dir = jobDir(this)
    try {
      val loadErr = SingzCore.ensureLoaded()
      if (loadErr != null) {
        finishJob(dir, JobStore.STATE_FAILED, "Splitting is unavailable on this phone ($loadErr)")
        return
      }
      // A cancel that raced the library load set only the service flag
      // (the engine flag would have thrown pre-load) — honor it now.
      if (cancelRequested) {
        dir.deleteRecursively()
        finishJob(dir, JobStore.STATE_CANCELLED, null)
        return
      }

      val prev = JobStore.read(dir)
      val mixFile = File(dir, "mix.raw")
      // A resume needs the decoded mix and a rate on record; anything else is
      // a fresh start. The engine re-validates against tail.bin either way.
      val canResume = wantResume && prev != null && prev.srcPath == src &&
        prev.srcRate > 0 && mixFile.length() > 0 &&
        (prev.state == JobStore.STATE_SPLITTING || prev.state == JobStore.STATE_FAILED)

      val srcRate: Int
      var resumeHint = 0L
      if (canResume) {
        srcRate = prev!!.srcRate
        resumeHint = prev.chunksDone
        // The intent is the truth of THIS run — the doc must name the model
        // and target that actually produce the stems, not last time's.
        JobStore.write(dir, prev.copy(
          state = JobStore.STATE_SPLITTING, error = null,
          modelPath = model, projectDir = projectDir,
          updatedAtMs = System.currentTimeMillis()))
      } else {
        dir.deleteRecursively()
        JobStore.write(dir, JobStore.Job(
          JobStore.STATE_DECODING, src, projectDir, model,
          0, 0, 0, null, System.currentTimeMillis()))
        armWatchdog(firstCapMs)
        postNotification("Reading the song…", 0, 0, indeterminate = true)
        sendProgress("decode", 0f, 0, 0)
        var lastNotified = -1f
        val decoded = AudioDecode.decodeToRawF32Stereo(src, mixFile, { cancelRequested }) { frac ->
          // Each tick re-arms the watchdog: total decode time is uncapped
          // (a 2h+ file on slow flash is legitimate), while a genuine hang
          // is caught twice over — AudioDecode's own 30 s no-movement guard
          // and this cap running dry.
          armWatchdog(firstCapMs)
          sendProgress("decode", frac, 0, 0)
          if (frac - lastNotified >= 0.05f) {
            lastNotified = frac
            postNotification("Reading the song…", (frac * 100).toInt(), 100, indeterminate = false)
          }
        }
        srcRate = decoded.sampleRate
        JobStore.write(dir, JobStore.read(dir)!!.copy(
          state = JobStore.STATE_SPLITTING, srcRate = srcRate,
          updatedAtMs = System.currentTimeMillis()))
      }

      armWatchdog(firstCapMs)
      lastChunkAt = SystemClock.elapsedRealtime()
      var lastStageSentAt = 0L
      val listener = object : SingzCore.SplitListener {
        override fun onStage(stage: String, frac: Float) {
          // A cancel could land between the post-load check and runSplit's
          // entry reset of the engine flag — re-assert it from here.
          if (cancelRequested) SingzCore.cancelSplit()
          val now = SystemClock.elapsedRealtime()
          if (frac >= 1f || now - lastStageSentAt > 250) {
            lastStageSentAt = now
            sendProgress(stage, frac, 0, 0)
            if (stage == "load-model") postNotification("Warming up…", 0, 0, indeterminate = true)
          }
        }
        override fun onChunk(done: Long, total: Long) {
          if (cancelRequested) SingzCore.cancelSplit()
          feedWatchdog()
          val cur = JobStore.read(dir)
          if (cur != null) {
            JobStore.write(dir, cur.copy(
              chunksDone = done, totalChunks = total,
              updatedAtMs = System.currentTimeMillis()))
          }
          sendProgress("chunk", if (total > 0) done.toFloat() / total else 0f, done, total)
          postNotification(chunkText(done, total), done.toInt(), total.toInt(), indeterminate = false)
        }
      }

      val result = SingzCore.runSplit(model, mixFile.path, dir.path, srcRate, resumeHint, 0, listener)
      disarmWatchdog()
      when {
        result.isEmpty() -> {
          for (stem in STEMS) {
            val part = File(dir, "$stem.wav.part")
            val final = File(dir, "$stem.wav")
            final.delete()
            if (!part.renameTo(final)) throw IOException("could not finalize $stem.wav")
          }
          finishJob(dir, JobStore.STATE_DONE, null)
        }
        result == "cancelled" -> {
          dir.deleteRecursively() // an explicit cancel discards; nothing to resume
          finishJob(dir, JobStore.STATE_CANCELLED, null)
        }
        else -> finishJob(dir, JobStore.STATE_FAILED, result)
      }
    } catch (t: Throwable) {
      disarmWatchdog()
      if (cancelRequested) {
        dir.deleteRecursively()
        finishJob(dir, JobStore.STATE_CANCELLED, null)
      } else {
        Log.w(TAG, "split job failed", t)
        finishJob(dir, JobStore.STATE_FAILED, t.message ?: t.javaClass.simpleName)
      }
    }
  }

  /** Persist the terminal state (cancel leaves no dir on purpose), tell the
   *  app, drop the notification, stop. */
  private fun finishJob(dir: File, state: String, error: String?) {
    if (state != JobStore.STATE_CANCELLED) {
      try {
        val cur = JobStore.read(dir)
        if (cur != null) {
          JobStore.write(dir, cur.copy(state = state, error = error,
            updatedAtMs = System.currentTimeMillis()))
        }
      } catch (e: Exception) {
        Log.w(TAG, "persisting terminal state failed", e)
      }
    }
    sendState(state, error)
    handler.post {
      disarmWatchdog()
      handler.removeCallbacks(pulse)
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      jobActive = false
    }
  }

  // --- watchdog -----------------------------------------------------------

  private fun armWatchdog(ms: Long) {
    handler.removeCallbacks(watchdog)
    handler.postDelayed(watchdog, ms)
  }

  private fun disarmWatchdog() = handler.removeCallbacks(watchdog)

  private fun feedWatchdog() {
    val now = SystemClock.elapsedRealtime()
    chunkDurations.addLast(now - lastChunkAt)
    lastChunkAt = now
    if (chunkDurations.size > 5) chunkDurations.removeFirst()
    val median = chunkDurations.sorted()[chunkDurations.size / 2]
    armWatchdog(maxOf(30_000L, median * 8))
  }

  private fun onStalled() {
    Log.w(TAG, "chunk-pace watchdog fired — persisting and killing :split")
    try {
      val dir = jobDir(this)
      val cur = JobStore.read(dir)
      if (cur != null) {
        JobStore.write(dir, cur.copy(state = JobStore.STATE_FAILED,
          error = "Splitting stalled — resume to try again",
          updatedAtMs = System.currentTimeMillis()))
      }
    } catch (_: Exception) {}
    sendState(JobStore.STATE_FAILED, "stalled")
    stopForeground(STOP_FOREGROUND_REMOVE)
    // Run() cannot be interrupted; the persisted tail makes this recoverable.
    android.os.Process.killProcess(android.os.Process.myPid())
  }

  // The system's own FGS time budget (6 h for mediaProcessing/dataSync) —
  // unreachable at real split times, but the contract requires stopping fast.
  override fun onTimeout(startId: Int) = onSystemTimeout()
  override fun onTimeout(startId: Int, fgsType: Int) = onSystemTimeout()
  private fun onSystemTimeout() {
    try {
      val dir = jobDir(this)
      val cur = JobStore.read(dir)
      if (cur != null) {
        JobStore.write(dir, cur.copy(state = JobStore.STATE_FAILED,
          error = "The system stopped the split — resume to continue",
          updatedAtMs = System.currentTimeMillis()))
      }
    } catch (_: Exception) {}
    sendState(JobStore.STATE_FAILED, "timeout")
    stopForeground(STOP_FOREGROUND_REMOVE)
    android.os.Process.killProcess(android.os.Process.myPid())
  }

  // --- messaging ----------------------------------------------------------

  private fun sendProgress(stage: String, frac: Float, done: Long, total: Long) {
    val b = Bundle()
    b.putString("stage", stage)
    b.putFloat("frac", frac)
    b.putLong("done", done)
    b.putLong("total", total)
    send(MSG_PROGRESS, b)
  }

  private fun sendState(state: String, error: String?) {
    val b = Bundle()
    b.putString("state", state)
    if (error != null) b.putString("error", error)
    send(MSG_STATE, b)
  }

  private fun send(what: Int, data: Bundle) {
    synchronized(clients) {
      val it = clients.iterator()
      while (it.hasNext()) {
        try {
          it.next().send(Message.obtain(null, what).apply { this.data = data })
        } catch (_: RemoteException) {
          it.remove()
        }
      }
    }
  }

  // --- notification -------------------------------------------------------

  private fun startInForeground() {
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Splitting", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Progress while a song is split into stems"
      })
    val notif = buildNotification("Getting ready…", 0, 0, indeterminate = true)
    when {
      Build.VERSION.SDK_INT >= 35 ->
        startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING)
      Build.VERSION.SDK_INT >= 29 ->
        startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
      else -> startForeground(NOTIF_ID, notif)
    }
  }

  private fun chunkText(done: Long, total: Long): String {
    var eta = ""
    if (chunkDurations.size >= 2 && total > done) {
      val median = chunkDurations.sorted()[chunkDurations.size / 2]
      val secs = (median * (total - done)) / 1000
      eta = when {
        secs >= 90 -> " · about ${(secs + 30) / 60} min left"
        secs >= 5 -> " · about $secs sec left"
        else -> ""
      }
    }
    return "Chunk $done of $total$eta"
  }

  private fun postNotification(text: String, done: Int, total: Int, indeterminate: Boolean) {
    handler.post {
      if (!jobActive) return@post
      getSystemService(NotificationManager::class.java)
        .notify(NOTIF_ID, buildNotification(text, done, total, indeterminate))
    }
  }

  private fun buildNotification(text: String, done: Int, total: Int, indeterminate: Boolean): Notification {
    val cancelIntent = PendingIntent.getService(
      this, 0, Intent(this, SplitService::class.java).setAction(ACTION_CANCEL),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val contentIntent = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
    return Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_split)
      .setContentTitle("Splitting into stems")
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(contentIntent)
      .addAction(Notification.Action.Builder(null, "Cancel", cancelIntent).build())
      .apply {
        if (total > 0) setProgress(total, done, false)
        else if (indeterminate) setProgress(0, 0, true)
      }
      .build()
  }
}
