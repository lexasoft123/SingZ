"""Hidden native diagnostic sessions, clipboard, and actual worker exports.

Three launches share an isolated config: the first persists labelled events,
the second reopens that session, and the third verifies short-content sizing.
No engine activity or filesystem export result is fabricated.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import struct
import subprocess
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def foreground():
    if platform.system() != 'Darwin':
        return {'available': False, 'reason': 'lsappinfo unavailable on this host'}
    try:
        proc = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True,
                              text=True, timeout=2, check=False)
        return {'available': proc.returncode == 0, 'front': proc.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'available': False, 'reason': str(error)}


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)


def launch(environment, phase, directory):
    directory.mkdir(parents=True, exist_ok=True)
    for name in ['result.json', 'failure.txt']:
        (directory / name).unlink(missing_ok=True)
    env = dict(environment, SINGZ_GPUI_DIAGNOSTICS_TEST=str(directory),
               SINGZ_GPUI_DIAGNOSTICS_STAGE=phase)
    before = foreground()
    samples, stopped, started = [], threading.Event(), time.monotonic()
    with (directory / 'diagnostics.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)

        def sample():
            previous = None
            while not stopped.wait(.3):
                try:
                    if platform.system() != 'Darwin':
                        samples.append({'available': False, 'reason': 'Native process counters are macOS-only'})
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        samples.append({'elapsedSeconds': now - started,
                            'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except OSError as error:
                    if child.poll() is None:
                        samples.append({'available': False, 'reason': str(error)})
                    return

        sampling = threading.Thread(target=sample, daemon=True)
        sampling.start()
        try:
            returncode = child.wait(timeout=150)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=10)
            raise AssertionError(f'Hidden diagnostics {phase} timed out')
        finally:
            stopped.set()
            sampling.join(timeout=4)
            after = foreground()
            (directory / 'foreground.json').write_text(json.dumps({'before': before, 'after': after}, indent=2))
            (directory / 'performance.json').write_text(json.dumps({'samples': samples,
                'scope': 'GPUI app process CPU/footprint; GPU counters are system-wide',
                'liveFps': {'available': False, 'reason': 'hidden event-driven rendering does not establish live display cadence'}}, indent=2))
    assert returncode == 0, (returncode, (directory / 'diagnostics.log').read_text()[-12000:])
    assert not (directory / 'failure.txt').exists(), (directory / 'failure.txt').read_text() if (directory / 'failure.txt').exists() else ''
    result = json.loads((directory / 'result.json').read_text())
    assert result and all(value is True for value in result.values()), result
    if platform.system() == 'Darwin' and phase == 'review':
        measured = [row['processCpuPercent'] for row in samples if 'processCpuPercent' in row]
        assert len(measured) >= 2 and all(math.isfinite(value) and value >= 0 for value in measured), samples
    if before['available'] and after['available']:
        assert before['front'] == after['front'], (before, after)
    for path in directory.glob('*.state.json'):
        state = json.loads(path.read_text())
        assert not state['windowPresented'] and not state['windowActive'], state
        assert state['hiddenConfigured'] and state['mutedConfigured'], state
        with path.with_name(path.name.replace('.state.json', '.png')).open('rb') as stream:
            header = stream.read(24)
        assert header[:8] == b'\x89PNG\r\n\x1a\n'
        assert struct.unpack('>II', header[16:24]) == tuple(round(value * state['scale']) for value in state['viewport'])
    return result


with tempfile.TemporaryDirectory(prefix='singz-native-diagnostics-') as temporary:
    root = Path(temporary).resolve()
    prefs = root / 'preferences'
    prefs.mkdir()
    (prefs / 'audio.json').write_text(json.dumps({'inputUid': '', 'diagnosticsForeign': {'keep': True}}))
    library = root / 'library'
    library.mkdir()
    catalog = root / 'catalog.json'
    catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('SINGZ_GPUI_') and key not in
           ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'OneDrive']}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
        SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library),
        SINGZ_GPUI_MODEL_FIXTURE=str(catalog), SINGZ_PACK_DIR=str(root / 'missing-pack'),
        SINGZ_MODELS_DIR=str(root / 'missing-models'), PYTHONDONTWRITEBYTECODE='1',
        SINGZ_GPUI_DIAGNOSTICS_READ_GATE=str(root / 'read-gate'),
        SINGZ_GPUI_DIAGNOSTICS_SAVE_GATE=str(root / 'save-gate'))
    launch(env, 'seed', out / 'seed')
    launch(env, 'review', out / 'review')
    launch(env, 'short', out / 'short')
    for phase, minimum in [('review', 6), ('short', 2)]:
        boundaries = json.loads((out / phase / 'inventory-open-boundaries.json').read_text())
        assert len(boundaries) >= minimum, boundaries
        assert any(row['previousInventoryCount'] > 0 for row in boundaries), boundaries
        for row in boundaries:
            assert row['sessions'] == [] and row['selectedSession'] is None, row
            assert row['pendingList'][1] == row['modalSession'], row
        assert len({row['modalSession'] for row in boundaries}) == len(boundaries), boundaries
    for width in [1280, 1060]:
        edge = json.loads((out / 'review' / f'long-content-{width}.json').read_text())
        expected = edge['input'].encode('utf-16-le')[:4000].decode('utf-16-le', errors='replace')
        assert edge['expected'] == expected and expected.endswith('\ufffd')
        assert len(expected.encode('utf-16-le')) // 2 == edge['expectedUtf16Units'] == 2000
        assert 'Привет 🎤' in expected and '/Users/Тест/' in expected
        assert 'ignored-after-utf16-limit' not in expected
        assert edge['maxScrollOffset'][0] == 0, edge
        assert edge['afterVerticalExtent'] > edge['baselineVerticalExtent'] + 80, edge
        assert edge['verticalGrowth'] > 80, edge
        assert 318 < edge['bodyViewportHeight'] <= edge['sourceInnerMaximum'], edge
        assert edge['sourceInnerMinimum'] == 238, edge
        shrink = json.loads((out / 'short' / f'intrinsic-shrink-{width}.json').read_text())
        assert shrink['shortBefore'] == shrink['shortRestored'] == shrink['sourceInnerMinimum'] == 238, shrink
        assert shrink['pastExpanded'] == shrink['sourceInnerMaximum'], shrink
        assert shrink['pastExpanded'] > shrink['shortRestored'] + 80, shrink
        copied = json.loads((out / 'review' / f'copied-{width}.state.json').read_text())
        assert any(line.endswith(expected) for line in copied['panel']['copyText'].splitlines())
        saved = (out / 'review' / f'current-{width}.txt').read_text()
        assert any(line.endswith(expected) for line in saved.splitlines())
        assert 'ignored-after-utf16-limit' not in saved
        ordering = json.loads((out / 'review' / f'save-callback-order-{width}.json').read_text())
        assert ordering['deliveryOrder'] == [ordering['newerSerial'], ordering['olderSerial']]
        assert ordering['newerSerial'] == ordering['olderSerial'] + 1
        assert ordering['bothActualExports'] and ordering['latestReceiptRetained']
        older, newer = Path(ordering['olderPath']), Path(ordering['newerPath'])
        assert older.parent == out / 'review' and newer.parent == out / 'review'
        assert older.read_bytes() == newer.read_bytes()
        assert b'diagnostics-ui-seed-0000:' in older.read_bytes()
        assert b'diagnostics-ui-seed-4106:' in older.read_bytes()
        assert len(older.read_text().splitlines()) > 4107
        receipt = json.loads((out / 'review' / f'save-callback-order-{width}.state.json').read_text())
        assert receipt['panel']['savedTo'] == str(newer), receipt
    assert json.loads((prefs / 'audio.json').read_text())['diagnosticsForeign'] == {'keep': True}
    exports = {str(path.relative_to(out)): {'sha256': sha(path), 'bytes': path.stat().st_size}
               for path in (out / 'review').glob('*.txt') if path.name != 'failure.txt'}
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
        'platform': platform.platform(), 'noNode': True, 'hidden': True, 'muted': True,
        'fixtures': 'first launch persists explicitly labelled diagnostics-ui-seed events through the actual native service',
        'clipboard': 'actual app clipboard readback; complete prior ClipboardItem restored',
        'savePrompt': 'UI-tests-only OS save-path interception; actual native worker performs all exports',
        'saveCallbackOrdering': 'explicit synthetic out-of-order callback delivery to production accept_diagnostics_path; both actual file exports must survive and latest UI receipt must retain ownership',
        'longContent': 'actual Sink fixture with unbroken path/Cyrillic/emoji; horizontal extent zero and vertical growth above 80 logical px; copied/exported content checked against independent UTF-16 truncation oracle',
        'intrinsicBody': 'wrapped content grows body beyond minimum within source viewport cap; third actual short launch expands to past4000 then shrinks to minimum after selecting current',
        'inventoryBoundary': 'Window.defer after real Header Log subscription in the same App effect cycle asserts empty session metadata while new list is pending, including reopening a panel with previously loaded inventory',
        'exports': exports, 'visualReference': 'candidate-only; no matched production reference claim'}, indent=2))
    (out / 'result.json').write_text(json.dumps({'restartPersistence': True, 'nativeInteractions': True,
        'twoSizes': True, 'resourceSamples': True, 'noForegroundActivation': True}, indent=2))
print('PASS: hidden native diagnostics, durable sessions and worker exports at two desktop sizes')
