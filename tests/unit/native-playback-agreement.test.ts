import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import cases from '../shared/native-playback-agreement-cases.json'
import { functionBody } from '../shared/native-playback-bridge-sources'
import {
  MAX_NATIVE_GRAPH_CONNECTIONS,
  MAX_NATIVE_GRAPH_NODES,
  MAX_NATIVE_GRAPH_PARAMETERS_PER_NODE,
  MAX_NATIVE_GRAPH_PORTS_PER_NODE,
  synthesizedNativeGraphNodeCount
} from '../../src/shared/graph-document'
import {
  DESKTOP_PLAYBACK_GRAPH_MAX_BUSES,
  DESKTOP_PLAYBACK_GRAPH_MAX_CONNECTIONS,
  DESKTOP_PLAYBACK_GRAPH_MAX_NODES
} from '../../src/shared/types'

// The TypeScript half of tests/shared/native-playback-agreement-cases.json.
// tests/native/native_playback_contract_tests.cpp reads the same file, but not
// all of it: it puts scalarBounds, codecBitValues, graphNodeCount and
// admissibleMeters to the core, and cannot reach loopFold or atEnd, which live
// inside a render callback and a park decision respectively. For those two the
// `core` column is pinned by the OPERATOR in its source rather than by
// execution — worth knowing before trusting a green run here to mean the core
// was asked.
//
// Neither side may edit a row to make itself pass. A row whose two columns
// differ is a DOCUMENTED divergence, listed in
// docs/NATIVE-PLAYBACK-BRIDGE.md section 11, and closing one is its own change
// with its own reasoning.

const root = process.cwd()
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n')

it('is the fixture both runners read', () => {
  expect(cases.version).toBe(1)
  for (const group of ['graphNodeCount', 'atEnd', 'codecBits', 'scalarBounds'])
    expect((cases as Record<string, unknown[]>)[group].length).toBeGreaterThan(0)
  expect(cases.loopFold.rows.length).toBeGreaterThan(0)
})

describe('the synthesized graph node count', () => {
  for (const row of cases.graphNodeCount) {
    it(row.name, () => {
      const predicted = synthesizedNativeGraphNodeCount({
        laneCount: row.laneCount,
        trainingLaneCount: row.trainingLaneCount,
        hasReference: row.hasReference,
        needsTimePitch: row.needsTimePitch
      })
      if (row.agreement === 'tsOnly') {
        // TypeScript refuses an input the core cannot even express: it derives
        // the training count by counting lanes, so "more training lanes than
        // lanes" has no representation there. Infinity fails the cap check,
        // which is the point — the request never reaches a bridge.
        expect(predicted).toBe(Number.POSITIVE_INFINITY)
        return
      }
      expect(predicted).toBe(row.expected)
    })
  }

  // A row past the cap has to exist, or the fixture only ever exercises graphs
  // that were always going to be admitted.
  it('carries a case the shared 128-node cap would refuse', () => {
    const over = cases.graphNodeCount.filter(row => row.expected > MAX_NATIVE_GRAPH_NODES)
    expect(over.length).toBeGreaterThan(0)
  })
})

describe('the codec bit table', () => {
  // Read out of the switch rather than restated here. The same nine bits are
  // asserted against zcore/include/zcore/media/decoded_audio.h by the native
  // contract test, so the two tables agree by construction rather than by
  // somebody remembering to update both.
  const supports = (formatMask: number, extension: string): boolean => {
    const body = functionBody(
      read('mobile/src/playback/native.ts'),
      'function codecSupportsExtension('
    )
    const arms = [...body.matchAll(/((?:case '[a-z0-9]+':\s*)+)return ([^;]+);/g)]
    for (const arm of arms) {
      const names = [...arm[1].matchAll(/case '([a-z0-9]+)':/g)].map(match => match[1])
      if (!names.includes(extension)) continue
      const exact = /\(formatMask & (0x[0-9a-f]+)\) === (0x[0-9a-f]+)/.exec(arm[2])
      if (exact !== null)
        return (formatMask & Number(exact[1])) === Number(exact[2])
      const any = /\(formatMask & (0x[0-9a-f]+)\) !== 0/.exec(arm[2])
      if (any !== null) return (formatMask & Number(any[1])) !== 0
      throw new Error(`unreadable codec arm: ${arm[2]}`)
    }
    return false
  }

  for (const row of cases.codecBits) {
    it(row.name, () => {
      expect(supports(row.formatMask, row.extension)).toBe(row.supported)
    })
  }

  it('needs both m4a bits, never one', () => {
    const bits = cases.codecBitValues
    expect(supports(bits.m4aAac, 'm4a')).toBe(false)
    expect(supports(bits.m4aAlac, 'm4a')).toBe(false)
    expect(supports(bits.m4aAac | bits.m4aAlac, 'm4a')).toBe(true)
  })

  it('covers every product bit with the full mask', () => {
    const bits = cases.codecBitValues
    const named = [
      bits.wav,
      bits.flac,
      bits.mp3,
      bits.m4aAac,
      bits.m4aAlac,
      bits.aac,
      bits.oggVorbis,
      bits.oggOpus,
      bits.aiff
    ]
    expect(named.reduce((all, bit) => all | bit, 0)).toBe(bits.productMask)
  })
})

