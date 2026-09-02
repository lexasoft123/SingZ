import fs from 'node:fs'
import path from 'node:path'

const mobile = path.join(__dirname, '..')
const repo = path.join(mobile, '..')
const readMobile = (relative: string): string =>
  fs.readFileSync(path.join(mobile, relative), 'utf8')
const readRepo = (relative: string): string =>
  fs.readFileSync(path.join(repo, relative), 'utf8')

describe('Signalsmith mobile packaging', () => {
  test('puts both MIT notices and pinned provenance in APK and IPA resources', () => {
    const gradle = readMobile('android/app/build.gradle')
    const podspec = readMobile(
      'ios/SingzPlaybackSession/SingzPlaybackSession.podspec',
    )
    const sync = readMobile('scripts/sync-singz-dsp-runtime.js')
    for (const name of [
      'VENDORED.txt',
      'LICENSE-stretch.txt',
      'LICENSE-linear.txt',
    ]) {
      expect(gradle).toContain(name)
      expect(sync).toContain(name)
    }
    expect(gradle).toContain('third_party/signalsmith')
    expect(podspec).toContain("'SingzSignalsmithNotices' => 'compliance/*'")
    expect(readRepo('third_party/native/signalsmith/LICENSE-stretch.txt'))
      .toContain('MIT License')
    expect(readRepo('third_party/native/signalsmith/LICENSE-linear.txt'))
      .toContain('MIT License')
  })
})
