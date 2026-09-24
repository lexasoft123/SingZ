import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import TrackLane from '../../src/renderer/src/components/TrackLane'
import { TRACK_META, type UITrack } from '../../src/renderer/src/model'

/**
 * A lane is two grid cells with nothing around them — the controls and the
 * waveform are siblings — so a CSS variable reaches only the cell it is set
 * on. The kit's waveform halo is drawn in `var(--stem, #fff)` from the two
 * canvases inside `.lane-wave`, and --stem sat on `.lane-controls` alone:
 * from 2026-08-04 every lane's halo was the white fallback, under two commits
 * that described it as the stem's own colour, until it was measured in the
 * running app. Rendered markup, because the variable is either on the
 * waveform's cell or it is not.
 */

type Props = Parameters<typeof TrackLane>[0]

function lane(over: Partial<Props> = {}, trackOver: Partial<UITrack> = {}): string {
  const track: UITrack = {
    id: 'bass',
    label: TRACK_META.bass.label,
    color: TRACK_META.bass.color,
    peaks: new Float32Array(64),
    duration: 30,
    scale: 1,
    muted: false,
    solo: false,
    volume: 1,
    ...trackOver
  }
  return renderToStaticMarkup(
    createElement(TrackLane, {
      track,
      buffer: null,
      dimmed: false,
      ducked: false,
      onMute: () => {},
      onSolo: () => {},
      onVolume: () => {},
      showSolo: true,
      index: 2,
      viewStart: 0,
      viewEnd: 30,
      ...over
    })
  )
}

/** The --stem on the opening tag of the cell with this class, if any. */
function stemOf(html: string, cell: string): string | null {
  const tag = html.match(new RegExp(`<div[^>]*\\bclass="${cell}(?: [^"]*)?"[^>]*>`))?.[0]
  return tag?.match(/--stem:([^;"]+)/)?.[1] ?? null
}

describe("a lane's colour reaches its waveform", () => {
  it('puts --stem on the waveform cell, where the halo reads it, as well as the controls', () => {
    const html = lane()
    expect(stemOf(html, 'lane-controls')).toBe(TRACK_META.bass.color)
    expect(stemOf(html, 'lane-wave')).toBe(TRACK_META.bass.color)
  })

  it('keeps it there on a muted, dimmed or ducked lane', () => {
    for (const html of [lane({}, { muted: true }), lane({ dimmed: true }), lane({ ducked: true })]) {
      expect(html).toMatch(/class="lane-wave (is-off|is-ducked)/)
      expect(stemOf(html, 'lane-wave')).toBe(TRACK_META.bass.color)
    }
  })
})
