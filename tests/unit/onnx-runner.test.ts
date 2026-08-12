import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ONNX_RUNNER_PY } from '../../src/main/dml-shim'

// The runner is Python written from a TS string — nothing else executes it
// before a field machine does. Probe mode runs the real DXGI enumeration on
// Windows CI (runners expose at least the Basic Render adapter), and the
// stub test pins that argv/exit-code chaining into demucs_onnx stays intact.

function python(): string | null {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['--version'], { timeout: 10_000 })
    if (r.status === 0) return cmd
  }
  return null
}

const py = python()

describe.skipIf(!py)('onnx runner shim', () => {
  const dir = mkdtempSync(join(tmpdir(), 'singz-onnx-runner-'))
  const runner = join(dir, 'onnx-runner.py')
  writeFileSync(runner, ONNX_RUNNER_PY, 'utf8')

  it('probe mode reports adapters as JSON', () => {
    const r = spawnSync(py as string, [runner], {
      env: { ...process.env, SINGZ_DML_PROBE: '1' },
      encoding: 'utf8',
      timeout: 30_000
    })
    expect(r.status).toBe(0)
    const out = JSON.parse(r.stdout) as {
      adapters: Array<{ index: number; description: string; software: boolean }>
      pick: { index: number; software: boolean } | null
    }
    expect(Array.isArray(out.adapters)).toBe(true)
    if (process.platform === 'win32') {
      // Every Windows machine enumerates at least one adapter (CI: WARP/Basic
      // Render) — an empty list here means the ctypes DXGI call broke.
      expect(out.adapters.length).toBeGreaterThan(0)
      for (const a of out.adapters) expect(typeof a.description).toBe('string')
    } else {
      expect(out.adapters).toEqual([])
    }
    if (out.pick) expect(out.pick.software).toBe(false)
  })

  it('chains argv and exit code into demucs_onnx.cli.main', () => {
    const stub = join(dir, 'stub')
    mkdirSync(join(stub, 'demucs_onnx'), { recursive: true })
    writeFileSync(join(stub, 'demucs_onnx', '__init__.py'), '')
    writeFileSync(
      join(stub, 'demucs_onnx', 'cli.py'),
      'import sys\ndef main(argv=None):\n    print("STUB:" + "|".join(sys.argv[1:]))\n    return 7\n'
    )
    const r = spawnSync(
      py as string,
      [runner, 'separate', 'in.wav', 'out', '--providers', 'cpu', '-v'],
      { env: { ...process.env, PYTHONPATH: stub }, encoding: 'utf8', timeout: 30_000 }
    )
    expect(r.stdout).toContain('STUB:separate|in.wav|out|--providers|cpu|-v')
    expect(r.status).toBe(7)
  })
})
