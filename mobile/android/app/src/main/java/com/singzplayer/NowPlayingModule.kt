package com.singzplayer

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.jstasks.HeadlessJsTaskConfig
import com.facebook.react.jstasks.HeadlessJsTaskContext
import com.facebook.react.modules.core.DeviceEventManagerModule

/**
 * The song on the lock screen, in the shade's media controls and in a media
 * notification — and the play, pause, scrub and skip that come back from there.
 * `mobile/src/playback/now-playing.ts` owns WHAT is shown and when; this puts
 * it in front of the OS, and keeps a PLAYING song alive once the app leaves the
 * screen.
 *
 * Method names and arity match iOS's NowPlaying exactly:
 * update(info) · clear() · debugCommand(command, value) · debugState().
 *
 * Background playback is the part iOS gets for free (its `audio` background
 * mode) and Android does not. The native backend used to park every song on
 * the way to the background precisely because nothing asked the OS to keep
 * the process playing. NowPlayingService is that ask: a mediaPlayback
 * foreground service, started only while a song is actually playing, detached
 * (notification kept, dismissible) on pause, and stopped with the song. The OS
 * may refuse the start — Android 12+ does from the background outside its
 * exemptions — and then update() says so and the song parks exactly as before.
 *
 * A foreground service keeps the PROCESS alive; it does not keep JavaScript's
 * timers running. React Native stops them while the activity is paused unless
 * a Headless JS task is active (JavaTimerManager), and everything that reacts
 * to a command from the lock screen is timer-driven — the Now Playing update
 * after a pause, the background park's wait for the pause to render, the
 * playback status poll. Measured on the emulator before this: a pause from the
 * media controls with the app on the home screen parked 6.3 s late, and only
 * because the next command woke the JS thread. So while a song plays in the
 * foreground service this holds a Headless JS task that does nothing but keep
 * timers alive, and lets it go [KEEP_ALIVE_GRACE_MS] after the song stops —
 * long enough for a park already under way to finish.
 *
 * Framework MediaSession, not androidx.media: nothing else in the app needs the
 * compat library, and minSdk 28 has every call used here.
 */
class NowPlayingModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx) {

  override fun getName(): String = "NowPlaying"

  private val main = Handler(Looper.getMainLooper())
  private var session: MediaSession? = null
  private var artwork: Bitmap? = null
  private var shown: Shown? = null
  private var keepAliveTask: Int? = null
  private val releaseKeepAlive = Runnable { finishKeepAlive() }

  private data class Shown(
    val title: String,
    val artist: String,
    val durationMs: Long,
    val elapsedMs: Long,
    val rate: Float,
    val playing: Boolean,
    val canSeek: Boolean,
    val skipSeconds: Double,
    val at: Long
  )

  init {
    active = this
    // A new React instance has no song. A notification still up is a leftover
    // from a process the system killed while the song was paused — its buttons
    // would reach nobody.
    runCatching {
      ctx.getSystemService(NotificationManager::class.java).cancel(NowPlayingService.NOTIFICATION_ID)
    }
  }

  // RN's NativeEventEmitter asks for these on Android; iOS's RCTEventEmitter
  // supplies its own.
  @ReactMethod fun addListener(@Suppress("UNUSED_PARAMETER") eventName: String) {}
  @ReactMethod fun removeListeners(@Suppress("UNUSED_PARAMETER") count: Double) {}

  @ReactMethod
  fun update(info: ReadableMap, promise: Promise) {
    val next = Shown(
      title = info.stringOr("title", ""),
      artist = info.stringOr("artist", ""),
      durationMs = (info.finiteOr("duration", 0.0).coerceAtLeast(0.0) * 1000).toLong(),
      elapsedMs = (info.finiteOr("elapsed", 0.0).coerceAtLeast(0.0) * 1000).toLong(),
      rate = info.finiteOr("rate", 0.0).coerceAtLeast(0.0).toFloat(),
      playing = info.hasKey("playing") && info.getBoolean("playing"),
      canSeek = info.hasKey("canSeek") && info.getBoolean("canSeek"),
      skipSeconds = info.finiteOr("skipSeconds", 10.0).takeIf { it > 0 } ?: 10.0,
      at = SystemClock.elapsedRealtime()
    )
    main.post {
      try {
        val background = show(next)
        promise.resolve(Arguments.createMap().apply { putBoolean("backgroundPlayback", background) })
      } catch (e: Exception) {
        Log.w(TAG, "update failed", e)
        promise.reject("E_NOW_PLAYING", e.message ?: e.javaClass.simpleName, e)
      }
    }
  }

  @ReactMethod
  fun clear(promise: Promise) {
    main.post {
      hide()
      promise.resolve(null)
    }
  }

