import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import type { BoxPreferences, BoxQueueRef, BoxResult, BoxState } from '../../shared/box-contract'

const MAX_STATE_BYTES = 256 * 1024
const MAX_QUEUE = 256

export const defaultBoxState = (): BoxState => ({
  version: 1,
  preferences: { setupComplete: false, safeAreaPercent: 0, language: 'system' },
  queue: []
})

const cloneState = (state: BoxState): BoxState => ({
  version: 1,
  preferences: { ...state.preferences },
  queue: state.queue.map((entry) => ({ ...entry }))
})

const failure = <T>(error: string, code: string): BoxResult<T> => ({ ok: false, error, code })
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value: Record<string, unknown>, allowed: string[], required = allowed): boolean => {
  const keys = Object.keys(value)
  return keys.every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key))
}
const boundedText = (value: unknown, maximum: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)

const validQueue = (value: unknown): value is BoxQueueRef[] => {
  if (!Array.isArray(value) || value.length > MAX_QUEUE) return false
  return value.every((entry) => {
    if (!record(entry)) return false
    if (entry.kind === 'local') {
      return exactKeys(entry, ['kind', 'dir']) && boundedText(entry.dir, 4096) && isAbsolute(entry.dir)
    }
    if (entry.kind === 'drive') {
      return exactKeys(entry, ['kind', 'id']) && boundedText(entry.id, 256) && !/[/\\]/.test(entry.id)
    }
    return false
  })
}

const validState = (value: unknown): value is BoxState => {
  if (!record(value) || !exactKeys(value, ['version', 'preferences', 'queue'])) return false
  if (value.version !== 1 || !record(value.preferences) || !validQueue(value.queue)) return false
  const preferences = value.preferences
  return exactKeys(preferences, ['setupComplete', 'safeAreaPercent', 'language']) &&
    typeof preferences.setupComplete === 'boolean' &&
    (preferences.safeAreaPercent === 0 || preferences.safeAreaPercent === 3 || preferences.safeAreaPercent === 5) &&
    boundedText(preferences.language, 64)
}

export class BoxStateService {
  private readonly file: string
  private state: BoxState | null = null
  private operations: Promise<void> = Promise.resolve()

  constructor(readonly userDataDir: string) {
    this.file = join(userDataDir, 'box-state.json')
  }

  getState(): Promise<BoxResult<BoxState>> {
    return this.serial(async () => {
      const loaded = await this.load()
      return loaded.ok ? { ok: true, value: cloneState(loaded.value) } : loaded
    })
  }

  setPreferences(patch: Partial<BoxPreferences>): Promise<BoxResult<BoxState>> {
    return this.serial(async () => {
      if (!record(patch) || !exactKeys(patch, ['setupComplete', 'safeAreaPercent', 'language'], [])) {
        return failure('Invalid Box preferences.', 'invalid-input')
      }
      const loaded = await this.load()
      if (!loaded.ok) return loaded
      const candidate = cloneState(loaded.value)
      if (Object.hasOwn(patch, 'setupComplete')) {
        if (typeof patch.setupComplete !== 'boolean') return failure('Invalid setup completion preference.', 'invalid-input')
        candidate.preferences.setupComplete = patch.setupComplete
      }
      if (Object.hasOwn(patch, 'safeAreaPercent')) {
        if (patch.safeAreaPercent !== 0 && patch.safeAreaPercent !== 3 && patch.safeAreaPercent !== 5) {
          return failure('Invalid safe area preference.', 'invalid-input')
        }
        candidate.preferences.safeAreaPercent = patch.safeAreaPercent
      }
      if (Object.hasOwn(patch, 'language')) {
        if (!boundedText(patch.language, 64)) return failure('Invalid language preference.', 'invalid-input')
        candidate.preferences.language = patch.language
      }
      const saved = await this.write(candidate)
      return saved.ok ? { ok: true, value: cloneState(candidate) } : saved
    })
  }

  saveQueue(queue: BoxQueueRef[]): Promise<BoxResult<BoxState>> {
    return this.serial(async () => {
      if (!validQueue(queue)) return failure('Invalid Box queue.', 'invalid-input')
      const loaded = await this.load()
      if (!loaded.ok) return loaded
      const candidate = cloneState(loaded.value)
      candidate.queue = queue.map((entry) => ({ ...entry }))
      const saved = await this.write(candidate)
      return saved.ok ? { ok: true, value: cloneState(candidate) } : saved
    })
  }

  private serial<T>(operation: () => Promise<BoxResult<T>>): Promise<BoxResult<T>> {
    const result = this.operations.then(operation, operation)
    this.operations = result.then(() => undefined, () => undefined)
    return result
  }

  private async load(): Promise<BoxResult<BoxState>> {
    if (this.state) return { ok: true, value: this.state }
    try {
      const info = await lstat(this.file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_STATE_BYTES) {
        return failure('Box state is not a bounded regular file.', 'invalid-state')
      }
      const parsed: unknown = JSON.parse(await readFile(this.file, 'utf8'))
      if (!validState(parsed)) return failure('Box state failed schema validation.', 'invalid-state')
      this.state = cloneState(parsed)
      return { ok: true, value: this.state }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = defaultBoxState()
        return { ok: true, value: this.state }
      }
      if (error instanceof SyntaxError) return failure('Box state is not valid JSON.', 'invalid-state')
      return failure(`Could not read Box state: ${error instanceof Error ? error.message : String(error)}`, 'read-failed')
    }
  }

  private async write(state: BoxState): Promise<BoxResult<null>> {
    if (!validState(state)) return failure('Refused to write invalid Box state.', 'invalid-state')
    const payload = `${JSON.stringify(state)}\n`
    if (Buffer.byteLength(payload, 'utf8') > MAX_STATE_BYTES) {
      return failure('Box state exceeds the 256 KiB storage limit.', 'invalid-input')
    }
    const temporary = `${this.file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      await mkdir(this.userDataDir, { recursive: true, mode: 0o700 })
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      await handle.writeFile(payload, 'utf8')
      await handle.sync()
      await handle.close()
      handle = null
      await chmod(temporary, 0o600)
      await rename(temporary, this.file)
      this.state = cloneState(state)
      await this.syncParentDirectory()
      const info = await stat(this.file)
      if (!info.isFile()) return failure('Box state did not persist as a regular file.', 'write-failed')
      return { ok: true, value: null }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined)
      await rm(temporary, { force: true }).catch(() => undefined)
      return failure(`Could not write Box state: ${error instanceof Error ? error.message : String(error)}`, 'write-failed')
    }
  }

  private async syncParentDirectory(): Promise<void> {
    if (process.platform === 'win32') return
    let directory: Awaited<ReturnType<typeof open>> | null = null
    try {
      directory = await open(this.userDataDir, constants.O_RDONLY)
      await directory.sync()
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOTSUP' && code !== 'ENOSYS' && code !== 'EINVAL') throw error
    } finally {
      if (directory) await directory.close()
    }
  }
}
