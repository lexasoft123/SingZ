import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe
const FAT_MAGIC_64 = 0xcafebabf
const LC_SEGMENT_64 = 0x19
const LC_CODE_SIGNATURE = 0x1d

interface Slice { offset: number; size: number; expectedCpu: number | null; expectedSubtype: number | null }

function slices(bytes: Buffer): Slice[] {
  if (bytes.length < 4) throw new Error('Mach-O is truncated')
  if (bytes.readUInt32LE(0) === MH_MAGIC_64) {
    return [{ offset: 0, size: bytes.length, expectedCpu: null, expectedSubtype: null }]
  }
  const magic = bytes.readUInt32BE(0)
  if (magic !== FAT_MAGIC && magic !== FAT_MAGIC_64) {
    throw new Error('Unsupported Mach-O magic (64-bit thin/fat required)')
  }
  if (bytes.length < 8) throw new Error('Fat Mach-O header is truncated')
  const count = bytes.readUInt32BE(4)
  if (count < 1 || count > 16) throw new Error(`Invalid fat Mach-O slice count: ${count}`)
  const entrySize = magic === FAT_MAGIC_64 ? 32 : 20
  if (8 + count * entrySize > bytes.length) throw new Error('Fat Mach-O table is truncated')
  const result: Slice[] = []
  for (let index = 0; index < count; index += 1) {
    const base = 8 + index * entrySize
    const offsetValue = magic === FAT_MAGIC_64
      ? bytes.readBigUInt64BE(base + 8) : BigInt(bytes.readUInt32BE(base + 8))
    const sizeValue = magic === FAT_MAGIC_64
      ? bytes.readBigUInt64BE(base + 16) : BigInt(bytes.readUInt32BE(base + 12))
    if (offsetValue > BigInt(Number.MAX_SAFE_INTEGER) || sizeValue > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Fat Mach-O slice exceeds safe file offsets')
    }
    const offset = Number(offsetValue)
    const size = Number(sizeValue)
    if (size < 32 || offset < 8 + count * entrySize || offset + size > bytes.length) {
      throw new Error('Fat Mach-O slice is out of bounds')
    }
    result.push({
      offset,
      size,
      expectedCpu: bytes.readUInt32BE(base),
      expectedSubtype: bytes.readUInt32BE(base + 4)
    })
  }
  const ordered = [...result].sort((a, b) => a.offset - b.offset)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].offset + ordered[index - 1].size > ordered[index].offset) {
      throw new Error('Fat Mach-O slices overlap')
    }
  }
  return result
}

function parseSlice(bytes: Buffer, slice: Slice): {
  cpu: number; subtype: number; hasCodeSignature: boolean; digest: string
} {
  const { offset, size, expectedCpu, expectedSubtype } = slice
  if (bytes.readUInt32LE(offset) !== MH_MAGIC_64) throw new Error('Mach-O slice is not little-endian 64-bit')
  const cpu = bytes.readUInt32LE(offset + 4)
  const subtype = bytes.readUInt32LE(offset + 8)
  if (expectedCpu !== null && (cpu !== expectedCpu || subtype !== expectedSubtype)) {
    throw new Error('Fat Mach-O CPU metadata disagrees with its slice')
  }
  const commandCount = bytes.readUInt32LE(offset + 16)
  const commandBytes = bytes.readUInt32LE(offset + 20)
  if (commandCount > 4096 || commandBytes > size - 32) throw new Error('Mach-O load commands are invalid')
  let cursor = offset + 32
  const commandEnd = cursor + commandBytes
  let linkedit: { fileOffset: number; fileSize: number; vmsizeOffset: number } | null = null
  let hasCodeSignature = false
  for (let index = 0; index < commandCount; index += 1) {
    if (cursor + 8 > commandEnd) throw new Error('Mach-O load command is truncated')
    const command = bytes.readUInt32LE(cursor)
    const commandSize = bytes.readUInt32LE(cursor + 4)
    if (commandSize < 8 || cursor + commandSize > commandEnd) throw new Error('Mach-O load command size is invalid')
    if (command === LC_CODE_SIGNATURE) hasCodeSignature = true
    if (command === LC_SEGMENT_64) {
      if (commandSize < 72) throw new Error('Mach-O segment command is truncated')
      const name = bytes.subarray(cursor + 8, cursor + 24).toString('ascii').replace(/\0.*$/, '')
      if (name === '__LINKEDIT') {
        if (linkedit) throw new Error('Mach-O has multiple __LINKEDIT segments')
        const fileOffset = bytes.readBigUInt64LE(cursor + 40)
        const fileSize = bytes.readBigUInt64LE(cursor + 48)
        if (fileOffset > BigInt(Number.MAX_SAFE_INTEGER) || fileSize > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error('Mach-O __LINKEDIT exceeds safe file offsets')
        }
        linkedit = {
          fileOffset: Number(fileOffset),
          fileSize: Number(fileSize),
          vmsizeOffset: cursor + 32 - offset
        }
      }
    }
    cursor += commandSize
  }
  if (cursor !== commandEnd || !linkedit) throw new Error('Mach-O load commands or __LINKEDIT are incomplete')
  const meaningfulEnd = linkedit.fileOffset + linkedit.fileSize
  if (linkedit.fileOffset < 32 + commandBytes || meaningfulEnd > size || meaningfulEnd <= linkedit.fileOffset) {
    throw new Error('Mach-O __LINKEDIT file range is invalid')
  }
  const canonical = Buffer.from(bytes.subarray(offset, offset + meaningfulEnd))
  canonical.fill(0, linkedit.vmsizeOffset, linkedit.vmsizeOffset + 8)
  return { cpu, subtype, hasCodeSignature, digest: createHash('sha256').update(canonical).digest('hex') }
}

export function machCanonicalSha256(addonPath: string): string {
  if (process.platform !== 'darwin') throw new Error('Canonical Mach-O digest requires macOS')
  const temp = mkdtempSync(join(tmpdir(), 'singz-mach-canonical-'))
  const copy = join(temp, 'singz-capture.node')
  try {
    copyFileSync(addonPath, copy)
    const before = readFileSync(copy)
    if (slices(before).map((slice) => parseSlice(before, slice)).some((slice) => slice.hasCodeSignature)) {
      const removed = spawnSync('/usr/bin/codesign', ['--remove-signature', copy], { encoding: 'utf8' })
      if (removed.status !== 0) throw new Error(`Could not remove Mach-O signature: ${removed.stderr || removed.stdout}`)
    }
    const bytes = readFileSync(copy)
    const identities = slices(bytes).map((slice) => parseSlice(bytes, slice))
      .map(({ cpu, subtype, digest }) => `${cpu.toString(16)}:${subtype.toString(16)}:${digest}`)
      .sort()
    const hash = createHash('sha256')
    hash.update('singz-mach-canonical-v1\n')
    for (const identity of identities) hash.update(`${identity}\n`)
    return hash.digest('hex')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