  /** DEBUG builds only: run a command through [dispatch], the same function
   *  the MediaSession callback and the notification's buttons reach. The
   *  emulator can deliver real media keys (`adb shell cmd media_session
   *  dispatch`), but only play/pause — not a scrub or a skip. */
  @ReactMethod
  fun debugCommand(command: String, value: Double, promise: Promise) {
    if (!BuildConfig.DEBUG) {
      promise.reject("E_NOW_PLAYING_DEBUG_ONLY", "debugCommand exists only in debug builds")
      return
    }
    if (command !in COMMANDS) {
      promise.reject("E_NOW_PLAYING_COMMAND", "unknown command $command")
      return
    }
    main.post { promise.resolve(dispatch(command, value)) }
  }

  /** DEBUG builds only: what the OS was actually handed, read back from the
   *  session's controller rather than from what this module meant to send. */
  @ReactMethod
  fun debugState(promise: Promise) {
    if (!BuildConfig.DEBUG) {
      promise.reject("E_NOW_PLAYING_DEBUG_ONLY", "debugState exists only in debug builds")
      return
    }
    main.post {
      val s = session
      val controller = s?.controller
      val metadata = controller?.metadata
      val state = controller?.playbackState
      val map = Arguments.createMap()
      map.putBoolean("active", s?.isActive == true)
      map.putString("title", metadata?.getString(MediaMetadata.METADATA_KEY_TITLE))
      map.putString("artist", metadata?.getString(MediaMetadata.METADATA_KEY_ARTIST))
      if (metadata != null) map.putDouble("duration", metadata.getLong(MediaMetadata.METADATA_KEY_DURATION) / 1000.0)
      else map.putNull("duration")
      if (state != null) {
        map.putDouble("elapsed", state.position / 1000.0)
        map.putDouble("rate", state.playbackSpeed.toDouble())
      } else {
        map.putNull("elapsed")
        map.putNull("rate")
      }
      map.putBoolean("artwork", metadata?.getBitmap(MediaMetadata.METADATA_KEY_ART) != null)
      map.putString(
        "state",
        when (state?.state) {
          PlaybackState.STATE_PLAYING -> "playing"
          PlaybackState.STATE_PAUSED -> "paused"
          PlaybackState.STATE_STOPPED -> "stopped"
          null -> "none"
          else -> "other"
        }
      )
      map.putBoolean("listening", ctx.hasActiveReactInstance())
      map.putBoolean("backgroundPlayback", NowPlayingService.foreground)
      map.putBoolean("jsTimersHeld", keepAliveTask != null)
      val actions = state?.actions ?: 0L
      map.putMap(
        "commands",
        Arguments.createMap().apply {
          putBoolean("play", actions and PlaybackState.ACTION_PLAY != 0L)
          putBoolean("pause", actions and PlaybackState.ACTION_PAUSE != 0L)
          putBoolean("toggle", actions and PlaybackState.ACTION_PLAY_PAUSE != 0L)
          putBoolean("seek", actions and PlaybackState.ACTION_SEEK_TO != 0L)
          putBoolean("skipForward", state?.customActions?.any { it.action == ACTION_SKIP_FORWARD } == true)
          putBoolean("skipBackward", state?.customActions?.any { it.action == ACTION_SKIP_BACKWARD } == true)
          putBoolean("nextTrack", actions and PlaybackState.ACTION_SKIP_TO_NEXT != 0L)
          putBoolean("previousTrack", actions and PlaybackState.ACTION_SKIP_TO_PREVIOUS != 0L)
        }
      )
      promise.resolve(map)
    }
  }

  override fun invalidate() {
    main.post {
      hide()
      main.removeCallbacks(releaseKeepAlive)
      finishKeepAlive()
    }
    if (active === this) active = null
    super.invalidate()
  }

  // --- the OS side, on the main thread -------------------------------------

  /** Returns whether a playing song will keep sounding in the background. */
  private fun show(next: Shown): Boolean {
    val s = session ?: MediaSession(ctx, "SingZ").also { created ->
      created.setCallback(callback, main)
      created.setSessionActivity(openAppIntent())
      session = created
    }
    val previous = shown
    shown = next
    if (previous == null || previous.title != next.title || previous.artist != next.artist ||
      previous.durationMs != next.durationMs
    ) {
      s.setMetadata(
        MediaMetadata.Builder()
          .putString(MediaMetadata.METADATA_KEY_TITLE, next.title)
          .putString(MediaMetadata.METADATA_KEY_ARTIST, next.artist.ifEmpty { null })
          .putLong(MediaMetadata.METADATA_KEY_DURATION, next.durationMs)
          .apply { artwork()?.let { putBitmap(MediaMetadata.METADATA_KEY_ART, it) } }
          .build()
      )
    }
    s.setPlaybackState(playbackState(next))
    if (!s.isActive) s.isActive = true

    val notification = buildNotification(next, s)
    NowPlayingService.notification = notification
    return if (next.playing) {
      val accepted = NowPlayingService.enterForeground(ctx, notification)
      if (accepted) holdJsTimers()
      accepted
    } else {
      NowPlayingService.leaveForeground(ctx, notification)
      releaseJsTimersSoon()
      false
    }
  }

