import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Library fixtures both roots share.
 *
 * The point is real bytes: every md5 in a test now comes from hashing an actual
 * file, so the desktop writes what the phone reads and a format change on
 * either side breaks a test on the other. The mobile suite used to hand-build
 * catalogs with invented tokens ('m-1', 'v-1'), which agreed with nothing.
 */

export interface ScenarioFile {
  /** Project-relative, e.g. "stems/vocals.flac". */
  path: string
  /** Content — short strings; nothing here decodes audio. */
  body: string
}

export interface ScenarioProject {
  dir: string
  name: string
  savedAt: string
  files: ScenarioFile[]
  /** Extra lanes the singer added, as project.json records them. */
  custom?: { id: string; label: string; color: string; file: string }[]
  settings?: Record<string, unknown>
}

export interface Scenario {
  projects: ScenarioProject[]
}

const STEMS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

/** A plain six-stem song, the shape most of the library is in. */
export function song(dir: string, opts?: Partial<ScenarioProject>): ScenarioProject {
  return {
    dir,
    name: dir,
    savedAt: '2026-01-01T00:00:00.000Z',
    files: [
      { path: 'lyrics.json', body: JSON.stringify({ lines: [{ t: 0, text: `${dir} line one` }] }) },
      ...STEMS.map((s, i) => ({ path: `stems/${s}.flac`, body: `fLaC ${dir} ${s} ${'x'.repeat(i + 1)}` }))
    ],
    ...opts
  }
}

export const scenarios = {
  /** Two songs, one of them carrying a track the singer added on the desktop. */
  twoSongs: (): Scenario => ({
    projects: [
      song('Song One'),
      song('Song Two', {
        savedAt: '2026-02-02T00:00:00.000Z',
        files: [
          ...song('Song Two').files,
          { path: 'stems/custom-harmony.mp3', body: 'ID3 my own harmony take' }
        ],
        custom: [
          { id: 'custom-harmony', label: 'Harmony', color: '#c7e06a', file: 'stems/custom-harmony.mp3' }
        ]
      })
    ]
  }),
  /** One song, for the cases where a second only adds noise. */
  oneSong: (): Scenario => ({ projects: [song('Song One')] })
}

export const md5 = (body: string | Buffer): string =>
  createHash('md5').update(typeof body === 'string' ? Buffer.from(body) : body).digest('hex')

/**
 * Write a scenario into a library root, exactly as the desktop would have left
 * it: a project.json per folder WITHOUT stemHashes, because those are the
 * desktop's own bookkeeping and the sync backfills them. A fixture that
 * pre-filled them would hide whether the backfill works.
 */
export function seedLibraryOnDisk(root: string, scenario: Scenario): void {
  for (const p of scenario.projects) {
    mkdirSync(join(root, p.dir, 'stems'), { recursive: true })
    for (const f of p.files) writeFileSync(join(root, p.dir, f.path), f.body)
    // the song itself: listProjects skips a project whose songFile is missing
    writeFileSync(join(root, p.dir, 'song.mp3'), `ID3 ${p.dir}`)
    writeFileSync(
      join(root, p.dir, 'project.json'),
      JSON.stringify(
        {
          version: 2,
          name: p.name,
          songFile: 'song.mp3',
          savedAt: p.savedAt,
          settings: { transpose: 0, tracks: {}, custom: p.custom ?? null, ...p.settings }
        },
        null,
        2
      )
    )
  }
}

/** What the phone should end up holding for a project: path → md5, audio only. */
export function expectedStems(p: ScenarioProject): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of p.files) if (f.path.startsWith('stems/')) out[f.path] = md5(f.body)
  return out
}
