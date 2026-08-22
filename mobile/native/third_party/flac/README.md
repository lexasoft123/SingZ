# libFLAC, vendored

Encoder + decoder sources from **flac 1.5.0**, taken so the phones can write
compact stems with the SAME encoder on both platforms rather than Android
MediaCodec on one and iOS ExtAudioFile on the other (docs/PHONE-STANDALONE.md,
Phase 5). Nothing here is modified — the only local file is `config.h`, which
is ours.

## Provenance

| | |
|---|---|
| upstream | https://downloads.xiph.org/releases/flac/flac-1.5.0.tar.xz |
| sha256 | `f2c1c76592a82ffff8413ba3c4a1299b6c7ab06c734dee03fd88630485c2b920` |
| verified against | Homebrew's independently recorded checksum for flac 1.5.0 (formulae.brew.sh API) — exact match |
| license | BSD (`COPYING.Xiph`) |

**The license matters and is easy to get wrong.** `src/libFLAC` — everything
here — is BSD. The FLAC *tools* (`src/flac`, `src/metaflac`) in the same
tarball are **GPL**, and none of them is vendored. Keep it that way: taking a
file from outside `src/libFLAC` can change the licence of the whole app.

## What was taken, and why only this

The 15 `.c` files in `src/` are exactly the set that compiles and links a
working encoder and decoder, determined by BUILDING rather than by reading a
manifest: the candidate set was compiled one file at a time and then linked
against a round-trip test, which passed with no undefined symbols. So
`metadata_iterators.c` and `metadata_object.c` are genuinely not needed, and
adding them "to be safe" would be adding code nothing calls.

That method has one blind spot, found in review and worth stating because the
next vendor drop will have it too: an orphaned `#include` fragment is neither
compiled nor linked, so it produces no symbol to be undefined and no object to
be unused — compile-then-link cannot see it. Two of the four `deduplication/`
fragments were exactly that (`lpc_compute_autocorrelation_intrin_{neon,sse2}.c`,
whose includers are the `lpc_intrin_*.c` files we do not take) and have been
dropped. **When a drop contains a `deduplication/`-style directory, check
reachability by `#include` name as well as by linking.**

One pair joined later (byte-identical to the same sha256-verified tarball):
`include/share/win_utf8_io.h` + `src/share/win_utf8_io/win_utf8_io.c`, BSD
like the rest. `compat.h`'s `_WIN32` branch includes the header
unconditionally and maps `flac_fopen` &co onto its UTF-8 wrappers, so the
first MSVC build (the desktop cutover's core-win workflow) stopped at
C1083 — none of the prior platforms ever took that branch. The `.c` sits in
a subdirectory on purpose: the phones' globs (`src/*.c`) must not compile
it, and only the host CMakeLists adds it, under `if(WIN32)`.

Deliberately NOT taken:

- `ogg_*.c` — we write native FLAC, and they need libogg, which we do not ship.
- `*_intrin_*.c` (avx2/sse/neon) — every one is guarded by the `FLAC__HAS_*INTRIN`
  macros that `config.h` sets to 0, so they would compile to empty objects.
  If they are ever wanted for speed, flipping the macro is not enough: the file
  has to be added to the Android CMakeLists and the iOS podspec source list
  too, and the NEON ones want per-file `-march` flags.

The decoder is included on purpose even though this is an encode path: the
encoder's `set_verify(true)` mode decodes its own output as it writes and
compares, which is how a corrupt stem is caught at the moment it is written
rather than the next time the singer opens the song.

## Every consumer must pass `-DHAVE_CONFIG_H`

`config.h` is not read otherwise — the sources gate its include on that macro.
There is no error when it is missing: `HAVE_FSEEKO` goes undefined, and the
build fails afterwards inside a platform system header, complaining about
`fseek`. `scripts/run-core-host-tests.sh` passes it. So must the Android
`CMakeLists.txt` and the SingzCore podspec when they gain these sources.

## Divergences from upstream

Only one, and it is inert: `ENABLE_64_BIT_WORDS` is pinned at 1 where upstream
gates it on pointer size. That is for uniformity across the two Android ABIs,
not for correctness — the tree built with the flag at 1 and at 0 encodes
byte-identical output, because every use of the macro is inside the bitwriter's
staging accumulator. `config.h` says so at the setting, with the hashes.

**To re-measure**, build `tests/native/flac_roundtrip.c` twice against this
tree, once with `-DENABLE_64_BIT_WORDS=0`, and `cmp` the two `flac_rt_*.flac`
files — the gate deletes them at the end, so comment out its `remove()` calls
or copy them first. Compare files a build is KNOWN to have written: the first
attempt at this measurement diffed two files the gate had already deleted and
reported a cheerful "identical", which is the check-that-cannot-fail shape
CLAUDE.md warns about elsewhere. The expected numbers are the ones the gate
itself prints — tonal 113255 B / `b4125f28c0bf5c5ca86530a908d7a2a1`, noise
176598 B / `a57a4db348ab0b832b7604f7496c2b5e`.

Worth knowing why that sentence is there: the comment that originally stood in
its place justified the pin as *determinism* — same bytes across ABIs, because
stem md5s go into `stemHashes` — which sounded right, was wrong, and was caught
by building it twice. A wrong reason attached to a right setting is more durable
than a wrong setting, because nothing ever fails and makes anyone re-examine it.

## Encoder settings

Level 5, verify on, total-samples declared, written through a `.part` rename —
the same four choices `src/main/flac.ts` makes on the desktop, so a stem is the
same kind of file whichever machine produced it.

## Upgrading

Re-take from a new tarball, keep `config.h`, and re-run the host round-trip
gate (`scripts/run-core-host-tests.sh`, which the Android CI canary runs). If a
new version needs a file this set does not have, the link fails loudly with an
undefined symbol — which is the intended way to find out.
