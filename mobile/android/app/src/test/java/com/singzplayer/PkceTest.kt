package com.singzplayer

import java.security.MessageDigest
import java.security.SecureRandom
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The PKCE pair, checked without a device.
 *
 * The property that matters is that the challenge really is
 * base64url(SHA-256(verifier)): a wrong encoder compiles perfectly and only
 * fails at Google's token endpoint, as "invalid_grant", days later.
 */
class PkceTest {
  /** java.util.Base64 is the oracle — available on the JVM, not on API 24. */
  private fun oracle(bytes: ByteArray): String =
    java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

  @Test
  fun base64UrlMatchesTheJdkForEveryTailLength() {
    val rnd = SecureRandom()
    // 0,1,2 mod 3 are the three padding cases; 32 is the SHA-256 digest size
    for (n in listOf(0, 1, 2, 3, 4, 5, 31, 32, 33, 64)) {
      val bytes = ByteArray(n).also { rnd.nextBytes(it) }
      assertEquals("length $n", oracle(bytes), Pkce.base64Url(bytes))
    }
  }

  @Test
  fun base64UrlNeverEmitsPlusSlashOrPadding() {
    val bytes = ByteArray(256) { (it and 0xFF).toByte() }
    val encoded = Pkce.base64Url(bytes)
    assertTrue(encoded.none { it == '+' || it == '/' || it == '=' })
  }

  @Test
  fun challengeIsBase64UrlOfTheSha256OfTheVerifier() {
    val verifier = Pkce.newVerifier()
    val expected =
      oracle(MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII)))
    assertEquals(expected, Pkce.challengeFor(verifier))
  }

  @Test
  fun challengeMatchesTheRfc7636WorkedExample() {
    // RFC 7636 appendix B: this verifier must produce this exact challenge.
    val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challengeFor(verifier))
  }

  @Test
  fun verifierUsesOnlyTheUnreservedAlphabetAndALegalLength() {
    repeat(200) {
      val v = Pkce.newVerifier()
      assertTrue("length ${v.length}", v.length in 43..128)
      assertTrue(v, v.all { it.isLetterOrDigit() || it == '-' || it == '.' || it == '_' || it == '~' })
    }
  }

  @Test
  fun verifiersDoNotRepeat() {
    val seen = HashSet<String>()
    repeat(500) { seen.add(Pkce.newVerifier()) }
    assertEquals(500, seen.size)
  }
}