  private fun holdJsTimers() {
    main.removeCallbacks(releaseKeepAlive)
    if (keepAliveTask != null) return
    keepAliveTask = runCatching {
      HeadlessJsTaskContext.getInstance(ctx).startTask(
        HeadlessJsTaskConfig(KEEP_ALIVE_TASK, Arguments.createMap(), 0, true)
      )
    }.onFailure {
      Log.w(TAG, "could not keep JS timers running behind the lock screen", it)
    }.getOrNull()
  }

  private fun releaseJsTimersSoon() {
    if (keepAliveTask == null) return
    main.removeCallbacks(releaseKeepAlive)
    main.postDelayed(releaseKeepAlive, KEEP_ALIVE_GRACE_MS)
  }

  private fun finishKeepAlive() {
    val task = keepAliveTask ?: return
    keepAliveTask = null
    // Idempotent in React Native: a second finish of the same id is a no-op.
    runCatching { HeadlessJsTaskContext.getInstance(ctx).finishTask(task) }
  }

  private fun hide() {
    shown = null
    releaseJsTimersSoon()
    NowPlayingService.stop(ctx)
    session?.let {
      it.isActive = false
      it.release()
    }
    session = null
  }

  private fun playbackState(info: Shown): PlaybackState {
    var actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
      PlaybackState.ACTION_PLAY_PAUSE
    if (info.canSeek) {
      actions = actions or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_FAST_FORWARD or
        PlaybackState.ACTION_REWIND
    }
    val skip = ctx.getString(R.string.np_seconds, info.skipSeconds.toInt())
    return PlaybackState.Builder()
      .setActions(actions)
      .setState(
        if (info.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
        info.elapsedMs,
        info.rate,
        info.at
      )
      .apply {
        if (info.canSeek) {
          addCustomAction(
            PlaybackState.CustomAction.Builder(ACTION_SKIP_BACKWARD, ctx.getString(R.string.np_back, skip), android.R.drawable.ic_media_rew).build()
          )
          addCustomAction(
            PlaybackState.CustomAction.Builder(ACTION_SKIP_FORWARD, ctx.getString(R.string.np_forward, skip), android.R.drawable.ic_media_ff).build()
          )
        }
      }
      .build()
  }

  private fun buildNotification(info: Shown, s: MediaSession): Notification {
    val nm = ctx.getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, ctx.getString(R.string.np_channel_name), NotificationManager.IMPORTANCE_LOW).apply {
        description = ctx.getString(R.string.np_channel_desc)
        setShowBadge(false)
      }
    )
    val skip = ctx.getString(R.string.np_seconds, info.skipSeconds.toInt())
    val buttons = mutableListOf<Notification.Action>()
    if (info.canSeek) buttons += action(android.R.drawable.ic_media_rew, ctx.getString(R.string.np_back, skip), NowPlayingService.ACTION_SKIP_BACKWARD)
    buttons += if (info.playing) action(android.R.drawable.ic_media_pause, ctx.getString(R.string.np_pause), NowPlayingService.ACTION_PAUSE)
    else action(android.R.drawable.ic_media_play, ctx.getString(R.string.np_play), NowPlayingService.ACTION_PLAY)
    if (info.canSeek) buttons += action(android.R.drawable.ic_media_ff, ctx.getString(R.string.np_forward, skip), NowPlayingService.ACTION_SKIP_FORWARD)
    val compact = IntArray(buttons.size) { it }
    return Notification.Builder(ctx, CHANNEL_ID)
      .setSmallIcon(R.drawable.ic_stat_now_playing)
      .setContentTitle(info.title)
      .setContentText(info.artist.ifEmpty { null })
      .setLargeIcon(artwork())
      .setContentIntent(openAppIntent())
      .setOngoing(info.playing)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setCategory(Notification.CATEGORY_TRANSPORT)
      .setStyle(Notification.MediaStyle().setMediaSession(s.sessionToken).setShowActionsInCompactView(*compact))
      .apply { buttons.forEach { addAction(it) } }
      .build()
  }

  private fun action(icon: Int, label: String, intentAction: String): Notification.Action =
    Notification.Action.Builder(
      Icon.createWithResource(ctx, icon), label,
      PendingIntent.getService(
        ctx, intentAction.hashCode(),
        Intent(ctx, NowPlayingService::class.java).setAction(intentAction),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      )
    ).build()

  private fun openAppIntent(): PendingIntent =
    PendingIntent.getActivity(
      ctx, 0,
      Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    )

  /** The launcher icon, rendered. Adaptive icons are XML on 26+, so decoding
   *  the mipmap as a bitmap would come back null. */
  private fun artwork(): Bitmap? {
    artwork?.let { return it }
    return runCatching {
      val drawable = ctx.packageManager.getApplicationIcon(ctx.applicationInfo)
      Bitmap.createBitmap(ARTWORK_PX, ARTWORK_PX, Bitmap.Config.ARGB_8888).also { bitmap ->
        val canvas = Canvas(bitmap)
        drawable.setBounds(0, 0, ARTWORK_PX, ARTWORK_PX)
        drawable.draw(canvas)
      }
    }.getOrNull().also { artwork = it }
  }

  private val callback = object : MediaSession.Callback() {
    override fun onPlay() { dispatch("play", 0.0) }
    override fun onPause() { dispatch("pause", 0.0) }
    override fun onStop() { dispatch("pause", 0.0) }
    override fun onSeekTo(pos: Long) { dispatch("seek", pos / 1000.0) }
    override fun onFastForward() { dispatch("skip", shown?.skipSeconds ?: 10.0) }
    override fun onRewind() { dispatch("skip", -(shown?.skipSeconds ?: 10.0)) }
    override fun onCustomAction(action: String, extras: android.os.Bundle?) {
      when (action) {
        ACTION_SKIP_FORWARD -> dispatch("skip", shown?.skipSeconds ?: 10.0)
        ACTION_SKIP_BACKWARD -> dispatch("skip", -(shown?.skipSeconds ?: 10.0))
      }
    }
  }

  /** Where every command lands: the session callback, the notification's
   *  buttons (through NowPlayingService) and debugCommand. */
  private fun dispatch(command: String, value: Double): Boolean {
    if (!ctx.hasActiveReactInstance() || shown == null) return false
    // Wake JS timers BEFORE the command lands. After a pause in the background
    // the keep-alive lets them go; a Play from the lock screen then starts the
    // song, but the update that would take the foreground back (and hold the
    // timers again) is itself timer-driven — measured: the song played on with
    // no foreground service. Held here for the grace period, the update that
    // follows either keeps the hold (playing) or lets it lapse (paused).
    holdJsTimers()
    releaseJsTimersSoon()
    return runCatching {
      ctx.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
        .emit(
          EVENT,
          Arguments.createMap().apply {
            putString("command", command)
            putDouble("value", value)
          }
        )
      true
    }.getOrDefault(false)
  }

  companion object {
    private const val TAG = "NowPlaying"
    const val CHANNEL_ID = "singz-now-playing"
    private const val EVENT = "singzNowPlayingCommand"
    private const val ARTWORK_PX = 512
    /** Registered in mobile/index.js; see NOW_PLAYING_KEEP_ALIVE_TASK. */
    private const val KEEP_ALIVE_TASK = "SingzNowPlayingKeepAlive"
    private const val KEEP_ALIVE_GRACE_MS = 5_000L
    private const val ACTION_SKIP_FORWARD = "singz.skip.forward"
    private const val ACTION_SKIP_BACKWARD = "singz.skip.backward"
    private val COMMANDS = setOf("play", "pause", "toggle", "seek", "skip")

    /** The live module, for NowPlayingService's notification buttons. */
    @Volatile private var active: NowPlayingModule? = null

    /** Returns whether a live module took the command. */
    fun fromNotification(intentAction: String): Boolean {
      val module = active ?: return false
      if (module.shown == null) return false
      module.main.post {
        val skip = module.shown?.skipSeconds ?: 10.0
        when (intentAction) {
          NowPlayingService.ACTION_PLAY -> module.dispatch("play", 0.0)
          NowPlayingService.ACTION_PAUSE -> module.dispatch("pause", 0.0)
          NowPlayingService.ACTION_SKIP_FORWARD -> module.dispatch("skip", skip)
          NowPlayingService.ACTION_SKIP_BACKWARD -> module.dispatch("skip", -skip)
        }
      }
      return true
    }


    private fun ReadableMap.stringOr(key: String, fallback: String): String =
      if (hasKey(key) && !isNull(key)) getString(key) ?: fallback else fallback

    private fun ReadableMap.finiteOr(key: String, fallback: Double): Double =
      if (hasKey(key) && !isNull(key)) getDouble(key).takeIf { it.isFinite() } ?: fallback else fallback
  }
}
