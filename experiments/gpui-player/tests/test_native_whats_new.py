"""Hidden native What's New: bundled content, real controls and durable seen state.

No Node, network release lookup, global input, OS URL launch or focus changes.
External actions are captured only by the scoped native ui-tests hook.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import struct
import tempfile
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
checkout = Path(__file__).resolve().parents[3]
content_path = checkout / 'src/shared/release-content.json'
content = json.loads(content_path.read_text())
version = content['version']


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def preferences(path):
    return {str(p.relative_to(path)): {'sha256': sha(p), 'text': p.read_text(errors='replace')}
            for p in sorted(path.rglob('*')) if p.is_file()} if path.exists() else {}


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

with tempfile.TemporaryDirectory(prefix='singz-whats-new-') as temporary:
    root = Path(temporary).resolve()
    catalog = root / 'catalog.json'
    catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
    configurations = {}
    for stage in ['fresh', 'prefeature', 'skipped', 'downgrade', 'settings', 'models', 'picker']:
        config = root / stage / 'preferences'
        configurations[stage] = config
        if stage != 'fresh':
            config.mkdir(parents=True)
            (config / 'audio.json').write_text(json.dumps({'inputUid': '', 'fixtureForeignAudio': {'keep': stage}}))
        if stage in ['skipped', 'downgrade']:
            (config / 'release-highlights.json').write_text(json.dumps({'version': 1,
                'releaseNotesSeen': '9.9.9' if stage == 'downgrade' else '0.26.1',
                'fixtureForeignRelease': {'keep': stage}}))
    configurations['restart'] = configurations['skipped']
    environment = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_')
                   and k not in ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'OneDrive']}
    environment.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
                       SINGZ_GPUI_RELEASE_AUTOMATIC='1', SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
                       SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
                       SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    results = {}
    all_states = []
    for stage in ['fresh', 'prefeature', 'skipped', 'restart', 'downgrade', 'settings', 'models', 'picker']:
        folder = out / stage
        folder.mkdir(exist_ok=True)
        for filename in ['result.json', 'failure.txt']:
            (folder / filename).unlink(missing_ok=True)
        config = configurations[stage]
        before = preferences(config)
        env = dict(environment, SINGZ_GPUI_WHATS_NEW_TEST=str(folder), SINGZ_GPUI_RELEASE_STAGE=stage,
                   SINGZ_GPUI_CONFIG_DIR=str(config))
        foreground_before = foreground()
        resources, stop, started = [], threading.Event(), time.monotonic()
        with (folder / 'whats-new.log').open('w') as log:
            child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)

            def sample():
                previous = None
                while not stop.wait(.5):
                    try:
                        if platform.system() != 'Darwin':
                            resources.append({'available': False, 'reason': 'macOS process counters unavailable'})
                            return
                        cpu, memory = perf.process_usage(child.pid)
                        now = time.monotonic()
                        if previous:
                            resources.append({'elapsedSeconds': now - started,
                                'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                                'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                        previous = cpu, now
                    except OSError:
                        return
            worker = threading.Thread(target=sample, daemon=True)
            worker.start()
            try:
                child.wait(timeout=100)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                stop.set()
                worker.join(timeout=4)
                foreground_after = foreground()
                (folder / 'foreground.json').write_text(json.dumps({'before': foreground_before,
                    'after': foreground_after, 'changed': (foreground_before.get('front') != foreground_after.get('front'))
                    if foreground_before.get('available') and foreground_after.get('available') else None,
                    'assessment': 'read-only observation; foreground changes may be user activity; hidden-window checks remain mandatory'}, indent=2))
                after = preferences(config)
                (folder / 'preferences-diff.json').write_text(json.dumps({'before': before, 'after': after,
                    'changed': [name for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)]}, indent=2))
                (folder / 'performance.json').write_text(json.dumps({
                    'scope': 'main GPUI CPU/footprint; GPU system-wide; no release inference or audio capture',
                    'wallSeconds': time.monotonic() - started, 'samples': resources,
                    'liveFps': {'available': False, 'reason': 'hidden static captures do not measure live cadence'}}, indent=2))
        assert child.returncode == 0 and (folder / 'result.json').is_file(), (folder / 'whats-new.log').read_text()
        result = json.loads((folder / 'result.json').read_text())
        assert all(value is True for value in result.values()), result
        if stage in ['fresh', 'restart', 'downgrade']:
            required = ['automaticSuppressed', 'manualReopen', 'twoSizes', 'focusTrap', 'allDismissals',
                        'linksCapturedWithoutClosing', 'keyboardSuppressed']
            assert all(result.get(key) is True for key in required), result
            expected_focus = ['whats-new-close'] + [
                ['whats-new-telegram', 'whats-new-full-notes', 'whats-new-done', 'whats-new-close'][i % 4]
                for i in range(9)] + ['whats-new-close']
            for width in [1280, 1060]:
                assert json.loads((folder / f'focus-order-{width}.json').read_text()) == expected_focus
        elif stage in ['settings', 'models', 'picker']:
            assert result.get('startupPrecedence') is True, result
        else:
            assert result.get('automaticUpgrade') is True, result
        if stage == 'fresh':
            assert result.get('freshBaseline') is True
        if stage == 'prefeature':
            assert result.get('quickStartWaitsForNews') is True
        if stage == 'skipped':
            assert result.get('multiReleaseScroll') is True
        saved = json.loads((config / 'release-highlights.json').read_text())
        assert saved['version'] == 1 and saved['releaseNotesSeen'] == ('9.9.9' if stage == 'downgrade' else version), saved
        if stage in ['skipped', 'restart', 'downgrade']:
            assert saved['fixtureForeignRelease'] == {'keep': 'skipped' if stage == 'restart' else stage}
        if stage != 'fresh':
            audio = json.loads((config / 'audio.json').read_text())
            assert audio['fixtureForeignAudio'] == {'keep': 'skipped' if stage == 'restart' else stage}
        states = []
        for state_path in folder.glob('*.state.json'):
            state = json.loads(state_path.read_text())
            image_path = state_path.with_name(state_path.name.replace('.state.json', '.png'))
            with image_path.open('rb') as stream:
                header = stream.read(24)
            assert header[:8] == b'\x89PNG\r\n\x1a\n', image_path
            raster = struct.unpack('>II', header[16:24])
            actual = tuple(state['viewport'])
            assert tuple(state['expectedViewport']) == actual, (state_path, state)
            expected_raster = tuple(round(value * state['scale']) for value in actual)
            assert raster == expected_raster, (image_path, raster, actual, state['scale'])
            states.append(state)
        assert states, f'No state captures for {stage}'
        if stage in ['fresh', 'restart', 'downgrade']:
            for width, height in [(1280, 800), (1060, 640)]:
                manual = json.loads((folder / f'manual-{width}.state.json').read_text())
                assert manual['viewport'] == [width, height], manual
                assert manual['release']['keyboardFocus'] is True, manual
        if stage == 'skipped':
            scrolled = json.loads((folder / 'skipped-scrolled-1060.state.json').read_text())
            assert scrolled['viewport'] == [1060, 640], scrolled
        for state in states:
            assert not state['windowPresented'] and not state['windowActive'], state
            assert state['hiddenConfigured'] and state['mutedConfigured'], state
            assert state['serviceError'] is None, state
            assert state['unexpectedBrowse'] == 0, 'Modal command leaked into native folder browsing'
            assert state['unexpectedBrowse'] == 0, state
        if stage == 'skipped':
            automatic = json.loads((folder / 'automatic-1280.state.json').read_text())
            entries = automatic['release']['notes']['entries']
            assert [entry['version'] for entry in entries] == ['0.26.5', '0.26.4', '0.26.3', '0.26.2']
            assert all(not item['desktopOnly'] for entry in entries for item in entry['highlights'])
        all_states.extend(states)
        results[stage] = result
    leftovers = [str(p.relative_to(root)) for p in root.rglob('*')
                 if p.name.startswith('.release-highlights-') and p.name.endswith('.tmp')]
    assert not leftovers, leftovers
    (out / 'result.json').write_text(json.dumps({'stages': results, 'freshBaseline': True,
        'returningUpgrade': True, 'skippedReleases': True, 'acknowledgementRestart': True,
        'downgradeMonotonic': True, 'startupPrecedence': True, 'quickStartWaits': True,
        'noTemporaryReleaseFiles': True}, indent=2))
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
        'releaseContentSha256': sha(content_path), 'version': version, 'catalog': {'flavor': 'linux', 'entries': []},
        'platform': platform.platform(), 'noNode': True, 'hidden': True, 'muted': True, 'locale': 'en',
        'viewports': sorted({tuple(state['viewport']) for state in all_states}),
        'scaleFactors': sorted({state['scale'] for state in all_states}),
        'startupRouteSetup': 'production Settings header, model/picker helpers established before startup poll',
        'quickStartPolicy': 'production maybe_open_quick_start(true) explicitly enables hidden welcome arbitration check',
        'externalLinks': 'actual entity actions captured in scoped ui-tests hook; no OS URL opening',
        'visualReference': 'candidate only; matched production captures absent'}, indent=2))
print('PASS: hidden native What\'s New controls, version persistence, skipped updates, downgrade, links, startup precedence and Quick Start ordering')
