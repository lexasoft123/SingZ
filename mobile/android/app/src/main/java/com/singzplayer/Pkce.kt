package com.singzplayer

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64

/**
 * PKCE verifier + S256 challenge, kept apart from the bridge so it can be
 * tested on the JVM without a device — the same split as CacheCurrency.
 *
 * base64url comes from java.util.Base64, which needs API 26 and is therefore
 * available now that minSdk is 26. It replaced a hand-rolled encoder written
 * for minSdk 24: `android.util.Base64` would have worked on-device but cannot
 * be called from a plain JVM test, which would have left the encoding
 * unverified.
 *
 * The verifier is still drawn straight from RFC 7636's unreserved alphabet
 * rather than base64-encoding random bytes, so no encoding step can smuggle
 * in a character the spec disallows.
 */
object Pkce {
  private const val UNRESERVED =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

  /** RFC 7636 allows 43-128 characters; 64 is comfortably inside it. */
  const val VERIFIER_LENGTH = 64

  fun base64Url(bytes: ByteArray): String =
    Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  fun challengeFor(verifier: String): String =
    base64Url(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))

  fun newVerifier(rnd: SecureRandom = SecureRandom()): String {
    val sb = StringBuilder(VERIFIER_LENGTH)
    repeat(VERIFIER_LENGTH) { sb.append(UNRESERVED[rnd.nextInt(UNRESERVED.length)]) }
    return sb.toString()
  }
}
