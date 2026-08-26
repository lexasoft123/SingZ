/*
 * The vendored libFLAC's gate (third_party/native/flac).
 *
 * What this is really testing is the VENDORING, not libFLAC: that the fifteen
 * .c files taken from the tarball are a complete, linkable encoder+decoder on
 * a toolchain other than the one they were selected on. The set was chosen by
 * building on macOS/clang; without this the claim "the vendor is complete"
 * would rest on that single compiler, and the first anyone heard of a missing
 * file would be an NDK or Xcode build failing on a branch.
 *
 * It also pins the four encoder settings the desktop uses (src/main/flac.ts:
 * level 5, verify on, total samples declared), so a stem is the same kind of
 * file whichever machine wrote it.
 *
 * Run by scripts/run-core-host-tests.sh, which the Android CI canary runs on
 * every push under mobile/. Plain C99 — no NDK, no device.
 */
#include <FLAC/stream_encoder.h>
#include <FLAC/stream_decoder.h>
#include <math.h>
#include <stdio.h>

/* glibc hides M_PI behind POSIX feature macros under strict -std=c99; macOS
 * exposes it regardless, which is how this compiled everywhere except the
 * CI canary's gcc — the first Linux build of this file found it. The
 * constant is spelled out rather than the build switched to gnu99: the
 * strictness is doing its job. */
#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif
#include <stdlib.h>
#include <string.h>

#define SR 44100
#define CH 2
#define FRAMES SR /* one second */
#define TOTAL (FRAMES * CH)

static int failures = 0;
static void ok(int cond, const char *what) {
  printf("%s  flac: %s\n", cond ? "PASS" : "FAIL", what);
  if (!cond) failures++;
}

static FLAC__int32 want[TOTAL];
static FLAC__int32 got[TOTAL];
static size_t gotn;

static FLAC__StreamDecoderWriteStatus on_write(const FLAC__StreamDecoder *d,
                                               const FLAC__Frame *f,
                                               const FLAC__int32 *const buf[],
                                               void *client) {
  (void)d; (void)client;
  for (unsigned i = 0; i < f->header.blocksize; i++)
    for (unsigned c = 0; c < CH; c++)
      if (gotn < TOTAL) got[gotn++] = buf[c][i];
  return FLAC__STREAM_DECODER_WRITE_STATUS_CONTINUE;
}
static void on_error(const FLAC__StreamDecoder *d, FLAC__StreamDecoderErrorStatus s, void *c) {
  (void)d; (void)c;
  fprintf(stderr, "  decoder error: %s\n", FLAC__StreamDecoderErrorStatusString[s]);
}

