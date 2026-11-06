import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const runner = new URL('../../scripts/vocal_split_runner.py', import.meta.url)
const source = readFileSync(runner, 'utf8')
const python = ['python3', 'python'].find(cmd => spawnSync(cmd, ['--version']).status === 0)

// Execute main through session construction with stdlib-only dependency stubs.
// This checks the options actually passed to ORT, including the platform gate,
// without requiring NumPy, weights, or an installed inference pack.
function probe(program: string, system: string, machine: string, threads: number): unknown {
  const result = spawnSync(python as string, ['-c', `
import hashlib, json, platform, sys, tempfile, types
from pathlib import Path
class Array:
    shape = (10, 2)
    def astype(self, dtype): return self
numpy = types.ModuleType('numpy')
numpy.hanning = lambda size: Array()
Array.__getitem__ = lambda self, key: self
numpy.float32 = 'float32'
sys.modules['numpy'] = numpy
soundfile = types.ModuleType('soundfile')
soundfile.read = lambda *args, **kwargs: (Array(), 44100)
sys.modules['soundfile'] = soundfile
class Options:
    def __init__(self):
        self.enable_cpu_mem_arena = True
        self.enable_mem_pattern = True
    def add_free_dimension_override_by_name(self, *args): pass
class Captured(BaseException): pass
captured = []
def session(model, sess_options, providers):
    captured.append([sess_options.__dict__, providers])
    raise Captured()
ort = types.ModuleType('onnxruntime')
ort.SessionOptions = Options
ort.InferenceSession = session
ort.get_available_providers = lambda: ['CPUExecutionProvider', 'CoreMLExecutionProvider']
sys.modules['onnxruntime'] = ort
scope = {'__name__': 'runner_test'}
exec(compile(sys.stdin.read(), 'vocal_split_runner.py', 'exec'), scope)
sys.platform = sys.argv[1]
machine = sys.argv[2]
platform.machine = lambda: machine
with tempfile.TemporaryDirectory() as directory:
    model = Path(directory) / 'model.onnx'
    model.write_bytes(b'')
    scope['MODEL_SHA256'] = hashlib.sha256(b'').hexdigest()
    sys.argv = ['runner', '--model', str(model), '--input', 'in.wav', '--output', 'out', '--threads', sys.argv[3]]
    try: scope['main']()
    except Captured: pass
print(json.dumps(captured))
`, system, machine, String(threads)], { input: program, encoding: 'utf8', timeout: 30_000 })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout)
}

describe.skipIf(!python)('vocal runner session memory', () => {
  it.each(['aarch64', 'arm64'])('reduces Linux %s CPU memory without changing threads', machine => {
    expect(probe(source, 'linux', machine, 4)).toEqual([[{
      enable_cpu_mem_arena: false, enable_mem_pattern: false,
      intra_op_num_threads: 4, inter_op_num_threads: 1
    }, ['CPUExecutionProvider']]])
  })

  it.each([
    ['linux', 'x86_64', 12, 8], ['win32', 'arm64', 0, 1], ['darwin', 'x86_64', 4, 4]
  ] as const)('preserves %s %s memory defaults and thread limits', (system, machine, requested, threads) => {
    expect(probe(source, system, machine, requested)).toEqual([[{
      enable_cpu_mem_arena: true, enable_mem_pattern: true,
      intra_op_num_threads: threads, inter_op_num_threads: 1
    }, ['CPUExecutionProvider']]])
  })

  it('preserves Apple Silicon CoreML options', () => {
    expect(probe(source, 'darwin', 'arm64', 4)).toEqual([[{
      enable_cpu_mem_arena: true, enable_mem_pattern: true,
      intra_op_num_threads: 4, inter_op_num_threads: 1
    }, [['CoreMLExecutionProvider', {
      ModelFormat: 'MLProgram', MLComputeUnits: 'ALL', RequireStaticInputShapes: '1'
    }], 'CPUExecutionProvider']]])
  })

  it('detects a deliberately disabled memory optimization', () => {
    const oldBehavior = source.replace('opts.enable_cpu_mem_arena = False', 'opts.enable_cpu_mem_arena = True')
    expect(oldBehavior).not.toBe(source)
    expect(probe(oldBehavior, 'linux', 'aarch64', 4)).not.toEqual(probe(source, 'linux', 'aarch64', 4))
  })
})
