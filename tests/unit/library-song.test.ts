import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// The e2e drivers' library-song helper, driven here with a fake page: the
// drivers themselves run by hand, so this is the only thing that holds the
// rule between runs.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assertOpenedProject, clickLibrarySong } = require('../e2e/mac/library-song.cjs') as typeof import('../e2e/mac/library-song.cjs')

type Entry = [string, string, ...unknown[]]
const g = globalThis as Record<string, unknown>
const FILES = ['project.json', 'lyrics.json']
const SAVED = '{"version":2,"saved":"by the open"}'
const PAST_S = 1_700_000_000
let root: string

// Two v2 projects, one's name inside the other's — the library the substring
// click went wrong on.
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'library-song-')))
  for (const name of ['Song', 'Song second']) {
    mkdirSync(join(root, name, 'stems'), { recursive: true })
    writeFileSync(join(root, name, 'project.json'), JSON.stringify({ version: 2, name, settings: {} }))
    writeFileSync(join(root, name, 'lyrics.json'), JSON.stringify({ source: 'whisper', lines: [name] }))
    for (const file of FILES) utimesSync(join(root, name, file), PAST_S, PAST_S)
  }
})

afterEach(() => {
  delete g.window
  delete g.__test
  rmSync(root, { recursive: true, force: true })
})

/** What an open with analyses missing does to its project, straight away. */
function save(dir: string) {
  for (const file of FILES) writeFileSync(join(dir, file), SAVED)
}

/** Just enough of a Playwright page: every card matches, and a click opens
 *  `opens` — its lanes reach the engine and `onOpen` saves into it. */
function fakeWindow(opens: string, onOpen: (dir: string) => void = save) {
  g.window = {
    singz: {
      listProjects: async () => ({
        root,
        projects: ['Song', 'Song second'].map((name) => ({ dir: join(root, name), name }))
      })
    }
  }
  const engine = { tracks: [] as { path: string }[] }
  g.__test = { engine }
  const cards = {
    count: async () => 1,
    click: async () => {
      engine.tracks = [{ path: join(opens, 'stems', 'vocals.flac') }]
      onOpen(opens)
    }
  }
  return {
    locator: () => ({ filter: () => cards }),
    evaluate: async (fn: () => unknown) => fn()
  } as never
}

const bytes = (dir: string) => FILES.map((file) => readFileSync(join(dir, file)))
const asked = () => join(root, 'Song')
const wrong = () => join(root, 'Song second')

/** Click, let the wrong project open, and run the check that must refuse it. */
async function openWrong(backups: Entry[], refusal: RegExp = /refusing to measure the wrong song/) {
  const win = fakeWindow(wrong())
  await clickLibrarySong(win, 'Song')
  await expect(assertOpenedProject(win, { dir: asked(), name: 'Song', backups })).rejects.toThrow(refusal)
}

