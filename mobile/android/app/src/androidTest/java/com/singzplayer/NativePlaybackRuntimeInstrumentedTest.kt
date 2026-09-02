package com.singzplayer

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.singzplayer.playback.NativePlaybackBridgeSchema
import com.singzplayer.split.SingzCore
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Device-side JNI/session boundary proof. It deliberately never opens an
 * output device: loading validates RegisterNatives and the exact Kotlin/JNI
 * descriptors, while claim/status/unload exercise ownership and zero-retained
 * teardown without producing audio.
 */
@RunWith(AndroidJUnit4::class)
class NativePlaybackRuntimeInstrumentedTest {
  @Test
  fun registeredPlaybackContractClaimsAndReleasesOneGeneration() {
    assertNull(SingzCore.ensureLoaded())

    val capability = JSONObject(SingzCore.nativePlaybackStatus())
    assertTrue(capability.getBoolean("available"))
    assertEquals(
      NativePlaybackBridgeSchema.BUILD_ID,
      capability.getString("buildId")
    )
    assertEquals(
      NativePlaybackBridgeSchema.PLAYBACK_BUILD,
      capability.getString("playbackBuild")
    )
    assertTrue(capability.getBoolean("playbackTransport"))
    assertTrue(capability.getBoolean("scheduledCues"))
    assertEquals(
      "unavailable",
      capability.getJSONObject("session").getString("transportTelemetryQuality")
    )

    val generation = 8_000_000_001L
    val claim = JSONObject(SingzCore.nativePlaybackClaim(generation, 0))
    assertTrue(claim.toString(), claim.getBoolean("ok"))
    assertEquals(generation, claim.getLong("generation"))

    val stale = JSONObject(SingzCore.nativePlaybackSeek(generation + 1, 0))
    assertFalse(stale.getBoolean("ok"))
    assertEquals("invalid-generation", stale.getString("error"))

    val unload = JSONObject(SingzCore.nativePlaybackUnload(generation))
    val cleanup = unload.getJSONObject("cleanup")
    assertTrue(unload.toString(), cleanup.getBoolean("globallyComplete"))
    assertTrue(cleanup.getBoolean("fallbackSafe"))
    assertEquals(0L, cleanup.getLong("retainedBytes"))
    assertEquals(0L, cleanup.getLong("processQuarantineRetainedBytes"))
    assertFalse(cleanup.getBoolean("physicalOwnershipRetained"))
  }
}
