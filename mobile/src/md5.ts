const SHIFTS = Uint8Array.from([
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
])
const ROUND_CONSTANTS = Int32Array.from(
  { length: 64 },
  (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0
)

/** Exact UTF-8 size used by native/Drive file hashes, including replacement
 * of lone UTF-16 surrogates with U+FFFD like TextEncoder/Response.text(). */
export function utf8TextByteLength(value: string): number {
  let bytes = 0
  for (let i = 0; i < value.length; i++) {
    const first = value.charCodeAt(i)
    if (first <= 0x7f) bytes += 1
    else if (first <= 0x7ff) bytes += 2
    else if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(i + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        bytes += 4
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** Small dependency-free MD5 for Drive's text members. It UTF-8 encodes into
 * one 64-byte block instead of materializing every input byte as a JS number;
 * a maximum-size graph therefore has fixed working memory. Media remains in
 * the native cache, which hashes files without bringing them through Hermes. */
export function md5Text(value: string): string {
  const block = new Uint8Array(64)
  const words = new Int32Array(16)
  let used = 0
  let byteLength = 0
  let a0 = 0x67452301 | 0
  let b0 = 0xefcdab89 | 0
  let c0 = 0x98badcfe | 0
  let d0 = 0x10325476 | 0

  const transform = (): void => {
    for (let i = 0; i < 16; i++) {
      const at = i * 4
      words[i] = block[at] | (block[at + 1] << 8) | (block[at + 2] << 16) | (block[at + 3] << 24)
    }
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let i = 0; i < 64; i++) {
      let f: number
      let g: number
      if (i < 16) {
        f = (b & c) | (~b & d)
        g = i
      } else if (i < 32) {
        f = (d & b) | (~d & c)
        g = (5 * i + 1) & 15
      } else if (i < 48) {
        f = b ^ c ^ d
        g = (3 * i + 5) & 15
      } else {
        f = c ^ (b | ~d)
        g = (7 * i) & 15
      }
      const sum = (a + f + ROUND_CONSTANTS[i] + words[g]) | 0
      const rotated = (sum << SHIFTS[i]) | (sum >>> (32 - SHIFTS[i]))
      const nextD = d
      d = c
      c = b
      b = (b + rotated) | 0
      a = nextD
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
    used = 0
  }

  const append = (byte: number, count = true): void => {
    block[used++] = byte
    if (count) byteLength++
    if (used === block.length) transform()
  }
  const appendCodePoint = (cp: number): void => {
    if (cp <= 0x7f) append(cp)
    else if (cp <= 0x7ff) {
      append(0xc0 | (cp >>> 6))
      append(0x80 | (cp & 0x3f))
    } else if (cp <= 0xffff) {
      append(0xe0 | (cp >>> 12))
      append(0x80 | ((cp >>> 6) & 0x3f))
      append(0x80 | (cp & 0x3f))
    } else {
      append(0xf0 | (cp >>> 18))
      append(0x80 | ((cp >>> 12) & 0x3f))
      append(0x80 | ((cp >>> 6) & 0x3f))
      append(0x80 | (cp & 0x3f))
    }
  }

  for (let i = 0; i < value.length; i++) {
    const first = value.charCodeAt(i)
    if (first >= 0xd800 && first <= 0xdbff) {
      const second = value.charCodeAt(i + 1)
      if (second >= 0xdc00 && second <= 0xdfff) {
        appendCodePoint(0x10000 + ((first - 0xd800) << 10) + second - 0xdc00)
        i++
      } else {
        // Node, TextEncoder and Response.text() replace malformed UTF-16 with
        // U+FFFD before UTF-8 encoding; match that exact Drive checksum input.
        appendCodePoint(0xfffd)
      }
    } else if (first >= 0xdc00 && first <= 0xdfff) {
      appendCodePoint(0xfffd)
    } else {
      appendCodePoint(first)
    }
  }

  const messageBytes = byteLength
  append(0x80, false)
  while (used !== 56) append(0, false)
  const lowBits = (messageBytes * 8) >>> 0
  const highBits = Math.floor(messageBytes / 0x20000000) >>> 0
  for (let i = 0; i < 4; i++) append((lowBits >>> (8 * i)) & 0xff, false)
  for (let i = 0; i < 4; i++) append((highBits >>> (8 * i)) & 0xff, false)

  return [a0, b0, c0, d0]
    .map((word) => {
      let out = ''
      for (let i = 0; i < 4; i++) out += ((word >>> (8 * i)) & 0xff).toString(16).padStart(2, '0')
      return out
    })
    .join('')
}
