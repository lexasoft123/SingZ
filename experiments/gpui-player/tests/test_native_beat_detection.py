"""Hidden connected beat-analysis state/fault checks; no Node or detector-quality claim.

The app talks to its real native playback helper. A bounded Python analyzer stub
only makes asynchronous result timing and deliberate faults deterministic.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import wave

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
contract = Path(__file__).resolve().parents[3] / 'src/renderer/src/audio/analysis-contract.ts'
version = int(contract.read_text().split('export const BEAT_DETECT_VERSION = ', 1)[1].splitlines()[0].strip())

with tempfile.TemporaryDirectory(prefix='singz-beat-detection-') as temp:
    root = Path(temp).resolve()
    control = root / 'control.json'
    control.write_text(json.dumps({'mode': 'valid', 'delayMs': 0}))
    calls = root / 'calls.jsonl'
    calls.write_text('')
    # Grid visibility belongs to app-wide preferences, not the project's saved
    # metronome object. Keep the ruler controls visible in this isolated run.
    preferences = {'version': 1, 'grid': True, 'click': False, 'countInBars': 0, 'volume': .7, 'accent': True}
    (root / 'prefs').mkdir()
    (root / 'prefs/metronome.json').write_text(json.dumps(preferences))
    analyzer = root / 'analyzer'
    analyzer.write_text(f'#!{sys.executable}\n' + '''import json, os, sys, time
from pathlib import Path
control = Path(os.environ['SINGZ_GPUI_BEAT_CONTROL'])
mode = json.loads(control.read_text())
args = sys.argv[1:]
if args[:2] != ['analyze', '--beats'] or '--ml-stdin' not in args or '--drums' not in args:
    raise SystemExit('Unexpected analyzer command: ' + repr(args))
tokens = sys.stdin.read()
if 'lineStarts ' not in tokens or 'words ' not in tokens:
    raise SystemExit('Missing bounded beat auxiliary stdin')
record = {'pid': os.getpid(), 'args': args, 'tokens': tokens, 'mode': mode['mode']}
with (control.parent / 'calls.jsonl').open('a') as log:
    log.write(json.dumps(record) + '\\n')
time.sleep(mode.get('delayMs', 0) / 1000)
print(json.dumps({'diagnostic': 'deterministic app-state fixture, not detector quality'}), flush=True)
if mode['mode'] == 'notfound':
    result = {'detVersion': VERSION, 'ok': False, 'beatsSec': []}
else:
    result = {'detVersion': VERSION, 'ok': True, 'bpm': 120, 'beatsPerBar': 4,
        'downbeat': 0, 'hasDownbeats': True, 'beatsSec': [i * .5 for i in range(24)],
        'downbeats': [0, 4, 8, 12, 16, 20], 'suspectAt': [4.0]}
print(json.dumps({'beats': result}), flush=True)
'''.replace('VERSION', str(version)))
    analyzer.chmod(0o700)
    # Whole-channel RMS must retain an anti-phase stereo signal. Averaging the
    # channels before measuring would incorrectly classify this as silence.
    audio_signal = root / 'anti-phase.wav'
    samples = [int(9000 * math.sin(i * math.tau * 220 / 44100)) for i in range(44100)]
    with wave.open(str(audio_signal), 'wb') as stream:
        stream.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
        stream.writeframes(b''.join(struct.pack('<hh', v, -v) for v in samples))
    measured = subprocess.run([str(helper), '--measure-input', str(audio_signal)], capture_output=True, text=True, timeout=20)
    assert measured.returncode == 0, measured.stderr
    rms = json.loads(measured.stdout)
    expected_rms = math.sqrt(sum((v / 32768) ** 2 for v in samples) / len(samples))
    assert rms['protocol'] == 1 and rms['ok'] is True
    assert rms['channels'] == 2 and rms['frames'] == len(samples) and rms['sampleRate'] == 44100
    assert expected_rms > .004 and abs(rms['rms'] - expected_rms) < 1e-6, (rms, expected_rms)
    (out / 'measurement.json').write_text(json.dumps({'actual': rms, 'expectedRms': expected_rms, 'antiPhaseRetained': True, 'outputStreamOpened': False}, indent=2))
    audio = root / 'drums.wav'
    with wave.open(str(audio), 'wb') as stream:
        stream.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
        stream.writeframes(b''.join(struct.pack('<h', samples[i % len(samples)]) for i in range(44100 * 12)))
    def grid(bpm, source, stamp):
        times = [round(i * 60 / bpm, 6) for i in range(int(12 * bpm / 60))]
        return {'beats': times, 'bpm': bpm, 'beatsPerBar': 4, 'downbeat': 0,
            'source': source, 'detVersion': stamp, 'futureBeat': {'keep': 17}}
    initial = {}
    for name in ['missing', 'stale', 'manual', 'future', 'changed', 'cancel', 'intent']:
        folder = root / name
        (folder / 'stems').mkdir(parents=True)
        shutil.copy2(audio, folder / 'stems/drums.wav')
        settings = {'foreignSettings': {'keep': name}, 'metronome': {'grid': True, 'click': False, 'countInBars': 0, 'volume': .7, 'accent': True}}
        if name == 'stale':
            settings['beat'] = grid(90, 'auto', version - 1)
        elif name == 'manual':
            settings['beat'] = grid(100, 'manual', version - 1)
        elif name == 'future':
            settings['beat'] = grid(110, 'auto', version + 1)
        initial[name] = {'version': 2, 'name': name, 'foreign': {'keep': name}, 'settings': settings}
        (folder / 'project.json').write_text(json.dumps(initial[name]))
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR']}
    env.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_BEAT_DETECTION_TEST=str(out), SINGZ_GPUI_BEAT_FIXTURES=str(root),
        SINGZ_GPUI_BEAT_CONTROL=str(control), SINGZ_GPUI_ANALYZER=str(analyzer),
        SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'empty-library'),
        SINGZ_PACK_DIR=str(root / 'missing-pack'))
    (out / 'result.json').unlink(missing_ok=True)
    (out / 'failure.txt').unlink(missing_ok=True)
    try:
        with (out / 'app.log').open('w') as log:
            child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=os.name != 'nt')
            try:
                returncode = child.wait(timeout=150)
            finally:
                if child.poll() is None:
                    if os.name == 'nt':
                        child.kill()
                    else:
                        os.killpg(child.pid, signal.SIGKILL)
                    child.wait(timeout=5)
        assert returncode == 0 and (out / 'result.json').is_file(), (out / 'app.log').read_text()
        results = json.loads((out / 'result.json').read_text())
        assert all(results[k] for k in ['autoMissing', 'autoStale', 'autoSave', 'manualProtected', 'futureProtected',
            'explicitRedetect', 'liveUserBars', 'explicitDoesNotAutoSave', 'pendingGridControlRace', 'automaticSaveNavigationConflict', 'inputChangedRefused', 'navigationCancelled',
            'manualIntentCancelled', 'rejectedGridNotSaved', 'notFoundRetainsGrid', 'hidden', 'muted']), results
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        assert records and all('--ml-stdin' in r['args'] and 'lineStarts ' in r['tokens'] and 'words ' in r['tokens'] for r in records)
        for record in records:
            try:
                os.kill(record['pid'], 0)
            except ProcessLookupError:
                continue
            raise AssertionError(f'Analyzer survived app cleanup: {record["pid"]}')
        for name in ['missing', 'stale']:
            saved = json.loads((root / name / 'project.json').read_text())
            assert saved['settings']['beat']['source'] == 'auto' and saved['settings']['beat']['detVersion'] == version
            assert saved['settings']['beat']['bpm'] == 120
            assert saved['foreign'] == initial[name]['foreign']
            assert saved['settings']['foreignSettings'] == initial[name]['settings']['foreignSettings']
        assert json.loads((root / 'stale/project.json').read_text())['settings']['beat']['futureBeat'] == {'keep': 17}
        assert json.loads((root / 'future/project.json').read_text()) == initial['future']
        assert json.loads((root / 'changed/project.json').read_text()) == initial['changed']
        assert json.loads((root / 'cancel/project.json').read_text()) == initial['cancel']
        race_saved = json.loads((out / 'pending-grid-saved.json').read_text())
        assert race_saved['settings']['beat']['userBars'] == [3., 4.5]
        conflict = json.loads((out / 'auto-save-navigation-conflict.json').read_text())
        assert conflict['project'] == 'manual' and 'changed outside' in conflict['notice']
        assert json.loads((root / 'manual/project.json').read_text())['externalChange'] == {'keep': 'outside writer'}
        (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app), 'helperSha256': sha(helper),
            'analyzerSha256': sha(analyzer), 'audioSha256': sha(audio), 'detectorVersion': version,
            'initialProjects': initial, 'calls': records, 'hiddenConfigured': True, 'mutedConfigured': True,
            'initialGlobalMetronomePreferences': preferences,
            'reference': 'app-state and deliberate fault evidence; deterministic analyzer stub, no detector/ML quality claim',
            'nativeAdmissionRejection': 'test adapter supplies invalid grid; Rust admission refuses before native plan application',
            'noNode': True}, indent=2))
    finally:
        # A deliberately timed-out app cannot run its normal cancellation hook.
        # Reap only analyzer PIDs whose current argv still names our unique stub.
        for line in calls.read_text().splitlines():
            pid = json.loads(line)['pid']
            if os.name != 'nt':
                command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True, timeout=30)
                if str(analyzer) in command.stdout:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True)
print('PASS: hidden connected beat state, persistence, protections, cancellation, faults and native anti-phase RMS')
