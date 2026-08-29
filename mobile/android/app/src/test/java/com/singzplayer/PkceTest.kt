package com.singzplayer

import java.security.MessageDigest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The PKCE pair, checked without a device.
 *
 * The property that matters is that the challenge really is
 * base64url(SHA-256(verifier)): a wrong encoding compiles perfectly and only
 * fails at Google's token endpoint, as "invalid_grant", days later.
 *
 * There is no longer a test comparing our base64url against the JDK's — since
 * our minSdk gives us the JDK's, so such a test would only assert that
 * java.util.Base64 agrees with itself. The RFC worked example below still
 * exercises the encoder, and does so against a value neither side chose.
 */
class PkceTest {
  @Test
  fun challengeIsBase64UrlOfTheSha256OfTheVerifier() {
    val verifier = Pkce.newVerifier()
    val expected =
      java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(verifier.toByteArray(Charsets.US_ASCII))
      )
    assertEquals(expected, Pkce.challengeFor(verifier))
  }

  @Test
  fun challengeMatchesTheRfc7636WorkedExample() {
    // RFC 7636 appendix B: this verifier must produce this exact challenge.
    val verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", Pkce.challengeFor(verifier))
  }

  @Test
  fun challengeCarriesNoPaddingOrNonUrlCharacters() {
    val c = Pkce.challengeFor(Pkce.newVerifier())
    assertTrue(c, c.none { it == '+' || it == '/' || it == '=' })
    assertEquals(43, c.length) // 32-byte digest, base64url, unpadded
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
