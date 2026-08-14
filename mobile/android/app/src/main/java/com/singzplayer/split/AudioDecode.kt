package com.singzplayer.split

import android.media.AudioFormat
import android.media.MediaCodec
import android.media.MediaExtractor
import android.media.MediaFormat
import android.os.SystemClock
import java.io.File
import java.io.FileOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Platform decode for the split job: any audio the phone can play
 * (mp3/m4a/aac/flac/wav/ogg via MediaExtractor+MediaCodec) to the raw
 * interleaved f32 STEREO file the C++ engine consumes. Kept at the source
 * sample rate — the engine owns resampling to the graph's 44.1 kHz.
 */
object AudioDecode {
  class DecodeException(message: String) : Exception(message)

  data class Result(val sampleRate: Int, val frames: Long)

  /**
   * Decode srcPath into outFile. Throws DecodeException with user-facing
   * text on anything unplayable; cancel is polled between buffers and
   * surfaces as DecodeException("cancelled") after cleanup.
   */
  fun decodeToRawF32Stereo(
    srcPath: String,
    outFile: File,
    cancelled: () -> Boolean,
    onProgress: (Float) -> Unit
  ): Result {
    val extractor = MediaExtractor()
    var codec: MediaCodec? = null
    var out: FileOutputStream? = null
    try {
      try {
        extractor.setDataSource(srcPath)
      } catch (e: Exception) {
        throw DecodeException("Could not open this file (${e.message ?: "unreadable"})")
      }
      var trackIndex = -1
      var format: MediaFormat? = null
      for (i in 0 until extractor.trackCount) {
        val f = extractor.getTrackFormat(i)
        val mime = f.getString(MediaFormat.KEY_MIME) ?: continue
        if (mime.startsWith("audio/")) {
          trackIndex = i
          format = f
          break
        }
      }
      if (trackIndex < 0 || format == null) throw DecodeException("No audio in this file")
      extractor.selectTrack(trackIndex)
      val mime = format.getString(MediaFormat.KEY_MIME)!!
      val durationUs =
        if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) else 0L

      // The track format goes to the codec UNTOUCHED. Requesting float via
      // KEY_PCM_ENCODING made the raw WAV decoder echo "float" in its output
      // format while emitting 16-bit samples — half the frames, all noise.
      // Unforced, the claimed encoding and the bytes agree; a plausibility
      // guard below turns any remaining mismatch into an error, not noise.
      codec = try {
        MediaCodec.createDecoderByType(mime).also { it.configure(format, null, null, 0); it.start() }
      } catch (e: Exception) {
        throw DecodeException("This phone cannot decode ${mime.removePrefix("audio/")} (${e.message ?: "no codec"})")
      }

      out = FileOutputStream(outFile)
      // Seeded from the track; the codec's own output format (signalled
      // before the first buffer) overrides all three.
      var sampleRate =
        if (format.containsKey(MediaFormat.KEY_SAMPLE_RATE)) format.getInteger(MediaFormat.KEY_SAMPLE_RATE) else 0
      var channels =
        if (format.containsKey(MediaFormat.KEY_CHANNEL_COUNT)) format.getInteger(MediaFormat.KEY_CHANNEL_COUNT) else 2
      var pcmEncoding =
        if (format.containsKey(MediaFormat.KEY_PCM_ENCODING)) format.getInteger(MediaFormat.KEY_PCM_ENCODING)
        else AudioFormat.ENCODING_PCM_16BIT
      var framesWritten = 0L
      var sawInputEos = false
      var sawOutputEos = false
      var lastProgressAt = SystemClock.elapsedRealtime()
      var lastReported = -1f
      var lastPumpAt = 0L
      var pack = ByteArray(0)
      val info = MediaCodec.BufferInfo()

      while (!sawOutputEos) {
        if (cancelled()) throw DecodeException("cancelled")

        var moved = false
        if (!sawInputEos) {
          val inIdx = codec.dequeueInputBuffer(10_000)
          if (inIdx >= 0) {
            moved = true
            val buf = codec.getInputBuffer(inIdx)!!
            val size = extractor.readSampleData(buf, 0)
            if (size < 0) {
              codec.queueInputBuffer(inIdx, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
              sawInputEos = true
            } else {
              codec.queueInputBuffer(inIdx, 0, size, extractor.sampleTime, 0)
              extractor.advance()
            }
          }
        }

        val outIdx = codec.dequeueOutputBuffer(info, 10_000)
        when {
          outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
            moved = true
            val f = codec.outputFormat
            val newRate = f.getInteger(MediaFormat.KEY_SAMPLE_RATE)
            if (framesWritten > 0 && newRate != sampleRate) {
              throw DecodeException("This file changes sample rate mid-stream")
            }
            sampleRate = newRate
            channels = f.getInteger(MediaFormat.KEY_CHANNEL_COUNT)
            pcmEncoding =
              if (f.containsKey(MediaFormat.KEY_PCM_ENCODING)) f.getInteger(MediaFormat.KEY_PCM_ENCODING)
              else AudioFormat.ENCODING_PCM_16BIT
          }
          outIdx >= 0 -> {
            moved = true
            if (info.size > 0) {
              val buf = codec.getOutputBuffer(outIdx)!!
              buf.position(info.offset)
              buf.limit(info.offset + info.size)
              buf.order(ByteOrder.nativeOrder())
              if (framesWritten == 0L && pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT) {
                // Music floats live in [-1, 1]; int16 bytes misread as f32
                // land at astronomic exponents. Better an honest error than
                // 20 minutes spent splitting noise.
                val fb = buf.asFloatBuffer()
                for (i in 0 until minOf(fb.remaining(), 4096)) {
                  val v = fb.get(i)
                  if (v.isNaN() || v > 16f || v < -16f) {
                    throw DecodeException("The decoder mislabeled its output for this file")
                  }
                }
              }
              val frames = writeStereoF32(buf, channels, pcmEncoding, out) { need ->
                if (pack.size < need) pack = ByteArray(need)
                pack
              }
              framesWritten += frames
            }
            codec.releaseOutputBuffer(outIdx, false)
            if (info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) sawOutputEos = true
            if (durationUs > 0 && info.presentationTimeUs > 0) {
              val frac = (info.presentationTimeUs.toFloat() / durationUs).coerceIn(0f, 1f)
              if (frac - lastReported >= 0.01f) {
                lastReported = frac
                onProgress(frac)
              }
            } else if (SystemClock.elapsedRealtime() - lastPumpAt >= 1000) {
              // Duration-less streams (raw ADTS, header-less VBR) still must
              // pump the caller's watchdog — silence here once meant a >5 min
              // decode was killed as "stalled" forever.
              lastPumpAt = SystemClock.elapsedRealtime()
              onProgress(0f)
            }
          }
        }

        if (moved) {
          lastProgressAt = SystemClock.elapsedRealtime()
        } else if (SystemClock.elapsedRealtime() - lastProgressAt > 30_000) {
          throw DecodeException("The decoder stalled on this file")
        }
      }

      if (framesWritten == 0L || sampleRate <= 0) throw DecodeException("No audio in this file")
      out.flush()
      out.fd.sync() // job.json says "decoded" only after these bytes are real
      return Result(sampleRate, framesWritten)
    } finally {
      try { out?.close() } catch (_: Exception) {}
      try { codec?.stop() } catch (_: Exception) {}
      try { codec?.release() } catch (_: Exception) {}
      try { extractor.release() } catch (_: Exception) {}
    }
  }

  /** One codec output buffer → interleaved f32 stereo appended to out. */
  private fun writeStereoF32(
    buf: ByteBuffer,
    channels: Int,
    pcmEncoding: Int,
    out: FileOutputStream,
    scratch: (Int) -> ByteArray
  ): Long {
    val srcCh = if (channels < 1) 1 else channels
    val frames: Int
    val bytes: ByteArray
    if (pcmEncoding == AudioFormat.ENCODING_PCM_FLOAT) {
      val fb = buf.asFloatBuffer()
      frames = fb.remaining() / srcCh
      bytes = scratch(frames * 8)
      val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      for (i in 0 until frames) {
        val base = i * srcCh
        val l = fb.get(base)
        // Channels beyond the first two are ignored (AAC layouts put L/R
        // first); mono duplicates into both lanes.
        val r = if (srcCh >= 2) fb.get(base + 1) else l
        bb.putFloat(l)
        bb.putFloat(r)
      }
    } else {
      val sb = buf.asShortBuffer()
      frames = sb.remaining() / srcCh
      bytes = scratch(frames * 8)
      val bb = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
      for (i in 0 until frames) {
        val base = i * srcCh
        val l = sb.get(base) / 32768f
        val r = if (srcCh >= 2) sb.get(base + 1) / 32768f else l
        bb.putFloat(l)
        bb.putFloat(r)
      }
    }
    out.write(bytes, 0, frames * 8)
    return frames.toLong()
  }
}
