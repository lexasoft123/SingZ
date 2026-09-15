import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
const issued = vi.hoisted(() => new Set<string>())
vi.mock('../../src/main/vocal-separation', () => ({ isIssuedLead: (path: string) => issued.has(path) }))
import { detectProject, saveProject } from '../../src/main/projects'
import { canResplitVocals } from '../../src/renderer/src/vocal-split-request'

function floatWav(): Buffer {
  const data = Buffer.alloc(44 + 64 * 8)
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(3, 20); data.writeUInt16LE(2, 22)
  data.writeUInt32LE(44100, 24); data.writeUInt32LE(44100 * 8, 28)
  data.writeUInt16LE(8, 32); data.writeUInt16LE(32, 34); data.write('data', 36)
  data.writeUInt32LE(data.length - 44, 40)
  data.writeFloatLE(1.25, 44) // retaining this is why the residual stays float WAV
  data.writeFloatLE(-1.1, 48)
  return data
}

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'singz-lead-save-'))
  await mkdir(join(dir, 'stems'))
  await writeFile(join(dir, 'song.mp3'), 'source-song')
  await writeFile(join(dir, 'stems', 'vocals.flac'), 'old-combined-vocal')
  for (const stem of ['drums', 'bass', 'other']) await writeFile(join(dir, 'stems', stem + '.flac'), 'fLaC-other-stem')
  await writeFile(join(dir, 'project.json'), JSON.stringify({
    version: 2, name: 'Lead test', songFile: 'song.mp3', savedAt: '2026-09-14',
    settings: { transpose: 0, tracks: {}, melody: { detVersion: 1, f0: '60 60', hopSec: .02 } }
  }))
  return dir
}

describe('saving a separated vocal', () => {
  it('replaces preferred FLAC in place, retains float samples, saves backing and disowns old melody', async () => {
    const dir = await project(), scratch = await mkdtemp(join(tmpdir(), 'singz-lead-output-'))
    const lead = join(scratch, 'lead.wav'), backing = join(scratch, 'backing.wav')
    const bytes = floatWav()
    await writeFile(lead, bytes); await writeFile(backing, bytes); issued.add(lead)
    const result = await saveProject(join(dir, 'song.mp3'), 'Lead test', {
      transpose: 0, tracks: {}, pendingLeadVocal: lead, leadVocalSeparated: true,
      custom: [{ id: 'custom-backing-vocals', label: 'Backing vocals', color: '#123456', file: backing }]
    })
    expect(result.ok).toBe(true)
    expect(await readFile(join(dir, 'stems', 'vocals.wav'))).toEqual(bytes)
    expect(await readdir(join(dir, 'stems'))).not.toContain('vocals.flac')
    const doc = JSON.parse(await readFile(join(dir, 'project.json'), 'utf8'))
    expect(doc.version).toBe(1) // existing reader supports mixed WAV/FLAC
    expect(doc.settings.pendingLeadVocal).toBeUndefined()
    expect(doc.settings.leadVocalSeparated).toBe(true)
    expect(doc.settings.melody).toBeUndefined()
    expect(doc.settings.custom[0].file).toBe('stems/custom-backing-vocals.wav')
    expect(Object.keys(doc.stemHashes)).toContain('vocals.wav')
    expect(Object.keys(doc.stemHashes)).toContain('custom-backing-vocals.wav')
    const reopened = await detectProject(join(dir, 'song.mp3'))
    expect(reopened?.stems?.vocals).toBe(join(dir, 'stems', 'vocals.wav'))
    expect(reopened?.settings.leadVocalSeparated).toBe(true)
    expect(canResplitVocals(null, false, reopened?.settings.leadVocalSeparated === true)).toBe(false)
    expect(await readFile(lead)).toEqual(bytes) // cache source is never moved
    const again = await saveProject(join(dir, 'song.mp3'), 'Lead test', {
      transpose: 0, tracks: {}, custom: reopened?.settings.custom,
      leadVocalSeparated: reopened?.settings.leadVocalSeparated
    })
    expect(again.ok).toBe(true)
    const reopenedAgain = await detectProject(join(dir, 'song.mp3'))
    expect(reopenedAgain?.settings.leadVocalSeparated).toBe(true)
    expect(canResplitVocals(null, false, reopenedAgain?.settings.leadVocalSeparated === true)).toBe(false)
    expect(await readFile(join(dir, 'stems', 'vocals.wav'))).toEqual(bytes)
  })

  it('rejects arbitrary replacement files and leaves the old vocal intact', async () => {
    const dir = await project()
    const result = await saveProject(join(dir, 'song.mp3'), 'Lead test', {
      transpose: 0, tracks: {}, pendingLeadVocal: join(dir, 'song.mp3')
    })
    expect(result.ok).toBe(false)
    expect(await readFile(join(dir, 'stems', 'vocals.flac'), 'utf8')).toBe('old-combined-vocal')
  })
})
