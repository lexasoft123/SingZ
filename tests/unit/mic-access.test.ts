import { describe, expect, it } from 'vitest'
import type { WebContents } from 'electron'
import { DesktopAudioInput } from '../../src/main/audio-input'
import { logEntries } from '../../src/main/log'
import { askMicrophoneAccess, type MicAccessPrompter, type MicAccessStatus } from '../../src/main/mic-access'

/** A systemPreferences that reports `before` until asked and `after` from
 *  then on, and answers the prompt with `answer`. */
function prompter(before: MicAccessStatus, after: MicAccessStatus, answer: boolean | Error): MicAccessPrompter & { asked: number } {
  let asked = 0
  return {
    get asked() {
      return asked
    },
    getMediaAccessStatus: () => (asked ? after : before),
    askForMediaAccess: async () => {
      asked += 1
      if (answer instanceof Error) throw answer
      return answer
    }
  }
}

const micLines = (): { line: string; level: string }[] =>
  logEntries()
    .filter((entry) => entry.source === 'mic')
    .map(({ line, level }) => ({ line, level }))

describe('askMicrophoneAccess', () => {
  it('answers true off macOS without asking anything', async () => {
    const p = prompter('not-determined', 'not-determined', new Error('must not be asked'))
    expect(await askMicrophoneAccess(p, 'win32')).toBe(true)
    expect(await askMicrophoneAccess(p, 'linux')).toBe(true)
    expect(p.asked).toBe(0)
  })

  it('records a first grant as the status moving to granted', async () => {
    const seen = micLines().length
    const p = prompter('not-determined', 'granted', true)
    expect(await askMicrophoneAccess(p, 'darwin')).toBe(true)
    expect(p.asked).toBe(1)
    const [entry] = micLines().slice(seen)
    expect(entry.level).toBe('info')
    expect(entry.line).toBe('macOS microphone access: not-determined → granted (now granted)')
  })

  it("names the entitlement when TCC refuses without ever prompting", async () => {
    // The v0.19.1–v0.20.1 signature: askForMediaAccess resolves false and the
    // status never leaves not-determined, because Hardened Runtime refused
    // the process before TCC could ask the singer.
    const seen = micLines().length
    const p = prompter('not-determined', 'not-determined', false)
    expect(await askMicrophoneAccess(p, 'darwin')).toBe(false)
    const [entry] = micLines().slice(seen)
    expect(entry.level).toBe('warn')
    expect(entry.line).toContain('not-determined → refused')
    expect(entry.line).toContain('no prompt was shown')
    expect(entry.line).toContain('audio-input entitlement')
  })

  it("does not blame the entitlement for the singer's own refusal", async () => {
    const seen = micLines().length
    const p = prompter('not-determined', 'denied', false)
    expect(await askMicrophoneAccess(p, 'darwin')).toBe(false)
    const [entry] = micLines().slice(seen)
    expect(entry.level).toBe('warn')
    expect(entry.line).toBe('macOS microphone access: not-determined → refused (now denied)')
  })

  it('treats a throwing prompt as refused, and says so', async () => {
    const seen = micLines().length
    const p = prompter('not-determined', 'not-determined', new Error('boom'))
    expect(await askMicrophoneAccess(p, 'darwin')).toBe(false)
    const lines = micLines().slice(seen)
    expect(lines[0]).toEqual({ level: 'error', line: 'askForMediaAccess failed: boom' })
    expect(lines[1].line).toContain('refused')
  })
})

describe('DesktopAudioInput.start', () => {
  it('reports a refused microphone as denied before touching the core or the sender', async () => {
    const sender = {
      isDestroyed: () => false,
      send: () => {
        throw new Error('nothing may be sent to a renderer whose start was refused')
      }
    } as unknown as WebContents
    let asked = 0
    const input = new DesktopAudioInput(async () => {
      asked += 1
      return false
    })
    const result = await input.start(sender, { channel: 0 })
    expect(asked).toBe(1)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.kind).toBe('denied')
    expect(result.error).toMatch(/Privacy & Security › Microphone/)
    // The gate is released again: a second attempt asks again rather than
    // reporting the first one as still busy.
    const again = await input.start(sender, {})
    expect(asked).toBe(2)
    expect(again.ok).toBe(false)
    if (!again.ok) expect(again.kind).toBe('denied')
  })
})
