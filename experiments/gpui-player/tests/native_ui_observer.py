"""Background-only macOS observation for isolated native UI test adapters.

This observes real process counters and foreground identity. It never builds,
activates a window, supplies global input, or treats hidden readback as live FPS.
"""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

sys.dont_write_bytecode = True
TESTS = Path(__file__).resolve().parent
REPO = TESTS.parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, TESTS / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def source_hashes():
    files = {p.resolve() for p in TESTS.glob("*.py")}
    for root in (TESTS.parent / 'src', TESTS.parent / 'vendor', TESTS.parent / 'assets',
                 REPO / 'src/shared/i18n', REPO.parent / 'singz-ui/gpui/src',
                 REPO.parent / 'singz-ui/dist/fonts'):
        files.update(p.resolve() for p in root.rglob('*') if p.is_file())
    return {str(p): sha(p) for p in sorted(files)}


def run(app, out, extra_env, *, timeout=180., prefs=None):
    """Run one no-helper demo adapter, preserving all failed observations.

    extra_env receives the fresh journey output path. Callers separately verify
    the adapter's assertions and case matrix; observer success is not UI parity.
    """
    if sys.platform != 'darwin' or sys.flags.optimize:
        raise RuntimeError('Requires macOS and checks-enabled Python')
    app = Path(app).resolve(strict=True)
    out = Path(out).absolute()
    out.mkdir(parents=True, exist_ok=False)
    counters = module('native_ui_counter_admission', 'test_native_lyrics_scroll.py')
    processes = module('native_ui_process_identity', 'test_native_lyrics_live.py')
    foreground = module('native_ui_foreground', 'test_native_lyrics_real.py').foreground
    perf = module('native_ui_process_counters', 'interface-perf.py')
    sys.path.insert(0, str(REPO / 'scripts'))
    from gpui_native_build_lock import native_build_lock

    private = out / 'private'
    for name in ('prefs', 'library', 'cache', 'tmp', 'pack', 'models'):
        (private / name).mkdir(parents=True, mode=0o700)
    if prefs is not None:
        prefs = Path(prefs).resolve(strict=True)
    else:
        prefs = private / 'prefs'
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
    env.update(SINGZ_GPUI_DEMO='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_MUTE='1',
               SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_CONFIG_DIR=str(prefs),
               SINGZ_GPUI_PROJECTS_ROOT=str(private / 'library'),
               SINGZ_PACK_DIR=str(private / 'pack'), SINGZ_MODELS_DIR=str(private / 'models'),
               TMPDIR=str(private / 'tmp'), XDG_CACHE_HOME=str(private / 'cache'),
               HF_HOME=str(private / 'cache/huggingface'), TORCH_HOME=str(private / 'cache/torch'),
               PYTHONDONTWRITEBYTECODE='1')
    env.update(extra_env(out / 'journey'))
    before = foreground()
    assert before.get('available'), before
    sources = source_hashes()
    runtime = {str(p): sha(p) for p in app.parent.rglob('*') if p.is_file()}
    (out / 'source-before.json').write_text(json.dumps(sources, indent=2))
    samples, raw_reads, errors, discards, fronts, transitions = [], [], [], [], [], []
    owners, root_identity, previous = {}, None, None
    forced, cleanup_blocked, failure, child = False, None, None, None
    started = time.monotonic()
    with native_build_lock(REPO, 'Hidden native UI adapter; compilation excluded'), (out / 'app.log').open('w') as log:
        try:
            child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT,
                                     start_new_session=True)
            while child.poll() is None:
                elapsed = time.monotonic() - started
                assert elapsed < timeout, 'Native UI adapter timed out'
                table = processes.process_table()
                if root_identity is None and child.pid in table:
                    root_identity = table[child.pid]
                if root_identity is not None and counters.observe_app_identity(
                        child, root_identity, table.get(child.pid), elapsed, transitions):
                    discards.append(transitions[-1])
                    break
                active = {child.pid}
                while True:
                    expanded = active | {r['pid'] for r in table.values() if r['parent'] in active}
                    if expanded == active:
                        break
                    active = expanded
                for pid in active:
                    if pid in table:
                        row = table[pid]
                        owners[(pid, row['start'], row['command'])] = row
                assert all(r['pid'] == child.pid for r in owners.values()), 'Unexpected native helper in no-worker fixture'
                current = foreground()
                fronts.append({'elapsedSeconds': elapsed, **current})
                assert current == before, 'Foreground application identity changed'
                if elapsed < 2.:
                    time.sleep(.2)
                    continue
                try:
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    percent = (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100 if previous else None
                    raw = dict(elapsedSeconds=now - started, cpuNanoseconds=cpu,
                               footprintBytes=memory, cpuPercent=percent)
                    raw_reads.append(raw)
                    if not counters.valid_resource_or_terminal(child, raw, errors, discards):
                        break
                    if percent is not None:
                        samples.append({**raw, 'gpuSystem': perf.gpu_usage()})
                    previous = (cpu, now)
                except (OSError, RuntimeError) as error:
                    record = {'elapsedSeconds': time.monotonic() - started, 'error': repr(error)}
                    if isinstance(error, OSError) and error.errno in (2, 3) and counters.confirm_terminal(child) is not None:
                        discards.append(record)
                        break
                    errors.append(record)
                    raise
                time.sleep(.2)
            assert root_identity is not None, 'App identity was never observed'
            assert child.wait(timeout=1) == 0, 'Adapter failed; inspect app.log'
            result_file = out / 'journey/result.json'
            assert result_file.is_file(), 'Native UI adapter failed before its result; inspect app.log'
            assert json.loads(result_file.read_text()).get('passed', True), 'Native UI adapter assertions failed'
            assert len(samples) >= 3, 'Insufficient measured post-warmup resource samples'
            assert source_hashes() == sources, 'Sources or fonts changed during observation'
            assert {str(p): sha(p) for p in app.parent.rglob('*') if p.is_file()} == runtime, 'Runtime changed'
        except BaseException as error:
            failure = repr(error)
        finally:
            if child is not None and child.poll() is None:
                table = processes.process_table()
                if root_identity is not None and processes.same_process(root_identity, table.get(child.pid)):
                    forced = True
                    child.terminate()
                    try:
                        child.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=5)
                else:
                    cleanup_blocked = 'Refused to signal a process without verified original identity'
            table = processes.process_table()
            survivors = [r for r in owners.values() if processes.same_process(r, table.get(r['pid']))]
            after = foreground()
            report = dict(passed=failure is None and not forced and not cleanup_blocked and not survivors and after == before and bool(samples) and not errors,
                          appSha256=sha(app), returncode=None if child is None else child.returncode,
                          forcedStop=forced, cleanupBlocked=cleanup_blocked, owners=list(owners.values()),
                          survivors=survivors, foregroundBefore=before, foregroundAfter=after,
                          foregroundSamples=fronts, samples=samples, rawResourceReads=raw_reads,
                          resourceWarmupSeconds=2., errors=errors, terminalDiscards=discards,
                          identityTransitions=transitions, failure=failure, liveFps=None,
                          scope='Native hidden demo adapter; UI CPU/footprint and system GPU; no helper audio, physical input, live display cadence or production parity')
            (out / 'observer.json').write_text(json.dumps(report, indent=2) + '\n')
            assert report['passed'], failure or 'Observation failed'
    return json.loads((out / 'journey/result.json').read_text()), report
