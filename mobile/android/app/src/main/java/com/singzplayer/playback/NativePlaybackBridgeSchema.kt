package com.singzplayer.playback

import kotlin.math.floor

class NativePlaybackGraphNodeJni(
  @JvmField val id: Long,
  @JvmField val typeHigh: Long,
  @JvmField val typeLow: Long,
  @JvmField val typeVersion: Int,
  @JvmField val execution: String,
  @JvmField val unavailable: Int,
  @JvmField val inputPortIds: Array<String>,
  @JvmField val inputPortChannels: IntArray,
  @JvmField val outputPortIds: Array<String>,
  @JvmField val outputPortChannels: IntArray,
  @JvmField val parameterIds: Array<String>,
  @JvmField val parameterValues: DoubleArray,
  @JvmField val bindingPresent: Boolean,
  @JvmField val bindingKind: String,
  @JvmField val bindingLaneId: String
)

class NativePlaybackGraphConnectionJni(
  @JvmField val sourceNode: Long,
  @JvmField val sourcePort: String,
  @JvmField val destinationNode: Long,
  @JvmField val destinationPort: String
)

/**
 * Framework-free validation for the Android native-playback boundary.
 *
 * React Native maps are converted to ordinary maps before they reach this
 * object, which keeps the exact Phase 4 transport/cue contract executable in
 * the local JVM suite. Nothing below opens media or touches an audio device.
 */
object NativePlaybackBridgeSchema {
  const val INTERFACE_VERSION = 3
  const val PLAYBACK_CONTRACT_VERSION = 2
  const val BUILD_ID = "singz.android.zdsp_runtime.phase-android-q32-time-pitch-v3"
  const val PLAYBACK_BUILD = "singz.native.playback-session.anchored-preview.v4"

  const val MAXIMUM_LANES = 16
  const val MAXIMUM_CHANNELS = 64
  const val MAXIMUM_BEATS = 20_000
  const val MAXIMUM_EVENTS = 40_000
  const val MAXIMUM_TRAINING_WINDOWS = 16_384
  const val MAXIMUM_DURATION_SECONDS = 12.0 * 60.0 * 60.0
  const val MAXIMUM_GAIN = 4.0
  const val MAXIMUM_JS_SAFE_INTEGER = 9_007_199_254_740_991.0
  const val GRAPH_FORMAT = 1
  const val MAXIMUM_GRAPH_NODES = 128
  const val MAXIMUM_GRAPH_CONNECTIONS = 256
  const val MAXIMUM_GRAPH_PORTS_PER_NODE = 16
  const val MAXIMUM_GRAPH_PARAMETERS_PER_NODE = 64

  data class GraphPort(val id: String, val channels: Int)
  data class GraphParameter(val id: String, val normalizedValue: Double)
  data class GraphBinding(val kind: String, val laneId: String)
  data class GraphNode(
    val id: Long,
    val typeHigh: Long,
    val typeLow: Long,
    val typeVersion: Int,
    val execution: String,
    val unavailable: Int,
    val inputs: List<GraphPort>,
    val outputs: List<GraphPort>,
    val parameters: List<GraphParameter>,
    val binding: GraphBinding?
  ) {
    fun toJni() = NativePlaybackGraphNodeJni(
      id, typeHigh, typeLow, typeVersion, execution, unavailable,
      inputs.map { it.id }.toTypedArray(), inputs.map { it.channels }.toIntArray(),
      outputs.map { it.id }.toTypedArray(), outputs.map { it.channels }.toIntArray(),
      parameters.map { it.id }.toTypedArray(),
      parameters.map { it.normalizedValue }.toDoubleArray(),
      binding != null, binding?.kind.orEmpty(), binding?.laneId.orEmpty()
    )
  }
  data class GraphConnection(
    val sourceNode: Long,
    val sourcePort: String,
    val destinationNode: Long,
    val destinationPort: String
  ) {
    fun toJni() = NativePlaybackGraphConnectionJni(
      sourceNode, sourcePort, destinationNode, destinationPort
    )
  }
  data class GraphDocument(
    val nodes: List<GraphNode>,
    val connections: List<GraphConnection>
  )

