import { constants } from 'node:fs'
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import type { BoxMicrophoneSelection } from '../../shared/box-audio'

export interface MicrophoneDocument extends BoxMicrophoneSelection {
  version: 1
  revision: string
  origin: 'default' | 'user'
}
export const MICROPHONE_MAX_BYTES = 64 * 1024
export const microphoneCounter = (value: unknown): value is string => typeof value === 'string' &&
  /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n
const uid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 &&
  Buffer.byteLength(value) <= 4096 && !value.includes('\0')
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
export function validMicrophoneSelection(value: unknown): value is BoxMicrophoneSelection {
  if (!record(value)) return false
  const { device, channels } = value
  if (device !== null && !uid(device) || !record(channels)) return false
  const entries = Object.entries(channels)
  return entries.length <= 64 && entries.every(([key, list]) => uid(key) && Array.isArray(list) && list.length <= 64 &&
    list.every((channel, index) => Number.isInteger(channel) && channel >= 0 && channel < 64 && (index === 0 || channel > list[index - 1]))) &&
    (device === null || Object.hasOwn(channels, device) && Array.isArray(channels[device]) && channels[device].length > 0)
}
export function validMicrophoneDocument(value: unknown): value is MicrophoneDocument {
  if (!validMicrophoneSelection(value)) return false
  const doc = value as MicrophoneDocument
  return Object.keys(doc).every(key => ['version', 'revision', 'origin', 'device', 'channels'].includes(key)) &&
    doc.version === 1 && microphoneCounter(doc.revision) && ['default', 'user'].includes(doc.origin)
}
export interface MicrophoneStore {
  load(): Promise<MicrophoneDocument | null>
  save(document: MicrophoneDocument): Promise<void>
}
/** Only the supervisor calls this store, on its serialized control chain. */
export class MicrophoneSelectionStore implements MicrophoneStore {
  readonly file: string
  constructor(private readonly directory: string, private readonly log: (message: string) => void = console.warn) {
    this.file = join(directory, 'microphones.json')
  }
  async load(): Promise<MicrophoneDocument | null> {
    try {
      for (const name of await readdir(this.directory)) {
        if (/^microphones\.json\.[0-9]+\.[0-9a-f]{16}\.tmp$/.test(name))
          await rm(join(this.directory, name), { force: true })
      }
    } catch { /* The read/write paths handle missing directories and access errors. */ }
    try {
      if ((await stat(this.file)).size > MICROPHONE_MAX_BYTES) throw new Error('Microphone selection exceeds 64 KiB')
      const bytes = await readFile(this.file)
      if (bytes.length > MICROPHONE_MAX_BYTES) throw new Error('Microphone selection exceeds 64 KiB')
      const document: unknown = JSON.parse(bytes.toString('utf8'))
      if (!validMicrophoneDocument(document)) throw new Error('Invalid or newer microphone selection')
      return document
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      // Failure to quarantine must not turn unreadable user intent into a default overwrite.
      await rename(this.file, `${this.file}.corrupt-${Date.now()}-${randomBytes(4).toString('hex')}`)
      this.log(`Microphone selection quarantined: ${String(error).slice(0, 500)}`)
      return null
    }
  }
  async save(document: MicrophoneDocument): Promise<void> {
    if (!validMicrophoneDocument(document)) throw new Error('Invalid microphone selection')
    const payload = `${JSON.stringify(document)}\n`
    if (Buffer.byteLength(payload) > MICROPHONE_MAX_BYTES) throw new Error('Microphone selection exceeds 64 KiB')
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | undefined
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, this.file)
    } catch (error) {
      await handle?.close().catch(() => {})
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    try {
      const directory = await open(this.directory, constants.O_RDONLY)
      try { await directory.sync() } finally { await directory.close() }
    } catch (error) {
      try { this.log(`Microphone selection saved; directory sync failed: ${String(error).slice(0, 500)}`) } catch { /* Rename already committed. */ }
    }
  }
}
