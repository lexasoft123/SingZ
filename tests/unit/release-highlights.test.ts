import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { RELEASE_VERSION, compareReleaseVersions, releaseHighlights } from '../../src/shared/release-highlights'
describe('bundled update highlights', () => {
  it('validates the release version, translations, icons and audiences in CI', () => {
    expect(execFileSync(process.execPath, ['scripts/check-release-highlights.cjs'], { encoding: 'utf8' })).toContain('valid')
  })
  it('shows current news to a pre-feature install and skipped updates to an older install', () => {
    expect(releaseHighlights(RELEASE_VERSION, undefined, 'en', 'desktop')?.entries[0].version).toBe(RELEASE_VERSION)
    expect(releaseHighlights(RELEASE_VERSION, '0.25.0', 'en', 'desktop')?.entries[0].version).toBe(RELEASE_VERSION)
  })
  it('does not repeat dismissed news or show news when downgrading', () => {
    expect(releaseHighlights(RELEASE_VERSION, RELEASE_VERSION, 'en', 'desktop')).toBeNull()
    expect(releaseHighlights(RELEASE_VERSION, '1.0.0', 'en', 'desktop')).toBeNull()
    expect(releaseHighlights('dev', undefined, 'en', 'desktop')).toBeNull()
    expect(compareReleaseVersions('0.10.0', '0.9.9')).toBeGreaterThan(0)
  })
  it.each(['en', 'ru', 'zh-CN'] as const)('keeps desktop capabilities labeled on phones in %s', locale => {
    const phone = releaseHighlights(RELEASE_VERSION, undefined, locale, 'ios')!
    expect(phone.entries[0].highlights.find(item => item.id === 'desktop-training')?.desktopOnly).toBe(true)
    expect(phone.entries[0].highlights.find(item => item.id === 'reference-sounds')?.desktopOnly).toBe(false)
    expect(phone.entries[0].highlights.every(item => item.title && item.description)).toBe(true)
    expect(phone.url).toBe(`https://github.com/lexasoft123/SingZ/releases/tag/v${RELEASE_VERSION}`)
  })
})