  data class Lane(
    val id: String,
    val path: String,
    val gain: Float,
    val muted: Boolean,
    val solo: Boolean
  )

  data class BeatGrid(
    val beats: DoubleArray,
    val beatsPerBar: Int,
    val downbeat: Int,
    val downbeats: IntArray
  )

  data class Playback(
    val entrySeconds: Double,
    /** Where the song audibly begins when that is not the entry (a Play from
     *  mid-song with the count-in on): the core plans the count-in before it
     *  and lands the transport on it. Negative when absent. */
    val countInAnchorSeconds: Double,
    val playbackRate: Double,
    val transposeSemitones: Double,
    val click: Boolean,
    val countInBars: Int,
    val volume: Double,
    val accent: Boolean,
    val beatGrid: BeatGrid?
  )

  sealed interface Training {
    val laneIds: List<String>
    val enabled: Boolean

    data class Period(
      val periodFrames: Long,
      override val laneIds: List<String>,
      override val enabled: Boolean
    ) : Training

    data class Windows(
      val windows: List<Window>,
      override val laneIds: List<String>,
      override val enabled: Boolean
    ) : Training
  }

  data class Window(val startProjectFrame: Long, val endProjectFrame: Long)

  data class InitialLoop(val startProjectFrame: Long, val endProjectFrame: Long)
  data class InitialTransport(val startPaused: Boolean, val loop: InitialLoop?)

  data class Prepare(
    val lanes: List<Lane>,
    val outputDeviceUid: String,
    val outputChannels: IntArray,
    val sampleRate: Int,
    val maximumFrames: Int,
    val bufferFrames: Int,
    val masterGain: Float,
    val maximumRetainedBytes: Long,
    val handoffLease: Long,
    /** Replace this generation on its running stream; 0 is an ordinary
     *  prepare. See NativePlaybackPrepareConfig::swapFromGeneration. */
    val swapFromGeneration: Long,
    /** Play the lanes out of their FLAC instead of decoding each one whole.
     *  See NativePlaybackPrepareConfig::streamLanes; absent is false, which is
     *  today's behaviour exactly. */
    val streamLanes: Boolean,
    val preparedStartProjectFrame: Long?,
    val initialTransport: InitialTransport,
    val playback: Playback?,
    val training: Training?,
    val graphDocument: GraphDocument?
  )

  sealed interface Control {
    data class LaneControl(
      val laneId: String,
      val gain: Float,
      val muted: Boolean,
      val solo: Boolean
    ) : Control

    data class MasterGain(val gain: Float) : Control
    data class TrainingEnabled(val enabled: Boolean) : Control
  }

  sealed interface Transport {
    data object Pause : Transport
    data object Resume : Transport
    data class Seek(val projectFrame: Long) : Transport
    data class SetLoop(val startProjectFrame: Long, val endProjectFrame: Long) : Transport
    data object ClearLoop : Transport
    data object Reanchor : Transport
  }

  enum class PreviewClickSound(val nativeValue: Int) {
    Ordinary(0),
    Accent(1)
  }

  class Invalid(message: String) : IllegalArgumentException(message)

  fun generation(value: Double): Long = unsignedInteger(value, false, "generation")

  fun previewClickSound(value: Double): PreviewClickSound =
    when (uint32(value, true, "preview sound")) {
      0 -> PreviewClickSound.Ordinary
      1 -> PreviewClickSound.Accent
      else -> invalid("The native playback preview sound is invalid")
    }

