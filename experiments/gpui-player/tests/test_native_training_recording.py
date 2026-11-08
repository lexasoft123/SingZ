"""Background-only real PCM replay -> native training recording -> WAV export.

Only microphone hardware is replaced by the existing PCM replay seam. Controls,
record/finish receipts, retained files and export validation use product workers.
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
import wave

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
for name in ['result.json', 'failure.txt', 'takes.json']:
    (out / name).unlink(missing_ok=True)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def foreground():
    if platform.system() != 'Darwin':
        return {'available': False, 'reason': 'lsappinfo unavailable'}
    try:
        process = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True,
                                 text=True, timeout=2, check=False)
        return {'available': process.returncode == 0, 'front': process.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'available': False, 'reason': str(error)}


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)


def decode(path):
    with wave.open(str(path), 'rb') as audio:
        assert audio.getnchannels() == 1 and audio.getsampwidth() == 2
        assert audio.getcomptype() == 'NONE' and audio.getframerate() == 16000
        rate, frames = audio.getframerate(), audio.getnframes()
        pcm = audio.readframes(frames)
    assert len(pcm) == frames * 2 and 0.1 < frames / rate <= 30
    samples = struct.unpack(f'<{frames}h', pcm)
    rms = math.sqrt(sum(value * value for value in samples) / frames)
    assert 4000 < rms < 7000, (path, rms)
    crossings = sum(left <= 0 < right for left, right in zip(samples, samples[1:]))
    frequency = crossings / (frames / rate)
    assert 320 < frequency < 340, (path, frequency)
    return {'sha256': sha(path), 'bytes': path.stat().st_size, 'sampleRate': rate,
            'frames': frames, 'seconds': frames / rate, 'pcmRms': rms,
            'positiveZeroCrossingHz': frequency}


with tempfile.TemporaryDirectory(prefix='singz-native-training-recording-') as temporary:
    root = Path(temporary).resolve()
    prefs, library = root / 'preferences', root / 'library'
    prefs.mkdir()
    library.mkdir()
    fixture = root / 'off-target-e4.wav'
    with wave.open(str(fixture), 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(index * math.tau * 330 / 16000)))
                                  for index in range(16000)))
    catalog = root / 'catalog.json'
    catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('SINGZ_GPUI_') and key not in
           ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'OneDrive']}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
        SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_CONFIG_DIR=str(prefs),
        SINGZ_GPUI_PROJECTS_ROOT=str(library), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
        SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
        SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture), SINGZ_GPUI_TRAINING_RECORDING_TEST=str(out),
        PYTHONDONTWRITEBYTECODE='1')
    before = foreground()
    samples, stopped, started = [], threading.Event(), time.monotonic()
    with (out / 'training-recording.log').open('w') as log:
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
            returncode = child.wait(timeout=85)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=4)
            raise AssertionError('Hidden native training recording exceeded 85 seconds')
        finally:
            stopped.set()
            sampling.join(timeout=3)
            after = foreground()
            (out / 'foreground.json').write_text(json.dumps({'before': before, 'after': after}, indent=2))
            (out / 'performance.json').write_text(json.dumps({'samples': samples,
                'scope': 'GPUI app CPU/footprint; native helper is separate; GPU counters are system-wide',
                'liveFps': {'available': False, 'reason': 'hidden event-driven rendering cannot establish live display cadence'}}, indent=2))
    assert returncode == 0, (returncode, (out / 'training-recording.log').read_text()[-14000:])
    assert not (out / 'failure.txt').exists()
    result = json.loads((out / 'result.json').read_text())
    assert result and all(value is True for value in result.values()), result
    if before['available'] and after['available']:
        assert before['front'] == after['front'], (before, after)
    if platform.system() == 'Darwin':
        cpu = [row['processCpuPercent'] for row in samples if 'processCpuPercent' in row]
        assert len(cpu) >= 2 and all(math.isfinite(value) and value >= 0 for value in cpu), samples
    takes = json.loads((out / 'takes.json').read_text())
    assert len(takes['inventory']) == len(takes['takes']) == 6
    assert {row['viewport'] for row in takes['takes']} == {1280, 1060}
    inventory = {}
    for item in takes['inventory']:
        original, artifact = Path(item['originalPath']), Path(item['artifact'])
        assert original.is_file() and artifact.is_file() and original.read_bytes() == artifact.read_bytes()
        inventory[artifact.name] = decode(artifact)
        assert item['bytes'] == inventory[artifact.name]['bytes']
    assert len(inventory) == 6, 'Native take filenames were reused'
    for take in takes['takes']:
        details = inventory[take['filename']]
        if 'sampleRate' in take:
            assert take['sampleRate'] == details['sampleRate']
            assert abs(take['seconds'] - details['seconds']) < .001
        if take['case'] in ['first', 'second']:
            exported = out / f"export-{take['case']}-{int(take['viewport'])}.wav"
            assert decode(exported) == details
            assert exported.read_bytes() == (out / 'retained' / take['filename']).read_bytes()
    for width in [1280, 1060]:
        assert (out / f'existing-{width}.wav').read_bytes() == b'existing destination must survive'
        for case in ['ready', 'recording', 'take-ready', 'export-error', 'navigation-retains', 'reopened-paused']:
            path = out / f'{case}-{width}.state.json'
            state = json.loads(path.read_text())
            assert state['viewport'] == [width, 800 if width == 1280 else 640]
            assert not state['windowPresented'] and not state['windowActive']
            assert state['hiddenConfigured'] and state['mutedConfigured']
            if case in ['ready', 'recording', 'take-ready', 'export-error']:
                layout = state['layout']
                assert layout['guidance']['bottom'] <= layout['dock']['top'], layout
                assert layout['bar']['bottom'] <= layout['guidance']['top'], layout
                assert 52 <= layout['guidance']['top'] < layout['guidance']['bottom'] <= state['viewport'][1]
                assert 52 <= layout['dock']['top'] < layout['dock']['bottom'] <= state['viewport'][1]
                assert layout['compact'] == (width == 1060)
                if layout['status'] is not None:
                    assert abs(layout['status']['left'] - layout['bar']['left'] - 16) <= 1, layout
                    assert layout['status']['bottom'] <= layout['bar']['bottom'], layout
            with path.with_name(path.name.replace('.state.json', '.png')).open('rb') as stream:
                header = stream.read(24)
            assert header[:8] == b'\x89PNG\r\n\x1a\n'
            assert struct.unpack('>II', header[16:24]) == tuple(round(value * state['scale']) for value in state['viewport'])
        ready = json.loads((out / f'ready-{width}.state.json').read_text())['recording']
        assert ready['fixtureInput'] and ready['inputOwner'] == 4 and ready['ui']['recordEnabled']
        active = json.loads((out / f'recording-{width}.state.json').read_text())['recording']
        assert active['recording'] and active['ui']['view']['recording']
        paused = json.loads((out / f'reopened-paused-{width}.state.json').read_text())['recording']
        assert paused['take'] is None and paused['message'] is None
        assert not paused['ui']['saveVisible'] and not paused['ui']['recordEnabled']
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app), 'fixtureSha256': sha(fixture),
        'fixture': '16000Hz mono PCM16, 330Hz off-target waveform replayed by the real native capture helper',
        'platform': platform.platform(), 'noNode': True, 'hidden': True, 'muted': True,
        'hardwareInput': False, 'syntheticRecordingReceipts': False,
        'savePrompt': 'UI-tests-only native path choice interception; actual native validation/export worker',
        'takes': inventory, 'retainedArtifacts': 'copied byte-for-byte into out/retained before isolated preferences cleanup',
        'keyboard': 'actual app-local native Tab traversal then Space starts and Enter finishes second take; exact take ID increments once and global playback remains unchanged',
        'layout': 'real bounds enforce guidance above transport and within viewport in ready/recording/take-ready/export-error; source recording paragraph left inset16 at both sizes',
        'visualReference': 'candidate-only; matched production reference absent'}, indent=2))
print('PASS: hidden real training capture, native recording and exact WAV exports at two sizes')
