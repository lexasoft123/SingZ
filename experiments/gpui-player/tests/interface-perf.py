#!/usr/bin/env python3
"""Background, silent GPUI interface performance gate. macOS resource counters; stdlib only."""
import argparse
import ctypes
import json
import math
import os
from pathlib import Path
import platform
import plistlib
import queue
import subprocess
import sys
import threading
import time

ROOT = Path(__file__).resolve().parents[1]

class RUsage(ctypes.Structure):
    _fields_ = [('uuid', ctypes.c_ubyte * 16)] + [(name, ctypes.c_uint64) for name in (
        'user_ticks', 'system_ticks', 'idle_wakeups', 'interrupt_wakeups', 'pageins',
        'wired', 'resident', 'footprint', 'started', 'exited')]

class Timebase(ctypes.Structure):
    _fields_ = [('numer', ctypes.c_uint32), ('denom', ctypes.c_uint32)]

def ticks_to_ns(ticks, numer, denom):
    return ticks * numer / denom

def process_usage(pid):
    lib = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
    func = lib.proc_pid_rusage
    func.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
    func.restype = ctypes.c_int
    result = RUsage()
    if func(pid, 0, ctypes.byref(result)) != 0:
        raise OSError(ctypes.get_errno(), 'proc_pid_rusage failed')
    # proc_pid_rusage CPU times are Mach absolute units, not nanoseconds on ARM.
    system = ctypes.CDLL('/usr/lib/libSystem.B.dylib')
    info = Timebase()
    system.mach_timebase_info.argtypes = [ctypes.POINTER(Timebase)]
    if system.mach_timebase_info(ctypes.byref(info)) != 0 or not info.denom:
        raise RuntimeError('mach_timebase_info failed')
    return ticks_to_ns(result.user_ticks + result.system_ticks, info.numer, info.denom), result.footprint

def gpu_usage():
    try:
        output = subprocess.run(['ioreg', '-r', '-c', 'IOAccelerator', '-a'],
                                check=True, capture_output=True, timeout=3).stdout
        devices = []
        def visit(row):
            stats = row.get('PerformanceStatistics', {})
            value = stats.get('Device Utilization %')
            if isinstance(value, (int, float)) and math.isfinite(value):
                devices.append({'device': row.get('IORegistryEntryName', 'GPU'),
                                'percent': value})
            for child in row.get('IORegistryEntryChildren', []):
                visit(child)
        for row in plistlib.loads(output):
            visit(row)
        if not devices:
            return {'available': False, 'reason': 'IOAccelerator exposes no utilization counter'}
        return {'available': True, 'devices': devices}
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        return {'available': False, 'reason': str(error)}

def summarize(values):
    if not values:
        return None
    ordered = sorted(values)
    return {'mean': sum(values) / len(values), 'p95': ordered[math.ceil(.95 * len(ordered))-1],
            'max': max(values), 'samples': len(values)}

