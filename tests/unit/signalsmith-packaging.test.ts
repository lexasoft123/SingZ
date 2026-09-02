import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repo = resolve(__dirname, '../..')
const read = (relative: string): string =>
  readFileSync(resolve(repo, relative), 'utf8')

describe('Signalsmith desktop packaging', () => {
  it('ships both pinned MIT notices outside the asar on macOS and Windows', () => {
    const builder = read('electron-builder.yml')
    const provenance = read('third_party/native/signalsmith/VENDORED.txt')
    const stretch = read('third_party/native/signalsmith/LICENSE-stretch.txt')
    const linear = read('third_party/native/signalsmith/LICENSE-linear.txt')
    expect(builder.match(/open-source-notices\/signalsmith/g)).toHaveLength(2)
    for (const name of [
      'VENDORED.txt',
      'LICENSE-stretch.txt',
      'LICENSE-linear.txt',
    ]) {
      expect(builder.match(new RegExp(name, 'g'))).toHaveLength(2)
    }
    expect(provenance).toContain('signalsmith-stretch')
    expect(provenance).toContain('signalsmith-linear')
    expect(stretch).toContain('MIT License')
    expect(linear).toContain('MIT License')
  })

  it('keeps loop replenishment wake machinery off the audio callback', () => {
    const source = read('native/playback/signalsmith_time_pitch.cpp')
    expect(source).not.toMatch(/loopConsumptionEpoch\.(?:wait|notify)/)
    expect(source).toContain('workerWake.wait_for')
    expect(source.match(/workerWake\.notify_(?:one|all)/g)).toEqual([
      'workerWake.notify_all',
    ])
    expect(source).toContain(
      'state->loopConsumptionEpoch.fetch_add(1u, std::memory_order_release)',
    )
  })
})
