import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configureBoxAudioHostProfile } from '../../src/main/box-audio/profile'

describe('headless Box audio identity', () => {
  it('locks the service profile after selecting userData even when socket paths differ', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'box-profile-'))
    const paths = new Map<string, string>()
    const lockedProfiles = new Set<string>()
    const order: string[] = []
    const app = {
      setName: (name: string) => { order.push(name) },
      getPath: (name: string) => paths.get(name) ?? directory,
      hasSingleInstanceLock: () => lockedProfiles.has(paths.get('userData') ?? ''),
      setPath: (name: string, value: string) => { paths.set(name, value); order.push(name) },
      requestSingleInstanceLock: () => {
        order.push('lock')
        const profile = paths.get('userData')!
        expect(paths.get('sessionData')).toBe(profile)
        if (lockedProfiles.has(profile)) return false
        lockedProfiles.add(profile)
        return true
      }
    }
    try {
      const first: NodeJS.ProcessEnv = { SINGZ_BOX_AUDIO_SOCKET: '/one/audio.sock' }
      const second: NodeJS.ProcessEnv = { SINGZ_BOX_AUDIO_SOCKET: '/two/audio.sock' }
      expect(configureBoxAudioHostProfile(app, first)).not.toBeNull()
      expect(configureBoxAudioHostProfile(app, second)).toBeNull()
      expect(paths.get('userData')).toBe(join(directory, 'SingZ Box Audio'))
      expect(first.SINGZ_MODELS_DIR).toBe(join(directory, 'SingZ Box Audio', 'models'))
      expect(order.slice(0, 4)).toEqual(['SingZ Box Audio', 'userData', 'sessionData', 'lock'])
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
})
