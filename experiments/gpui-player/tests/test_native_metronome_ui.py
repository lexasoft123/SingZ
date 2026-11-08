"""Hidden native metronome controls, accepted state and project persistence.
Build with ui-tests first. No Node; all output is forced silent.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
import platform
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import wave
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
(out / 'result.json').unlink(missing_ok=True)
(out / 'failure.txt').unlink(missing_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)


def run_process(env, folder):
    """One hidden process and its resource evidence, with bounded cleanup."""
    folder.mkdir(parents=True, exist_ok=True)
    (folder / 'result.json').unlink(missing_ok=True)
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (folder / 'metronome.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)
        def sample():
            previous = None
            while not stop.wait(.5):
                try:
                    if platform.system() != 'Darwin':
                        resources.append({'available': False, 'reason': 'macOS resource counters unavailable'})
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now-started,
                            'processCpuPercent': (cpu-previous[0]) / ((now-previous[1])*1e9)*100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except OSError:
                    return
        sampling = threading.Thread(target=sample, daemon=True)
        sampling.start()
        try:
            child.wait(timeout=180)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            sampling.join(timeout=4)
    (folder / 'performance.json').write_text(json.dumps({'scope': 'main GPUI CPU/footprint; excludes native helper; GPU system-wide',
        'wallSeconds': time.monotonic()-started, 'samples': resources,
        'liveFps': {'available': False, 'reason': 'hidden static renders do not measure live display cadence'}}, indent=2))
    assert child.returncode == 0 and (folder / 'result.json').is_file(), (folder / 'metronome.log').read_text()
    return json.loads((folder / 'result.json').read_text())
with tempfile.TemporaryDirectory(prefix='singz-metronome-ui-') as temp:
    root = Path(temp).resolve()
    project = root / 'projects' / 'metronome'
    gridless = root / 'projects' / 'gridless'
    legacy = root / 'projects' / 'legacy'
    project.mkdir(parents=True)
    gridless.mkdir()
    legacy.mkdir()
    with wave.open(str(project / 'song.wav'), 'wb') as audio:
        audio.setparams((2, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<hh', int(4500 * math.sin(i * math.tau * 220 / 48000)), int(3500 * math.sin(i * math.tau * 330 / 48000))) for i in range(48000 * 12)))
    shutil.copyfile(project / 'song.wav', gridless / 'song.wav')
    shutil.copyfile(project / 'song.wav', legacy / 'song.wav')
    audio_hash = sha(project / 'song.wav')
    beat = {'beats': [round(i * .2, 6) for i in range(60)], 'bpm': 300, 'beatsPerBar': 4,
            'downbeat': 0, 'downbeats': [0, 4, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58],
            'autoDownbeats': [0, 4, 6, 10, 14, 18, 22, 26, 30, 34, 38, 42, 46, 50, 54, 58],
            'userBars': [1.2], 'source': 'auto', 'detVersion': 23, 'futureBeat': {'preserve': 'beat metadata'}}
    met = {'click': True, 'countInBars': 1, 'volume': .3, 'accent': False, 'grid': False,
           'futureMet': {'preserve': 'metronome metadata'}}
    initial = {'version': 2, 'name': 'Metronome fixture', 'songFile': 'song.wav', 'foreign': {'preserve': True},
               'settings': {'beat': beat, 'metronome': met, 'futureSetting': {'preserve': 17}}}
    (project / 'project.json').write_text(json.dumps(initial))
    (gridless / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Gridless fixture', 'songFile': 'song.wav',
        'settings': {'metronome': {'click': True, 'countInBars': 1, 'volume': .7, 'accent': True, 'grid': False}}}))
    (legacy / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Legacy fixture', 'songFile': 'song.wav', 'settings': {'futureSetting': {'legacy': True}}}))
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR']}
    env.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
               SINGZ_GPUI_TEST_PROJECT=str(project), SINGZ_GPUI_METRONOME_GRIDLESS=str(gridless), SINGZ_GPUI_METRONOME_LEGACY=str(legacy),
               SINGZ_GPUI_METRONOME_TEST=str(out), SINGZ_PACK_DIR=str(root / 'missing-pack'))
    try:
        result = run_process(env, out)
        assert result['sizes'] == 2
        assert all(result[k] for k in ['restored', 'controlAcknowledgements', 'pausedControlsPreservePosition', 'blurTempoCommitted', 'openingPreservesGraph', 'typedTempo', 'invalidTempo',
            'halfDoubleMeterNudge', 'gridPaint', 'barHandleDrag', 'barHandlePreview', 'barHandleAltClear', 'barHandlePersistence', 'escapeDraft', 'outsideClose', 'triggerClose', 'saveReopen',
            'supersededSuccessRetained', 'sameSongHandoffNoCountIn', 'deferredSaveAndNavigation', 'countInAnchor', 'gridlessIntent', 'tapTempo', 'hidden', 'muted']), result
        images = list(out.glob('*.png'))
        states = [json.loads(p.read_text()) for p in out.glob('*.state.json')]
        assert result['barHandleSizes'] == 2
        assert len(images) == len(states) == 16, (len(images), len(states))
        assert {tuple(s['viewport']) for s in states} == {(1280., 800.), (1060., 640.)}
        assert all(s['hidden'] and s['muted'] and s['scale'] == 2 for s in states)
        assert all(s['windowPresented'] is False and s['windowActive'] is False for s in states)
        assert all(len(s['mousePosition']) == 2 and isinstance(s['bpmInputValue'], str) for s in states)
        for width in [1280, 1060]:
            focused = json.loads((out / f'bpm-focus-{width}.state.json').read_text())
            assert focused['bpmInputValue'] == '77' and focused['bpmFocused'] is True
            assert focused['beat']['bpm'] == 120 and focused['desiredBeat']['bpm'] == 120
            preview = json.loads((out / f'bar-ghost-{width}.state.json').read_text())
            moved = json.loads((out / f'bar-moved-{width}.state.json').read_text())
            cleared = json.loads((out / f'bar-cleared-{width}.state.json').read_text())
            assert preview['beat']['userBars'] == [1.2]
            assert preview['barGhostTime'] == 2.2
            assert moved['beat']['userBars'] == [1.2, 2.2]
            assert cleared['beat']['userBars'] == [1.2]
            assert moved['barGhostTime'] is None and cleared['barGhostTime'] is None
            assert all(s['beat']['autoDownbeats'] == beat['autoDownbeats'] and s['beat']['source'] == 'auto' and s['beat']['detVersion'] == 23 for s in [preview, moved, cleared])
            saved_bars = json.loads((out / f'bar-saved-{width}.json').read_text())
            assert saved_bars['foreign'] == initial['foreign']
            assert saved_bars['settings']['futureSetting'] == initial['settings']['futureSetting']
            assert saved_bars['settings']['metronome']['futureMet'] == met['futureMet']
            assert saved_bars['settings']['beat']['futureBeat'] == beat['futureBeat']
            assert saved_bars['settings']['beat']['userBars'] == [1.2, 2.2]
            assert saved_bars['settings']['beat']['autoDownbeats'] == beat['autoDownbeats']
            assert saved_bars['settings']['beat']['source'] == 'auto' and saved_bars['settings']['beat']['detVersion'] == 23
        deferred = json.loads((out / 'deferred-save-project.json').read_text())
        assert abs(deferred['settings']['metronome']['volume']-.64) < 1e-9
        saved = json.loads((project / 'project.json').read_text())
        assert saved['foreign'] == initial['foreign'] and saved['settings']['futureSetting'] == initial['settings']['futureSetting']
        assert saved['settings']['beat']['futureBeat'] == beat['futureBeat']
        assert saved['settings']['metronome']['futureMet'] == met['futureMet']
        assert saved['settings']['beat']['beatsPerBar'] == 3 and saved['settings']['beat']['downbeat'] == 1
        assert saved['settings']['beat']['source'] == 'manual'
        assert saved['settings']['metronome']['click'] is False and saved['settings']['metronome']['accent'] is False
        assert abs(saved['settings']['metronome']['volume']-.61) < 1e-9
        assert sha(project / 'song.wav') == audio_hash and sha(gridless / 'song.wav') == audio_hash
        # Preserve the first process's Save evidence, then deliberately make
        # this song's grid preference false. The second process must obtain
        # true from native global preferences, never from the project alone.
        (out / 'saved-before-restart.json').write_text(json.dumps(saved, indent=2))
        prefs_before = json.loads((root / 'prefs' / 'metronome.json').read_text())
        assert prefs_before['version'] == 1 and prefs_before['grid'] is True
        restart_project = json.loads(json.dumps(saved))
        restart_project['settings']['metronome']['grid'] = False
        (project / 'project.json').write_text(json.dumps(restart_project))
        (out / 'restart-project.json').write_text(json.dumps(restart_project, indent=2))
        restart_env = env.copy()
        restart_env.update(SINGZ_GPUI_METRONOME_TEST=str(out / 'restart'), SINGZ_GPUI_METRONOME_RESTART='1')
        restarted = run_process(restart_env, out / 'restart')
        assert all(restarted[k] for k in ['restart', 'globalGridRestored', 'songSettingsRestored', 'songGridFalse', 'legacyInheritsCurrent', 'hidden', 'muted']), restarted
        assert not list((out / 'restart').glob('*.png')), 'Restart check must not alter the sixteen-capture matrix'
        restart_state = json.loads((out / 'restart' / 'restart.state.json').read_text())
        assert restart_state['metronome']['grid'] is True
        legacy_state = json.loads((out / 'restart' / 'legacy.state.json').read_text())
        assert legacy_state['project'] == 'Legacy fixture' and legacy_state['beat'] is None and legacy_state['metronome'] == restart_state['metronome']
        assert sha(legacy / 'song.wav') == audio_hash
        prefs_after = json.loads((root / 'prefs' / 'metronome.json').read_text())
        assert prefs_after['version'] == 1 and prefs_after['grid'] is True
        assert prefs_after['click'] is False and prefs_after['countInBars'] == 1 and prefs_after['accent'] is False
        assert abs(prefs_after['volume']-.61) < 1e-9, 'Immediate quit lost the last visible song preference adoption'
        (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
            'helperSha256': sha(app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')),
            'audioSha256': audio_hash, 'initialProject': initial, 'restart': {'samePreferencesDirectory': True, 'songGrid': False, 'restoredGrid': True, 'preferencesBefore': prefs_before, 'preferencesAfter': prefs_after}, 'noNode': True, 'hidden': True, 'muted': True,
            'microphoneCaptureDisabled': True, 'viewportSizes': [[1280, 800], [1060, 640]], 'scale': 2, 'locale': 'en',
            'reference': 'new screenshots are candidates; matched production captures absent',
            'covered': ['saved settings', 'actual popover controls', 'input Enter/Escape/button blur', 'opening preserves graph and clean state', 'disabled gridless choices',
                        'grid paint', 'ruler handle geometry', 'bar handle drag/ghost/release/Alt-clear at both sizes', 'manual bar Save/reopen and detector provenance/foreign metadata', 'paused control position/seek invariance', 'acknowledged changes', 'superseded success followed by rejection', 'same-song audio handoff without count-in', 'deferred Save before navigation', 'save/reopen', 'unknown metadata', 'count-in anchor', 'tap tempo', 'fresh-process global preference restoration over song grid', 'legacy song inherits current accepted metronome preferences', 'immediate-quit preference adoption drain']}, indent=2))
    finally:
        # Both failure and success retain the isolated evidence; user files are never used.
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True)
print('PASS: hidden native metronome popover, two sizes, control receipts, tempo/meter/grid paint, save/reopen, count-in anchor, gridless/tap behavior and fresh-process preferences')