def evaluate(windows, resources, min_fps, max_frame_ms, max_cpu):
    failures = []
    if len(windows) < 3:
        failures.append('fewer than three complete post-warmup frame windows')
    for window in windows:
        if not all(math.isfinite(window[key]) and window[key] > 0 for key in ('draw_fps', 'window_ms', 'frame_interval_p95_ms')):
            failures.append('invalid frame telemetry')
            continue
        if window['draw_fps'] < min_fps:
            failures.append(f"draw cadence {window['draw_fps']:.1f} below {min_fps} FPS")
        if window['frame_interval_p95_ms'] > max_frame_ms:
            failures.append(f"frame interval p95 {window['frame_interval_p95_ms']:.1f} above {max_frame_ms} ms")
    if len(resources) < 3:
        failures.append('fewer than three process resource samples')
    if max_cpu is not None and resources:
        measured = summarize([r['process_cpu_percent'] for r in resources])['p95']
        if measured > max_cpu:
            failures.append(f'process CPU p95 {measured:.1f}% above {max_cpu}%')
    return failures

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--binary', type=Path, default=ROOT/'target/debug/singz-gpui-player')
    parser.add_argument('--warmup', type=float, default=5)
    parser.add_argument('--seconds', type=float, default=12)
    parser.add_argument('--min-fps', type=float, default=50)
    parser.add_argument('--max-frame-p95-ms', type=float, default=40)
    parser.add_argument('--max-cpu-percent', type=float)
    parser.add_argument('--out', type=Path, default=Path('/tmp/singz-gpui-interface-perf.json'))
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('this resource sampler requires macOS; do not substitute zero counters')
    if args.seconds < 6 or args.warmup < 0:
        parser.error('measurement needs at least 6 seconds and nonnegative warmup')
    if not args.skip_build:
        subprocess.run(['cargo', 'build', '--locked', '--manifest-path', str(ROOT/'Cargo.toml'), '-j', '4'], check=True)
    effects = []
    events = queue.Queue()
    child = subprocess.Popen([str(args.binary.resolve())], env={**os.environ,
        'SINGZ_GPUI_PROFILE': '1', 'SINGZ_MUTE': '1', 'SINGZ_NO_SYNC': '1',
        'SINGZ_GPUI_BACKGROUND': '1'},
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    def read():
        for line in child.stderr:
            if line.startswith('EFFECT_JSON '):
                try:
                    effects.append(json.loads(line[len('EFFECT_JSON '):]))
                except ValueError:
                    pass
            if line.startswith('PERF_JSON '):
                try:
                    events.put((time.monotonic(), json.loads(line[len('PERF_JSON '):])))
                except ValueError:
                    events.put((time.monotonic(), {'invalid': line.strip()}))
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    windows, resources, failures = [], [], []
    started = time.monotonic()
    measurement_start = started + args.warmup
    deadline = measurement_start + args.seconds
    try:
        time.sleep(args.warmup)
        previous_cpu, _ = process_usage(child.pid)
        previous_time = time.monotonic()
        deadline = previous_time + args.seconds
        while time.monotonic() < deadline:
            time.sleep(min(1, max(0, deadline-time.monotonic())))
            if child.poll() is not None:
                raise RuntimeError(f'player exited during measurement: {child.returncode}')
            cpu, memory = process_usage(child.pid)
            now = time.monotonic()
            resources.append({'elapsed_s': now-started,
                'process_cpu_percent': (cpu-previous_cpu) / ((now-previous_time)*1e9)*100,
                'process_footprint_bytes': memory, 'gpu_system': gpu_usage()})
            previous_cpu, previous_time = cpu, now
    except Exception as error:
        failures.append(str(error))
    finally:
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)
        reader.join(timeout=2)
        child.stderr.close()
    while not events.empty():
        received, record = events.get()
        if 'invalid' in record:
            failures.append('malformed frame telemetry')
        elif received-record['window_ms']/1000 >= measurement_start and received <= deadline:
            windows.append(record)
    if not effects or not any(effect.get('advancing_glow_draws', 0) > 0 for effect in effects):
        failures.append('advancing glyph glow was never painted')
    failures += evaluate(windows, resources, args.min_fps, args.max_frame_p95_ms, args.max_cpu_percent)
    report = {'schema': 1, 'scenario': 'visible six-stem player, silent autoplay, karaoke and glyph glow',
        'platform': platform.platform(), 'machine': platform.machine(), 'pid': child.pid,
        'binary': str(args.binary.resolve()), 'warmup_s': args.warmup, 'measurement_s': args.seconds,
        'definitions': {'fps': 'native UI draw cadence; not GPU presentation timestamps',
            'cpu': 'process user+system time delta; 100% is one logical core',
            'gpu': 'IOAccelerator device utilization; system-wide, includes other applications'},
        'frames': windows, 'resources': resources, 'effects': effects,
        'summary': {'draw_fps': summarize([r['draw_fps'] for r in windows]),
            'frame_p95_ms': summarize([r['frame_interval_p95_ms'] for r in windows]),
            'process_cpu_percent': summarize([r['process_cpu_percent'] for r in resources]),
            'gpu_system_percent': summarize([d['percent'] for r in resources if r['gpu_system']['available']
                                            for d in r['gpu_system']['devices']])},
        'passed': not failures, 'failures': failures}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2)+'\n')
    print(json.dumps({'passed': report['passed'], 'summary': report['summary'], 'failures': failures,
                      'report': str(args.out)}, indent=2))
    return 0 if report['passed'] else 1

if __name__ == '__main__':
    sys.exit(main())
