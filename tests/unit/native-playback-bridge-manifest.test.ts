import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import manifest from '../shared/native-playback-bridge-manifest.json'
import {
  addonExportNames,
  addonObjectKeys,
  interfaceKeys,
  switchStringTable
} from '../shared/native-playback-bridge-sources'
import { parseNativePlaybackSession } from '../../mobile/src/playback/native'

// The desktop half of the bridge contract, pinned against
// tests/shared/native-playback-bridge-manifest.json — the same file the two
// mobile packaging suites and the native contract ctest read. The phones' half
// lives in mobile/__tests__/; what is here is everything only this root can
// see: the Electron addon's own sources, the IPC and preload wiring, and
// DesktopPlaybackStatus.
//
// Why a manifest rather than a list per suite: this file used to carry 31
// projected status keys typed out by hand in capture-addon-build.test.ts, and
// the Android packaging suite carried its own shorter list. Neither could see
// the other, so a key added to one bridge and forgotten on another passed
// both. See docs/NATIVE-PLAYBACK-BRIDGE.md.

const root = process.cwd()
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n')

const addon = read('native/electron/playback_addon_bridge.cpp')
const types = read('src/shared/types.ts')
const main = read('src/main/index.ts')
const preload = read('src/preload/index.ts')
const capture = read('src/main/capture.ts')

describe('desktop playback addon exports', () => {
  it('exports exactly the manifest names, in order', () => {
    expect(addonExportNames(addon)).toEqual(manifest.methods.desktopAddon.map(m => m.name))
  })

  it('binds each live export to the IPC channel and preload method the manifest names', () => {
    for (const method of manifest.methods.desktopAddon) {
      if (method.dormant) continue
      expect(method.ipc).not.toBeNull()
      expect(method.preload).not.toBeNull()
      expect(main).toContain(`'${method.ipc}'`)
      // Paired, not three separate contains-checks: those pass just as well
      // when a preload method invokes some OTHER method's channel. The
      // continuation is one wrapped line, never a whole entry, so the match
      // cannot slide into the next method's invoke.
      const quote = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const wiring = new RegExp(
        `${quote(method.preload as string)}:[^\\n]*(?:\\n\\s*)?ipcRenderer\\.invoke\\('${quote(
          method.ipc as string
        )}'`
      )
      expect(preload).toMatch(wiring)
    }
  })

  // capture.ts checks the addon it loaded really exports what it is about to
  // call. That list was the third hand-kept copy of these names; it answers to
  // the manifest now like the other two.
  it('requires exactly the live exports in the binding guard', () => {
    for (const method of manifest.methods.desktopAddon) {
      if (method.dormant) continue
      expect(capture).toContain(`'${method.name}'`)
    }
  })

  // An export with no caller is indistinguishable from one whose caller was
  // deleted by accident, so the two dormant ones are pinned as dormant rather
  // than left unmentioned. If either is ever wired up, this is the test that
  // says the manifest and the contract document are now out of date.
  it('leaves the two dormant exports unreachable from the renderer', () => {
    const dormant = manifest.methods.desktopAddon.filter(m => m.dormant).map(m => m.name)
    expect(dormant).toEqual(['unloadPlaybackRetainingLanes', 'playbackLanePeaks'])
    for (const name of dormant) {
      expect(main).not.toContain(name)
      expect(preload).not.toContain(name)
      expect(capture).not.toContain(name)
    }
  })
})

describe('desktop playback status', () => {
  const emitted = addonObjectKeys(addon, 'napi_value playbackStatus(', 'result')

  it('emits exactly the manifest key set', () => {
    expect(emitted).toEqual(manifest.session.desktop.keys)
  })

  // The gap this closes: every one of the eight names below was emitted by the
  // addon and declared by nothing, so the renderer could not read a value the
  // bridge was already sending. Set equality is the pin — a subset check would
  // have passed throughout.
  it('declares in DesktopPlaybackStatus exactly what the addon emits', () => {
    const declared = interfaceKeys(types, 'DesktopPlaybackStatus')
    expect([...declared].sort()).toEqual([...emitted].sort())
  })

  it('nests format, latency and lanes as the manifest describes', () => {
    expect(addonObjectKeys(addon, 'void setFormat(', 'value')).toEqual(
      manifest.session.desktop.nested.format
    )
    expect(addonObjectKeys(addon, 'void setLatency(', 'value')).toEqual(
      manifest.session.desktop.nested.latency
    )
    expect(addonObjectKeys(addon, 'napi_value playbackStatus(', 'lane')).toEqual(
      manifest.session.desktop.nested.lanes
    )
  })

  it('carries every phone session key, relocating only the four the manifest lists', () => {
    const renamed = new Map(
      manifest.desktopRenames
        .filter(rename => rename.object === 'session')
        .map(rename => [rename.phone, rename.desktop])
    )
    for (const key of manifest.session.common) {
      if (emitted.includes(key)) continue
      const relocated = manifest.session.desktop.underFormat.includes(key)
      expect(relocated || renamed.has(key), `${key} is neither emitted, relocated nor renamed`).toBe(
        true
      )
      if (!relocated) expect(emitted).toContain(renamed.get(key))
    }
  })
})

