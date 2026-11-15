import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { UnavailableCustomTracks } from '../../src/renderer/src/unavailable-custom-tracks'

const unavailable = { id: 'custom-guide', label: 'Guide', color: '#123456', file: '/song/stems/custom-guide.m4a' }
const playable = { id: 'custom-click', label: 'Click', color: '#abcdef', file: '/song/stems/custom-click.wav' }

describe('unavailable custom track ownership', () => {
  it('carries rejected definitions across stem and vocal splits, but never into another song', () => {
    const retained = new UnavailableCustomTracks()
    retained.reset(1)
    retained.retain(1, [unavailable, playable], [unavailable.id])
    retained.advance(1, 2)
    retained.advance(2, 3)
    expect(retained.forSave(3, [playable])).toEqual([unavailable, playable])
    expect(retained.forSave(2, [])).toEqual([])
    retained.reset(4)
    retained.retain(3, [unavailable], [unavailable.id]) // Late result from the old song.
    expect(retained.forSave(4, [playable])).toEqual([playable])
  })

  it('reanchors retained paths after save, import or rename', () => {
    const retained = new UnavailableCustomTracks()
    retained.reset(1)
    retained.retain(1, [unavailable], [unavailable.id])
    const moved = { ...unavailable, file: '/renamed/stems/custom-guide.m4a' }
    retained.reanchor(1, [moved])
    retained.reanchor(0, [unavailable])
    expect(retained.forSave(1, [])).toEqual([moved])
  })

  it('keeps playable edits and does not resurrect a removed playable lane', () => {
    const retained = new UnavailableCustomTracks()
    retained.reset(1)
    retained.retain(1, [unavailable, playable], [unavailable.id])
    expect(retained.forSave(1, [])).toEqual([unavailable])
    const edited = { ...unavailable, label: 'Restored guide' }
    expect(retained.forSave(1, [edited])).toEqual([edited])
  })

  it('wires initial load, split commit and save to the same generation-bound retention', () => {
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8')
    const open = app.slice(app.indexOf('const seq = ++loadSeq.current'), app.indexOf('/** Re-apply a project'))
    expect(open).toContain('unavailableCustom.current.reset(seq)')
    expect(open).toContain('unavailableCustom.current.retain(seq, defs,')
    const split = app.slice(app.indexOf('// Commit synchronously after the final cancellation check.'), app.indexOf('melodyWorkerRef.current?.terminate()', app.indexOf('// Commit synchronously after the final cancellation check.')))
    expect(split).toContain('unavailableCustom.current.advance(run.seq, loadSeq.current + 1)')
    expect(split).toContain('unavailableCustom.current.retain(run.seq, kept.map(')
    expect(split).toContain('optional.errors.keys()')
    const save = app.slice(app.indexOf('const handleSaveProject ='), app.indexOf('const res = await window.singz.saveProject(song.path'))
    expect(save).toContain('custom: unavailableCustom.current.forSave(seq, tracks')
  })
})
