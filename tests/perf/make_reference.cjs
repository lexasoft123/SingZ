'use strict'
// Deterministic synthetic benchmark library; stdout is the harness reference JSON.
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const dest = process.argv[2]
if (!dest || fs.existsSync(dest)) throw new Error('supply a fresh fixture directory')
const root = path.resolve(__dirname, '../..')
function version(file, constant) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const match = text.match(new RegExp(`constexpr int ${constant}\\s*=\\s*(\\d+)`))
  if (!match) throw new Error(`missing detector stamp ${constant}`)
  return Number(match[1])
}
const pitchVersion = version('zcore/include/zcore/legacy/melody.h', 'kPitchDetectVersion')
const beatVersion = version('zcore/include/zcore/legacy/beats.h', 'kBeatDetectVersion')
const keyVersion = version('zcore/include/zcore/legacy/analysis.h', 'kKeyDetectVersion')
const lib = path.resolve(dest, 'library'), prefs = path.resolve(dest, 'prefs')
const names = ['Perf reference 5m', 'Perf reference 12m']
const stems = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']
for (const [index, duration] of [300, 720].entries()) {
  const dir = path.join(lib, names[index])
  fs.mkdirSync(path.join(dir, 'stems'), { recursive: true })
  for (const [i, stem] of stems.entries()) {
    // Sine at known frequency, gated to create note boundaries; no random state.
    const freq = [440, 110, 55, 220, 330, 165][i]
    const signal = `0.08*sin(2*PI*${freq}*t)*if(lt(mod(t,2),1.5),1,0)`
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc='${signal}':s=44100:d=${duration}`, '-c:a', 'flac', '-sample_fmt', 's16', path.join(dir, 'stems', `${stem}.flac`)])
  }
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=44100:cl=stereo`, '-t', String(duration), '-c:a', 'libmp3lame', '-b:a', '32k', path.join(dir, 'song.mp3')])
  const lines = []
  for (let t = 2; t < duration - 2; t += 5) {
    lines.push({ start: t, end: t + 2, text: 'Sing with me', words: [{ w: 'Sing', s: t, e: t + .5 }, { w: 'with', s: t + .6, e: t + 1 }, { w: 'me', s: t + 1.1, e: t + 1.8 }] })
  }
  const settings = { transpose: 0, tempo: 1, training: { on: false, mode: 'lines', periodSec: 10, hear: 1, sing: 1, stems: ['vocals'] }, tracks: Object.fromEntries(stems.map(s => [s, { muted: false, solo: false, volume: 1 }])), metronome: { click: false, countInBars: 0, volume: 0, accent: true, grid: false }, melody: { detVersion: pitchVersion, hopSec: .025, f0: Array.from({ length: duration * 40 }, (_, i) => i % 80 < 60 ? '3600' : 'x').join(' ') }, beat: { bpm: 120, beats: Array.from({ length: duration * 2 }, (_, i) => i / 2), beatsPerBar: 4, downbeat: 0, source: 'auto', detVersion: beatVersion }, key: { pc: 9, minor: false, detVersion: keyVersion } }
  fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify({ version: 2, name: names[index], songFile: 'song.mp3', savedAt: '2026-07-28T00:00:00.000Z', settings }, null, 2))
  fs.writeFileSync(path.join(dir, 'lyrics.json'), JSON.stringify({ source: 'whisper', credit: 'Synthetic benchmark', aligned: true, lines }, null, 2))
}
fs.mkdirSync(prefs, { recursive: true })
fs.writeFileSync(path.join(prefs, 'settings.json'), JSON.stringify({ projectsRoot: lib }))
console.log(JSON.stringify({ names, projects: names.map(n => path.join(lib, n)), library: lib, prefs, reference: 'synthetic 5-minute reference; 12-minute cycle partner', stemCount: 6, durationS: 300, lyricsPresent: true, storedPitchLine: true }))