  fun prepare(value: Map<String, Any?>): Prepare {
    exactKeys(
      value,
      setOf(
        "lanes", "outputDeviceUid", "outputChannels", "sampleRate",
        "maximumFrames", "bufferFrames", "masterGain", "maximumRetainedBytes",
        "handoffLease", "playback", "training", "preparedStartProjectFrame",
        "initialTransport", "graphDocument", "swapFromGeneration",
        "streamLanes"
      )
    )
    val laneValues = list(value["lanes"], "lanes")
    if (laneValues.isEmpty() || laneValues.size > MAXIMUM_LANES)
      invalid("The native playback lane list is invalid")
    val lanes = laneValues.map { raw ->
      val lane = map(raw, "lane")
      exactKeys(lane, setOf("id", "path", "gain", "muted", "solo"))
      Lane(
        string(lane["id"], "lane id"),
        string(lane["path"], "lane path"),
        optionalGain(lane, "gain", 1.0F),
        optionalBoolean(lane, "muted", false),
        optionalBoolean(lane, "solo", false)
      )
    }
    if (lanes.map { it.id }.toSet().size != lanes.size)
      invalid("Native playback lane IDs must be unique")

    val channels = list(value["outputChannels"], "outputChannels").map {
      unsignedInteger(number(it, "output channel"), true, "output channel").toInt()
    }
    if (channels.isEmpty() || channels.size > MAXIMUM_CHANNELS ||
      channels.any { it !in 0 until MAXIMUM_CHANNELS } || channels.toSet().size != channels.size
    ) invalid("The native playback output channel list is invalid")

    val sampleRate = uint32(value["sampleRate"], false, "sample rate")
    val maximumFrames = value["maximumFrames"]?.let {
      uint32(it, false, "maximum callback size")
    } ?: 4096
    val bufferFrames = value["bufferFrames"]?.let {
      uint32(it, true, "buffer size")
    } ?: 0
    val retained = value["maximumRetainedBytes"]?.let {
      unsignedInteger(number(it, "retained-byte limit"), false, "retained-byte limit")
    } ?: (1L shl 30)
    val lease = value["handoffLease"]?.let {
      unsignedInteger(number(it, "handoff lease"), false, "handoff lease")
    } ?: 0L
    val swapFrom = value["swapFromGeneration"]?.let {
      unsignedInteger(number(it, "swap source generation"), false, "swap source generation")
    } ?: 0L

    return Prepare(
      lanes = lanes,
      outputDeviceUid = string(value["outputDeviceUid"], "output device UID"),
      outputChannels = channels.toIntArray(),
      sampleRate = sampleRate,
      maximumFrames = maximumFrames,
      bufferFrames = bufferFrames,
      masterGain = optionalGain(value, "masterGain", 1.0F),
      maximumRetainedBytes = retained,
      handoffLease = lease,
      swapFromGeneration = swapFrom,
      streamLanes = optionalBoolean(value, "streamLanes", false),
      preparedStartProjectFrame = value["preparedStartProjectFrame"]?.let {
        signedInteger(it, "prepared start project frame")
      },
      initialTransport = value["initialTransport"]?.let {
        initialTransport(map(it, "initial transport"))
      } ?: InitialTransport(false, null),
      playback = value["playback"]?.let { playback(map(it, "playback")) },
      training = value["training"]?.let { training(map(it, "training")) },
      graphDocument = value["graphDocument"]?.let { graphDocument(map(it, "graph document")) }
    )
  }

  private fun graphDocument(value: Map<String, Any?>): GraphDocument {
    exactKeys(value, setOf("format", "engine", "nodes", "connections"))
    if (uint32(value["format"], false, "graph format") != GRAPH_FORMAT ||
      string(value["engine"], "graph engine") != "singz-dsp"
    ) invalid("The portable graph envelope is unsupported")
    val nodes = list(value["nodes"], "graph nodes").map { graphNode(map(it, "graph node")) }
    val connections = list(value["connections"], "graph connections").map {
      graphConnection(map(it, "graph connection"))
    }
    if (nodes.isEmpty() || nodes.size > MAXIMUM_GRAPH_NODES ||
      connections.size > MAXIMUM_GRAPH_CONNECTIONS ||
      nodes.map { it.id }.toSet().size != nodes.size
    ) invalid("The portable graph topology exceeds native bounds")
    return GraphDocument(nodes, connections)
  }