describe('desktop result, receipt and peaks', () => {
  it('renames the two result fields the manifest records', () => {
    const result = addonObjectKeys(addon, 'napi_value resultValue(', 'result')
    expect(result).toEqual(manifest.result.desktop)
    for (const rename of manifest.desktopRenames.filter(r => r.object === 'result')) {
      expect(result).toContain(rename.desktop)
      expect(manifest.result.phone).toContain(rename.phone)
    }
    // The swap is the trap: `error` exists on both objects meaning different
    // things — the enum name on the desktop, the free text on the phones.
    expect(manifest.result.phone).toContain('error')
    expect(manifest.result.desktop).toContain('error')
    expect(manifest.result.phone).toContain('message')
    expect(manifest.result.desktop).not.toContain('message')
    expect(manifest.result.phone).not.toContain('errorCode')
  })

  it('flattens the cleanup receipt to the four keys the manifest lists', () => {
    expect(addonObjectKeys(addon, 'napi_value unloadPlaybackWithRetention(', 'result')).toEqual(
      manifest.cleanup.desktop
    )
    expect(manifest.cleanup.desktop.length).toBeLessThan(manifest.cleanup.phone.length)
    expect(manifest.cleanup.phone).toContain('globallyComplete')
    expect(manifest.cleanup.desktop).toContain('cleanupComplete')
  })

  it('agrees with the phones on the lanePeaks shape', () => {
    expect(addonObjectKeys(addon, 'napi_value playbackLanePeaks(', 'result')).toEqual(
      manifest.lanePeaks.keys
    )
    expect(addonObjectKeys(addon, 'napi_value playbackLanePeaks(', 'lane')).toEqual(
      manifest.lanePeaks.lane
    )
  })
})

describe('desktop enum tables', () => {
  const tables: [string, string][] = [
    ['playbackState', 'const char *playbackStateName('],
    ['hostState', 'const char *hostStateName('],
    ['terminalReason', 'const char *terminalReasonName('],
    ['transportState', 'const char *transportStateName('],
    ['transportTelemetryQuality', 'const char *telemetryQualityName('],
    ['transportBoundaryReason', 'const char *boundaryName('],
    ['audibleProjectionQuality', 'const char *audibleProjectionQualityName('],
    ['graphNodeRole', 'const char *graphNodeRoleName('],
    ['graphNodeKind', 'const char *graphNodeKindName(']
  ]

  for (const [name, signature] of tables) {
    it(`${name} matches the manifest, fallthrough included`, () => {
      const entry = (manifest.enums as Record<string, Record<string, unknown>>)[name]
      const declared = entry.desktop as { strings: string[]; fallback: string | null }
      const extracted = switchStringTable(addon, signature)
      expect(extracted.cases).toEqual(declared.strings)
      expect(extracted.fallback).toEqual(declared.fallback)
    })
  }

  // Not a formality. The desktop falls through to `quarantined` where both
  // phones fall through to `terminal`, and one platform reporting a different
  // state for the same unknown enumerator is exactly the kind of thing that
  // gets diagnosed as a core bug.
  it('keeps the desktop playback-state fallthrough distinct from the phones', () => {
    expect(manifest.enums.playbackState.desktop.fallback).toBe('quarantined')
    expect(manifest.enums.playbackState.ios.fallback).toBe('terminal')
    expect(manifest.enums.playbackState.android.fallback).toBe('terminal')
  })
})

// The behavioural half: the phone parser really does yield the manifest's key
// set, not merely a superset of it. Source extraction alone cannot say this —
// a bridge could emit a key the parser silently drops, which is what the six
// leniently-read keys nearly were.
describe('the phone session parser', () => {
  const session = (): Record<string, unknown> => {
    const value: Record<string, unknown> = {}
    for (const key of manifest.session.common) value[key] = 0
    Object.assign(value, {
      state: 'running',
      hostState: 'running',
      terminalReason: 'none',
      transportState: 'playing',
      transportTelemetryQuality: 'current',
      lastTransportBoundary: 'none',
      audibleProjectionQuality: 'current',
      loopEnabled: false,
      trainingEnabled: false,
      timePitchReplacementReady: false,
      timePitchLoopPriming: false,
      trainingLanes: [],
      laneDecodeFallback: '',
      topology: 'source',
      message: '',
      playbackRate: 1,
      sampleRate: 48000,
      lanes: [],
      latency: {
        outputDeviceFrames: 0,
        bufferFrames: 0,
        externalRouteFrames: 0,
        presentationFrames: 0
      }
    })
    return value
  }

  it('returns every emitted key except the two nothing parses', () => {
    const parsed = parseNativePlaybackSession(session())
    expect(parsed).not.toBeNull()
    const expected = manifest.session.common.filter(
      key => !(manifest.session.unparsed as string[]).includes(key)
    )
    expect(Object.keys(parsed as object).sort()).toEqual([...expected].sort())
  })

  // 69 strict + 6 lenient + 2 unparsed = the 77 both phones emit. Deleting one
  // key at a time is the only way to tell those three groups apart from the
  // outside, and getting the split wrong in either direction is a real bug:
  // a strict key gone lenient loses a whole class of drift silently, and a
  // lenient key gone strict blanks the transport whenever a JS bundle runs
  // ahead of the binary under it.
  it('sorts every emitted key into strict, lenient or unparsed as the manifest says', () => {
    const lenient = new Set([
      ...(manifest.session.lenient as string[]),
      ...(manifest.session.unparsed as string[])
    ])
    expect(manifest.session.common.length - lenient.size).toBe(69)
    for (const key of manifest.session.common) {
      const value = session()
      delete value[key]
      const parsed = parseNativePlaybackSession(value)
      if (lenient.has(key)) expect(parsed, `${key} is documented lenient`).not.toBeNull()
      else expect(parsed, `${key} is documented strict`).toBeNull()
    }
  })
})
