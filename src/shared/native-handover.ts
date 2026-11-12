import { TRAINING_SOUNDS } from './training-sound'

/**
 * C-44: the Electron side of the handover to the native desktop app (D-04, H-C).
 * Pure helpers only: what the offer looks like, how the release feed is read for
 * the native manifest, and how renderer preferences become the
 * `native-handover.json` export that native's first-run import (C-40,
 * `experiments/gpui-player/src/migrate.rs`) reads. Contract:
 * `experiments/gpui-player/plan/C-44-handover-export.md`.
 */

/** Build-time switch. The last Electron desktop build flips this to true; until
 * then the offer is off and today's behaviour is unchanged. `SINGZ_NATIVE_OFFER=1`
 * turns it on at run time (tests, hand-verification) without a rebuild. */
export const NATIVE_OFFER_BUILD_DEFAULT = false

export function nativeOfferEnabled(
  surface: 'desktop' | 'box',
  env: { SINGZ_NATIVE_OFFER?: string } = {},
  buildDefault: boolean = NATIVE_OFFER_BUILD_DEFAULT
): boolean {
  if (surface !== 'desktop') return false
  if (env.SINGZ_NATIVE_OFFER === '1') return true
  if (env.SINGZ_NATIVE_OFFER === '0') return false
  return buildDefault
}

export type NativeOffer =
  | { available: false }
  | { available: true; channel: 'beta' | 'stable'; version: string; url: string }

/** The export is bounded; native refuses anything above this. */
export const NATIVE_HANDOVER_MAX_BYTES = 64 * 1024
export const NATIVE_HANDOVER_FILE = 'native-handover.json'
const RELEASE_URL_PREFIX = 'https://github.com/lexasoft123/SingZ/'

export type NativeTarget = 'macos-arm64' | 'macos-x64' | 'windows-x64'

/** Linux has no native build in D-04 (check-and-offer preview only): no offer. */
export function nativeTarget(platform: string, arch: string): NativeTarget | null {
  if (platform === 'darwin') return arch === 'arm64' ? 'macos-arm64' : arch === 'x64' ? 'macos-x64' : null
  if (platform === 'win32') return arch === 'x64' ? 'windows-x64' : null
  return null
}

export function nativeManifestName(target: NativeTarget): string {
  return `singz-native-${target}.update.json`
}

interface Semver { core: number[]; pre: string[] }
function parseSemver(tag: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(tag.trim())
  if (!m) return null
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

/** Full semver precedence, prerelease identifiers included (0.27.0-beta.2 < 0.27.0). */
export function compareSemver(a: string, b: string): number {
  const [x, y] = [parseSemver(a), parseSemver(b)]
  if (!x || !y) return x ? 1 : y ? -1 : 0
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1 }
    else if (pn !== qn) return pn ? -1 : 1
    else if (p !== q) return p < q ? -1 : 1
  }
  return 0
}

export interface ReleaseSummary {
  tag_name?: unknown
  html_url?: unknown
  prerelease?: unknown
  draft?: unknown
  assets?: unknown
}

/** The installer a person downloads for this platform, named by
 * `.github/workflows/native-release.yml` (the version has no leading `v`). */
export function nativeInstallerName(target: NativeTarget, version: string): string {
  return target === 'windows-x64' ? `SingZ-native-${version}-windows-x64-setup.exe` : `SingZ-native-${version}-${target}.dmg`
}

/** The highest release that carries this platform's native manifest asset, or
 * none. A release whose tag is a prerelease (or is flagged prerelease) is `beta`;
 * only a plain-version release is `stable`, which is what turns the quiet entry
 * into the title-bar chip. */
export function pickNativeOffer(releases: readonly ReleaseSummary[], target: NativeTarget | null): NativeOffer {
  if (!target) return { available: false }
  const manifest = nativeManifestName(target)
  let best: { tag: string; url: string; beta: boolean; assets: unknown[] } | null = null
  for (const rel of releases) {
    const tag = typeof rel.tag_name === 'string' ? rel.tag_name : ''
    const parsed = parseSemver(tag)
    const url = typeof rel.html_url === 'string' && rel.html_url.startsWith(RELEASE_URL_PREFIX) ? rel.html_url : ''
    const assets = Array.isArray(rel.assets) ? rel.assets : []
    if (!parsed || !url || rel.draft === true) continue
    if (!assets.some((a) => (a as { name?: unknown } | null)?.name === manifest)) continue
    if (!best || compareSemver(tag, best.tag) > 0) best = { tag, url, beta: rel.prerelease === true || parsed.pre.length > 0, assets }
  }
  if (!best) return { available: false }
  const version = best.tag.replace(/^v/, '')
  // Open the installer itself when the release lists it, else the release page.
  const installer = nativeInstallerName(target, version)
  const listed = best.assets.map((a) => a as { name?: unknown; browser_download_url?: unknown } | null)
    .find((a) => a?.name === installer && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(RELEASE_URL_PREFIX))
  return { available: true, channel: best.beta ? 'beta' : 'stable', version, url: listed ? String(listed.browser_download_url) : best.url }
}

