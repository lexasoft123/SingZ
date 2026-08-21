/**
 * The sample rate a stem file states in its own header.
 *
 * That rate — not the playback device's — is what the melody tracker has to
 * run at. Its framing is derived from the rate on BOTH sides of the port
 * (`hop = round(sr / DECIM * HOP_SEC)`, `hopSec = hop / (sr / DECIM)` in
 * pitch-core.ts and melody.cpp alike), so the same song analysed at two rates
 * gives two different hops and two different frame counts: 44.1 kHz decimates
 * to 14700 and rounds 367.5 up to a 368-sample hop (0.0250340136 s), while
 * 48 kHz decimates to 16000 and lands on exactly 400 (0.025 s). The C++ core
 * reads the stem file, so it always sees the file's rate; the desktop used to
 * hand the tracker whatever `decodeAudioData` returned, which is the PLAYBACK
 * AudioContext's rate — the output device's, 48 kHz on most Macs and 44.1 kHz
 * on plenty of Windows machines. Same project, same stem, a different stored
 * line per machine, every one of them stamped current so nothing ever
 * re-derives it. Measured on Wild World: 8009 frames at hop 0.025 from the
 * desktop against 7998 at 0.0250340136 from the core, 5% of the shared voiced
 * frames more than a quarter-tone apart.
 *
 * WAV and FLAC are the two stem formats (v1 projects are WAV, v2 FLAC) and
 * both state the rate a few bytes in. Returns null for anything else, or for a
 * header too short or too odd to read — the caller falls back rather than
 * guessing a rate, since a wrong guess is the bug this exists to prevent.
 */
export function stemSampleRate(bytes: ArrayBuffer): number | null {
  if (bytes.byteLength < 32) return null
  const b = new DataView(bytes)
  const tag = (off: number): string =>
    String.fromCharCode(b.getUint8(off), b.getUint8(off + 1), b.getUint8(off + 2), b.getUint8(off + 3))

  // FLAC: 'fLaC', then metadata blocks — STREAMINFO is first by the spec, and
  // its rate is the 20 bits at bit 80 of the block body (which starts at 8).
  if (tag(0) === 'fLaC') {
    if ((b.getUint8(4) & 0x7f) !== 0 || bytes.byteLength < 21) return null
    const sr = (b.getUint8(18) << 12) | (b.getUint8(19) << 4) | (b.getUint8(20) >> 4)
    return sr > 0 ? sr : null
  }

  // WAV: chunks from byte 12; the rate is a little-endian uint32 four bytes
  // into 'fmt ' (after the format tag and the channel count).
  if (tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let off = 12
    while (off + 8 <= bytes.byteLength) {
      const size = b.getUint32(off + 4, true)
      if (tag(off) === 'fmt ') {
        if (off + 16 > bytes.byteLength) return null
        const sr = b.getUint32(off + 12, true)
        return sr > 0 ? sr : null
      }
      off += 8 + size + (size & 1)
    }
  }
  return null
}
