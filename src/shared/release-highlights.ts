import data from './release-highlights.json'
import type { Locale } from './i18n/rules'
export type ReleasePlatform = 'desktop' | 'ios' | 'android'
export type HighlightIcon = 'news' | 'export' | 'mic' | 'controls'
export interface ReleaseHighlight { id: string; icon: HighlightIcon; title: string; description: string; desktopOnly: boolean }
export interface ReleaseNoteEntry { version: string; highlights: ReleaseHighlight[] }
export interface ReleaseNotes { version: string; entries: ReleaseNoteEntry[]; url: string }
export const RELEASE_VERSION = data.version
export function validReleaseVersion(version: string): boolean { return /^\d+\.\d+\.\d+$/.test(version) }
export function compareReleaseVersions(a: string, b: string): number {
  const left = a.split('.').map(Number), right = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) { const difference = left[i] - right[i]; if (difference) return difference }
  return 0
}
/** Acknowledgement never moves backwards; skipped updates include every bundled release since it. */
export function releaseHighlights(current: string, previous: string | undefined, locale: Locale,
                                  platform: ReleasePlatform): ReleaseNotes | null {
  if (!validReleaseVersion(current)) return null
  const seen = previous && validReleaseVersion(previous) ? previous : undefined
  const entries = data.releases.filter(release => compareReleaseVersions(release.version, current) <= 0 &&
    (seen ? compareReleaseVersions(release.version, seen) > 0 : release.version === current))
    .sort((a, b) => compareReleaseVersions(b.version, a.version))
    .map(release => ({ version: release.version, highlights: release.highlights
      .filter(item => item.platforms.includes(platform) || (platform !== 'desktop' && item.platforms.includes('desktop')))
      .map(item => ({ id: item.id, icon: item.icon as HighlightIcon, ...item.text[locale],
        desktopOnly: !item.platforms.includes(platform) })) }))
    .filter(entry => entry.highlights.length > 0)
  return entries.length ? { version: current, entries, url: `https://github.com/lexasoft123/SingZ/releases/tag/v${current}` } : null
}
