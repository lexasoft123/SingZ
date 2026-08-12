import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ONNX_RUNNER_PY } from '../../src/main/onnx-runner'
import { onnxSpawnEnv } from '../../src/main/separation'

// A test build once shipped an attempt flag that never left the parent
// process — pin what the child actually sees, not just runner behavior.
describe('onnxSpawnEnv', () => {
  it('carries the pack invariants', () => {
    expect(onnxSpawnEnv().HF_HUB_OFFLINE).toBe('1')
    expect(onnxSpawnEnv().PYTHONUTF8).toBe('1')
    expect(onnxSpawnEnv().PYTHONUNBUFFERED).toBe('1')
  })
})

// The runner is Python written from a TS string — nothing else executes it
// before a field machine does, and on a release build the log is the only
// evidence there is.
function python(): string | null {
  for (const cmd of ['python3', 'python']) {
    const r = spawnSync(cmd, ['--version'], { timeout: 10_000 })
    if (r.status === 0) return cmd
  }
  return null
}

const py = python()

describe.skipIf(!py)('onnx runner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'singz-onnx-runner-'))
  const runner = join(dir, 'onnx-runner.py')
  writeFileSync(runner, ONNX_RUNNER_PY, 'utf8')

  it('exits 3 on a trtrtx attempt when the pack has no rtx payload', () => {
    // sys.executable's dir stands in for the pack python dir — no rtx/ there,
    // so the runner must bail cleanly for the app ladder to move on. The
    // check is win32-gated like the rest of the GPU path.
    const r = spawnSync(
      py as string,
      [runner, 'separate', 'in.wav', 'out', '--providers', 'trtrtx', '-v'],
      { env: { ...process.env }, encoding: 'utf8', timeout: 30_000 }
    )
    if (process.platform === 'win32') {
      expect(r.stdout).toContain('TensorRT RTX payload missing')
      expect(r.status).toBe(3)
    }
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
      { env: { ...onnxSpawnEnv(), PYTHONPATH: stub }, encoding: 'utf8', timeout: 30_000 }
    )
    expect(r.stdout).toContain('STUB:separate|in.wav|out|--providers|cpu|-v')
    expect(r.status).toBe(7)
  })
})
