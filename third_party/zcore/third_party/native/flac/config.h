/* libFLAC build configuration for the SingZ core — ours, not upstream.
 *
 * libFLAC normally gets this from autotools or its own CMake probing neither
 * of which runs here: the sources are compiled by the root native CMake
 * wrapper (host + Android) and the SingzCore podspec (iOS), so the handful of
 * symbols those builds actually depend on are stated once, here.
 *
 * HAVE_FSEEKO is the one that is not optional. Without it share/compat.h does
 * `#define fseeko fseek`, which then rewrites the platform SDK own
 * declaration of fseeko into a second, conflicting declaration of fseek —
 * lpc.c and bitreader.c fail to compile with "conflicting types for fseek"
 * and the cause is nowhere near the error. Every platform this core targets
 * (macOS, iOS, Android API 24+) has fseeko.
 *
 * FLAC__HAS_OGG 0 is why ogg_*.c are not vendored: we write native FLAC.
 * The *_intrin_* sources are not vendored either — they are guarded by these
 * three HAS_ macros, so with all of them 0 they would compile to nothing.
 *
 * NONE OF THIS FILE IS READ unless the consumer compiles with -DHAVE_CONFIG_H:
 * every source gates the include on it (format.c:33, fixed.c:33, and the rest).
 * Omit the flag and there is no error — HAVE_FSEEKO simply goes undefined and
 * the build fails later, in a system header, for a reason that looks unrelated.
 * SingZ::native_flac passes it for host and Android; the SingzCore podspec
 * must too.
 */
#define PACKAGE_VERSION "1.5.0"

#define FLAC__HAS_OGG 0
#define FLAC__HAS_X86INTRIN 0
#define FLAC__HAS_NEONINTRIN 0
#define FLAC__HAS_A64NEONINTRIN 0

#define HAVE_FSEEKO 1
#define HAVE_STDINT_H 1
#define HAVE_INTTYPES_H 1
#define HAVE_LROUND 1

/* Endianness is decided by CPU_IS_BIG_ENDIAN being ABSENT as much as by this:
 * the sources test for the big-endian macro, not for a little-endian one, so
 * defining a CPU_IS_LITTLE_ENDIAN would read as load-bearing while doing
 * nothing. Every platform this core targets is little-endian. */
#define WORDS_BIGENDIAN 0

/* Upstream gates this on pointer size, for SPEED — its own line above the
 * bwword typedef says "things should be fastest when this matches the machine
 * word size". We pin it at 1 for both ABIs (gradle.properties ships
 * armeabi-v7a alongside arm64-v8a) so there is one configuration to reason
 * about rather than two; it is portable C on 32-bit, only slower there.
 *
 * It does NOT affect the bytes that come out. Measured, because the comment
 * that stood here claimed the opposite: this tree built with the flag at 1 and
 * at 0 encodes the gate's own two cases to byte-identical files — tonal
 * 113255 B, md5 b4125f28c0bf5c5ca86530a908d7a2a1; noise 176598 B, md5
 * a57a4db348ab0b832b7604f7496c2b5e — which are the same numbers
 * tests/native/flac_roundtrip.c prints, so anyone can check them. Two inputs,
 * one compiler: a measurement, not a proof. Every use of the macro is inside
 * the bitwriter's staging accumulator, and the buffer is byte-swapped to
 * big-endian on the way out regardless. So do not reach for this one if a
 * stem's md5 ever differs across devices — whatever is wrong is somewhere
 * else. */
#define ENABLE_64_BIT_WORDS 1

/* HAVE_PTHREAD is deliberately NOT defined, and this reason is about output,
 * unlike the one above. 1.5.0 added a multithreaded encoder that partitions
 * the input across workers, which can move frame boundaries — and a stem's
 * md5 goes into `stemHashes`, where a file that re-encodes differently reads
 * as a project that changed. Single-threaded is one behaviour. (Untested
 * here: unlike the claim above, this one is a reason to keep the flag off
 * rather than a measurement.) */
