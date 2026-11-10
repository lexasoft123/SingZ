'use strict'
// Copy the bundled sample into a task-owned library; never alter the source.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const dest = process.argv[2]
if (!dest || fs.existsSync(dest)) throw new Error('supply a fresh fixture directory')
const root = path.resolve(__dirname, '../..')
const sample = path.join(root, 'mobile/assets/sample')
const lib = path.join(dest, 'library')
const prefs = path.join(dest, 'prefs')
const names = ['Perf sample A', 'Perf sample B']
for (const name of names) {
  const project = path.join(lib, name)
  fs.cpSync(sample, project, { recursive: true })
  const docPath = path.join(project, 'project.json')
  const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'))
  doc.name = name
  doc.settings.metronome = { click: false, countInBars: 0, volume: 0, accent: true, grid: false }
  fs.writeFileSync(docPath, JSON.stringify(doc, null, 2))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '1', path.join(project, doc.songFile)])
}
fs.mkdirSync(prefs, { recursive: true })
fs.writeFileSync(path.join(prefs, 'settings.json'), JSON.stringify({ projectsRoot: lib }))
const stems = fs.readdirSync(path.join(sample, 'stems')).filter(f => /\.(flac|wav|mp3)$/i.test(f))
const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path.join(sample, 'stems', stems[0])], { encoding: 'utf8' }).trim())
const sourceDocument = JSON.parse(fs.readFileSync(path.join(sample, 'project.json'), 'utf8'))
console.log(JSON.stringify({ names, projects: names.map(name => path.join(lib, name)), library: lib, prefs, reference: 'bundled sample stems; one-second silent original placeholder', stemCount: stems.length, durationS: duration, lyricsPresent: fs.existsSync(path.join(sample, 'lyrics.json')), storedPitchLine: Boolean(sourceDocument.settings?.melody) }))