describe('library-song: a wrong open is put back as it was before the click', () => {
  it('hands the driver the copies from before the click, not the ones the check found', async () => {
    const before = bytes(wrong())
    const backups: Entry[] = [[join(asked(), 'project.json'), readFileSync(join(asked(), 'project.json'), 'utf8')]]
    await openWrong(backups, /the app opened .*Song second — refusing to measure the wrong song$/)
    for (const [path, text] of backups) writeFileSync(path, text) // the driver's finally
    expect(bytes(wrong())).toEqual(before)
    // and the times from before the click ride along, for restores that put them back
    const lyrics = backups.find(([path]) => path === join(wrong(), 'lyrics.json'))
    expect(lyrics?.[2]).toMatchObject({ mtimeNs: BigInt(PAST_S) * 1_000_000_000n })
  })

  it('covers a click that was handed the wrong name, too', async () => {
    const before = bytes(wrong())
    const win = fakeWindow(wrong())
    const backups: Entry[] = []
    await clickLibrarySong(win, 'Song second') // the driver mixed up its names
    await expect(assertOpenedProject(win, { dir: asked(), name: 'Song', backups })).rejects.toThrow(
      /refusing to measure the wrong song$/
    )
    for (const [path, text] of backups) writeFileSync(path, text)
    expect(bytes(wrong())).toEqual(before)
  })

  it("keeps the driver's own copy and adds only what it does not hold", async () => {
    const own: Entry = [join(wrong(), 'project.json'), 'the driver’s own copy']
    const backups: Entry[] = [own]
    await openWrong(backups)
    expect(backups.map(([path]) => path)).toEqual([join(wrong(), 'project.json'), join(wrong(), 'lyrics.json')])
    expect(backups[0]).toBe(own)
  })

  it('names a file the open created, and leaves it in place', async () => {
    rmSync(join(wrong(), 'lyrics.json'))
    const win = fakeWindow(wrong(), (dir) => writeFileSync(join(dir, 'lyrics.json'), '{"source":"lrclib"}'))
    const backups: Entry[] = []
    await clickLibrarySong(win, 'Song')
    await expect(assertOpenedProject(win, { dir: asked(), name: 'Song', backups })).rejects.toThrow(
      /lyrics\.json did not exist before the click; left in place/
    )
    expect(backups.map(([path]) => path)).toEqual([join(wrong(), 'project.json')])
    expect(existsSync(join(wrong(), 'lyrics.json'))).toBe(true)
  })

  it("leaves a v1 project's doc as the app writes it — opening one converts its stems", async () => {
    writeFileSync(join(wrong(), 'project.json'), JSON.stringify({ name: 'Song second', settings: {} })) // no version: v1
    const lyrics = readFileSync(join(wrong(), 'lyrics.json'), 'utf8')
    const backups: Entry[] = []
    await openWrong(backups, /project\.json is a v1 project, which opening converts to FLAC/)
    expect(backups.map(([path, text]) => [path, text])).toEqual([[join(wrong(), 'lyrics.json'), lyrics]])
  })

  it('never writes back a copy caught mid-write — it takes the file as found, and says so', async () => {
    const pj = readFileSync(join(wrong(), 'project.json'), 'utf8')
    writeFileSync(join(wrong(), 'lyrics.json'), '{"source":"whi')
    const backups: Entry[] = []
    await openWrong(backups, /no copy of .*lyrics\.json from before the click, so it goes back as found now/)
    expect(backups.map(([path, text]) => [path, text])).toEqual([
      [join(wrong(), 'project.json'), pj],
      [join(wrong(), 'lyrics.json'), SAVED]
    ])
  })

  it('writes back nothing at all for a file caught mid-write both times', async () => {
    writeFileSync(join(wrong(), 'lyrics.json'), '{"source":"whi')
    const win = fakeWindow(wrong(), (dir) => writeFileSync(join(dir, 'lyrics.json'), '{"source":"lrc'))
    const backups: Entry[] = []
    await clickLibrarySong(win, 'Song')
    await expect(assertOpenedProject(win, { dir: asked(), name: 'Song', backups })).rejects.toThrow(
      /lyrics\.json was caught mid-write, so nothing will put it back/
    )
    expect(backups.map(([path]) => path)).toEqual([join(wrong(), 'project.json')])
  })

  it('without a click of its own, takes the files as found, and says so', async () => {
    const win = fakeWindow(wrong())
    const backups: Entry[] = []
    save(wrong()) // opened some other way, with no copies taken
    ;(g.__test as { engine: { tracks: { path: string }[] } }).engine.tracks = [{ path: join(wrong(), 'stems', 'vocals.flac') }]
    await expect(assertOpenedProject(win, { dir: asked(), name: 'Song', backups })).rejects.toThrow(
      /no copy of .*project\.json from before the click.*; no copy of .*lyrics\.json from before the click/
    )
    expect(backups.map(([, text]) => text)).toEqual([SAVED, SAVED])
  })

  it('says only what it did with a v1 doc it had no copy of', async () => {
    const win = fakeWindow(wrong())
    const backups: Entry[] = []
    writeFileSync(join(wrong(), 'project.json'), JSON.stringify({ name: 'Song second', settings: {} })) // v1 at the check
    ;(g.__test as { engine: { tracks: { path: string }[] } }).engine.tracks = [{ path: join(wrong(), 'stems', 'vocals.flac') }]
    const error = String(await assertOpenedProject(win, { dir: asked(), name: 'Song', backups }).catch((e: Error) => e))
    expect(error).toMatch(/project\.json is a v1 project, which opening converts to FLAC/)
    expect(error).not.toMatch(/no copy of .*project\.json/)
    expect(backups.map(([path]) => path)).toEqual([join(wrong(), 'lyrics.json')])
  })

  it('holds nothing when the song asked for is the one that opened', async () => {
    const win = fakeWindow(asked())
    const backups: Entry[] = []
    await clickLibrarySong(win, 'Song')
    await assertOpenedProject(win, { dir: asked(), name: 'Song', backups })
    expect(backups).toEqual([])
  })

  it('resolves to the moment the click was sent, after the copies were taken', async () => {
    const win = fakeWindow(asked())
    const singz = (g.window as { singz: { listProjects: () => Promise<unknown> } }).singz
    const list = singz.listProjects
    singz.listProjects = async () => {
      await new Promise((resolve) => setTimeout(resolve, 60)) // a big library
      return list()
    }
    const t0 = Date.now()
    const clickedAt = await clickLibrarySong(win, 'Song')
    expect(clickedAt - t0).toBeGreaterThanOrEqual(50)
    expect(clickedAt).toBeLessThanOrEqual(Date.now())
  })
})