  private fun graphNode(value: Map<String, Any?>): GraphNode {
    exactKeys(
      value,
      setOf(
        "id", "type", "typeVersion", "execution", "unavailable",
        "ports", "parameters", "binding"
      )
    )
    val type = graphType(string(value["type"], "graph node type"))
    val ports = map(value["ports"], "graph ports")
    exactKeys(ports, setOf("inputs", "outputs"))
    val inputs = graphPorts(ports["inputs"], "graph input ports")
    val outputs = graphPorts(ports["outputs"], "graph output ports")
    val parametersObject = map(value["parameters"], "graph parameters")
    if (parametersObject.size > MAXIMUM_GRAPH_PARAMETERS_PER_NODE)
      invalid("The portable graph parameter list is too large")
    val parameters = parametersObject.entries.map { (id, raw) ->
      GraphParameter(stableGraphName(id, "graph parameter"), finite(raw, 0.0, 1.0, "graph parameter"))
    }
    val binding = value["binding"]?.let {
      val objectValue = map(it, "graph binding")
      exactKeys(objectValue, setOf("kind", "laneId"))
      GraphBinding(
        stableGraphName(string(objectValue["kind"], "graph binding kind"), "graph binding kind"),
        objectValue["laneId"]?.let { lane ->
          stableGraphName(string(lane, "graph binding lane"), "graph binding lane")
        }.orEmpty()
      )
    }
    val policy = when (string(value["unavailable"], "graph unavailable policy")) {
      "bypass" -> 0
      "silence" -> 1
      else -> invalid("The portable graph unavailable policy is invalid")
    }
    return GraphNode(
      graphUnsigned64(string(value["id"], "graph node id"), false, "graph node id"),
      type.first,
      type.second,
      uint32(value["typeVersion"], false, "graph type version"),
      stableGraphName(string(value["execution"], "graph execution"), "graph execution"),
      policy,
      inputs,
      outputs,
      parameters,
      binding
    )
  }

  private fun graphPorts(value: Any?, label: String): List<GraphPort> {
    val result = list(value, label).map { raw ->
      val objectValue = map(raw, "graph port")
      exactKeys(objectValue, setOf("id", "channels"))
      GraphPort(
        stableGraphName(string(objectValue["id"], "graph port id"), "graph port id"),
        uint32(objectValue["channels"], false, "graph port channels")
      )
    }
    if (result.size > MAXIMUM_GRAPH_PORTS_PER_NODE ||
      result.map { it.id }.toSet().size != result.size ||
      result.any { it.channels > MAXIMUM_CHANNELS }
    ) invalid("The portable graph port list is invalid")
    return result
  }

  private fun graphConnection(value: Map<String, Any?>): GraphConnection {
    exactKeys(value, setOf("from", "to"))
    fun endpoint(raw: Any?, label: String): Pair<Long, String> {
      val objectValue = map(raw, label)
      exactKeys(objectValue, setOf("node", "port"))
      return graphUnsigned64(string(objectValue["node"], "$label node"), false, "$label node") to
        stableGraphName(string(objectValue["port"], "$label port"), "$label port")
    }
    val from = endpoint(value["from"], "graph source")
    val to = endpoint(value["to"], "graph destination")
    return GraphConnection(from.first, from.second, to.first, to.second)
  }

  private fun graphType(value: String): Pair<Long, Long> {
    if (!value.matches(Regex("^[0-9a-f]{32}$")))
      invalid("The portable graph type ID is invalid")
    return try {
      value.substring(0, 16).toULong(16).toLong() to
        value.substring(16).toULong(16).toLong()
    } catch (_: NumberFormatException) {
      invalid("The portable graph type ID is invalid")
    }
  }

  private fun graphUnsigned64(value: String, allowZero: Boolean, label: String): Long {
    if (!value.matches(Regex(if (allowZero) "^(?:0|[1-9][0-9]*)$" else "^[1-9][0-9]*$")))
      invalid("The portable graph $label is invalid")
    return try {
      val parsed = value.toULong(10)
      if (!allowZero && parsed == 0UL) invalid("The portable graph $label is invalid")
      parsed.toLong()
    } catch (_: NumberFormatException) {
      invalid("The portable graph $label is invalid")
    }
  }

  private fun stableGraphName(value: String, label: String): String {
    if (value.length !in 1..128 || value.any { it.code < 0x20 || it.code == 0x7f })
      invalid("The portable graph $label is invalid")
    return value
  }