/** A dismissal is remembered per channel and version, so a new native release
 * (or beta -> stable) offers again. */
export function nativeOfferKey(offer: Extract<NativeOffer, { available: true }>): string {
  return `${offer.channel}:${offer.version}`
}

/** What the renderer reports: the stored preference values, unvalidated. */
export interface NativeHandoverReport {
  audio?: unknown
  metronome?: unknown
  karaoke?: unknown
  trainingPractice?: unknown
  trainingProgram?: unknown
}

const PITCH_WINDOWS = [5, 10, 15, 20]
const PROGRAM_LEVELS = ['foundation', 'developing', 'advanced']
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
const int = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : undefined
const num = (v: unknown, lo: number, hi: number): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined
const uid = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 && v.length <= 512 && v !== 'default' && v !== 'communications' ? v : undefined

/**
 * Renderer preferences to the contract's JSON. Each optional item is exported only
 * when valid, so native records an absent item as skipped rather than importing
 * guesses. Never exported: credentials, projects, sessions, Chromium device ids
 * (`outputId` goes only as Linux's explicit `native:<uid>` form), headphone
 * confirmation or monitor enablement. `nativeOutputUid` is deliberately never
 * written: nothing in the Electron renderer proves a native playback route's UID.
 */
export function buildNativeHandover(report: NativeHandoverReport): Record<string, unknown> {
  const doc: Record<string, unknown> = { formatVersion: 1, product: 'desktop' }

  const a = obj(report.audio)
  if (a) {
    const audio: Record<string, unknown> = {}
    if (typeof a.outputId === 'string' && a.outputId.startsWith('native:') && uid(a.outputId.slice(7))) audio.outputId = a.outputId
    const input = uid(a.nativeInputUid)
    if (input) {
      audio.nativeInputUid = input
      audio.inputChannel = int(a.inputChannel, 0, 31) ?? 0
    }
    const monitor = uid(a.nativeMonitorOutputUid)
    const ch = Array.isArray(a.nativeMonitorOutputChannels) ? a.nativeMonitorOutputChannels : []
    if (monitor && ch.length === 2 && ch.every((n) => int(n, 0, 63) !== undefined) && ch[0] !== ch[1]) {
      audio.nativeMonitorOutputUid = monitor
      audio.nativeMonitorOutputChannels = [ch[0], ch[1]]
    }
    const gain = num(a.monitorGainDb, -60, 0)
    if (gain !== undefined) audio.monitorGainDb = gain
    if (Object.keys(audio).length) doc.audio = audio
  }

  const m = obj(report.metronome)
  if (m) {
    const [countInBars, volume] = [int(m.countInBars, 0, 2), num(m.volume, 0, 1)]
    if ([m.click, m.accent, m.grid].every((b) => typeof b === 'boolean') && countInBars !== undefined && volume !== undefined)
      doc.metronome = { click: m.click, countInBars, volume, accent: m.accent, grid: m.grid }
  }

  if (typeof report.karaoke === 'boolean') doc.karaoke = report.karaoke

  // A complete native Controls object; fields with no Electron equivalent (focus)
  // take native's defaults. Sound order is shared: piano, electric, guitar, organ.
  const sound = TRAINING_SOUNDS.indexOf(a?.trainingSound as (typeof TRAINING_SOUNDS)[number])
  const cents = num(obj(report.trainingPractice)?.pitchWindowCents, 0, 1000)
  const nearest = cents === undefined ? 1
    : PITCH_WINDOWS.reduce((best, w, i) => (Math.abs(w - cents) < Math.abs(PITCH_WINDOWS[best] - cents) ? i : best), 0)
  const p = obj(report.trainingProgram)
  const level = p ? PROGRAM_LEVELS.indexOf(String(p.level)) : -1
  const startedAt = p ? int(p.startedAt, 0, Number.MAX_SAFE_INTEGER) : undefined
  doc.trainingControls = {
    formatVersion: 1,
    sound: Math.max(0, sound),
    volume: num(a?.referenceVolume, 0, 2) ?? 0.65,
    tolerance: nearest,
    focus: 0,
    program: level >= 0 && startedAt !== undefined ? { level, startedAt } : null
  }
  return doc
}
