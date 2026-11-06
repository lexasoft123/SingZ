import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    writeFileSync(join(stub, 'demucs_onnx', 'inference.py'), 'def _make_session(*args): return None\n')
    writeFileSync(join(stub, 'onnxruntime.py'), '')
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

  function arm64Probe(body: string): unknown {
    const script = `
import builtins, io, json, os, platform, runpy, sys, types
scope = runpy.run_path(sys.argv[1], run_name="runner_test")
sys.platform = "linux"
platform.machine = lambda: "aarch64"
affinity = []
os.sched_getaffinity = lambda pid: {2, 4, 5, 6, 7}
os.sched_setaffinity = lambda pid, cpus: affinity.append(sorted(cpus))
def read_capacity(path, *args, **kwargs):
    cpu = int(str(path).split("/")[5][3:])
    return io.StringIO("512" if cpu == 2 else "1024")
builtins.open = read_capacity
class Options:
    def __init__(self): self.config = {}
    def add_session_config_entry(self, key, value): self.config[key] = value
sessions = []
def session(path, **kwargs):
    sessions.append(kwargs)
    return "cpu-session"
ort = types.ModuleType("onnxruntime")
ort.SessionOptions = Options
ort.GraphOptimizationLevel = types.SimpleNamespace(ORT_ENABLE_ALL=99)
ort.InferenceSession = session
sys.modules["onnxruntime"] = ort
inference = types.ModuleType("demucs_onnx.inference")
inference._make_session = lambda path, providers: "original-session"
package = types.ModuleType("demucs_onnx")
package.inference = inference
sys.modules["demucs_onnx"] = package
sys.modules["demucs_onnx.inference"] = inference
${body}
`
    const result = spawnSync(py as string, ['-c', script, runner], {
      encoding: 'utf8', timeout: 30_000
    })
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    return JSON.parse(result.stdout.trim().split('\n').at(-1) as string)
  }

  it('pins ARM CPU sessions to available big cores and bounds memory', () => {
    expect(arm64Probe(`
scope["setup_arm64_cpu"]()
first = inference._make_session("model", ["CPUExecutionProvider"])
# A second session must retain the original allowed core set after main pinning.
os.sched_getaffinity = lambda pid: {4}
inference._make_session("model2", ["CPUExecutionProvider"])
options = sessions[-1]["sess_options"]
print(json.dumps([first, affinity, options.__dict__, sessions[-1]["providers"]]))
`)).toEqual(['cpu-session', [[4], [4]], {
      config: { 'session.intra_op_thread_affinities': '6;7;8' },
      graph_optimization_level: 99, intra_op_num_threads: 4, inter_op_num_threads: 1,
      enable_cpu_mem_arena: false, enable_mem_pattern: false
    }, ['CPUExecutionProvider']])
  })

  it('keeps GPU providers on the original factory without pinning', () => {
    expect(arm64Probe(`
scope["setup_arm64_cpu"]()
result = inference._make_session("model", ["CUDAExecutionProvider", "CPUExecutionProvider"])
print(json.dumps([result, affinity, sessions]))
`)).toEqual(['original-session', [], []])
  })

  it('falls back to bounded scheduler-managed threads when topology is absent', () => {
    expect(arm64Probe(`
def unavailable(*args, **kwargs): raise OSError("no sysfs")
builtins.open = unavailable
scope["setup_arm64_cpu"]()
inference._make_session("model", ["CPUExecutionProvider"])
options = sessions[0]["sess_options"]
print(json.dumps([affinity, options.intra_op_num_threads, options.config]))
`)).toEqual([[], 4, {}])
  })

  it('uses the frequency fallback and respects a restricted CPU mask', () => {
    expect(arm64Probe(`
os.sched_getaffinity = lambda pid: {2, 6}
def frequency(path, *args, **kwargs):
    if str(path).endswith("cpu_capacity"): raise OSError("unsupported")
    return io.StringIO("1800000" if "/cpu2/" in str(path) else "2400000")
builtins.open = frequency
scope["setup_arm64_cpu"]()
inference._make_session("model", ["CPUExecutionProvider"])
options = sessions[0]["sess_options"]
print(json.dumps([affinity, options.intra_op_num_threads, options.config]))
`)).toEqual([[[6]], 1, {}])
  })

  it('leaves non-ARM session factories unchanged', () => {
    expect(arm64Probe(`
platform.machine = lambda: "x86_64"
scope["setup_arm64_cpu"]()
print(json.dumps([inference._make_session("model", ["CPUExecutionProvider"]), affinity, sessions]))
`)).toEqual(['original-session', [], []])
  })

  it('keeps CPU inference usable when affinity is denied', () => {
    expect(arm64Probe(`
def denied(*args, **kwargs): raise OSError("permission denied")
os.sched_setaffinity = denied
scope["setup_arm64_cpu"]()
inference._make_session("model", ["CPUExecutionProvider"])
options = sessions[0]["sess_options"]
print(json.dumps([options.intra_op_num_threads, options.config, options.enable_cpu_mem_arena]))
`)).toEqual([4, {}, false])
  })
})

// Execute the production target guard: ARM must receive the graph that passed
// the existing checksum/parity gate, without changing other Linux/macOS packs.
describe.skipIf(process.platform === 'win32')('slim model packaging', () => {
  it.each([
    ['win32-x64', true], ['linux-arm64', true], ['linux-x64', false],
    ['darwin-arm64', false], ['darwin-x64', false]
  ] as const)('selects %s correctly', (target, selected) => {
    const pack = readFileSync(join(process.cwd(), 'scripts/build-onnx-pack.sh'), 'utf8')
    const guard = pack.match(/^if .*; then\n  MODEL_FILE=/m)?.[0].split('\n')[0]
    expect(guard).toBeDefined()
    const result = spawnSync('bash', ['-c', `${guard}\n echo selected\nfi`], {
      env: { ...process.env, TARGET: target }, encoding: 'utf8'
    })
    expect(result.status).toBe(0)
    expect(result.stdout.trim() === 'selected').toBe(selected)
  })
})