// The loop fold is TWO implementations of one wrap, and they disagree by one
// sample at the loop end. It moved out of backend.ts's projected() when the
// synchronous clock landed — into foldFrame in native.ts, which both the live
// clock and the polled fallback call — but it was not removed, and it still
// folds on `>` where the core wraps on `>=`.
//
// Getting that wrong is how this test earned its shape: an earlier version of
// this file declared the divergence closed on the strength of a grep for the
// old spelling, and guarded the claim with a pattern that could not match the
// new one. So what is pinned here is the OPERATOR in each implementation, read
// from source, and the seam row that separates them.
describe('the loop fold', () => {
  const native = read('mobile/src/playback/native.ts')

  const fold = (row: (typeof cases.loopFold.rows)[number]): number => {
    const span = row.loopEndFrame - row.loopStartFrame
    if (row.positionFrame > row.loopEndFrame)
      return row.loopStartFrame + ((row.positionFrame - row.loopStartFrame) % span)
    return Math.min(row.durationFrames, row.positionFrame)
  }

  it('folds past the loop end in TypeScript and at it in the core', () => {
    // The comparison itself, from the function that actually performs it.
    expect(functionBody(native, 'private foldFrame(')).toContain('if (frame > end)')
    expect(read('native/playback/native_playback_session.cpp')).toContain(
      'callbackProjectFrame >= callbackLoopEnd'
    )
    expect(cases.loopFold.typescriptOperator).toBe('>')
    expect(cases.loopFold.coreOperator).toBe('>=')
  })

  it('runs that fold on both the live clock and the polled fallback', () => {
    // If either path stopped folding, the seam below would stop describing the
    // product even though every row still passed.
    expect(functionBody(native, 'clock(): NativePlaybackClock')).toContain('this.foldFrame(')
    expect(functionBody(native, 'private polledClock()')).toContain('this.foldFrame(')
  })

  for (const row of cases.loopFold.rows) {
    it(row.name, () => {
      expect(fold(row)).toBeCloseTo(row.typescript, 6)
      if (row.agree) expect(row.typescript).toBeCloseTo(row.core, 6)
      else expect(row.typescript).not.toBeCloseTo(row.core, 6)
    })
  }

  // Exactly one row may disagree, and it is the loop end itself. A second one
  // means the two folds have parted somewhere new.
  it('disagrees with the core at the loop end and nowhere else', () => {
    const disagreeing = cases.loopFold.rows.filter(row => !row.agree)
    expect(disagreeing.map(row => row.name)).toEqual(['exactly at the loop end'])
    const [seam] = disagreeing
    expect(seam.positionFrame).toBe(seam.loopEndFrame)
    expect(seam.core).toBe(seam.loopStartFrame)
    expect(seam.typescript).toBe(seam.loopEndFrame)
  })
})

describe('at-end detection', () => {
  const EPSILON = 0.01
  const atEnd = (duration: number, position: number): boolean => position >= duration - EPSILON

  it('keeps the same epsilon in both TypeScript engines while the core is exact', () => {
    expect(read('mobile/src/playback/native.ts')).toContain('durationSec - 0.01')
    expect(read('src/renderer/src/audio/engine.ts')).toContain('this.duration - 0.01')
    expect(read('native/playback/native_playback_session.cpp')).toContain(
      'callbackProjectFrame >= durationFrames'
    )
  })

  for (const row of cases.atEnd) {
    it(row.name, () => {
      expect(atEnd(row.durationSeconds, row.positionSeconds)).toBe(row.typescript)
      expect(row.positionFrame >= row.durationFrames).toBe(row.core)
    })
  }

  it('is generous exactly inside the epsilon and nowhere else', () => {
    for (const row of cases.atEnd) {
      if (row.agree) continue
      expect(row.typescript).toBe(true)
      expect(row.core).toBe(false)
      const short = row.durationSeconds - row.positionSeconds
      expect(short).toBeGreaterThan(0)
      expect(short).toBeLessThanOrEqual(EPSILON)
    }
  })
})

describe('scalar bounds', () => {
  const bound = (name: string): number => {
    const row = cases.scalarBounds.find(entry => entry.name === name)
    if (row === undefined) throw new Error(`no bound named ${name}`)
    return row.value
  }

  it('matches the graph caps TypeScript enforces', () => {
    expect(MAX_NATIVE_GRAPH_NODES).toBe(bound('maximumGraphNodes'))
    expect(MAX_NATIVE_GRAPH_CONNECTIONS).toBe(bound('maximumGraphConnections'))
    expect(MAX_NATIVE_GRAPH_PORTS_PER_NODE).toBe(16)
    expect(MAX_NATIVE_GRAPH_PARAMETERS_PER_NODE).toBe(64)
  })

  it('matches the desktop restatement of the same caps', () => {
    expect(DESKTOP_PLAYBACK_GRAPH_MAX_NODES).toBe(bound('maximumGraphNodes'))
    expect(DESKTOP_PLAYBACK_GRAPH_MAX_CONNECTIONS).toBe(bound('maximumGraphConnections'))
    expect(DESKTOP_PLAYBACK_GRAPH_MAX_BUSES).toBe(MAX_NATIVE_GRAPH_PORTS_PER_NODE)
  })

  it('matches the phone facade constants', () => {
    const facade = read('mobile/src/playback/native.ts')
    expect(facade).toContain(`playbackRate < ${bound('playbackRateMinimum')}`)
    expect(facade).toContain(`playbackRate > ${bound('playbackRateMaximum')}`)
    expect(facade).toContain(`transposeSemitones < ${bound('transposeSemitonesMinimum')}`)
    expect(facade).toContain(`transposeSemitones > ${bound('transposeSemitonesMaximum')}`)
    // The core pins 96 buckets; the facade's MAX_LANE_PEAK_BUCKETS is a much
    // larger defensive stack bound and deliberately NOT the same number, so
    // the two are asserted apart rather than compared.
    expect(bound('laneSummaryBuckets')).toBe(96)
    expect(facade).toContain('MAX_LANE_PEAK_BUCKETS = 4096')
  })
})
