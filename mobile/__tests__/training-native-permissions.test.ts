import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('native vocal training permissions', () => {
  test('ships friendly iOS microphone disclosure', () => {
    const plist = readFileSync(join(__dirname, '../ios/SingZPlayer/Info.plist'), 'utf8')
    expect(plist).toContain('<key>NSMicrophoneUsageDescription</key>')
    expect(plist).toMatch(/listens while you practise/)
  })

  test('declares Android RECORD_AUDIO', () => {
    const manifest = readFileSync(join(__dirname, '../android/app/src/main/AndroidManifest.xml'), 'utf8')
    expect(manifest).toContain('android.permission.RECORD_AUDIO')
  })
})
