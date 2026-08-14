package com.singzplayer

import android.app.Application
import android.os.Build
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeApplicationEntryPoint.loadReactNative
import com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost
import java.io.File

class MainApplication : Application(), ReactApplication {

  override val reactHost: ReactHost by lazy {
    getDefaultReactHost(
      context = applicationContext,
      packageList =
        PackageList(this).packages.apply {
          add(SingZPackage())
        },
    )
  }

  override fun onCreate() {
    super.onCreate()
    // The :split process hosts only the split service + JNI core — booting
    // React Native there would spend tens of MB inside the process whose
    // whole point is dying without consequences.
    if (currentProcessName().endsWith(":split")) return
    loadReactNative(this)
  }

  private fun currentProcessName(): String =
    if (Build.VERSION.SDK_INT >= 28) getProcessName()
    else try {
      File("/proc/self/cmdline").readText().substringBefore('\u0000').trim()
    } catch (_: Exception) {
      packageName
    }
}
