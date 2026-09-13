import { systemPreferences } from 'electron'
import { log } from './log'

export type MicAccessStatus = ReturnType<typeof systemPreferences.getMediaAccessStatus>

/** The two calls this needs from Electron's systemPreferences, so a test can
 *  hand in a fake and the module never touches the real one at import. */
export interface MicAccessPrompter {
  getMediaAccessStatus(mediaType: 'microphone'): MicAccessStatus
  askForMediaAccess(mediaType: 'microphone'): Promise<boolean>
}

/**
 * Ask macOS for the microphone, and write down what happened.
 *
 * Every desktop mic path asks through here BEFORE it opens a device: the
 * pitch strip and Settings over `mic:ask`, and the training mic before it
 * spawns `singz-analyze live-input` (audio-input.ts) — that child opens the
 * HAL AudioUnit itself, cannot ask, and when refused delivers silence with
 * nothing to say. Other platforms have no TCC and answer true.
 *
 * The log line is the evidence a singer's machine can give. A refusal that
 * leaves the status at `not-determined` means TCC declined to PROMPT at all:
 * on a signed build that is Hardened Runtime holding the process to
 * com.apple.security.device.audio-input (build/entitlements.mac.plist) — the
 * v0.19.1–v0.20.1 releases shipped without it — never the singer's choice.
 * A singer's own refusal reads `denied`; `restricted` is a managed Mac.
 */
export async function askMicrophoneAccess(
  prompter: MicAccessPrompter = systemPreferences,
  platform: NodeJS.Platform = process.platform
): Promise<boolean> {
  if (platform !== 'darwin') return true
  const before = prompter.getMediaAccessStatus('microphone')
  let allowed = false
  try {
    allowed = await prompter.askForMediaAccess('microphone')
  } catch (error) {
    log('mic', `askForMediaAccess failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
  }
  const after = prompter.getMediaAccessStatus('microphone')
  const moved = after === before ? '' : ` (now ${after})`
  const unprompted =
    !allowed && after === 'not-determined'
      ? ' — no prompt was shown; on a signed build that is the missing audio-input entitlement, not a refusal'
      : ''
  log(
    'mic',
    `macOS microphone access: ${before} → ${allowed ? 'granted' : 'refused'}${moved}${unprompted}`,
    allowed ? 'info' : 'warn'
  )
  return allowed
}
