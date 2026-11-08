"""Hidden engine-setup controls and real local --help probes; no installation.

The otherwise unreachable legacy !ok&&!needsModels header branch is explicitly
seeded by the adapter. Every recheck outcome comes from the actual worker and
local executable, never a fabricated engine-success response.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
for name in ('result.json', 'failure.txt'):
    (out / name).unlink(missing_ok=True)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def foreground():
    if platform.system() != 'Darwin':
        return {'available': False, 'reason': 'lsappinfo is macOS-only'}
    try:
        result = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True,
                                text=True, timeout=2, check=False)
        return {'available': result.returncode == 0, 'front': result.stdout.strip(),
                'stderr': result.stderr.strip(), 'returnCode': result.returncode}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'available': False, 'reason': str(error)}


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

with tempfile.TemporaryDirectory(prefix='singz-engine-setup-') as temporary:
    root = Path(temporary).resolve()
    prefs = root / 'preferences'
    prefs.mkdir()
    (prefs / 'audio.json').write_text(json.dumps({'inputUid': '', 'engineSetupForeign': {'keep': True}}))
    control = root / 'probe-stage'
    control.write_text('failure')
    invocations = root / 'probe-invocations.jsonl'
    local_pack = root / 'local-pack'
    local_pack.mkdir()
    fake = local_pack / 'engine_probe.py'
    fake.write_text('''import json, os, sys, time
from pathlib import Path
control = Path(os.environ['SINGZ_GPUI_ENGINE_SETUP_CONTROL'])
stage = control.read_text()
with Path(os.environ['SINGZ_GPUI_ENGINE_SETUP_INVOCATIONS']).open('a') as stream:
    stream.write(json.dumps({'stage': stage, 'argv': sys.argv[1:], 'pid': os.getpid()}) + '\\n')
if '--help' not in sys.argv[1:]:
    raise SystemExit('fixture only permits engine discovery --help')
if stage == 'slow-old-success':
    control.with_suffix('.ready').write_text(str(os.getpid()))
    release = control.with_suffix('.manual-release')
    deadline = time.monotonic() + 25
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(.01)
    print('older manual helper intentionally succeeds after newer source failure')
    raise SystemExit(0)
if stage == 'slow-old-failure':
    control.with_suffix('.ready').write_text(str(os.getpid()))
    release = control.with_suffix('.old-release')
    deadline = time.monotonic() + 25
    while not release.exists() and time.monotonic() < deadline:
        time.sleep(.01)
    time.sleep(.5)
    print('older source worker intentionally failed after newer manual success', file=sys.stderr)
    raise SystemExit(3)
if stage.startswith('slow'):
    control.with_suffix('.ready').write_text(str(os.getpid()))
    deadline = time.monotonic() + 25
    while control.read_text() == stage and time.monotonic() < deadline:
        time.sleep(.01)
    stage = control.read_text()
if stage == 'success':
    print('Demucs isolated fixture --help: discovery only')
    raise SystemExit(0)
print('isolated engine intentionally unavailable', file=sys.stderr)
raise SystemExit(3)
''')
    # The override is an argv list executed by Command, not a shell command.
    # Use the current Python interpreter as a real executable on every host.
    candidates = root / 'engine-candidates.json'
    candidates.write_text(json.dumps([[str(Path(sys.executable).resolve()), str(fake)]]))
    catalog = root / 'catalog.json'
    catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
    library = root / 'library'
    library.mkdir()
    environment = {k: v for k, v in os.environ.items()
                   if not k.startswith('SINGZ_GPUI_') and k not in
                   ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'SINGZ_NO_SYSTEM_ENGINES', 'OneDrive')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_GPUI_BACKGROUND='1',
        SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_ENGINE_SETUP_TEST=str(out),
        SINGZ_GPUI_ENGINE_SETUP_CONTROL=str(control), SINGZ_GPUI_ENGINE_SETUP_INVOCATIONS=str(invocations),
        SINGZ_GPUI_ENGINE_CANDIDATES=str(candidates), SINGZ_GPUI_CONFIG_DIR=str(prefs),
        SINGZ_GPUI_PROJECTS_ROOT=str(library), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
        SINGZ_PACK_DIR=str(local_pack), SINGZ_MODELS_DIR=str(root / 'missing-models'), PYTHONDONTWRITEBYTECODE='1')
    initial_pack = {str(path.relative_to(local_pack)): sha(path) for path in local_pack.rglob('*') if path.is_file()}
    before = foreground()
    resources, stopped, started = [], threading.Event(), time.monotonic()
    with (out / 'engine-setup.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT)

        def sample():
            previous = None
            while not stopped.wait(.5):
                try:
                    if platform.system() != 'Darwin':
                        resources.append({'available': False, 'reason': 'Native resource counters are macOS-only'})
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now - started,
                            'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except OSError as error:
                    if child.poll() is None:
                        resources.append({'available': False, 'reason': str(error)})
                    return

        sampling = threading.Thread(target=sample, daemon=True)
        sampling.start()
        try:
            returncode = child.wait(timeout=100)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)
            raise AssertionError('Hidden engine setup suite timed out')
        finally:
            stopped.set()
            sampling.join(timeout=2)
            after = foreground()
            (out / 'foreground.json').write_text(json.dumps({'before': before, 'after': after}, indent=2))
            (out / 'performance.json').write_text(json.dumps({'samples': resources,
                'scope': 'GPUI app only; engine subprocesses excluded; GPU is system-wide',
                'liveFps': 'unmeasured: hidden native window'}, indent=2))
    assert returncode == 0, (returncode, (out / 'engine-setup.log').read_text()[-8000:])
    if platform.system() == 'Darwin':
        assert any('processCpuPercent' in row for row in resources), resources
    assert not (out / 'failure.txt').exists(), (out / 'failure.txt').read_text() if (out / 'failure.txt').exists() else ''
    result = json.loads((out / 'result.json').read_text())
    assert result and all(value is True for value in result.values()), result
    expected = ['engine-setup-copy'] + [
        ['engine-setup-recheck', 'engine-setup-github', 'engine-setup-close', 'engine-setup-copy'][index % 4]
        for index in range(8)]
    for width, height in [(1280, 800), (1060, 640)]:
        order = json.loads((out / f'focus-order-{width}.json').read_text())
        assert order == expected, order
        for phase in ['initial', 'copied', 'command-scrolled', 'copy-reset', 'recheck-busy', 'recheck-failure', 'recheck-success', 'older-manual-success-refused']:
            state = json.loads((out / f'{phase}-{width}.state.json').read_text())
            assert state['viewport'] == [width, height], state
        copied = json.loads((out / f'copied-{width}.state.json').read_text())
        assert copied['setup']['copied'] is True
        reset = json.loads((out / f'copy-reset-{width}.state.json').read_text())
        assert reset['setup']['copied'] is False
        busy = json.loads((out / f'recheck-busy-{width}.state.json').read_text())
        assert busy['setup']['checking'] and 'engine-setup-recheck' not in busy['setup']['focusOrder'], busy
        success = json.loads((out / f'recheck-success-{width}.state.json').read_text())
        assert success['engineStatus']['ok'] and not success['setup']['open'], success
        assert success['headerReady'] and not success['sourceEngineStatus']['ok'], success
        reverse = json.loads((out / f'older-manual-success-refused-{width}.state.json').read_text())
        assert reverse['setup']['open'] and not reverse['setup']['checking'], reverse
        assert not reverse['headerReady'] and not reverse['engineStatus']['ok'] and not reverse['setup']['status']['ok'], reverse
    timings = json.loads((out / 'copy-timing.json').read_text())
    assert len(timings) == 2 and all(row['resetElapsedMs'] >= 1600 for row in timings), timings
    checks = [json.loads(line) for line in invocations.read_text().splitlines()]
    assert all(row['argv'] == ['--help'] for row in checks), checks
    assert any(row['stage'] == 'failure' for row in checks)
    assert sum(row['stage'] == 'slow-failure' for row in checks) == 2, checks
    assert sum(row['stage'] == 'success' for row in checks) == 2, checks
    assert sum(row['stage'] == 'slow-old-failure' for row in checks) == 2, checks
    assert sum(row['stage'] == 'slow-old-success' for row in checks) == 2, checks
    assert {str(path.relative_to(local_pack)): sha(path) for path in local_pack.rglob('*') if path.is_file()} == initial_pack, 'Engine setup installed or modified the local pack'
    assert json.loads((prefs / 'audio.json').read_text())['engineSetupForeign'] == {'keep': True}
    for path in out.glob('*.state.json'):
        state = json.loads(path.read_text())
        assert not state['windowPresented'] and not state['windowActive'], state
        assert state['hiddenConfigured'] and state['mutedConfigured'], state
        assert set(state['externalUrls']) <= {'https://github.com/adefossez/demucs'}, state
        with path.with_name(path.name.replace('.state.json', '.png')).open('rb') as stream:
            header = stream.read(24)
        assert header[:8] == b'\x89PNG\r\n\x1a\n'
        raster = struct.unpack('>II', header[16:24])
        assert raster == tuple(round(value * state['scale']) for value in state['viewport']), (path, raster, state)
    if before.get('available') and after.get('available'):
        assert before['front'] == after['front'], (before, after)
    # A real CLI Open supersedes the SourceService's initial check before it
    # can publish. The adapter releases the slow fixture only after observing
    # the actual Open failure, then requires the production idle recovery probe.
    startup_out = out / 'startup-recovery'
    startup_out.mkdir(exist_ok=True)
    for name in ('result.json', 'failure.txt'):
        (startup_out / name).unlink(missing_ok=True)
    startup_prefs = root / 'startup-preferences'
    startup_prefs.mkdir()
    (startup_prefs / 'audio.json').write_text(json.dumps({'inputUid': '', 'engineSetupForeign': {'keep': True}}))
    startup_control = root / 'startup-stage'
    startup_control.write_text('slow-startup-failure')
    startup_invocations = root / 'startup-probes.jsonl'
    missing_project = root / 'project-that-does-not-exist' / 'project.json'
    startup_env = dict(environment, SINGZ_GPUI_ENGINE_SETUP_TEST=str(startup_out),
        SINGZ_GPUI_ENGINE_SETUP_STAGE='startup-recovery', SINGZ_GPUI_ENGINE_SETUP_CONTROL=str(startup_control),
        SINGZ_GPUI_ENGINE_SETUP_INVOCATIONS=str(startup_invocations), SINGZ_GPUI_CONFIG_DIR=str(startup_prefs))
    startup_before = foreground()
    with (startup_out / 'engine-setup.log').open('w') as log:
        startup = subprocess.Popen([str(app), '--project', str(missing_project)], env=startup_env,
                                   stdout=log, stderr=subprocess.STDOUT)
        try:
            startup_code = startup.wait(timeout=50)
        except subprocess.TimeoutExpired:
            startup.kill()
            startup.wait(timeout=10)
            raise AssertionError('Actual startup Open/probe recovery timed out')
    startup_after = foreground()
    assert startup_code == 0, (startup_code, (startup_out / 'engine-setup.log').read_text()[-8000:])
    assert not (startup_out / 'failure.txt').exists(), (startup_out / 'failure.txt').read_text() if (startup_out / 'failure.txt').exists() else ''
    startup_result = json.loads((startup_out / 'result.json').read_text())
    assert startup_result and all(value is True for value in startup_result.values()), startup_result
    failed_open = json.loads((startup_out / 'startup-open-failed.state.json').read_text())
    recovered = json.loads((startup_out / 'startup-probe-recovered.state.json').read_text())
    assert failed_open['engineStatus'] is None and failed_open['sourceEngineRevision'] == 0, failed_open
    assert recovered['sourceEngineRevision'] > 0 and recovered['engineStatus'] is not None, recovered
    assert not recovered['engineStatus']['ok'] and not recovered['headerReady'], recovered
    startup_checks = [json.loads(line) for line in startup_invocations.read_text().splitlines()]
    assert startup_checks and all(row['argv'] == ['--help'] for row in startup_checks), startup_checks
    for path in startup_out.glob('*.state.json'):
        value = json.loads(path.read_text())
        assert not value['windowPresented'] and not value['windowActive'] and value['hiddenConfigured'] and value['mutedConfigured'], value
        assert not value['externalUrls'], value
    if startup_before.get('available') and startup_after.get('available'):
        assert startup_before['front'] == startup_after['front'], (startup_before, startup_after)
    (startup_out / 'fixture.json').write_text(json.dumps({'argv': [str(app), '--project', str(missing_project)],
        'invocations': startup_checks, 'canonicalNoneWasSynthetic': False,
        'before': startup_before, 'after': startup_after}, indent=2))
    result['actualStartupFailureRecovery'] = True
    (out / 'result.json').write_text(json.dumps(result, indent=2))
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app), 'fakeEngineSha256': sha(fake),
        'candidates': json.loads(candidates.read_text()), 'invocations': checks, 'platform': platform.platform(),
        'noNode': True, 'hidden': True, 'muted': True, 'installedAnything': False,
        'legacyRoute': 'synthetic bad/no-needsModels status only; actual header action and every recheck subprocess are real',
        'clipboard': 'actual app clipboard readback; prior ClipboardItem restored after test',
        'startupRecovery': 'second process actual invalid --project supersedes initial probe; recovery uses actual worker',
        'externalLinks': 'allowlisted production GitHub event intercepted; browser not opened',
        'visualReference': 'candidate only; matched production captures absent'}, indent=2))
print('PASS: hidden native engine setup controls, subprocess recheck, clipboard timing, focus and dismissal at two desktop sizes')
