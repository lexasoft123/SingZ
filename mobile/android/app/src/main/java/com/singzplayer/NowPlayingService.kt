package com.singzplayer

import android.app.Notification
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Keeps a PLAYING song alive once the app leaves the screen: a mediaPlayback
 * foreground service carrying NowPlayingModule's media notification, plus the
 * target of that notification's buttons.
 *
 * Three things about its lifecycle are deliberate:
 *
 *  - It is only ever foreground while a song plays. Pause detaches it
 *    (STOP_FOREGROUND_DETACH: the notification stays, and becomes
 *    dismissible) — a paused song holding a foreground service is exactly the
 *    kind of thing Android's FGS policy exists to stop.
 *  - Once started with startForegroundService it ALWAYS calls startForeground,
 *    even when the song was paused or closed while the start was in flight:
 *    Android kills an app whose service misses that call. It then detaches or
 *    stops at once, according to what was last wanted.
 *  - Swiping the app away pauses the song rather than leaving it playing with
 *    no screen and no way back to it except the notification.
 */
class NowPlayingService : Service() {

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    instance = this
    when (intent?.action) {
      ACTION_FOREGROUND -> goForeground()
      ACTION_PLAY, ACTION_PAUSE, ACTION_SKIP_FORWARD, ACTION_SKIP_BACKWARD -> {
        if (!NowPlayingModule.fromNotification(intent.action!!)) {
          // Nobody to take it: the process was killed and restarted by this
          // very tap, or the song was closed. The notification is a leftover —
          // take it away rather than leave buttons that do nothing.
          getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
          stopSelf(startId)
        } else if (wanted == Wanted.STOPPED) {
          // A button pressed on a notification left behind by a service that
          // has since stopped starts a plain one; do not keep it around.
          stopSelf(startId)
        }
      }
      else -> if (wanted == Wanted.STOPPED) stopSelf(startId)
    }
    return START_NOT_STICKY
  }

  private fun goForeground() {
    val n = notification
    if (n == null) {
      // Nothing to show means the song was closed before the start landed.
      // startForeground is still owed; a bare notification pays it.
      startForegroundCompat(Notification.Builder(this, NowPlayingModule.CHANNEL_ID)
        .setSmallIcon(R.drawable.ic_stat_now_playing).build())
      finish()
      return
    }
    if (!startForegroundCompat(n)) return
    when (wanted) {
      Wanted.FOREGROUND -> Unit
      Wanted.DETACHED -> detach(notification ?: n)
      Wanted.STOPPED -> finish()
    }
  }

  private fun startForegroundCompat(n: Notification): Boolean =
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(NOTIFICATION_ID, n)
      }
      foreground = true
      true
    } catch (e: Exception) {
      // Android 12+ refuses outside its exemptions (ForegroundServiceStart-
      // NotAllowedException); the song then parks in the background as it did
      // before this service existed. Say so where the logcat shows it.
      Log.w(TAG, "startForeground refused — a playing song will park in the background", e)
      foreground = false
      stopSelf()
      false
    }

  private fun detach(n: Notification) {
    if (foreground) {
      stopForeground(STOP_FOREGROUND_DETACH)
      foreground = false
    }
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
  }

  private fun finish() {
    stopForeground(STOP_FOREGROUND_REMOVE)
    foreground = false
    getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    stopSelf()
  }

  override fun onTaskRemoved(rootIntent: Intent?) {
    NowPlayingModule.fromNotification(ACTION_PAUSE)
    wanted = Wanted.STOPPED
    finish()
    super.onTaskRemoved(rootIntent)
  }

  override fun onDestroy() {
    if (instance === this) instance = null
    foreground = false
    super.onDestroy()
  }

  private enum class Wanted { FOREGROUND, DETACHED, STOPPED }

  companion object {
    private const val TAG = "NowPlayingService"
    const val NOTIFICATION_ID = 4210
    const val ACTION_FOREGROUND = "singz.nowplaying.FOREGROUND"
    const val ACTION_PLAY = "singz.nowplaying.PLAY"
    const val ACTION_PAUSE = "singz.nowplaying.PAUSE"
    const val ACTION_SKIP_FORWARD = "singz.nowplaying.SKIP_FORWARD"
    const val ACTION_SKIP_BACKWARD = "singz.nowplaying.SKIP_BACKWARD"

    /** The notification the service shows, always the latest one built. */
    @Volatile var notification: Notification? = null
    /** Whether startForeground has succeeded and not been undone. */
    @Volatile var foreground = false
      private set
    @Volatile private var instance: NowPlayingService? = null
    @Volatile private var wanted = Wanted.STOPPED

    /** A song started playing. Returns whether the OS accepted the start —
     *  a refusal here is synchronous; one inside the service is logged. */
    fun enterForeground(ctx: Context, n: Notification): Boolean {
      notification = n
      wanted = Wanted.FOREGROUND
      if (foreground) {
        ctx.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
        return true
      }
      return try {
        ctx.startForegroundService(Intent(ctx, NowPlayingService::class.java).setAction(ACTION_FOREGROUND))
        true
      } catch (e: Exception) {
        Log.w(TAG, "startForegroundService refused — a playing song will park in the background", e)
        false
      }
    }

    /** The song paused: keep its notification, give up the foreground. */
    fun leaveForeground(ctx: Context, n: Notification) {
      notification = n
      if (wanted == Wanted.STOPPED && instance == null) {
        // Never played in this session: no service, and no notification for
        // a song the singer only opened.
        return
      }
      wanted = Wanted.DETACHED
      val running = instance
      if (running != null) running.detach(n)
      else ctx.getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, n)
    }

    /** The song closed: no service, no notification. */
    fun stop(ctx: Context) {
      wanted = Wanted.STOPPED
      notification = null
      val running = instance
      if (running != null) running.finish()
      ctx.getSystemService(NotificationManager::class.java).cancel(NOTIFICATION_ID)
    }
  }
}
