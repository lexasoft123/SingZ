"""Hidden muted timing UI, actual native rate/count-in receipts, durable restart.

Frozen analysis snapshots are candidate visuals, not inference or live-FPS proof.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)


def foreground():
    if platform.system() != 'Darwin':
        return None
    return subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=2).stdout.strip()


def audio(path, frequency):
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 16000
    second = b''.join(struct.pack('<h', round(1000 * math.sin(i * math.tau * frequency / rate))) for i in range(rate))
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        stream.writeframes(second * 30)


def inventory(directory):
    return {str(path.relative_to(directory)): {'bytes': path.stat().st_size, 'sha256': sha(path)}
            for path in directory.rglob('*') if path.is_file()}


def launch(environment, folder):
    folder.mkdir(parents=True, exist_ok=True)
    before = foreground()
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (folder / 'timing.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT)
        baseline, baseline_record, sampling_errors = None, None, []
        if platform.system() == 'Darwin':
            try:
                cpu, memory = perf.process_usage(child.pid)
                now = time.monotonic()
                assert math.isfinite(cpu) and cpu >= 0 and memory >= 0, (cpu, memory)
                baseline = cpu, now
                baseline_record = {'elapsedSeconds': now-started, 'processCpuNanoseconds': cpu,
                                   'processFootprintBytes': memory}
            except OSError as error:
                sampling_errors.append({'phase': 'immediate-baseline', 'errno': error.errno, 'error': str(error)})
        def sample():
            previous, intervals = baseline, 0
            # Two short intervals cover genuine fast restart processes. Later
            # observations use the normal cadence; the app is never held idle.
            while not stop.wait(.1 if intervals < 2 else .5):
                try:
                    if platform.system() != 'Darwin':
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now-started,
                            'processCpuPercent': (cpu-previous[0])/((now-previous[1])*1e9)*100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                        intervals += 1
                    previous = cpu, now
                except OSError as error:
                    sampling_errors.append({'phase': 'interval', 'errno': error.errno, 'error': str(error)})
                    return
        thread = threading.Thread(target=sample, daemon=True)
        thread.start()
        try:
            child.wait(timeout=120)
            process_lifetime = time.monotonic()-started
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            thread.join(timeout=4)
    after = foreground()
    (folder / 'foreground.json').write_text(json.dumps({'before': before, 'after': after,
        'unchanged': before == after, 'method': 'read-only; no activation or global input'}, indent=2))
    cpu = [row['processCpuPercent'] for row in resources if 'processCpuPercent' in row]
    availability = {'available': bool(cpu), 'intervalCount': len(cpu)}
    if not cpu:
        availability['reason'] = ('macOS counters unavailable on this platform' if platform.system() != 'Darwin'
            else 'Process exited before two readable CPU samples were available' if process_lifetime < .25
            else 'Process CPU counters failed to produce an interval; see samplingErrors')
    (folder / 'performance.json').write_text(json.dumps({'samples': resources,
        'baseline': baseline_record, 'samplingErrors': sampling_errors, 'cpuAvailability': availability,
        'processLifetimeSeconds': process_lifetime, 'samplingIntervalsSeconds': [.1, .1, .5],
        'scope': 'GPUI process CPU/footprint; native helper separate; GPU system-wide',
        'liveFps': {'available': False, 'reason': 'Hidden macOS windows suspend display callbacks'},
        'frozenAnalysis': 'candidate screenshot only; does not establish native inference'}, indent=2))
    assert child.returncode == 0 and (folder / 'result.json').exists(), (folder / 'timing.log').read_text()
    if platform.system() == 'Darwin':
        assert all(math.isfinite(value) and value >= 0 for value in cpu), resources
        # Missing intervals are legitimate only for an observed very short
        # process, and remain explicitly unavailable rather than a fake zero.
        assert cpu or process_lifetime < .25, (availability, sampling_errors, process_lifetime)


with tempfile.TemporaryDirectory(prefix='singz-timing-ui-') as directory:
    root = Path(directory).resolve()
    library = root / 'library'
    project, gridless, variable, same = [library / name for name in ('Timing fixture', 'Gridless fixture', 'Variable bars', 'Same BPM fixture')]
    for path in (project, variable):
        audio(path / 'stems/vocals.wav', 220)
        audio(path / 'stems/bass.wav', 110)
    audio(gridless / 'song.wav', 330)
    beat = {'beats': [i*.5 for i in range(60)], 'bpm': 120, 'beatsPerBar': 4, 'downbeat': 0,
            'downbeats': list(range(0, 60, 4)), 'autoDownbeats': list(range(0, 60, 4)),
            'source': 'auto', 'detVersion': 23, 'futureTiming': {'keep': True}}
    original = {'version': 2, 'name': 'Timing fixture', 'foreign': {'preserve': 17}, 'settings': {
        'tempo': 1, 'transpose': -2, 'masterVolume': .61, 'loop': True,
        'selection': {'s': 3, 'e': 11}, 'view': {'s': 1, 'e': 25},
        'tracks': {'vocals': {'volume': .37, 'muted': False, 'solo': False},
                   'bass': {'volume': .7, 'muted': True, 'solo': False}},
        'beat': beat, 'melody': {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400']*3000)},
        'metronome': {'click': False, 'countInBars': 0, 'volume': .3, 'accent': True, 'grid': False}}}
    (project / 'project.json').write_text(json.dumps(original))
    (project / 'foreign.txt').write_text('Preserve foreign content byte for byte.')
    (gridless / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Gridless fixture', 'songFile': 'song.wav',
        'settings': {'tempo': 1, 'metronome': {'click': False, 'countInBars': 0, 'volume': .3, 'accent': True, 'grid': False}},
        'foreign': {'gridless': True}}))
    # Three beats in the entry bar, then four, with an explicitly shifted
    # downbeat and actual variable bar-map evidence supplied to the native core.
    variable_raw = json.loads(json.dumps(original))
    variable_raw['name'] = 'Variable bars'
    variable_raw['settings']['loop'] = False
    variable_raw['settings']['beat'].update({'beats': [i*.25 for i in range(120)], 'bpm': 240,
        'beatsPerBar': 4, 'downbeat': 1, 'downbeats': [0, 3, 7, 10, 14, 17, 21, 24, 28, 31, 35, 38, 42, 45, 49, 52, 56, 59, 63, 66, 70, 73, 77, 80, 84, 87, 91, 94, 98, 101, 105, 108, 112, 115, 119],
        'autoDownbeats': [0, 3, 7, 10, 14, 17, 21, 24, 28, 31, 35, 38, 42, 45, 49, 52, 56, 59, 63, 66, 70, 73, 77, 80, 84, 87, 91, 94, 98, 101, 105, 108, 112, 115, 119], 'source': 'manual'})
    (variable / 'project.json').write_text(json.dumps(variable_raw))
    shutil.copytree(project, same)
    same_raw = json.loads(json.dumps(original))
    same_raw['name'] = 'Same BPM fixture'
    (same / 'project.json').write_text(json.dumps(same_raw))
    before = {str(path): inventory(path) for path in (project, gridless, variable, same)}
    environment = {key: value for key, value in os.environ.items()
        if not key.startswith('SINGZ_GPUI_') and key not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS')}
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
        SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(library),
        SINGZ_GPUI_TEST_PROJECT=str(project), SINGZ_GPUI_TIMING_GRIDLESS=str(gridless),
        SINGZ_GPUI_TIMING_VARIABLE=str(variable), SINGZ_GPUI_TIMING_SAME_BPM=str(same), SINGZ_GPUI_RATE_RECEIPT_GATE=str(root / 'rate.gate'),
        SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app), 'helperSha256': sha(helper),
        'source': 'Transport.tsx BpmEntry/CountInDots', 'project': original, 'variable': variable_raw,
        'inventory': before, 'viewports': [[1280,800],[1060,640]], 'hidden': True, 'muted': True,
        'noNode': True, 'productionParity': 'unqualified; native candidate frames only'}, indent=2))
    try:
        for stage in ('exercise', 'restart'):
            folder = out / stage
            launch({**environment, 'SINGZ_GPUI_TRANSPORT_TIMING_TEST': str(folder), 'SINGZ_GPUI_TIMING_STAGE': stage}, folder)
            for path in (project, gridless, variable, same):
                actual = inventory(path)
                for name, stamp in before[str(path)].items():
                    if name != 'project.json':
                        assert actual[name] == stamp, (path, name, actual[name], stamp)
        queued = json.loads((out / 'exercise' / 'queued-save-project.json').read_text())
        assert queued['settings']['tempo'] == 1.25 and queued['foreign'] == original['foreign']
        saved = json.loads((project / 'project.json').read_text())
        assert abs(saved['settings']['tempo'] - 1.25) < 1e-6, saved
        assert saved['foreign'] == original['foreign']
        assert saved['settings']['tracks'] == original['settings']['tracks']
        assert saved['settings']['selection'] == original['settings']['selection'] and saved['settings']['loop'] is True
        assert saved['settings']['beat'] == beat
        for width,height in ((1280,800),(1060,640)):
            ready = json.loads((out / 'exercise' / f'ready-{width}.json').read_text())
            typed = json.loads((out / 'exercise' / f'typed-{width}.json').read_text())
            assert ready['viewport'] == typed['viewport'] == [width,height] and typed['hidden']
            assert typed['timing']['inputValue'] == '150' and typed['timing']['effectiveBpm'] == 150
            restarted = json.loads((out / 'restart' / f'saved-restart-{width}.json').read_text())
            assert restarted['viewport'] == [width,height] and restarted['timing']['effectiveBpm'] == 150 and restarted['timing']['dots'] == ''
            for action in ('button', 'space', 'rapid-buttons', 'rapid-buttons-final-play'):
                held = json.loads((out / 'exercise' / f'held-rate-{action}-pending-{width}.json').read_text())
                final_playing = action == 'rapid-buttons-final-play'
                suffix = 'playing' if final_playing else 'paused'
                paused = json.loads((out / 'exercise' / f'held-rate-{action}-{suffix}-{width}.json').read_text())
                assert held['ratePending'] is True and held['viewport'] == [width,height]
                assert paused['playing'] is final_playing and paused['native']['playing'] is final_playing and paused['ratePending'] is False
                assert paused['playIntent'] is None and paused['playIntentSerial'] is None
                assert paused['viewport'] == [width,height] and paused['hidden']
                assert held['playIntent'] is final_playing and held['playIntentSerial'] > 0, held
                ack_trace = json.loads((out / 'exercise' / f'held-rate-{action}-ack-trace-{width}.json').read_text())
                assert ack_trace['latestSerial'] == held['playIntentSerial'] and ack_trace['targetPlaying'] is final_playing
                for field in ('gain', 'solo', 'master', 'transpose', 'selection', 'loop'):
                    assert paused[field] == ready[field], (action, field, paused[field], ready[field])
                native_bass = next(lane for lane in paused['native']['observedLanes'] if lane['id'] == 'bass')
                if action == 'button':
                    assert native_bass['muted'] is False
                    restored_mix = json.loads((out / 'exercise' / f'held-rate-mixer-restored-{width}.json').read_text())
                    assert restored_mix['muted'] == ready['muted']
                    assert next(lane for lane in restored_mix['native']['observedLanes'] if lane['id'] == 'bass')['muted'] is True
                else:
                    assert paused['muted'] == ready['muted'] and native_bass['muted'] is True
            same_state = json.loads((out / 'exercise' / f'same-bpm-reset-{width}.json').read_text())
            assert same_state['timing']['inputValue'] == '120' and same_state['timing']['draft'] is None and not same_state['timing']['inputFocused']
            analysis = json.loads((out / 'exercise' / f'frozen-analysis-candidate-{width}.json').read_text())
            assert analysis['timing']['analysisPercent'] == 42 and analysis['timing']['enabled'] is False
            for case in ('grid','gridless','variable'):
                trace = json.loads((out / 'exercise' / f'live-{case}-{width}.json').read_text())
                steps = [row['timing']['countIn'] for row in trace if row['timing']['countIn'] is not None]
                assert len({row['done'] for row in steps}) >= 2
                assert [row['done'] for row in steps] == sorted(row['done'] for row in steps)
                for row in steps:
                    assert row['total'] == row['perBar'] * (2 if case == 'grid' else 1)
            stale = json.loads((out / 'exercise' / f'stale-rejected-{width}.json').read_text())
            assert stale['timing']['dots'] == '' and stale['timing']['baseBpm'] is None and not stale['playing']
        assert inventory(same) == before[str(same)], 'Uncommitted old-song BPM draft changed the same-BPM project'
        failure = json.loads((out / 'exercise' / 'rate-failure-notice.json').read_text())
        assert 'Queued Save did not run' in failure['notice']
        assert failure['ratePending'] is False and failure['rateQueued'] is None and failure['rateSaveRequested'] is False
        assert failure['rateNavigation'][0] == str(gridless) and failure['project'] is None
        after_ack = json.loads((out / 'exercise' / 'rate-failure-navigation-after-ack.json').read_text())
        assert after_ack['notice'] is None and after_ack['project'] == str(gridless)
        (out / 'saved-project.json').write_text(json.dumps(saved, indent=2))
    finally:
        for path in (project, gridless, variable, same):
            shutil.copytree(path, out / ('final-' + path.name), dirs_exist_ok=True)
print('PASS hidden transport timing: native BPM edits/count-in clocks, grouped dots, cancellation/navigation and restart')
