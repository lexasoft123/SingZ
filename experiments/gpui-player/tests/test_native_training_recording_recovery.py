#!/usr/bin/env python3
"""One hidden native recording lifecycle through owned input failure and retry.

Synthetic off-target E4 PCM is replayed by the real native input helper and real CREPE model.
Only its worker-owned child is faulted. Native recording workers are exercised;
no physical microphone/device or OS-dialog qualification, OS input, foreground activation, downloads or native builds occur.
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

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parents[1] / 'src/ui_training_recording_recovery.rs'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()


def foreground():
    if platform.system() != 'Darwin':
        return None
    p = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=3)
    return {'returncode': p.returncode, 'identity': p.stdout.strip()}


def off_target_pcm(path):
    rate = 16000
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * math.tau * 330 / rate))) for i in range(rate)))


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)
audio_helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
input_helper = app.with_name('singz-gpui-input.exe' if os.name == 'nt' else 'singz-gpui-input')
model = app.with_name('pitch') / 'crepe-tiny.bin'
assert all(p.is_file() for p in [app, audio_helper, input_helper, model]), 'Requires built ui-tests app, both native helpers and existing local CREPE model'
for name in ['result.json', 'failure.txt']:
    (out / name).unlink(missing_ok=True)
binary_hash, audio_hash, input_hash, model_hash, source_hash = map(sha, [app, audio_helper, input_helper, model, source])
front_before = foreground()
with tempfile.TemporaryDirectory(prefix='singz-training-recording-recovery-') as temporary:
    root = Path(temporary).resolve()
    fixture = root / 'synthetic-e4.wav'
    off_target_pcm(fixture)
    fixture_hash = sha(fixture)
    config = root / 'preferences'
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in {
        'SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'SINGZ_MUTE', 'SINGZ_NO_SYNC', 'SINGZ_NO_SYSTEM_ENGINES'}}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(config), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
               SINGZ_GPUI_AUDIO_HELPER=str(audio_helper), SINGZ_GPUI_INPUT_HELPER=str(input_helper),
               SINGZ_GPUI_PITCH_MODEL=str(model), SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture),
               SINGZ_GPUI_TRAINING_RECORDING_RECOVERY_TEST=str(out),
               SINGZ_GPUI_ANALYZER=str(root / 'missing-analyzer'),
               SINGZ_GPUI_LRCLIB_URL='http://127.0.0.1:1/api',
               SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
               SINGZ_DEMUCS=str(root / 'missing-demucs'))
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'native-training-recording-recovery.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)

        def sample():
            previous = None
            while not stop.wait(.4):
                if platform.system() != 'Darwin':
                    resources.append({'available': False, 'reason': 'macOS process resource counters unavailable'})
                    return
                try:
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now - started,
                            'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except (OSError, RuntimeError):
                    return

        worker = threading.Thread(target=sample, daemon=True)
        worker.start()
        try:
            child.wait(timeout=150)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            worker.join(timeout=4)
            front_after = foreground()
            (out / 'performance.json').write_text(json.dumps({
                'scope': 'GPUI main process CPU/footprint; excludes native helpers; GPU system-wide',
                'wallSeconds': time.monotonic() - started, 'samples': resources,
                'foregroundBefore': front_before, 'foregroundAfter': front_after,
                'liveFps': {'available': False, 'reason': 'hidden renders do not measure live display cadence'}}, indent=2))
    assert front_before == front_after, 'Hidden run changed foreground application'
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'native-training-recording-recovery.log').read_text()
    result = json.loads((out / 'result.json').read_text())
    flags = ['actualTrainingStart', 'native330HzPcmReplay', 'realCrepeOffTargetRespond',
             'actualFirstRecordStop', 'firstExactWorkerExport', 'actualAcceptedSecondRecording',
             'faultedInspectedOwnedNativeInput', 'samePausedSessionAndPrompt', 'specificWorkerErrorRetained',
             'cleanInputCueRecorderRelease', 'failedSecondTakeHasNoWav', 'previousOriginalAndExportByteExact',
             'actualContinue', 'freshCaptureGenerationAndPid', 'staleQueuedContinueIgnored',
             'actualThirdRecordStop', 'thirdExactWorkerExport', 'noGhostPendingOrStaleError', 'measuredRecorderLayoutNoOverlap', 'actualExitCleanup',
             'hidden', 'muted']
    assert all(result.get(key) is True for key in flags), result
    assert result['originalInputPid'] == result['killedInputPid'] > 0
    assert result['replacementInputPid'] > 0 and result['replacementInputPid'] != result['originalInputPid']
    assert result['replacementCaptureGeneration'] > result['originalCaptureGeneration'] > 0
    assert result['faultPromptIndex'] == 1 and result['retainedNativeFileCount'] == 2
    assert result['runError'] and result['recordingError']
    assert not any(result[k] for k in ['failedActiveAudioSalvaged', 'nativeOsDialogQualified', 'physicalMicrophoneQualified', 'physicalHotplugQualified'])
    assert 'no recoverable new WAV' in result['failedTakeScope']
    assert 'test chooser seam and real export worker' in result['saveChooserScope']
    assert 'Limited controller' in result['staleContinueScope'] and 'not a second rendered button click' in result['staleContinueScope']
    takes = json.loads((out / 'takes.json').read_text())
    assert takes['originalInputPid'] == takes['killedInputPid'] == result['originalInputPid']
    assert takes['replacementInputPid'] == result['replacementInputPid']
    assert takes['third']['id'] == takes['first']['id'] + 2
    assert takes['retainedNativeFileCount'] == 2
    native_files = sorted((config / 'training-recordings').glob('*.wav'))
    assert len(native_files) == 2
    assert set(native_files) == {Path(takes['first']['path']), Path(takes['third']['path'])}

    def decode(path):
        with wave.open(str(path), 'rb') as audio:
            assert audio.getnchannels() == 1 and audio.getsampwidth() == 2 and audio.getcomptype() == 'NONE'
            assert audio.getframerate() == 16000
            rate, frames = audio.getframerate(), audio.getnframes()
            pcm = audio.readframes(frames)
        assert len(pcm) == frames * 2 and .1 < frames / rate <= 30
        samples = struct.unpack(f'<{frames}h', pcm)
        rms = math.sqrt(sum(value * value for value in samples) / frames)
        crossings = sum(left <= 0 < right for left, right in zip(samples, samples[1:]))
        frequency = crossings / (frames / rate)
        assert 4000 < rms < 7000 and 320 < frequency < 340, (path, rms, frequency)
        return {'sha256': sha(path), 'bytes': path.stat().st_size, 'channels': 1, 'sampleWidth': 2,
                'sampleRate': rate, 'frames': frames, 'seconds': frames / rate,
                'pcmRms': rms, 'positiveZeroCrossingHz': frequency}

    wav_report = {}
    for label in ['first', 'third']:
        original, retained, exported = Path(takes[label]['path']), out / f'retained-{label}.wav', out / f'export-{label}.wav'
        assert original.read_bytes() == retained.read_bytes() == exported.read_bytes()
        assert sha(original) == takes[label + 'Sha256']
        assert original.resolve().is_relative_to(config.resolve() / 'training-recordings')
        assert takes[label]['sampleRate'] == 16000
        for kind, path in [('original', original), ('retained', retained), ('exported', exported)]:
            wav_report[label + '-' + kind] = decode(path)
    assert takes['first']['path'] != takes['third']['path']
    (out / 'wav-report.json').write_text(json.dumps(wav_report, indent=2))
    assert not list((config / 'training-receipts').glob('*.json')), 'Off-target uncompleted exercise recorded unexpected session history'
    sidecars = sorted(out.glob('recording-*.state.json'))
    assert len(sidecars) == 7
    assert {tuple(json.loads(p.read_text())['viewport']) for p in sidecars} == {(1280, 800), (1060, 640)}
    for sidecar in sidecars:
        state = json.loads(sidecar.read_text())
        png = sidecar.with_name(sidecar.name.removesuffix('.state.json') + '.png')
        data = png.read_bytes()
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        dimensions = list(struct.unpack('>II', data[16:24]))
        assert dimensions == state['imagePixels'] and sha(png) == state['screenshotSha256']
        assert all(abs(dimensions[i] - state['viewport'][i] * state['scale']) <= 2 for i in [0, 1])
        assert state['hidden'] and state['hiddenConfigured'] and state['mutedConfigured']
        assert not state['windowPresented'] and not state['windowActive']
        assert state['fixtureSha256'] == fixture_hash and state['binarySha256'] == binary_hash and state['testSourceSha256'] == source_hash
        assert state['session']['id'] == result['sessionId'] and state['session']['index'] == 1 and state['session']['receiptCount'] == 0
        assert 'failed second take has no recoverable WAV' in state['scope']
        layout = state['layout']
        assert layout['noOverlap'] and layout['paragraphContained'] and layout['paragraphLeftAligned']
        if state['session']['phase'] == 'Paused':
            assert layout['pausedErrorMeasured'] and not layout['guidanceAndDockRendered']
            assert layout['bar']['bottom'] <= layout['pausedError']['top']
            assert layout['pausedError']['bottom'] <= layout['continue']['top']
        else:
            assert layout['guidanceAndDockRendered']
            assert layout['bar']['bottom'] <= layout['guidance']['top'] <= layout['guidance']['bottom'] <= layout['dock']['top']
        rec = state['recording']
        assert rec['exportsPending'] == rec['promptPathsPending'] == 0
        if sidecar.name.startswith('recording-failed-'):
            assert state['session']['phase'] == 'Paused' and state['session']['error'] == result['runError']
            assert state['microphone']['phase'] == 'Off' and state['microphone']['owner'] == 0 and not state['microphone']['intent']
            assert state['training']['generation'] is None and state['training']['stopped'] >= state['training']['serial']
            assert not rec['recording'] and not rec['busy'] and rec['take'] is None and not rec['ui']['saveVisible']
            assert rec['message'] == result['recordingError']
        else:
            assert state['session']['phase'] == 'Respond' and state['session']['error'] is None
            assert state['microphone']['phase'] == 'Live' and state['microphone']['owner'] == 4 and state['microphone']['fixture']
        if sidecar.name.startswith('recording-recovered-active-'):
            assert rec['recording'] and not rec['busy'] and rec['take'] is None and not rec['ui']['saveVisible']
            assert rec['message'] != result['recordingError']
            assert state['microphone']['generation'] == result['replacementCaptureGeneration']
        elif sidecar.name.startswith('recording-recovered-retained-') or sidecar.name.startswith('recording-recovered-exported-'):
            assert not rec['recording'] and not rec['busy'] and rec['ui']['saveVisible']
            assert rec['take']['id'] == takes['third']['id'] and rec['message'].startswith('Saved ')
            assert state['microphone']['generation'] == result['replacementCaptureGeneration']
        elif sidecar.name.startswith('recording-first-retained-'):
            assert rec['take']['id'] == takes['first']['id'] and rec['ui']['saveVisible']
    (out / 'synthetic-e4.wav').write_bytes(fixture.read_bytes())
    (out / 'fixture.json').write_text(json.dumps({'appSha256': binary_hash,
        'audioHelperSha256': audio_hash, 'inputHelperSha256': input_hash, 'crepeModelSha256': model_hash,
        'testSourceSha256': source_hash, 'sourceFilesSha256': {str(p.relative_to(source.parent.parent)): sha(p) for p in [source, source.with_name('main.rs'), source.with_name('microphone.rs'), source.with_name('training_recording.rs'), source.with_name('training_recording_host.rs')]},
        'syntheticPcmSha256': fixture_hash, 'sampleRate': 16000, 'frequencyHz': 330, 'platform': platform.platform(),
        'isolatedProfilesAndLibrary': True, 'oneAppProcess': True, 'noNode': True, 'hidden': True, 'muted': True,
        'physicalMicrophoneQualified': False, 'nativeOsDialogQualified': False, 'failedActiveAudioSalvaged': False,
        'saveChooserScope': result['saveChooserScope'], 'failedTakeScope': result['failedTakeScope'],
        'productionParity': 'not evaluated'}, indent=2))
print('PASS: retained native WAV/export survive active input-child failure; failed RAM take has no WAV; explicit Continue records and exports a fresh third take')
