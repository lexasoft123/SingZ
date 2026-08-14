package com.singzplayer

import java.security.MessageDigest
import java.security.SecureRandom

/**
 * PKCE verifier + S256 challenge, kept apart from the bridge so it can be
 * tested on the JVM without a device — the same split as CacheCurrency.
 *
 * Two things are deliberately hand-rolled rather than borrowed:
 *
 * The verifier is drawn straight from RFC 7636's unreserved alphabet instead
 * of base64-encoding random bytes, so no encoding step can smuggle in a
 * character the spec disallows.
 *
 * base64url is written out because `android.util.Base64` is framework code
 * that a plain JVM unit test cannot call, and `java.util.Base64` needs API 26
 * while this app supports 24. The unit test checks this encoder against
 * java.util.Base64 as an oracle, which is available where the test runs.
 */
object Pkce {
  private const val UNRESERVED =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  private const val B64URL =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

  /** RFC 7636 allows 43-128 characters; 64 is comfortably inside it. */
  const val VERIFIER_LENGTH = 64

  fun base64Url(bytes: ByteArray): String {
    val out = StringBuilder((bytes.size + 2) / 3 * 4)
    var i = 0
    while (i < bytes.size) {
      val b0 = bytes[i].toInt() and 0xFF
      val has1 = i + 1 < bytes.size
      val has2 = i + 2 < bytes.size
      val b1 = if (has1) bytes[i + 1].toInt() and 0xFF else 0
      val b2 = if (has2) bytes[i + 2].toInt() and 0xFF else 0
      out.append(B64URL[b0 ushr 2])
      out.append(B64URL[((b0 and 0x03) shl 4) or (b1 ushr 4)])
      if (has1) out.append(B64URL[((b1 and 0x0F) shl 2) or (b2 ushr 6)])
      if (has2) out.append(B64URL[b2 and 0x3F])
      i += 3
    }
    return out.toString()
  }

  fun challengeFor(verifier: String): String =
    base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

  fun newVerifier(rnd: SecureRandom = SecureRandom()): String {
    val sb = StringBuilder(VERIFIER_LENGTH)
    repeat(VERIFIER_LENGTH) { sb.append(UNRESERVED[rnd.nextInt(UNRESERVED.length)]) }
    return sb.toString()
  }
}
