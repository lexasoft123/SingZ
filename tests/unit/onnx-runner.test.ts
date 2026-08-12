import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ONNX_RUNNER_PY } from '../../src/main/dml-shim'
import { onnxSpawnEnv } from '../../src/main/separation'

// v0.14.1-test2 shipped a fusion-off retry whose env flag never left the
// parent process — the field run repeated the fused attempt byte for byte.
// Pin the attempt→env wiring, not just the runner's own behavior.
describe('onnxSpawnEnv', () => {
  it('carries the fusion flag only for no-fusion attempts', () => {
    expect(onnxSpawnEnv({ noFusion: true }).SINGZ_DML_NO_FUSION).toBe('1')
    expect(onnxSpawnEnv({}).SINGZ_DML_NO_FUSION).toBeUndefined()
    expect(onnxSpawnEnv({}).HF_HUB_OFFLINE).toBe('1')
    expect(onnxSpawnEnv({}).PYTHONUTF8).toBe('1')
  })
})

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

  it('turns fusion off when spawned with the no-fusion attempt env', () => {
    const stub = join(dir, 'stub2')
    mkdirSync(join(stub, 'demucs_onnx'), { recursive: true })
    writeFileSync(join(stub, 'demucs_onnx', '__init__.py'), '')
    writeFileSync(join(stub, 'demucs_onnx', 'cli.py'), 'def main(argv=None):\n    return 0\n')
    const r = spawnSync(
      py as string,
      [runner, 'separate', 'in.wav', 'out', '--providers', 'dml', '-v'],
      {
        env: { ...onnxSpawnEnv({ noFusion: true }), PYTHONPATH: stub },
        encoding: 'utf8',
        timeout: 30_000
      }
    )
    // The runner's DML patching is win32-gated; elsewhere this only proves
    // the spawn env + runner combination doesn't break the chain.
    if (process.platform === 'win32') {
      expect(r.stdout).toContain('graph fusion off')
    }
    expect(r.status).toBe(0)
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