  private fun initialTransport(value: Map<String, Any?>): InitialTransport {
    exactKeys(value, setOf("state", "loop"))
    val paused = when (string(value["state"], "initial transport state")) {
      "playing" -> false
      "paused" -> true
      else -> invalid("The prepared initial transport state is invalid")
    }
    val loop = value["loop"]?.let { raw ->
      val objectValue = map(raw, "initial loop")
      exactKeys(objectValue, setOf("startProjectFrame", "endProjectFrame"))
      val start = nonNegativeFrame(objectValue["startProjectFrame"], "initial loop start")
      val end = nonNegativeFrame(objectValue["endProjectFrame"], "initial loop end")
      if (end <= start) invalid("The prepared initial loop range is invalid")
      InitialLoop(start, end)
    }
    return InitialTransport(paused, loop)
  }

  fun control(value: Map<String, Any?>): Control {
    val hasLane = value.containsKey("laneId")
    val hasMaster = value.containsKey("masterGain")
    val hasTraining = value.containsKey("trainingEnabled")
    if (listOf(hasLane, hasMaster, hasTraining).count { it } != 1)
      invalid("A native playback control selector is invalid")
    return if (hasLane) {
      exactKeys(value, setOf("laneId", "gain", "muted", "solo"))
      Control.LaneControl(
        string(value["laneId"], "lane id"),
        requiredGain(value["gain"], "lane gain"),
        boolean(value["muted"], "muted"),
        boolean(value["solo"], "solo")
      )
    } else if (hasMaster) {
      exactKeys(value, setOf("masterGain"))
      Control.MasterGain(requiredGain(value["masterGain"], "master gain"))
    } else {
      exactKeys(value, setOf("trainingEnabled"))
      Control.TrainingEnabled(boolean(value["trainingEnabled"], "training enabled"))
    }
  }

  private fun training(value: Map<String, Any?>): Training {
    exactKeys(value, setOf("mode", "periodFrames", "windows", "laneIds", "enabled"))
    val laneIds = list(value["laneIds"], "training lane IDs").map {
      string(it, "training lane ID")
    }
    if (laneIds.isEmpty() || laneIds.size > MAXIMUM_LANES || laneIds.toSet().size != laneIds.size)
      invalid("The native playback training lane list is invalid")
    val enabled = boolean(value["enabled"], "training enabled")
    return when (string(value["mode"], "training mode")) {
      "period" -> {
        if (value.containsKey("windows"))
          invalid("A period training schedule cannot contain windows")
        Training.Period(
          unsignedInteger(number(value["periodFrames"], "training period"), false, "training period"),
          laneIds,
          enabled
        )
      }
      "windows" -> {
        if (value.containsKey("periodFrames"))
          invalid("A window training schedule cannot contain a period")
        val windows = list(value["windows"], "training windows").map { raw ->
          val window = map(raw, "training window")
          exactKeys(window, setOf("startProjectFrame", "endProjectFrame"))
          val start = nonNegativeFrame(window["startProjectFrame"], "training window start")
          val end = nonNegativeFrame(window["endProjectFrame"], "training window end")
          if (end <= start) invalid("A native playback training window is invalid")
          Window(start, end)
        }
        if (windows.isEmpty() || windows.size > MAXIMUM_TRAINING_WINDOWS)
          invalid("The native playback training window list is invalid")
        for (index in 1 until windows.size)
          if (windows[index].startProjectFrame < windows[index - 1].endProjectFrame)
            invalid("The native playback training windows overlap")
        Training.Windows(windows, laneIds, enabled)
      }
      else -> invalid("The native playback training mode is invalid")
    }
  }

  fun transport(value: Map<String, Any?>): Transport {
    return when (string(value["kind"], "transport kind")) {
      "pause" -> noArgumentTransport(value, Transport.Pause)
      "resume" -> noArgumentTransport(value, Transport.Resume)
      "clear-loop" -> noArgumentTransport(value, Transport.ClearLoop)
      "reanchor" -> noArgumentTransport(value, Transport.Reanchor)
      "seek" -> {
        exactKeys(value, setOf("kind", "projectFrame"))
        Transport.Seek(nonNegativeFrame(value["projectFrame"], "project frame"))
      }
      "set-loop" -> {
        exactKeys(value, setOf("kind", "startProjectFrame", "endProjectFrame"))
        val start = nonNegativeFrame(value["startProjectFrame"], "loop start")
        val end = nonNegativeFrame(value["endProjectFrame"], "loop end")
        if (end <= start) invalid("The native playback loop range is invalid")
        Transport.SetLoop(start, end)
      }
      else -> invalid("The native playback transport command is invalid")
    }
  }

