import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '../..')
const read = (relative: string): string => readFileSync(resolve(repo, relative), 'utf8')

/** `<key>NAME</key>` immediately followed by `<true/>` — the only form an
 *  entitlement grant takes. A `<false/>` or a stray key elsewhere in the file
 *  (a comment quoting the name, say) does not count. */
const grants = (plist: string, key: string): boolean =>
  new RegExp(`<key>${key.replace(/\./g, '\\.')}</key>\\s*<true/>`).test(plist)

const MAIN = 'build/entitlements.mac.plist'
const INHERIT = 'build/entitlements.mac.inherit.plist'

// Hardened Runtime holds every hardened process to
// com.apple.security.device.audio-input before TCC will so much as prompt for
// the microphone: without it the signed app never asks and never hears
// anything, which is what the v0.19.1–v0.20.1 builds shipped as. The two
// docs that used to say the key was "an App Sandbox thing" are corrected;
// this test is what stops the next reader from removing it on the same
// reasoning. Ad-hoc dev builds carry no `runtime` flag, so nothing short of a
// Developer ID build can show the difference — a config test is the only
// check that runs on every push.
describe('macOS Hardened Runtime entitlements', () => {
  it('grants microphone access to the main executable', () => {
    expect(grants(read(MAIN), 'com.apple.security.device.audio-input')).toBe(true)
  })

  it('grants microphone access to every nested binary too', () => {
    // The training mic is a child process (`singz-analyze live-input`) and
    // Chromium's audio service may run in a helper app; both are signed with
    // the inherit file, not the main one.
    expect(grants(read(INHERIT), 'com.apple.security.device.audio-input')).toBe(true)
  })

  it('keeps the two JIT flags V8 needs on both files', () => {
    for (const file of [MAIN, INHERIT]) {
      const plist = read(file)
      expect(grants(plist, 'com.apple.security.cs.allow-jit')).toBe(true)
      expect(grants(plist, 'com.apple.security.cs.allow-unsigned-executable-memory')).toBe(true)
    }
  })

  it('never turns on the App Sandbox — this is the dmg target, not mas', () => {
    for (const file of [MAIN, INHERIT]) {
      expect(grants(read(file), 'com.apple.security.app-sandbox')).toBe(false)
    }
  })

  it('is what electron-builder signs with, under Hardened Runtime, with the prompt text beside it', () => {
    const builder = read('electron-builder.yml')
    expect(builder).toMatch(/^\s*hardenedRuntime:\s*true\s*$/m)
    expect(builder).toMatch(/^\s*entitlements:\s*build\/entitlements\.mac\.plist\s*$/m)
    expect(builder).toMatch(/^\s*entitlementsInherit:\s*build\/entitlements\.mac\.inherit\.plist\s*$/m)
    // The entitlement lets TCC ask; this is what it asks with. Both are
    // needed, and neither stands in for the other.
    expect(builder).toMatch(/^\s*NSMicrophoneUsageDescription:\s*\S/m)
  })
})
