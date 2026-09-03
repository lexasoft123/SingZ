/*
 * The two songs this suite replays a session against, built on the host and
 * staged into a plain directory that each platform layer copies (iOS) or
 * pushes (Android) into the app's phone library.
 *
 * Why not just `openSample()`: the bundled sample is 40.8 s, and a session
 * spent seeking, transposing and reaching the end of a 40 s song exercises
 * none of the sizes that matter — a real six-lane song is minutes long, and
 * both the native graph's materialization and the legacy decode scale with
 * it. So the sample's six FLAC stems are looped with ffmpeg into a long one
 * (LOOPS x 40.8 s), cached under the OS temp dir so a re-run costs nothing.
 *
 * The beat grid is HAND-MADE (`source: 'manual'`) and the count-in is off:
 * a manual grid is the one thing the phone's re-detect will not overwrite,
 * so the same project opens the same way on every run, and a count-in would
 * make "Play -> position advancing" measure a metronome rather than a
 * transport. The metronome click starts OFF and its volume is turned to 0 by
 * the scenario's first touch, because clicks bypass master gain and an
 * automated run is silent.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createHash } = require('crypto')
const { execFileSync } = require('child_process')

const STEM_IDS = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']

/** One 40.8 s pass of the sample, looped this many times: ~2 min and ~1 min. */
const SONGS = [
  { key: 'a', name: 'Player Session E2E', loops: 3 },
  { key: 'b', name: 'Player Session E2E second', loops: 2 }
]

const stageRoot = () => path.join(os.tmpdir(), 'singz-player-session')

function ffprobeSeconds(file) {
  const out = execFileSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' }
  )
  return Number(out.trim())
}

/**
 * Loop every sample stem `loops` times into `dest`, skipping the work when a
 * complete set is already there (every vendor script in this repo skip-guards
 * the same way; delete the directory to force a rebuild).
 */
function buildStems(sampleStems, dest, loops) {
  const want = STEM_IDS.map((id) => `${id}.flac`)
  const have = fs.existsSync(dest) && want.every((f) => fs.existsSync(path.join(dest, f)))
  if (!have) {
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(dest, { recursive: true })
    for (const f of want) {
      const src = path.join(sampleStems, f)
      if (!fs.existsSync(src)) throw new Error(`sample stem missing: ${src}`)
      execFileSync(
        'ffmpeg',
        ['-v', 'error', '-y', '-stream_loop', String(loops - 1), '-i', src, '-c:a', 'flac', path.join(dest, f)],
        { stdio: 'inherit' }
      )
    }
  }
  return { dir: dest, seconds: ffprobeSeconds(path.join(dest, want[0])) }
}

/**
 * A phone-library project folder on the HOST: stems, lyrics, project.json.
 * `stemHashes` is filled in for real because the doc is what states every
 * file the project is made of, and a doc that lies about it is a different
 * test from the one this suite means to run.
 */
function stageProject({ sampleDir, stemsDir, seconds, name, dest, bpm = 120, beatsPerBar = 4 }) {
  fs.rmSync(dest, { recursive: true, force: true })
  fs.mkdirSync(path.join(dest, 'stems'), { recursive: true })
  const stemHashes = {}
  for (const id of STEM_IDS) {
    const f = `${id}.flac`
    const to = path.join(dest, 'stems', f)
    fs.copyFileSync(path.join(stemsDir, f), to)
    const buf = fs.readFileSync(to)
    stemHashes[f] = {
      md5: createHash('md5').update(buf).digest('hex'),
      size: buf.length,
      mtimeMs: fs.statSync(to).mtimeMs
    }
  }
  fs.copyFileSync(path.join(sampleDir, 'lyrics.json'), path.join(dest, 'lyrics.json'))

  const spb = 60 / bpm
  const beats = []
  for (let t = 0; t + spb <= seconds; t += spb) beats.push(Number(t.toFixed(3)))
  const downbeats = []
  for (let i = 0; i < beats.length; i += beatsPerBar) downbeats.push(i)

  const doc = JSON.parse(fs.readFileSync(path.join(sampleDir, 'project.json'), 'utf8'))
  doc.name = name
  doc.stemHashes = stemHashes
  doc.settings.beat = { beats, bpm, beatsPerBar, downbeat: 0, downbeats, source: 'manual' }
  /* Click OFF and no count-in at rest: see the header. The scenario's three
     metronome touches turn the volume to 0, switch the click on and ask for a
     count-in bar, in that order, so nothing is ever audible. */
  doc.settings.metronome = { click: false, countInBars: 0, volume: 0.7, accent: true }
  delete doc.settings.key
  delete doc.settings.melody
  delete doc.settings.analysisNone
  fs.writeFileSync(path.join(dest, 'project.json'), JSON.stringify(doc))
  return { name, dir: dest, seconds, bars: downbeats.length, bpm }
}

/**
 * Build (or reuse) both songs under the staging root. Returns the two
 * descriptors in scenario order; the platform layer installs `dir`.
 */
function stageSongs(mobileRoot) {
  const sampleDir = path.join(mobileRoot, 'assets', 'sample')
  const sampleStems = path.join(sampleDir, 'stems')
  const root = stageRoot()
  fs.mkdirSync(root, { recursive: true })
  const out = []
  for (const song of SONGS) {
    const built = buildStems(sampleStems, path.join(root, `stems-x${song.loops}`), song.loops)
    out.push(
      stageProject({
        sampleDir,
        stemsDir: built.dir,
        seconds: built.seconds,
        name: song.name,
        dest: path.join(root, song.name)
      })
    )
  }
  return out
}

module.exports = { STEM_IDS, SONGS, stageSongs, stageRoot }