  private fun playback(value: Map<String, Any?>): Playback {
    exactKeys(value, setOf("version", "transport", "cues"))
    if (uint32(value["version"], false, "playback contract version") != PLAYBACK_CONTRACT_VERSION)
      invalid("The native playback contract version is unsupported")
    val transport = map(value["transport"], "transport")
    exactKeys(transport, setOf("entrySeconds", "countInAnchorSeconds", "durationSeconds", "playbackRate", "transposeSemitones"))
    val entry = finite(transport["entrySeconds"], 0.0, MAXIMUM_DURATION_SECONDS, "entry")
    val anchor = transport["countInAnchorSeconds"]?.let {
      finite(it, 0.0, MAXIMUM_DURATION_SECONDS, "count-in anchor")
    } ?: -1.0
    if (anchor >= 0.0 && anchor < entry) invalid("The native playback count-in anchor precedes the entry")
    val rate = finite(transport["playbackRate"], 0.25, 4.0, "playback rate")
    val transpose = finite(transport["transposeSemitones"], -24.0, 24.0, "transpose")
    transport["durationSeconds"]?.let {
      if (finite(it, 0.0, MAXIMUM_DURATION_SECONDS, "duration") <= 0.0)
        invalid("The native playback duration is invalid")
    }

    val cues = map(value["cues"], "cues")
    exactKeys(cues, setOf("click", "countInBars", "volume", "accent", "beatGrid"))
    val click = boolean(cues["click"], "click")
    val countInBars = uint32(cues["countInBars"], true, "count-in bars")
    if (countInBars > 2) invalid("The native playback count-in is invalid")
    val volume = finite(cues["volume"], 0.0, 1.0, "cue volume")
    val accent = boolean(cues["accent"], "accent")
    val grid = cues["beatGrid"]?.let { beatGrid(map(it, "beat grid"), countInBars) }
    if (click && grid == null) invalid("A click track requires a beat grid")
    val eventPotential = (if (click) (grid?.beats?.size ?: 0) + 2 else 0) +
      countInBars * (grid?.maximumBarLength() ?: 3)
    if (eventPotential > MAXIMUM_EVENTS)
      invalid("The native playback cue plan is too large")
    return Playback(entry, anchor, rate, transpose, click, countInBars, volume, accent, grid)
  }

  private fun beatGrid(value: Map<String, Any?>, countInBars: Int): BeatGrid {
    exactKeys(value, setOf("beats", "beatsPerBar", "downbeat", "downbeats"))
    val beats = list(value["beats"], "beats").map {
      finite(it, 0.0, MAXIMUM_DURATION_SECONDS, "beat")
    }
    if (beats.size !in 2..MAXIMUM_BEATS) invalid("The native playback beat grid is invalid")
    val intervals = ArrayList<Double>(beats.size - 1)
    for (index in 1 until beats.size) {
      val interval = beats[index] - beats[index - 1]
      if (interval <= 0.05) invalid("The native playback beat grid is not ordered")
      intervals += interval
    }
    intervals.sort()
    val bpm = 60.0 / intervals[intervals.size / 2]
    if (!bpm.isFinite() || bpm !in 30.0..300.0)
      invalid("The native playback beat grid tempo is invalid")

    val beatsPerBar = uint32(value["beatsPerBar"], false, "beats per bar")
    if (beatsPerBar !in setOf(2, 3, 4, 6)) invalid("The native playback meter is invalid")
    val downbeat = uint32(value["downbeat"], true, "downbeat")
    if (downbeat >= beatsPerBar) invalid("The native playback downbeat is invalid")
    val downbeats = list(value["downbeats"], "downbeats").map {
      uint32(it, true, "downbeat index")
    }
    if (downbeats.size > beats.size || downbeats.any { it !in beats.indices })
      invalid("The native playback downbeat list is invalid")
    for (index in 1 until downbeats.size) {
      if (downbeats[index] <= downbeats[index - 1])
        invalid("The native playback downbeat list is not ordered")
    }
    val grid = BeatGrid(beats.toDoubleArray(), beatsPerBar, downbeat, downbeats.toIntArray())
    if (countInBars.toLong() * grid.maximumBarLength() > MAXIMUM_EVENTS)
      invalid("The native playback count-in plan is too large")
    return grid
  }

