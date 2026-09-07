package com.singzplayer

import android.content.Context
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.singzplayer.split.SingzCore
import java.io.File
import java.io.FileInputStream
import java.io.InputStream
import java.security.MessageDigest
import java.util.zip.ZipFile
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Executes the full descriptor-decoder matrix in the installed target process
 * and writes pullable evidence. It never initializes AudioManager or a native
 * AudioHost; all work is on the instrumentation test thread.
 */
@RunWith(AndroidJUnit4::class)
class CodecTargetProofInstrumentedTest {
  private val names = listOf(
    "tone.mp3",
    "tone.aac",
    "tone-aac.m4a",
    "tone-alac.m4a",
    "tone.ogg",
    "tone.opus",
    "tone.aiff",
    "tone.aifc",
    "audio-plus-video.m4a",
    "video-only.m4a",
    "unsupported-flac.ogg",
    "cancel-long.mp3"
  )

  private fun digest(input: InputStream): String {
    val digest = MessageDigest.getInstance("SHA-256")
    input.use {
      val buffer = ByteArray(32 * 1024)
      while (true) {
        val count = it.read(buffer)
        if (count < 0) break
        digest.update(buffer, 0, count)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it) }
  }

  private fun sha256(file: File): String = digest(FileInputStream(file))

  private fun sha256(text: String): String = MessageDigest.getInstance("SHA-256")
    .digest(text.toByteArray(Charsets.UTF_8))
    .joinToString("") { "%02x".format(it) }

  private fun copyFixtures(context: Context): List<File> {
    val directory = File(context.filesDir, "codec-target-proof-fixtures")
    directory.mkdirs()
    return names.map { name ->
      val target = File(directory, name)
      context.assets.open(name).use { input ->
        target.outputStream().use { output -> input.copyTo(output) }
      }
      target
    }
  }

  private fun packagedNativeArtifact(
    context: Context,
    abi: String,
    name: String
  ): JSONObject {
    val extracted = File(context.applicationInfo.nativeLibraryDir, name)
    if (extracted.isFile) {
      return JSONObject()
        .put("path", extracted.absolutePath)
        .put("bytes", extracted.length())
        .put("sha256", sha256(extracted))
    }
    val entryName = "lib/$abi/$name"
    val apks = listOfNotNull(context.applicationInfo.sourceDir) +
      context.applicationInfo.splitSourceDirs.orEmpty()
    for (apk in apks) {
      ZipFile(apk).use { archive ->
        val entry = archive.getEntry(entryName) ?: return@use
        return JSONObject()
          .put("path", "$apk!/$entryName")
          .put("bytes", entry.size)
          .put("sha256", digest(archive.getInputStream(entry)))
      }
    }
    throw AssertionError("packaged native artifact is missing: $entryName in $apks")
  }

  private fun runtimeRow(context: Context, abi: String, component: String): JSONObject {
    val file = packagedNativeArtifact(context, abi, "lib$component.so")
    return JSONObject()
      .put("component", component)
      .put("path", file.getString("path"))
      .put("bytes", file.getLong("bytes"))
      .put("sha256", file.getString("sha256"))
  }

  @Test
  fun packagedRuntimeExecutesFullMatrixAndPublishesBoundEvidence() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    assertNull(SingzCore.ensureLoaded())

    val fixtures = copyFixtures(context)
    val nativeOutputText = SingzCore.nativeCodecTargetProof(
      fixtures.map { it.absolutePath }.toTypedArray()
    )
    val nativeOutput = JSONObject(nativeOutputText)
    assertEquals(nativeOutputText, "actual-packaged-zcore-runtime", nativeOutput.getString("execution"))
    assertEquals(nativeOutputText, "full dynamic matrix ok", nativeOutput.getString("result"))

    val configuration = nativeOutput.getString("runtimeConfiguration")
    val selection = File(context.filesDir, "codec-target-selection.json")
    context.assets.open("third_party/ffmpeg/singz-ffmpeg-selection.json").use { input ->
      selection.outputStream().use { output -> input.copyTo(output) }
    }
    assertTrue("packaged selection receipt is missing", selection.isFile)

    val abi = Build.SUPPORTED_ABIS.first()
    val target = when (abi) {
      "arm64-v8a" -> "android-arm64-v8a"
      "armeabi-v7a" -> "android-armeabi-v7a"
      "x86" -> "android-x86"
      "x86_64" -> "android-x86_64"
      else -> throw AssertionError("unsupported Android proof ABI: $abi")
    }
    val binary = packagedNativeArtifact(context, abi, "libsingzcore.so")
    val packageInfo = context.packageManager.getPackageInfo(context.packageName, 0)
    val versionCode = if (Build.VERSION.SDK_INT >= 28) {
      packageInfo.longVersionCode
    } else {
      @Suppress("DEPRECATION") packageInfo.versionCode.toLong()
    }
    val evidence = JSONObject()
      .put("format", 1)
      .put("executionMode", "actual-packaged-runtime")
      .put("platform", "android")
      .put("target", target)
      .put("architecture", abi)
      .put("osVersion", Build.VERSION.RELEASE)
      .put("result", "full dynamic matrix ok")
      .put("nativeOutput", nativeOutputText)
      .put("outputSha256", sha256(nativeOutputText))
      .put("configurationSha256", sha256(configuration))
      .put("runtimeLibraries", JSONArray(listOf(
        runtimeRow(context, abi, "avcodec"),
        runtimeRow(context, abi, "avformat"),
        runtimeRow(context, abi, "avutil"),
        runtimeRow(context, abi, "swresample")
      )))
      .put("binary", JSONObject()
        .put("id", "${context.packageName}:${packageInfo.versionName}:$versionCode:$abi")
        .put("path", binary.getString("path"))
        .put("bytes", binary.getLong("bytes"))
        .put("sha256", binary.getString("sha256")))
      .put("selectionReceipt", JSONObject()
        .put("path", "third_party/ffmpeg/singz-ffmpeg-selection.json")
        .put("bytes", selection.length())
        .put("sha256", sha256(selection))
        .put("json", selection.readText()))
      .put("fixtures", JSONArray(fixtures.mapIndexed { index, file ->
        JSONObject()
          .put("name", names[index])
          .put("bytes", file.length())
          .put("sha256", sha256(file))
      }))

    val outputDirectory = File(context.filesDir, "codec-target-proof")
    outputDirectory.mkdirs()
    val evidenceFile = File(outputDirectory, "$target.json")
    evidenceFile.writeText(evidence.toString(2) + "\n")
    println("SINGZ_CODEC_TARGET_PROOF=${evidenceFile.absolutePath}")
  }
}
