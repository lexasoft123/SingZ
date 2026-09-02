package com.singzplayer

import com.singzplayer.playback.NativePlaybackBridgeSchema
import com.singzplayer.playback.NativePlaybackPathPolicy
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class NativePlaybackBridgeSchemaTest {
  private fun validPrepare(): Map<String, Any?> = mapOf(
    "lanes" to listOf(
      mapOf(
        "id" to "vocals",
        "path" to "/data/user/0/com.lexasoft.singz/files/vocals.flac",
        "gain" to 0.8,
        "muted" to false,
        "solo" to false
      )
    ),
    "outputDeviceUid" to "android:17",
    "outputChannels" to listOf(0.0, 1.0),
    "sampleRate" to 48_000.0,
    "maximumFrames" to 4096.0,
    "bufferFrames" to 192.0,
    "masterGain" to 1.0,
    "maximumRetainedBytes" to 1_073_741_824.0,
    "handoffLease" to 7.0,
    "preparedStartProjectFrame" to -24_000.0,
    "playback" to mapOf(
      "version" to 2.0,
      "transport" to mapOf(
        "entrySeconds" to 1.25,
        "playbackRate" to 1.0,
        "transposeSemitones" to 0.0
      ),
      "cues" to mapOf(
        "click" to true,
        "countInBars" to 1.0,
        "volume" to 0.7,
        "accent" to true,
        "beatGrid" to mapOf(
          "beats" to listOf(0.0, 0.5, 1.0, 1.5, 2.0),
          "beatsPerBar" to 4.0,
          "downbeat" to 0.0,
          "downbeats" to listOf(0.0, 4.0)
        )
      )
    )
  )

  @Test
  fun `whole transport cue request parses without per-click events`() {
    val parsed = NativePlaybackBridgeSchema.prepare(validPrepare())
    assertEquals(1, parsed.lanes.size)
    assertArrayEquals(intArrayOf(0, 1), parsed.outputChannels)
    assertEquals(7L, parsed.handoffLease)
    assertEquals(-24_000L, parsed.preparedStartProjectFrame)
    assertEquals(1, parsed.playback!!.countInBars)
    assertEquals(0.0, parsed.playback!!.transposeSemitones, 0.0)
    assertEquals(5, parsed.playback!!.beatGrid!!.beats.size)
    assertEquals(
      "singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3",
      NativePlaybackBridgeSchema.BUILD_ID
    )
    assertEquals(
      "singz.native.playback-session.anchored-preview.v4",
      NativePlaybackBridgeSchema.PLAYBACK_BUILD
    )
    assertEquals(3, NativePlaybackBridgeSchema.INTERFACE_VERSION)
  }

  @Test
  fun `portable graph projection is strict bounded and preserves unsigned identities`() {
    val graph = mapOf(
      "format" to 1.0,
      "engine" to "singz-dsp",
      "nodes" to listOf(
        mapOf(
          "id" to "13835058055282163713",
          "type" to "73696e677a2d64737000000000000001",
          "typeVersion" to 1.0,
          "execution" to "native",
          "unavailable" to "silence",
          "ports" to mapOf(
            "inputs" to emptyList<Any>(),
            "outputs" to listOf(mapOf("id" to "out", "channels" to 2.0))
          ),
          "parameters" to emptyMap<String, Any>(),
          "binding" to mapOf("kind" to "project-lane", "laneId" to "vocals")
        ),
        mapOf(
          "id" to "2",
          "type" to "73696e677a2d6473700000000000000d",
          "typeVersion" to 9.0,
          "execution" to "vendor-bridge",
          "unavailable" to "bypass",
          "ports" to mapOf(
            "inputs" to listOf(mapOf("id" to "in", "channels" to 2.0)),
            "outputs" to listOf(mapOf("id" to "out", "channels" to 2.0))
          ),
          "parameters" to mapOf("vendor.depth" to 0.25)
        )
      ),
      "connections" to listOf(
        mapOf(
          "from" to mapOf("node" to "13835058055282163713", "port" to "out"),
          "to" to mapOf("node" to "2", "port" to "in")
        )
      )
    )
    val request = validPrepare().toMutableMap().apply { this["graphDocument"] = graph }
    val parsed = NativePlaybackBridgeSchema.prepare(request).graphDocument!!
    assertEquals(2, parsed.nodes.size)
    assertEquals(0xc000000000000001UL.toLong(), parsed.nodes[0].id)
    assertEquals(0x73696e677a2d6473UL.toLong(), parsed.nodes[0].typeHigh)
    assertEquals(0, parsed.nodes[1].unavailable)
    assertEquals("vendor.depth", parsed.nodes[1].toJni().parameterIds.single())
    assertEquals(1, parsed.connections.size)

    fun rejected(mutated: Map<String, Any?>) {
      request["graphDocument"] = mutated
      expectInvalid { NativePlaybackBridgeSchema.prepare(request) }
    }
    rejected(graph + ("future" to true))
    assertEquals(128, NativePlaybackBridgeSchema.MAXIMUM_GRAPH_NODES)
    rejected(graph + ("nodes" to List(129) { (graph["nodes"] as List<*>).first() }))
    rejected(graph + ("nodes" to (graph["nodes"] as List<Map<String, Any?>>).mapIndexed { index, node ->
      if (index == 0) node + ("type" to "73696E677A2D64737000000000000001") else node
    }))
    rejected(graph + ("nodes" to (graph["nodes"] as List<Map<String, Any?>>).mapIndexed { index, node ->
      if (index == 1) node + ("parameters" to mapOf("vendor.depth" to Double.NaN)) else node
    }))
  }

  @Test
  fun `initial transport is exact typed and carries pause plus loop atomically`() {
    val request = validPrepare().toMutableMap().apply {
      this["initialTransport"] = mapOf(
        "state" to "paused",
        "loop" to mapOf(
          "startProjectFrame" to 48_000.0,
          "endProjectFrame" to 96_000.0
        )
      )
    }
    val parsed = NativePlaybackBridgeSchema.prepare(request).initialTransport
    assertTrue(parsed.startPaused)
    assertEquals(48_000L, parsed.loop!!.startProjectFrame)
    assertEquals(96_000L, parsed.loop!!.endProjectFrame)

    request["initialTransport"] = mapOf("state" to "playing")
    val playing = NativePlaybackBridgeSchema.prepare(request).initialTransport
    assertFalse(playing.startPaused)
    assertEquals(null, playing.loop)

    for (invalid in listOf<Map<String, Any?>>(
      mapOf("state" to "stopped"),
      mapOf("state" to true),
      mapOf("state" to "paused", "future" to true),
      mapOf(
        "state" to "paused",
        "loop" to mapOf("startProjectFrame" to -1.0, "endProjectFrame" to 4.0)
      ),
      mapOf(
        "state" to "paused",
        "loop" to mapOf("startProjectFrame" to 8.0, "endProjectFrame" to 8.0)
      ),
      mapOf(
        "state" to "paused",
        "loop" to mapOf(
          "startProjectFrame" to 8.5,
          "endProjectFrame" to 10.0
        )
      ),
      mapOf(
        "state" to "paused",
        "loop" to mapOf(
          "startProjectFrame" to 8.0,
          "endProjectFrame" to 10.0,
          "future" to 1.0
        )
      )
    )) {
      request["initialTransport"] = invalid
      expectInvalid { NativePlaybackBridgeSchema.prepare(request) }
    }
  }

  @Test
  fun `gridless count-in stays bounded and click requires a grid`() {
    val request = validPrepare().toMutableMap()
    request["playback"] = mapOf(
      "version" to 2.0,
      "transport" to mapOf(
        "entrySeconds" to 0.0,
        "playbackRate" to 1.0,
        "transposeSemitones" to 0.0
      ),
      "cues" to mapOf(
        "click" to false,
        "countInBars" to 2.0,
        "volume" to 0.25,
        "accent" to false
      )
    )
    assertEquals(2, NativePlaybackBridgeSchema.prepare(request).playback!!.countInBars)

    val playback = (request["playback"] as Map<String, Any?>).toMutableMap()
    playback["cues"] = (playback["cues"] as Map<String, Any?>).toMutableMap().apply {
      this["click"] = true
    }
    request["playback"] = playback
    expectInvalid { NativePlaybackBridgeSchema.prepare(request) }
  }

  @Test
  fun `transpose is required bounded finite and rejects unknown transport keys`() {
    fun withTransport(transform: (MutableMap<String, Any?>) -> Unit): Map<String, Any?> {
      val request = validPrepare().toMutableMap()
      val playback = (request["playback"] as Map<String, Any?>).toMutableMap()
      val transport = (playback["transport"] as Map<String, Any?>).toMutableMap()
      transform(transport)
      playback["transport"] = transport
      request["playback"] = playback
      return request
    }

    assertEquals(
      -24.0,
      NativePlaybackBridgeSchema.prepare(
        withTransport { it["transposeSemitones"] = -24.0 }
      ).playback!!.transposeSemitones,
      0.0
    )
    for (invalid in listOf<Any?>(-24.001, 24.001, true, "0", Double.NaN, null)) {
      expectInvalid {
        NativePlaybackBridgeSchema.prepare(
          withTransport { it["transposeSemitones"] = invalid }
        )
      }
    }
    expectInvalid {
      NativePlaybackBridgeSchema.prepare(
        withTransport { it.remove("transposeSemitones") }
      )
    }
    expectInvalid {
      NativePlaybackBridgeSchema.prepare(
        withTransport { it["futureTransposeMode"] = "formant" }
      )
    }
  }

  @Test
  fun `unknown fields duplicate channels and malformed scalar types fail closed`() {
    val request = validPrepare().toMutableMap()
    request["future"] = true
    expectInvalid { NativePlaybackBridgeSchema.prepare(request) }

    request.remove("future")
    request["outputChannels"] = listOf(0.0, 0.0)
    expectInvalid { NativePlaybackBridgeSchema.prepare(request) }

    request["outputChannels"] = listOf(0.0, 1.0)
    request["masterGain"] = true
    expectInvalid { NativePlaybackBridgeSchema.prepare(request) }

    request["masterGain"] = Double.NaN
    expectInvalid { NativePlaybackBridgeSchema.prepare(request) }

    request["masterGain"] = 1.0
    request["preparedStartProjectFrame"] = 0.5
    expectInvalid { NativePlaybackBridgeSchema.prepare(request) }
  }

  @Test
  fun `generation and transport frames obey the JS safe integer boundary`() {
    assertEquals(7L, NativePlaybackBridgeSchema.generation(7.0))
    expectInvalid { NativePlaybackBridgeSchema.generation(0.0) }
    expectInvalid {
      NativePlaybackBridgeSchema.generation(
        NativePlaybackBridgeSchema.MAXIMUM_JS_SAFE_INTEGER + 1.0
      )
    }
    assertEquals(
      NativePlaybackBridgeSchema.Transport.Seek(96_000),
      NativePlaybackBridgeSchema.transport(
        mapOf("kind" to "seek", "projectFrame" to 96_000.0)
      )
    )
    expectInvalid {
      NativePlaybackBridgeSchema.transport(
        mapOf(
          "kind" to "set-loop",
          "startProjectFrame" to 200.0,
          "endProjectFrame" to 100.0
        )
      )
    }
  }

  @Test
  fun `preview click sound accepts only the exact ordinary and accent DTO values`() {
    assertEquals(
      NativePlaybackBridgeSchema.PreviewClickSound.Ordinary,
      NativePlaybackBridgeSchema.previewClickSound(0.0)
    )
    assertEquals(
      NativePlaybackBridgeSchema.PreviewClickSound.Accent,
      NativePlaybackBridgeSchema.previewClickSound(1.0)
    )
    for (invalid in listOf(-1.0, 0.5, 2.0, Double.NaN))
      expectInvalid { NativePlaybackBridgeSchema.previewClickSound(invalid) }
  }

  @Test
  fun `lane and master controls are exclusive and typed`() {
    assertEquals(
      NativePlaybackBridgeSchema.Control.MasterGain(0.5F),
      NativePlaybackBridgeSchema.control(mapOf("masterGain" to 0.5))
    )
    val lane = NativePlaybackBridgeSchema.control(
      mapOf("laneId" to "vocals", "gain" to 1.25, "muted" to true, "solo" to false)
    ) as NativePlaybackBridgeSchema.Control.LaneControl
    assertTrue(lane.muted)
    assertFalse(lane.solo)
    expectInvalid {
      NativePlaybackBridgeSchema.control(
        mapOf(
          "laneId" to "vocals",
          "gain" to 1.0,
          "muted" to false,
          "solo" to false,
          "masterGain" to 1.0
        )
      )
    }
    assertEquals(
      NativePlaybackBridgeSchema.Control.TrainingEnabled(true),
      NativePlaybackBridgeSchema.control(mapOf("trainingEnabled" to true))
    )
    expectInvalid {
      NativePlaybackBridgeSchema.control(
        mapOf("trainingEnabled" to true, "masterGain" to 1.0)
      )
    }
  }

  @Test
  fun `prepared training schedules are frame domain bounded and disjoint`() {
    val periodRequest = validPrepare().toMutableMap().apply {
      this["training"] = mapOf(
        "mode" to "period",
        "periodFrames" to 240_000.0,
        "laneIds" to listOf("vocals"),
        "enabled" to true
      )
    }
    assertEquals(
      240_000L,
      (NativePlaybackBridgeSchema.prepare(periodRequest).training as
        NativePlaybackBridgeSchema.Training.Period).periodFrames
    )

    val windowsRequest = validPrepare().toMutableMap().apply {
      this["training"] = mapOf(
        "mode" to "windows",
        "windows" to listOf(
          mapOf("startProjectFrame" to 10.0, "endProjectFrame" to 20.0),
          mapOf("startProjectFrame" to 20.0, "endProjectFrame" to 40.0)
        ),
        "laneIds" to listOf("vocals"),
        "enabled" to false
      )
    }
    assertEquals(
      2,
      (NativePlaybackBridgeSchema.prepare(windowsRequest).training as
        NativePlaybackBridgeSchema.Training.Windows).windows.size
    )

    windowsRequest["training"] = mapOf(
      "mode" to "windows",
      "windows" to listOf(
        mapOf("startProjectFrame" to 10.0, "endProjectFrame" to 30.0),
        mapOf("startProjectFrame" to 20.0, "endProjectFrame" to 40.0)
      ),
      "laneIds" to listOf("vocals"),
      "enabled" to true
    )
    expectInvalid { NativePlaybackBridgeSchema.prepare(windowsRequest) }

    periodRequest["training"] = mapOf(
      "mode" to "period",
      "periodFrames" to 10.0,
      "laneIds" to listOf("vocals", "vocals"),
      "enabled" to true
    )
    expectInvalid { NativePlaybackBridgeSchema.prepare(periodRequest) }
  }

  @Test
  fun `authorized roots compare path components rather than string prefixes`() {
    assertTrue(NativePlaybackPathPolicy.inside("/data/user/0/app/files/a.flac", "/data/user/0/app"))
    assertFalse(NativePlaybackPathPolicy.inside("/data/user/0/app-evil/a.flac", "/data/user/0/app"))
    assertFalse(NativePlaybackPathPolicy.inside("/data/user/0/app", "/data/user/0/app"))
  }

  private fun expectInvalid(operation: () -> Unit) {
    try {
      operation()
      throw AssertionError("Expected strict native playback schema rejection")
    } catch (_: NativePlaybackBridgeSchema.Invalid) {
    }
  }
}
