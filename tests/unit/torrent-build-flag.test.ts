import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
const require = createRequire(import.meta.url)
const { iosTorrentsEnabled, resolveTorrentModule } = require('../../mobile/scripts/torrent-build-policy.cjs')
const { assertTorrentContents } = require('../../mobile/scripts/verify-torrent-build.cjs')
const root = path.resolve(import.meta.dirname, '../..')
const feature = path.join(root, 'mobile/src/features/torrent-feature.tsx')
const disabled = path.join(root, 'mobile/src/features/torrent-feature.disabled.tsx')
const clean = { flag: '0', native: Buffer.from('plain app'), bundle: Buffer.from('plain UI'), paths: [] as string[] }
describe('iOS internal download build boundary', () => {
  it('fails closed for store, unknown configurations and ordinary production bundles', () => {
    expect(iosTorrentsEnabled(false, {})).toBe(false)
    expect(iosTorrentsEnabled(true, { CONFIGURATION: 'Release', SINGZ_ENABLE_TORRENTS: '1' })).toBe(false)
    expect(iosTorrentsEnabled(true, { CONFIGURATION: 'Unexpected', SINGZ_ENABLE_TORRENTS: '1' })).toBe(false)
    expect(iosTorrentsEnabled(false, { CONFIGURATION: 'AdHoc', SINGZ_ENABLE_TORRENTS: '0' })).toBe(false)
    expect(iosTorrentsEnabled(false, { CONFIGURATION: 'AdHoc', SINGZ_ENABLE_TORRENTS: '1' })).toBe(true)
    expect(iosTorrentsEnabled(true, {})).toBe(true)
  })
  it('replaces the feature before Metro collects its implementation dependencies', () => {
    const context = { dev: false, resolveRequest: () => ({ type: 'sourceFile', filePath: feature }) }
    expect(resolveTorrentModule(context, '../features/torrent-feature', 'ios')).toEqual({ type: 'sourceFile', filePath: disabled })
    expect(resolveTorrentModule(context, '../features/torrent-feature', 'android').filePath).toBe(feature)
  })
  it('rejects a new direct import bypassing the feature boundary', () => {
    const context = { dev: false, resolveRequest: () => ({ type: 'sourceFile', filePath: path.join(root, 'mobile/src/ui/TorrentScreen.tsx') }) }
    expect(() => resolveTorrentModule(context, './TorrentScreen', 'ios')).toThrow('disabled iOS build')
  })
  it('accepts a clean store artifact but rejects dormant native code and resources', () => {
    expect(() => assertTorrentContents(clean, false)).not.toThrow()
    expect(() => assertTorrentContents({ ...clean, native: Buffer.from('SingzTorrent') }, false)).toThrow('Store binary')
    expect(() => assertTorrentContents({ ...clean, native: Buffer.from('libtorrent') }, false)).toThrow('Store binary')
    expect(() => assertTorrentContents({ ...clean, paths: ['SingzTorrentNotices.bundle'] }, false)).toThrow('resources')
  })
  it('rejects provider or UI code in both Hermes string encodings', () => {
    for (const encoding of ['utf8', 'utf16le'] as const) {
      expect(() => assertTorrentContents({ ...clean, bundle: Buffer.from('Search RuTracker', encoding) }, false)).toThrow('Store bundle')
      expect(() => assertTorrentContents({ ...clean, bundle: Buffer.from('https://rutracker.org', encoding) }, false)).toThrow('Store bundle')
    }
  })
  it('requires the real enabled closure and matching metadata in internal artifacts', () => {
    const internal = { ...clean, flag: '1', native: Buffer.from('SingzTorrent'), bundle: Buffer.from('Search RuTracker') }
    expect(() => assertTorrentContents(internal, true)).not.toThrow()
    expect(() => assertTorrentContents({ ...internal, native: clean.native }, true)).toThrow('missing')
    expect(() => assertTorrentContents(internal, false)).toThrow('flag')
  })
  // Fastlane/Ruby is an iOS build dependency, not a Windows desktop dependency.
  it.skipIf(process.platform !== 'darwin')('separates native archive cache keys by build configuration', () => {
    const script = `require './mobile/ios/fastlane/incremental-archive'; require './mobile/ios/fastlane/torrent-build'
module Open3
 def self.capture3(*args); ['a'*64, '', Struct.new(:success?).new(true)]; end
end
raise unless SingzTorrentBuild.configuration('appstore') == 'Release'
raise unless SingzTorrentBuild.configuration('adhoc') == 'AdHoc'
raise if SingzIncrementalArchive.fingerprint('.', 'Release') == SingzIncrementalArchive.fingerprint('.', 'AdHoc')
puts 'ok'`
    expect(execFileSync('ruby', ['-e', script], { cwd: root, encoding: 'utf8' }).trim()).toBe('ok')
  })
})
