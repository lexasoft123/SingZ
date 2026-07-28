package com.singzplayer

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.File
import java.net.HttpURLConnection
import java.net.ServerSocket
import java.net.URL
import java.util.concurrent.Executors
import kotlin.concurrent.thread

/**
 * Android counterpart of the iOS FolderAccess pod. The library root is either
 * the app's own folder (reachable over USB / adb push) or a folder picked with
 * the system document tree picker (SAF) — including Google Drive folders,
 * which stream and cache on first read the way iCloud dataless files do on
 * iOS. The JS API surface matches the iOS module exactly.
 */
class FolderAccessModule(private val ctx: ReactApplicationContext) :
  ReactContextBaseJavaModule(ctx), ActivityEventListener {

  private val exec = Executors.newSingleThreadExecutor()
  private var pickPromise: Promise? = null

  init {
    ctx.addActivityEventListener(this)
  }

  override fun getName(): String = "FolderAccess"

  private val prefs
    get() = ctx.getSharedPreferences("singz", Context.MODE_PRIVATE)

  // ---------------------------------------------------------------- roots --

  private fun documentsDir(): File {
    val base = ctx.getExternalFilesDir(null) ?: ctx.filesDir
    return File(base, "SingZ projects").apply { mkdirs() }
  }

  /** The picked tree, only while its persisted read permission is still held. */
  private fun rootUri(): Uri? {
    val stored = prefs.getString("rootUri", null) ?: return null
    val uri = Uri.parse(stored)
    val held = ctx.contentResolver.persistedUriPermissions.any {
      it.uri == uri && it.isReadPermission
    }
    return if (held) uri else null
  }

  private fun rootInfo(): WritableMap {
    val map = Arguments.createMap()
    val uri = rootUri()
    if (uri != null) {
      map.putString("kind", "picked")
      map.putString("path", uri.toString())
      map.putString("name", DocumentFile.fromTreeUri(ctx, uri)?.name ?: "Folder")
    } else {
      map.putString("kind", "documents")
      map.putString("path", documentsDir().absolutePath)
      map.putString("name", "On this device")
    }
    return map
  }

  @ReactMethod
  fun getRoot(promise: Promise) {
    promise.resolve(rootInfo())
  }

  @ReactMethod
  fun clearRoot(promise: Promise) {
    prefs.edit().remove("rootUri").apply()
    promise.resolve(rootInfo())
  }

  @ReactMethod
  fun pickFolder(promise: Promise) {
    val activity = ctx.currentActivity
      ?: return promise.reject("no_activity", "Nothing to present the folder picker from")
    if (pickPromise != null) return promise.reject("busy", "Folder picker is already open")
    pickPromise = promise
    val intent = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
      Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
    )
    try {
      activity.startActivityForResult(intent, PICK_REQUEST)
    } catch (e: Exception) {
      pickPromise = null
      promise.reject("picker", e.message ?: "Cannot open the folder picker")
    }
  }

  override fun onActivityResult(activity: Activity, requestCode: Int, resultCode: Int, data: Intent?) {
    if (requestCode != PICK_REQUEST) return
    val p = pickPromise ?: return
    pickPromise = null
    val uri = data?.data
    if (resultCode != Activity.RESULT_OK || uri == null) {
      p.resolve(null) // user cancelled — JS treats null as "keep current root"
      return
    }
    try {
      ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
      prefs.edit().putString("rootUri", uri.toString()).apply()
      p.resolve(rootInfo())
    } catch (e: Exception) {
      p.reject("persist", e.message ?: "Cannot keep access to that folder")
    }
  }

  override fun onNewIntent(intent: Intent) {}

  // ------------------------------------------------------------- listing --

  /** One resolver round-trip per directory: index children by name. */
  private fun index(dir: DocumentFile): Map<String, DocumentFile> =
    dir.listFiles().mapNotNull { f -> f.name?.let { it to f } }.toMap()

  private fun cacheFile(project: String, file: String): File =
    File(File(File(ctx.cacheDir, "singz-projects"), project), file)

  @ReactMethod
  fun listProjects(promise: Promise) {
    exec.execute {
      try {
        val arr = Arguments.createArray()
        val uri = rootUri()
        if (uri != null) {
          val root = DocumentFile.fromTreeUri(ctx, uri)
            ?: throw Exception("The picked folder is no longer reachable")
          for (dir in root.listFiles()) {
            val name = dir.name ?: continue
            if (!dir.isDirectory) continue
            val kids = index(dir)
            val meta = kids["project.json"] ?: continue
            val stemsDir = kids["stems"]
            val stemKids = if (stemsDir?.isDirectory == true) index(stemsDir) else emptyMap()
            val entry = Arguments.createMap()
            entry.putString("dir", name)
            entry.putString("meta", readDoc(meta))
            val stems = Arguments.createMap()
            var cached = true
            var bytes = 0L
            var any = false
            for (id in STEMS) {
              val f = stemKids["$id.flac"] ?: stemKids["$id.wav"] ?: continue
              val ext = if (f.name!!.endsWith(".flac")) "flac" else "wav"
              stems.putString(id, ext)
              any = true
              bytes += f.length()
              val local = cacheFile(name, "stems/${f.name}")
              if (!local.isFile || local.length() != f.length()) cached = false
            }
            if (!any) continue
            entry.putMap("stems", stems)
            entry.putBoolean("cached", cached)
            entry.putDouble("bytes", bytes.toDouble())
            entry.putBoolean("hasLyrics", kids.containsKey("lyrics.json"))
            arr.pushMap(entry)
          }
        } else {
          for (dir in documentsDir().listFiles() ?: emptyArray()) {
            if (!dir.isDirectory) continue
            val meta = File(dir, "project.json")
            if (!meta.isFile) continue
            val entry = Arguments.createMap()
            entry.putString("dir", dir.name)
            entry.putString("meta", meta.readText())
            val stems = Arguments.createMap()
            var bytes = 0L
            var any = false
            for (id in STEMS) {
              val flac = File(dir, "stems/$id.flac")
              val wav = File(dir, "stems/$id.wav")
              val f = if (flac.isFile) flac else if (wav.isFile) wav else continue
              stems.putString(id, if (f === flac) "flac" else "wav")
              any = true
              bytes += f.length()
            }
            if (!any) continue
            entry.putMap("stems", stems)
            entry.putBoolean("cached", true) // plain local files — nothing to fetch
            entry.putDouble("bytes", bytes.toDouble())
            entry.putBoolean("hasLyrics", File(dir, "lyrics.json").isFile)
            arr.pushMap(entry)
          }
        }
        promise.resolve(arr)
      } catch (e: Exception) {
        promise.reject("list", e.message ?: "Cannot list the projects folder")
      }
    }
  }

  // --------------------------------------------------------------- reads --

  private fun readDoc(doc: DocumentFile): String =
    ctx.contentResolver.openInputStream(doc.uri)?.use { it.readBytes().decodeToString() }
      ?: throw Exception("Cannot read ${doc.name}")

  /** Walk "a/b/c" from the tree root, one indexed listing per level. */
  private fun resolvePath(root: DocumentFile, path: String): DocumentFile? {
    var node: DocumentFile = root
    for (part in path.split('/')) {
      if (part.isEmpty()) continue
      node = index(node)[part] ?: return null
    }
    return node
  }

  @ReactMethod
  fun readText(project: String, file: String, promise: Promise) {
    exec.execute {
      try {
        val uri = rootUri()
        if (uri == null) {
          val f = File(File(documentsDir(), project), file)
          if (!f.isFile) throw Exception("$file is missing")
          promise.resolve(f.readText())
        } else {
          val root = DocumentFile.fromTreeUri(ctx, uri)
            ?: throw Exception("The picked folder is no longer reachable")
          val doc = resolvePath(root, "$project/$file") ?: throw Exception("$file is missing")
          promise.resolve(readDoc(doc))
        }
      } catch (e: Exception) {
        promise.reject("read", e.message ?: "Cannot read $file")
      }
    }
  }

  /**
   * Absolute path to a readable copy of project/file. Plain local roots hand
   * back the file itself; SAF trees copy into the cache on first use (a Drive
   * document downloads inside openInputStream — the provider blocks until the
   * bytes are local, so this doubles as ensureDownloaded).
   */
  @ReactMethod
  fun localFile(project: String, file: String, promise: Promise) {
    exec.execute {
      try {
        val uri = rootUri()
        if (uri == null) {
          val f = File(File(documentsDir(), project), file)
          if (!f.isFile) throw Exception("$file is missing")
          promise.resolve(f.absolutePath)
          return@execute
        }
        val root = DocumentFile.fromTreeUri(ctx, uri)
          ?: throw Exception("The picked folder is no longer reachable")
        val src = resolvePath(root, "$project/$file") ?: throw Exception("$file is missing")
        val out = cacheFile(project, file)
        if (!out.isFile || out.length() != src.length()) {
          out.parentFile?.mkdirs()
          val tmp = File(out.path + ".part")
          ctx.contentResolver.openInputStream(src.uri)?.use { input ->
            tmp.outputStream().use { output -> input.copyTo(output) }
          } ?: throw Exception("Cannot open $file")
          if (!tmp.renameTo(out)) throw Exception("Cannot cache $file")
        }
        promise.resolve(out.absolutePath)
      } catch (e: Exception) {
        promise.reject("file", e.message ?: "Cannot fetch $file")
      }
    }
  }

  // ------------------------------------------------- Google Drive helpers --

  private var oauthSocket: ServerSocket? = null

  /**
   * Loopback OAuth (Google installed-app flow): bind an ephemeral local port
   * for the browser to redirect back to. One Desktop-type OAuth client then
   * serves every platform — no custom schemes, no SHA-1 binding.
   */
  @ReactMethod
  fun oauthStart(promise: Promise) {
    try {
      oauthSocket?.close()
      val socket = ServerSocket(0)
      oauthSocket = socket
      promise.resolve(socket.localPort)
    } catch (e: Exception) {
      promise.reject("oauth", e.message ?: "Cannot open the sign-in listener")
    }
  }

  /** Wait for the browser redirect; resolves the full local URL (with ?code=). */
  @ReactMethod
  fun oauthWait(promise: Promise) {
    val socket = oauthSocket
      ?: return promise.reject("oauth", "Sign-in listener is not running")
    thread(name = "singz-oauth") {
      try {
        socket.soTimeout = 5 * 60 * 1000
        socket.accept().use { client ->
          val line = client.getInputStream().bufferedReader().readLine() ?: ""
          val path = line.split(" ").getOrNull(1) ?: "/"
          val body = "<html><body style=\"font-family:sans-serif;padding:40px\">" +
            "<h3>SingZ is signed in</h3>You can close this tab and go back to the app." +
            "</body></html>"
          client.getOutputStream().write(
            ("HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${body.length}\r\n" +
              "Connection: close\r\n\r\n$body").toByteArray()
          )
          client.getOutputStream().flush()
          promise.resolve("http://127.0.0.1:${socket.localPort}$path")
        }
      } catch (e: Exception) {
        promise.reject("oauth", e.message ?: "Sign-in was not completed")
      } finally {
        try { socket.close() } catch (_: Exception) {}
        if (oauthSocket === socket) oauthSocket = null
      }
    }
  }

  /**
   * Stream an authorized URL into the project cache (Drive media downloads —
   * stems are too big for the JS bridge). Same .part+rename discipline as
   * the SAF copies; skipped when the cached size already matches.
   */
  @ReactMethod
  fun fetchToCache(project: String, file: String, url: String, auth: String, expectedBytes: Double, promise: Promise) {
    exec.execute {
      try {
        val out = cacheFile(project, file)
        if (out.isFile && expectedBytes > 0 && out.length() == expectedBytes.toLong()) {
          promise.resolve(out.absolutePath)
          return@execute
        }
        val conn = URL(url).openConnection() as HttpURLConnection
        conn.setRequestProperty("Authorization", auth)
        conn.connectTimeout = 20000
        conn.readTimeout = 60000
        if (conn.responseCode / 100 != 2) {
          throw Exception("Drive download failed (${conn.responseCode}) for $file")
        }
        out.parentFile?.mkdirs()
        val tmp = File(out.path + ".part")
        conn.inputStream.use { input -> tmp.outputStream().use { o -> input.copyTo(o) } }
        if (!tmp.renameTo(out)) throw Exception("Cannot cache $file")
        promise.resolve(out.absolutePath)
      } catch (e: Exception) {
        promise.reject("fetch", e.message ?: "Cannot fetch $file")
      }
    }
  }

  companion object {
    private const val PICK_REQUEST = 42901
    private val STEMS = listOf("vocals", "drums", "bass", "guitar", "piano", "other")
  }
}
