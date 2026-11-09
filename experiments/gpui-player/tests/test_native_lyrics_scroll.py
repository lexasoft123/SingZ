#!/usr/bin/env python3
"""Hidden synthetic lyrics geometry journey with native app-local wheel events.

No production-reference, inference, physical input, or live display FPS claim.
Uses a previously built ui-tests binary; never builds or launches Electron/Node.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import uuid

from PIL import Image

sys.dont_write_bytecode = True
TESTS = Path(__file__).resolve().parent
REPO = TESTS.parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, TESTS / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def confirm_terminal(child):
    """Return an authoritative Popen exit code, or None while still live."""
    try:
        return child.wait(timeout=.1)
    except subprocess.TimeoutExpired:
        return None


def valid_resource_or_terminal(child, raw, errors, discards):
    """Accept valid counters; discard invalid counters only at verified exit.

    Callers retain raw reads before invoking this helper. False means stop the
    sampling loop; a discarded counter must never enter measured statistics.
    """
    cpu, memory, percent = raw['cpuNanoseconds'], raw['footprintBytes'], raw['cpuPercent']
    valid = math.isfinite(cpu) and cpu >= 0 and math.isfinite(memory) and memory > 0 and (percent is None or math.isfinite(percent) and percent >= 0)
    if valid:
        return True
    record = {'kind': 'invalidMeasuredCounter', **raw}
    returncode = confirm_terminal(child)
    if returncode is not None:
        record.update(terminalVerified=True, returncode=returncode,
                      status='discarded-verified-terminal-invalid-resource')
        discards.append(record)
        return False
    record.update(terminalVerified=False, returncode=None,
                  status='rejected-live-invalid-resource')
    errors.append(record)
    raise AssertionError('Invalid measured resource counter while child remains live; raw values preserved')


def observe_app_identity(child, expected, actual, elapsed, transitions):
    """Return True only for a verified terminal mismatch; never adopt a new PID identity."""
    same = actual is not None and expected['pid'] == actual['pid'] and ' '.join(expected['start'].split()) == ' '.join(actual['start'].split()) and expected['command'] == actual['command']
    if same:
        return False
    transition = {'elapsedSeconds': elapsed, 'expected': dict(expected),
                  'actual': dict(actual) if actual is not None else None,
                  'terminalVerified': False, 'returncode': None}
    transitions.append(transition)
    returncode = confirm_terminal(child)
    if returncode is None:
        transition['status'] = 'rejected-live-identity-mismatch'
        raise AssertionError('App PID identity changed while child remains live')
    transition.update(terminalVerified=True, returncode=returncode,
                      status='discarded-verified-terminal-identity-mismatch')
    return True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path, nargs='?', default=Path('/tmp') / ('singz-native-lyrics-scroll-' + uuid.uuid4().hex))
    parser.add_argument('--timeout', type=float, default=180.)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('Native resource/foreground observation requires macOS')
    if not 10 <= args.timeout <= 600:
        parser.error('--timeout must be between 10 and 600 seconds')
    app = args.app.resolve(strict=True)
    out = args.out.absolute()
    out.mkdir(parents=True, exist_ok=False)
    out = out.resolve()
    processes = module('lyrics_scroll_processes', 'test_native_lyrics_live.py')
    front = module('lyrics_scroll_foreground', 'test_native_lyrics_real.py').foreground
    perf = module('lyrics_scroll_performance', 'interface-perf.py')
    sys.path.insert(0, str(REPO / 'scripts'))
    from gpui_native_build_lock import native_build_lock

    private = out / 'private'
    for name in ('prefs', 'library', 'cache', 'tmp', 'pack', 'models'):
        (private / name).mkdir(parents=True, mode=0o700)
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
    env.update(SINGZ_GPUI_LYRICS_SCROLL_TEST=str(out / 'journey'), SINGZ_GPUI_DEMO='1',
               SINGZ_GPUI_BACKGROUND='1', SINGZ_MUTE='1', SINGZ_NO_SYNC='1',
               SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(private / 'prefs'),
               SINGZ_GPUI_PROJECTS_ROOT=str(private / 'library'),
               SINGZ_PACK_DIR=str(private / 'pack'), SINGZ_MODELS_DIR=str(private / 'models'),
               TMPDIR=str(private / 'tmp'), XDG_CACHE_HOME=str(private / 'cache'),
               HF_HOME=str(private / 'cache/huggingface'), TORCH_HOME=str(private / 'cache/torch'),
               PYTHONDONTWRITEBYTECODE='1')
    source_files = [Path(__file__), TESTS.parent / 'src/ui_lyrics_scroll.rs',
                    TESTS.parent / 'src/lyric_scroll_geometry.rs', TESTS.parent / 'src/main.rs']
    before = front()
    assert before.get('available'), before
    observed, fronts, samples, reads, errors, discards = {}, [], [], [], [], []
    previous = None
    failure = None
    warmup = 2.
    child = None
    forced = False
    root_identity = None
    identity_transitions = []
    cleanup_blocked_identity = None
    started = None
    with native_build_lock(REPO, 'Hidden synthetic lyric scrolling journey; compilation excluded'), (out / 'app.log').open('w') as log:
        pins = {str(p): sha(p) for p in source_files + [app]}
        try:
            started = time.monotonic()
            child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            while child.poll() is None:
                assert time.monotonic() - started < args.timeout, 'Native scrolling journey timed out'
                table = processes.process_table()
                if root_identity is None and child.pid in table:
                    root_identity = table[child.pid]
                if root_identity is not None and observe_app_identity(child, root_identity, table.get(child.pid), time.monotonic() - started, identity_transitions):
                    discards.append(identity_transitions[-1])
                    break
                active = {child.pid}
                while True:
                    new = active | {row['pid'] for row in table.values() if row['parent'] in active}
                    if new == active:
                        break
                    active = new
                for pid in active:
                    if pid in table:
                        row = table[pid]
                        observed[(pid, row['start'], row['command'])] = row
                current = front()
                fronts.append({'elapsedSeconds': time.monotonic() - started, **current})
                assert current == before, 'Foreground application identity changed'
                assert all(row['pid'] == child.pid for row in observed.values()), 'Demo spawned an unexpected helper/audio/input process'
                if time.monotonic() - started < warmup:
                    time.sleep(.2)
                    continue
                try:
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    percent = (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100 if previous else None
                    raw = dict(elapsedSeconds=now - started, cpuNanoseconds=cpu, footprintBytes=memory, cpuPercent=percent)
                    reads.append(raw)
                    if not valid_resource_or_terminal(child, raw, errors, discards):
                        break
                    if percent is not None:
                        samples.append({**raw, 'gpuSystem': perf.gpu_usage()})
                    previous = (cpu, now)
                except (OSError, RuntimeError) as error:
                    record = {'elapsedSeconds': time.monotonic() - started, 'error': repr(error)}
                    if isinstance(error, OSError) and error.errno in (2, 3) and child.poll() is not None:
                        discards.append(record)
                    else:
                        errors.append(record)
                        raise
                time.sleep(.2)
            assert root_identity is not None, 'App process identity was never observed'
            assert child.returncode == 0, 'Native journey failed; see app.log'
            assert len(samples) >= 3, 'Insufficient post-warmup resource samples'
            result = json.loads((out / 'journey/result.json').read_text())
            assert result['passed'] and result['binarySha256'] == sha(app), 'Invalid/stale result'
            assert result['journeySourceSha256'] == pins[str(TESTS.parent / 'src/ui_lyrics_scroll.rs')], 'Stale compiled journey adapter'
            assert result['geometrySourceSha256'] == pins[str(TESTS.parent / 'src/lyric_scroll_geometry.rs')], 'Stale compiled geometry module'
            assert result['mainSourceSha256'] == pins[str(TESTS.parent / 'src/main.rs')], 'Stale compiled player source'
            expected = {'short-future', 'active-paragraph', 'wrapped-future', 'oversized-left',
                        'horizontal-thumb-drag', 'horizontal-wheel', 'shift-wheel', 'oversized-right', 'replacement-reset', 'vertical-retained'}
            assert len(result['cases']) == 20
            for width, height in ((1280, 800), (1060, 640)):
                cases = {r['id'].removeprefix(f'{width}-'): r for r in result['cases'] if r['id'].startswith(f'{width}-')}
                assert cases.keys() == expected, cases.keys()
                for case in cases.values():
                    assert case['viewport'] == [width, height] and case['hidden'] and not case['active']
                    assert case['lineCount'] == 24 and case['steps']
                    image_path = out / 'journey' / case['png']
                    assert sha(image_path) == case['pngSha256']
                    assert case['deviceScale'] == 2., 'This Mac qualification expects native 2x scale'
                    expected_raster = (round(width * case['deviceScale']), round(height * case['deviceScale']))
                    with Image.open(image_path) as image:
                        assert image.size == expected_raster, 'Actual PNG raster differs from independent viewport contract'
                    assert case['raster'] == list(expected_raster)
                for name in ('short-future', 'wrapped-future', 'replacement-reset', 'vertical-retained'):
                    case = cases[name]
                    assert not case['horizontalGutter'] and not case['geometry']['overflows']
                    assert abs(case['offset'][0]) < .1 and abs(case['nativeMaxOffset'][0]) < .5
                for name, amount in (('horizontal-wheel', 75.), ('shift-wheel', 90.)):
                    assert abs(cases[name]['offset'][0] + amount) < .5, 'Native wheel delta applied more or less than once'
                drag = cases['horizontal-thumb-drag']
                assert abs(drag['offset'][0] + drag['geometry']['maxOffset']) < 1
                assert drag['offset'][0] < -100
                right = cases['oversized-right']
                assert abs(right['offset'][0] + right['geometry']['maxOffset']) < 1
                assert cases['vertical-retained']['offset'][1] < -100
            assert all(path.is_file() and sha(path) == digest for name, digest in pins.items() for path in [Path(name)]), 'Source/binary changed during run'
        except BaseException as error:
            failure = repr(error)
        finally:
            if child is not None and child.poll() is None:
                forced = True
                cleanup_table = processes.process_table()
                if root_identity is not None and processes.same_process(root_identity, cleanup_table.get(child.pid)):
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        cleanup_table = processes.process_table()
                        if processes.same_process(root_identity, cleanup_table.get(child.pid)):
                            child.kill()
                            child.wait(timeout=5)
                        else:
                            cleanup_blocked_identity = cleanup_table.get(child.pid)
                else:
                    cleanup_blocked_identity = cleanup_table.get(child.pid)
            table = processes.process_table()
            survivors = [r for r in observed.values() if processes.same_process(r, table.get(r['pid']))]
            survivors_before_cleanup = list(survivors)
            # Retire only exact task-owned process identities, even after failed runs.
            for row in survivors:
                try:
                    os.kill(row['pid'], signal.SIGTERM)
                except ProcessLookupError:
                    pass
            deadline = time.monotonic() + 3
            while survivors and time.monotonic() < deadline:
                time.sleep(.1)
                table = processes.process_table()
                survivors = [r for r in survivors if processes.same_process(r, table.get(r['pid']))]
            for row in survivors:
                try:
                    os.kill(row['pid'], signal.SIGKILL)
                except ProcessLookupError:
                    pass
            table = processes.process_table()
            remaining = [r for r in observed.values() if processes.same_process(r, table.get(r['pid']))]
            after = front()
            passed = failure is None and not forced and not survivors_before_cleanup and not remaining and after == before and bool(samples) and not errors
            observer = dict(passed=passed, failure=failure, forcedStop=forced,
                            returncode=child.returncode if child else None, observedProcesses=list(observed.values()),
                            survivorsBeforeCleanup=survivors_before_cleanup, survivors=remaining,
                            foregroundBefore=before, foregroundAfter=after, foregroundSamples=fronts,
                            startupWarmupSeconds=warmup, rawResourceReads=reads,
                            samples=samples, errors=errors, terminalDiscards=discards,
                            sourceAndBinarySha256=pins, liveFps=None,
                            identityTransitions=identity_transitions, cleanupBlockedIdentity=cleanup_blocked_identity,
                            scope='synthetic hidden demo native scrolling; process CPU/footprint; GPU system-wide; no physical input, production visual parity, or live FPS claim')
            (out / 'observer.json').write_text(json.dumps(observer, indent=2) + '\n')
    assert passed, failure or f'Observation failed; see {out / "observer.json"}'
    print(f'PASS: 20 hidden native scrolling cases; {len(samples)} resource samples; {out}')


if __name__ == '__main__':
    main()