  private fun BeatGrid.maximumBarLength(): Int {
    var result = beatsPerBar
    for (index in 1 until downbeats.size)
      result = maxOf(result, downbeats[index] - downbeats[index - 1])
    return result
  }

  private fun <T : Transport> noArgumentTransport(
    value: Map<String, Any?>,
    result: T
  ): T {
    exactKeys(value, setOf("kind"))
    return result
  }

  private fun nonNegativeFrame(value: Any?, label: String): Long =
    unsignedInteger(number(value, label), true, label)

  private fun requiredGain(value: Any?, label: String): Float =
    finite(value, 0.0, MAXIMUM_GAIN, label).toFloat()

  private fun optionalGain(value: Map<String, Any?>, key: String, fallback: Float): Float =
    value[key]?.let { requiredGain(it, key) } ?: fallback

  private fun optionalBoolean(value: Map<String, Any?>, key: String, fallback: Boolean): Boolean =
    value[key]?.let { boolean(it, key) } ?: fallback

  private fun uint32(value: Any?, allowZero: Boolean, label: String): Int {
    val parsed = unsignedInteger(number(value, label), allowZero, label)
    if (parsed > UInt.MAX_VALUE.toLong() || parsed > Int.MAX_VALUE.toLong())
      invalid("The native playback $label is out of range")
    return parsed.toInt()
  }

  private fun unsignedInteger(value: Double, allowZero: Boolean, label: String): Long {
    if (!value.isFinite() || value < (if (allowZero) 0.0 else 1.0) ||
      floor(value) != value || value > MAXIMUM_JS_SAFE_INTEGER
    ) invalid("The native playback $label is invalid")
    return value.toLong()
  }

  private fun signedInteger(value: Any?, label: String): Long {
    val parsed = number(value, label)
    if (!parsed.isFinite() || floor(parsed) != parsed ||
      parsed < -MAXIMUM_JS_SAFE_INTEGER || parsed > MAXIMUM_JS_SAFE_INTEGER
    ) invalid("The native playback $label is invalid")
    return parsed.toLong()
  }

  private fun finite(value: Any?, minimum: Double, maximum: Double, label: String): Double {
    val result = number(value, label)
    if (!result.isFinite() || result < minimum || result > maximum)
      invalid("The native playback $label is invalid")
    return result
  }

  private fun number(value: Any?, label: String): Double {
    if (value !is Number) invalid("The native playback $label is not a number")
    return value.toDouble()
  }

  private fun boolean(value: Any?, label: String): Boolean =
    value as? Boolean ?: invalid("The native playback $label is not a boolean")

  private fun string(value: Any?, label: String): String {
    val result = value as? String ?: invalid("The native playback $label is not a string")
    if (result.isEmpty() || result.indexOf('\u0000') >= 0)
      invalid("The native playback $label is invalid")
    return result
  }

  @Suppress("UNCHECKED_CAST")
  private fun map(value: Any?, label: String): Map<String, Any?> {
    if (value !is Map<*, *> || value.keys.any { it !is String })
      invalid("The native playback $label is not an object")
    return value as Map<String, Any?>
  }

  private fun list(value: Any?, label: String): List<Any?> =
    value as? List<Any?> ?: invalid("The native playback $label is not an array")

  private fun exactKeys(value: Map<String, Any?>, allowed: Set<String>) {
    if (value.keys.any { it !in allowed }) invalid("The native playback schema has an unknown field")
  }

  private fun invalid(message: String): Nothing = throw Invalid(message)
}