/* Returns the encoded size, or -1. Fills `want` first. */
static long round_trip(const char *path, const char *label, int tonal) {
  unsigned seed = 12345u;
  for (size_t i = 0; i < TOTAL; i++) {
    seed = seed * 1103515245u + 12345u;
    if (tonal) {
      /* Music-like: a triad plus a little noise. Compresses. */
      double t = (double)(i / CH) / (double)SR;
      double v = 0.35 * sin(2 * M_PI * 220.0 * t) + 0.25 * sin(2 * M_PI * 330.0 * t) +
                 0.15 * sin(2 * M_PI * 440.0 * t) +
                 0.02 * ((double)(FLAC__int16)(seed >> 16) / 32768.0);
      want[i] = (FLAC__int32)(v * 20000.0);
    } else {
      /* Worst case: white noise, which FLAC cannot compress. Lossless still. */
      want[i] = (FLAC__int32)(FLAC__int16)(seed >> 16);
    }
  }

  FLAC__StreamEncoder *e = FLAC__stream_encoder_new();
  if (!e) { ok(0, "encoder allocates"); return -1; }
  /* The desktop's four choices, asserted rather than assumed: every setter
   * returns false if the encoder rejects the value. */
  int set = FLAC__stream_encoder_set_channels(e, CH) &&
            FLAC__stream_encoder_set_bits_per_sample(e, 16) &&
            FLAC__stream_encoder_set_sample_rate(e, SR) &&
            FLAC__stream_encoder_set_compression_level(e, 5) &&
            FLAC__stream_encoder_set_total_samples_estimate(e, FRAMES) &&
            FLAC__stream_encoder_set_verify(e, true);
  if (!set) { ok(0, "encoder accepts the desktop's settings"); FLAC__stream_encoder_delete(e); return -1; }
  ok(FLAC__stream_encoder_get_verify(e), "self-verify is ON (the encoder decodes its own output as it writes)");

  if (FLAC__stream_encoder_init_file(e, path, NULL, NULL) != FLAC__STREAM_ENCODER_INIT_STATUS_OK) {
    ok(0, "encoder initialises"); FLAC__stream_encoder_delete(e); return -1;
  }
  int wrote = FLAC__stream_encoder_process_interleaved(e, want, FRAMES) &&
              FLAC__stream_encoder_finish(e);
  /* If verify had caught a mismatch, finish() fails and the state says so. */
  FLAC__StreamEncoderState st = FLAC__stream_encoder_get_state(e);
  FLAC__stream_encoder_delete(e);
  if (!wrote) {
    printf("      encoder state: %s\n", FLAC__StreamEncoderStateString[st]);
    ok(0, "encode succeeds"); return -1;
  }

  gotn = 0;
  memset(got, 0, sizeof got);
  FLAC__StreamDecoder *d = FLAC__stream_decoder_new();
  if (!d || FLAC__stream_decoder_init_file(d, path, on_write, NULL, on_error, NULL) !=
                FLAC__STREAM_DECODER_INIT_STATUS_OK) {
    ok(0, "decoder initialises"); return -1;
  }
  FLAC__stream_decoder_process_until_end_of_stream(d);
  FLAC__stream_decoder_delete(d);

  char msg[160];
  snprintf(msg, sizeof msg, "%s: every one of %d samples survives the round trip", label, TOTAL);
  if (gotn != TOTAL) {
    printf("      decoded %zu samples, wanted %d\n", gotn, TOTAL);
    ok(0, msg); return -1;
  }
  size_t bad = 0, first = 0;
  for (size_t i = 0; i < TOTAL; i++)
    if (got[i] != want[i]) { if (!bad) first = i; bad++; }
  if (bad) printf("      %zu differ; first at %zu: %d != %d\n", bad, first, got[first], want[first]);
  ok(bad == 0, msg);

  FILE *fp = fopen(path, "rb");
  if (!fp) { ok(0, "output file exists"); return -1; }
  char magic[4] = {0};
  size_t rd = fread(magic, 1, 4, fp);
  fseek(fp, 0, SEEK_END);
  long size = ftell(fp);
  fclose(fp);
  snprintf(msg, sizeof msg, "%s: output is a native FLAC stream (fLaC magic, not Ogg)", label);
  ok(rd == 4 && memcmp(magic, "fLaC", 4) == 0, msg);
  return size;
}

int main(void) {
  const long raw = (long)sizeof(FLAC__int16) * TOTAL;

  long tonal = round_trip("flac_rt_tonal.flac", "tonal", 1);
  long noise = round_trip("flac_rt_noise.flac", "noise", 0);

  if (tonal > 0) {
    printf("      tonal   %ld B -> %ld B (%.0f%%)\n", raw, tonal, 100.0 * tonal / raw);
    /* Guards a config that silently disables compression — the round trip
     * would still pass sample-exact while every stem stayed WAV-sized, which
     * is the entire point of Phase 5 quietly not happening. */
    ok(tonal < raw * 9 / 10, "tonal content actually compresses (the point of doing this at all)");
  }
  if (noise > 0) {
    printf("      noise   %ld B -> %ld B (%.0f%%)\n", raw, noise, 100.0 * noise / raw);
    /* The other half of the pair, and the reason both are asserted rather than
     * one: together they prove the harness can TELL the two kinds of content
     * apart. Swap the two labels and both fail at once, which makes the
     * compression claim above mutation-provable in five seconds — with data
     * the test already generates and no config to invent. */
    ok(noise > raw * 95 / 100, "incompressible content stays incompressible (the gate can tell them apart)");
  }

  remove("flac_rt_tonal.flac");
  remove("flac_rt_noise.flac");

  if (failures) { printf("\n%d FLAC CHECK(S) FAILED\n", failures); return 1; }
  printf("\nALL FLAC VENDOR CHECKS PASS\n");
  return 0;
}
