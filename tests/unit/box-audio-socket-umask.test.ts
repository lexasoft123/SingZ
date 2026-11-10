import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Neutralize the post-listen chmod: the socket must already be private when
// bound, because a readiness waiter can connect as soon as the path exists.
vi.mock('node:fs/promises', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
  chmod: async () => {}
}))
const { startBoxAudioHost } = await import('../../src/main/box-audio/server')

describe.skipIf(process.platform === 'win32')('Box audio socket creation', () => {
  it('binds the socket with a private umask and restores the process umask', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'box-audio-umask-'))
    const previous = process.umask(0o022)
    try {
      const host = await startBoxAudioHost(join(dir, 'audio.sock'), {
        owner: {}, binding: {}, routingRequest: () => '{}', routingCapabilities: () => ({}), shutdown: () => {}
      })
      try {
        expect((await stat(join(dir, 'audio.sock'))).mode & 0o077).toBe(0)
        expect(process.umask()).toBe(0o022)
      } finally { await host.close() }
    } finally { process.umask(previous); await rm(dir, { recursive: true, force: true }) }
  })
})
