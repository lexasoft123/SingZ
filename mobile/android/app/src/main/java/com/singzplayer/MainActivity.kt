package com.singzplayer

import android.media.AudioManager
import android.os.Bundle
import android.view.WindowManager
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate
import com.swmansion.rnscreens.fragment.restoration.RNScreensFragmentFactory

class MainActivity : ReactActivity() {

  override fun onCreate(savedInstanceState: Bundle?) {
    // Restore native-stack fragments with the factory that knows how to
    // recreate react-native-screens views after an Activity restart.
    supportFragmentManager.fragmentFactory = RNScreensFragmentFactory()
    super.onCreate(savedInstanceState)
    // Singers read lyrics hands-free — keep the screen on while SingZ is
    // in the foreground (the flag only applies while this window shows).
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    // The volume keys control MEDIA the whole time SingZ is open, not only
    // while sound is already coming out. Without this, a phone whose media
    // volume sits at zero is a dead end: play does nothing, the volume keys
    // move the ringtone instead because no media is audibly playing yet, and
    // the app looks broken. That is what the first closed-test round reported
    // as "it doesn't play songs" — the engine was running the whole time.
    volumeControlStream = AudioManager.STREAM_MUSIC
  }

  /**
   * Returns the name of the main component registered from JavaScript. This is used to schedule
   * rendering of the component.
   */
  override fun getMainComponentName(): String = "SingZPlayer"

  /**
   * Returns the instance of the [ReactActivityDelegate]. We use [DefaultReactActivityDelegate]
   * which allows you to enable New Architecture with a single boolean flags [fabricEnabled]
   */
  override fun createReactActivityDelegate(): ReactActivityDelegate =
      DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)
}
