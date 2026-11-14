import { audioBufferChoices, audioBufferPreferences, validAudioBufferSize, type AudioBufferStatus } from '../shared/audio-buffer'
import type { DesktopAudioHostInventoryResult } from '../shared/types'

/** Main owns persistence; the utility process alone owns device changes. */
export class AudioBufferSettingsController {
  private queue = Promise.resolve()
  constructor(private readonly deps: {
    platform: string
    read(): unknown
    save(preferences: Record<string, number>): void
    inventory(): Promise<DesktopAudioHostInventoryResult>
    native(preferences?: Record<string, number>): Promise<AudioBufferStatus>
  }) {}

  async request(change?: unknown): Promise<AudioBufferStatus> {
    const run = this.queue.then(async () => {
      if (this.deps.platform !== 'darwin') return {
        ok: false, pending: false, reason: 'unsupported-platform' as const,
        preferences: audioBufferPreferences(this.deps.read()), outputUid: '',
        requestedFrames: 128, obtainedFrames: 0, inputUid: '', inputRequestedFrames: 128, inputObtainedFrames: 0
      }
      if (change === undefined) return this.deps.native()
      const row = change as { frames?: unknown; deviceUids?: unknown }
      if (!row || !validAudioBufferSize(row.frames) || !Array.isArray(row.deviceUids) ||
          !row.deviceUids.length || row.deviceUids.length > 2 ||
          !row.deviceUids.every(uid => typeof uid === 'string' && uid.length > 0 && uid.length <= 4096 && !uid.includes('\0')))
        throw new Error('Invalid audio buffer selection')
      const inventory = await this.deps.inventory()
      if (!inventory.ok) throw new Error(inventory.error)
      const devices = inventory.devices.filter(device => (row.deviceUids as string[]).includes(device.uid))
      if (devices.length !== new Set(row.deviceUids).size || !audioBufferChoices(devices).includes(row.frames))
        throw new Error('The selected buffer is unavailable on the current audio devices')
      const next = { ...audioBufferPreferences(this.deps.read()),
        ...Object.fromEntries(row.deviceUids.map(uid => [uid, row.frames])) }
      if (Object.keys(next).length > 256) throw new Error('Too many saved audio devices')
      this.deps.save(next)
      if (JSON.stringify(audioBufferPreferences(this.deps.read())) !== JSON.stringify(next))
        throw new Error('The audio buffer preference could not be saved')
      return this.deps.native(next)
    })
    this.queue = run.then(() => {}, () => {})
    return run
  }
}
