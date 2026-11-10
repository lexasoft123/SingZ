import { afterEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MicrophoneSelectionStore, MICROPHONE_MAX_BYTES, validMicrophoneDocument, type MicrophoneDocument } from '../../src/main/box-audio/microphone-store'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const roots: string[] = []
const doc = (): MicrophoneDocument => ({ version: 1, revision: '7', origin: 'user', device: null, channels: { mic: [] } })
async function fixture() {
  const dir = await fs.mkdtemp(join(tmpdir(), 'box-microphone-store-')); roots.push(dir)
  return { dir, file: join(dir, 'microphones.json'), store: new MicrophoneSelectionStore(dir, vi.fn()) }
}
afterEach(async () => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) await fs.rm(dir, { force: true, recursive: true }) })
describe('crash-safe microphone selection store', () => {
  it('round trips explicit all-off with a private exclusive temporary and commit-by-rename', async () => {
    const { file, store } = await fixture()
    const open = vi.spyOn(fs, 'open')
    await store.save(doc())
    expect(await store.load()).toEqual(doc())
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    expect(open.mock.calls[0]).toEqual([expect.stringMatching(/microphones\.json\.[0-9]+\.[0-9a-f]{16}\.tmp$/), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600])
  })
  it('cleans only matching orphan temporaries', async () => {
    const { dir, store } = await fixture()
    await fs.writeFile(join(dir, 'microphones.json.123.1234567890abcdef.tmp'), 'orphan')
    await fs.writeFile(join(dir, 'unrelated.tmp'), 'keep')
    expect(await store.load()).toBeNull()
    expect(await fs.readdir(dir)).toEqual(['unrelated.tmp'])
  })
  it.each(['{', JSON.stringify({ ...doc(), version: 2 }), 'x'.repeat(MICROPHONE_MAX_BYTES + 1)])('quarantines invalid, newer and oversized input (%#)', async payload => {
    const { dir, file, store } = await fixture()
    await fs.writeFile(file, payload)
    expect(await store.load()).toBeNull()
    const names = await fs.readdir(dir)
    expect(names).toHaveLength(1); expect(names[0]).toMatch(/^microphones\.json\.corrupt-/)
    expect(await fs.readFile(join(dir, names[0]), 'utf8')).toBe(payload)
  })
  it('keeps committed bytes unchanged when pre-rename persistence fails and removes the temporary', async () => {
    const { dir, file, store } = await fixture()
    await store.save(doc())
    const before = await fs.readFile(file, 'utf8')
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.save({ ...doc(), revision: '8' })).rejects.toThrow('disk full')
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    expect(await fs.readdir(dir)).toEqual(['microphones.json'])
  })
  it('reports success after the rename commit even if directory fsync fails', async () => {
    const { dir, store } = await fixture()
    const original = fs.open
    vi.spyOn(fs, 'open').mockImplementation(((path, ...args) => path === dir
      ? Promise.reject(new Error('directory sync denied')) : original(path, ...args)) as typeof fs.open)
    await expect(store.save(doc())).resolves.toBeUndefined()
    expect(await store.load()).toEqual(doc())
  })
  it('validates uint64, uid bytes, sorted bounded channels, device count and encoded size', async () => {
    const { store } = await fixture()
    for (const invalid of [
      { ...doc(), revision: '18446744073709551616' }, { ...doc(), revision: '01' },
      { ...doc(), device: 'missing' }, { ...doc(), channels: new Date() }, { ...doc(), channels: new Map() }, { ...doc(), channels: { mic: [1, 0] } },
      { ...doc(), channels: { mic: [64] } }, { ...doc(), channels: { ['a\0']: [] } },
      { ...doc(), channels: { ['字'.repeat(1400)]: [] } },
      { ...doc(), channels: Object.fromEntries(Array.from({ length: 65 }, (_, n) => [String(n), []])) }
    ]) { expect(validMicrophoneDocument(invalid)).toBe(false); await expect(store.save(invalid as MicrophoneDocument)).rejects.toThrow('Invalid') }
    const oversized = { ...doc(), channels: Object.fromEntries(Array.from({ length: 64 }, (_, n) => [`${n}${'a'.repeat(1100)}`, []])) }
    expect(validMicrophoneDocument(oversized)).toBe(true)
    await expect(store.save(oversized)).rejects.toThrow('64 KiB')
  })
})
