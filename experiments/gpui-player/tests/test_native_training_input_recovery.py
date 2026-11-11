#!/usr/bin/env python3
"""One hidden native vocal run: owned input failure in Cue or Completing.

Synthetic A3 PCM is replayed by the real native input helper and real CREPE model.
Only its worker-owned child is faulted. No physical microphone/device/recording
qualification, OS input, foreground activation, downloads or native builds occur.
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
parser.add_argument('--completing', action='store_true', help='Fault the owned input child immediately upon second-prompt Completing, before its 250 ms score hold expires')
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
phase = 'completing' if args.completing else 'cue'
source = Path(__file__).resolve().parents[1] / 'src/ui_training_input_recovery.rs'
sha = lambda p: hashlib.sha256(Path(p).read_bytes()).hexdigest()


def foreground():
    if platform.system() != 'Darwin':
        return None
    p = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=3)
    return {'returncode': p.returncode, 'identity': p.stdout.strip()}


def a3_pcm(path):
    rate = 16000
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(i * math.tau * 220 / rate))) for i in range(rate)))


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
with tempfile.TemporaryDirectory(prefix='singz-training-input-recovery-') as temporary:
    root = Path(temporary).resolve()
    fixture = root / 'synthetic-a3.wav'
    a3_pcm(fixture)
    fixture_hash = sha(fixture)
    config = root / 'preferences'
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in {
        'SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'SINGZ_MUTE', 'SINGZ_NO_SYNC', 'SINGZ_NO_SYSTEM_ENGINES'}}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(config), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
               SINGZ_GPUI_AUDIO_HELPER=str(audio_helper), SINGZ_GPUI_INPUT_HELPER=str(input_helper),
               SINGZ_GPUI_PITCH_MODEL=str(model), SINGZ_GPUI_CAPTURE_FIXTURE=str(fixture),
               SINGZ_GPUI_TRAINING_INPUT_RECOVERY_TEST=str(out),
               SINGZ_GPUI_TRAINING_INPUT_RECOVERY_PHASE=phase,
               SINGZ_GPUI_ANALYZER=str(root / 'missing-analyzer'),
               SINGZ_GPUI_LRCLIB_URL='http://127.0.0.1:1/api',
               SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
               SINGZ_DEMUCS=str(root / 'missing-demucs'))
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'native-training-input-recovery.log').open('w') as log:
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
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'native-training-input-recovery.log').read_text()
    result = json.loads((out / 'result.json').read_text())
    flags = ['actualStart', 'nativePcmReplay', 'realCrepeFirstPrompt', 'faultedOwnedNativeInput',
             'workerErrorPausedRun', 'retainedSessionAndPrompt', 'retainedFirstReceipt', 'noInterruptedReceipt',
             'noAutomaticRetryOrScore', 'pausedOldViewIgnored', 'actualContinue', 'freshCaptureGenerationAndPid',
             'realCrepeSecondPrompt', 'completedSameSession', 'hidden', 'muted']
    assert all(result.get(key) is True for key in flags), result
    assert result['phase'] == phase and result['faultObservedPhase'] == ('Completing' if args.completing else 'Cue')
    assert result['faultPromptIndex'] == 2 and result['persistedHistoryCount'] == 1
    assert result['originalInputPid'] > 0 and result['replacementInputPid'] > 0
    assert result['originalInputPid'] != result['replacementInputPid']
    assert result['replacementCaptureGeneration'] > result['originalCaptureGeneration'] > 0
    assert result['replayCueGeneration'] > result['oldCueGeneration'] > 0
    assert result['sequenceAtFault'] > 0 and result['replaySequence'] > 0 and result['error']
    assert 'worker detects actual process/pipe error' in result['inputFaultMethod']
    assert 'only while Paused' in result['oldViewScope'] and 'no data injected into live host' in result['oldViewScope']
    assert not any(result[k] for k in ['hardwareMicrophoneQualified', 'physicalHotplugQualified', 'recordingsExercised', 'otherScreenNavigationExercised'])
    first = result['firstReceipt']
    assert first['promptIndex'] == 1 and first['response'].startswith('Vocal(')
    assert result['finalReceipts'][0] == first and len(result['finalReceipts']) == 2
    assert len(result['firstNativeVocalEvidence']) == 1 and len(result['finalNativeVocalEvidence']) == 2
    for evidence in result['finalNativeVocalEvidence']:
        assert evidence['classification'] == 'OnTarget' and evidence['voicedCoverage'] > .85
        assert evidence['detectedMidi'] is not None
    assert result['finalNativeVocalEvidence'][0] == result['firstNativeVocalEvidence'][0]
    sidecars = sorted(out.glob('input-*.state.json'))
    assert len(sidecars) == 5
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
        assert state['session']['id'] == result['sessionId'] and state['faultPhase'] == phase
        assert 'no frames injected into live host' in state['scope']
        if sidecar.name.startswith('input-failed-'):
            assert state['session']['phase'] == 'Paused' and state['session']['index'] == 2
            assert state['session']['receipts'] == [first] and state['session']['error'] == result['error']
            assert state['microphone']['phase'] == 'Off' and state['microphone']['owner'] == 0 and not state['microphone']['intent']
            assert state['training']['generation'] is None and state['training']['stopped'] >= state['training']['serial']
        elif sidecar.name.startswith('input-replayed-cue-'):
            assert state['session']['phase'] == 'Cue' and state['session']['index'] == 2
            assert state['session']['receipts'] == [first]
            assert state['microphone']['phase'] == 'Live' and state['microphone']['owner'] == 4 and state['microphone']['fixture']
            assert state['microphone']['generation'] == result['replacementCaptureGeneration']
            assert state['training']['generation'] == result['replayCueGeneration']
        elif sidecar.name.startswith('input-summary-'):
            assert state['session']['phase'] == 'Summary' and state['session']['correct'] == 2
            assert state['session']['receipts'] == result['finalReceipts']
            assert state['microphone']['phase'] == 'Off' and state['microphone']['owner'] == 0 and not state['microphone']['intent']
            assert state['training']['generation'] is None
    receipts = sorted((config / 'training-receipts').glob('*.json'))
    assert len(receipts) == 1
    receipt = json.loads(receipts[0].read_text())
    assert receipt['sessionId'] == result['sessionId'] and receipt['aggregate']['sessions'] == 1
    (out / 'persisted-training-history.json').write_text(json.dumps(receipt, indent=2))
    (out / 'synthetic-a3.wav').write_bytes(fixture.read_bytes())
    (out / 'fixture.json').write_text(json.dumps({'phase': phase, 'appSha256': binary_hash,
        'audioHelperSha256': audio_hash, 'inputHelperSha256': input_hash, 'crepeModelSha256': model_hash,
        'testSourceSha256': source_hash, 'sourceFilesSha256': {str(p.relative_to(source.parent.parent)): sha(p) for p in [source, source.with_name('main.rs'), source.with_name('microphone.rs'), source.with_name('training.rs'), source.with_name('training_run.rs')]},
        'syntheticPcmSha256': fixture_hash, 'sampleRate': 16000, 'frequencyHz': 220, 'platform': platform.platform(),
        'isolatedProfilesAndLibrary': True, 'oneAppProcess': True, 'noNode': True, 'hidden': True, 'muted': True,
        'hardwareMicrophoneQualified': False, 'physicalHotplugQualified': False,
        'nativePcmReplayAndRealCrepe': True, 'productionParity': 'not evaluated'}, indent=2))
print('PASS: real native PCM/CREPE vocal session retains first receipt across owned input failure in ' + phase + '; explicit Continue uses fresh capture and completes exactly once')
