#!/usr/bin/env python3
"""Real native WAV publication collision, retained recovery capability and repeated Save.

Synthetic off-target E4 PCM is replayed by the real native input helper and real CREPE model.
Controlled unrelated sentinel files block host publication or helper-stage promotion.
No disk-full, physical microphone/device or native OS-dialog qualification, OS input, foreground activation, downloads or native builds occur.
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
parser.add_argument('--helper-stage', action='store_true', help='Block native helper stage promotion rather than host flat-root publication with an unrelated sentinel file')
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
source = Path(__file__).resolve().parents[1] / 'src/ui_recording_publication_recovery.rs'
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
with tempfile.TemporaryDirectory(prefix='singz-recording-publication-recovery-') as temporary:
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
               SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_TEST=str(out),
               SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_STAGE='helper' if args.helper_stage else 'host',
               SINGZ_GPUI_ANALYZER=str(root / 'missing-analyzer'),
               SINGZ_GPUI_LRCLIB_URL='http://127.0.0.1:1/api',
               SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
               SINGZ_DEMUCS=str(root / 'missing-demucs'))
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'native-recording-publication-recovery.log').open('w') as log:
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
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'native-recording-publication-recovery.log').read_text()
    result = json.loads((out / 'result.json').read_text())
    flags = ['actualTrainingStart', 'native330HzPcmReplay', 'realCrepeOffTargetRespond', 'actualRecordStop',
             'controlledSentinelCollision', 'recoveryBackedTake', 'sameNativeInputGenerationAndPid',
             'exactValidatedNativeRecoverySource', 'actualFailedSave', 'failedSaveRetainsRecovery',
             'failedSaveStillPromotesFlatRoot', 'actualSuccessfulSave', 'successfulSaveClearsError',
             'actualRepeatedSave', 'stableOwnedPromotion', 'unrelatedSentinelByteExact', 'sameExerciseNoScore',
             'hidden', 'muted']
    assert all(result.get(key) is True for key in flags), result
    stage = 'helper' if args.helper_stage else 'host'
    assert result['stage'] == stage and result['captureGeneration'] > 0 and result['inputPid'] > 0
    assert result['takeId'] > 0 and result['failedSaveError']
    assert not any(result[key] for key in ['hardwareMicrophoneQualified', 'nativeOsDialogQualified', 'diskFullQualified'])
    assert 'Controlled unrelated sentinel file collision' in result['faultScope']
    assert 'test-only' in result['chooserScope'] and 'native OS dialog not qualified' in result['chooserScope']
    source_path, staged, directory = map(Path, [result['source'], result['staged'], result['directory']])
    barrier, promoted = Path(result['barrier']), Path(result['promotedFlatRoot'])
    assert directory.resolve() == config.resolve() / 'training-recordings'
    source_root = source_path.parent.parent.parent if args.helper_stage else source_path.parent.parent
    assert source_root.samefile(directory), 'Recovery must remain inside its exact owned recording root'
    assert result['take']['recovery'] and result['take']['path'] == result['take']['recoveryPath'] == result['source']
    assert result['take']['id'] == result['takeId'] and result['take']['sampleRate'] == 16000
    if args.helper_stage:
        assert barrier == staged
        expected_source = staged.parent / f'.writing-{result["takeId"]}' / result['filename']
        assert source_path.name == expected_source.name and source_path.samefile(expected_source)
        assert source_path.parent.samefile(expected_source.parent)
    else:
        assert barrier == directory / result['filename']
        assert source_path.name == staged.name and source_path.samefile(staged)
        assert source_path.parent.samefile(staged.parent)
    assert barrier.read_bytes() == (out / 'unrelated-sentinel.bin').read_bytes()
    assert sha(barrier) == result['barrierSha256']
    assert Path(result['failedSaveDestination']).read_bytes() == (out / 'unrelated-sentinel.bin').read_bytes()
    assert promoted.parent == directory and promoted != barrier and promoted.is_file()
    native_bytes = (out / 'recovery-original.wav').read_bytes()
    assert sha(source_path) == result['sourceSha256']
    assert all(p.read_bytes() == native_bytes for p in [source_path, promoted, out / 'promoted-flat-root.wav', out / 'export-recovered.wav', out / 'export-again.wav'])
    stat = promoted.stat()
    assert stat.st_size == result['promotedIdentity']['bytes']
    if os.name != 'nt':
        assert stat.st_ino == result['promotedIdentity']['inode'] and stat.st_dev == result['promotedIdentity']['device']
    flat_wavs = [p for p in directory.glob('*.wav') if p.read_bytes().startswith(b'RIFF')]
    assert flat_wavs == [promoted]

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
        hz = crossings / (frames / rate)
        assert 4000 < rms < 7000 and 320 < hz < 340, (path, rms, hz)
        return {'sha256': sha(path), 'bytes': path.stat().st_size, 'sampleRate': rate, 'channels': 1,
                'sampleWidth': 2, 'frames': frames, 'seconds': frames / rate,
                'pcmRms': rms, 'positiveZeroCrossingHz': hz}

    wav_report = {name: decode(out / name) for name in ['recovery-original.wav', 'promoted-flat-root.wav', 'export-recovered.wav', 'export-again.wav']}
    wav_report['native-recovery-source'] = decode(source_path)
    wav_report['native-flat-root'] = decode(promoted)
    (out / 'wav-report.json').write_text(json.dumps(wav_report, indent=2))
    assert not list((config / 'training-receipts').glob('*.json')), 'Off-target unfinished exercise produced unexpected completion history'
    sidecars = sorted(out.glob('publication-*.state.json'))
    assert len(sidecars) == 6
    assert {tuple(json.loads(p.read_text())['viewport']) for p in sidecars} == {(1280, 800), (1060, 640)}
    for sidecar in sidecars:
        state = json.loads(sidecar.read_text())
        assert state['layout']['noOverlap'] and state['layout']['paragraphContained']
        assert state['layout']['paragraphLeftAligned'] and state['layout']['guidanceAndDockRendered']
        png = sidecar.with_name(sidecar.name.removesuffix('.state.json') + '.png')
        data = png.read_bytes()
        assert data[:8] == b'\x89PNG\r\n\x1a\n'
        dimensions = list(struct.unpack('>II', data[16:24]))
        assert dimensions == state['imagePixels'] and sha(png) == state['screenshotSha256']
        assert all(abs(dimensions[i] - state['viewport'][i] * state['scale']) <= 2 for i in [0, 1])
        assert state['hidden'] and state['hiddenConfigured'] and state['mutedConfigured']
        assert not state['windowPresented'] and not state['windowActive']
        assert state['fixtureSha256'] == fixture_hash and state['binarySha256'] == binary_hash and state['testSourceSha256'] == source_hash
        assert state['faultStage'] == stage and state['session']['id'] == result['sessionId']
        assert state['session']['phase'] == 'Respond' and state['session']['index'] == 1
        assert state['session']['receiptCount'] == 0 and state['session']['error'] is None and state['notice'] is None
        assert state['microphone']['phase'] == 'Live' and state['microphone']['owner'] == 4 and state['microphone']['fixture']
        assert state['microphone']['generation'] == result['captureGeneration']
        recording = state['recording']
        assert recording['exportsPending'] == recording['promptPathsPending'] == 0
        assert not recording['recording'] and not recording['busy'] and recording['ui']['saveVisible']
        assert recording['take']['recovery'] and recording['take']['id'] == result['takeId']
        assert recording['take']['path'] == recording['take']['recoveryPath'] == result['source']
        if sidecar.name.startswith('publication-export-error-'):
            assert recording['message'] == result['failedSaveError']
        elif sidecar.name.startswith('publication-exported-') or sidecar.name.startswith('publication-repeated-'):
            assert recording['message'] and recording['message'] != result['failedSaveError']
    (out / 'synthetic-e4.wav').write_bytes(fixture.read_bytes())
    (out / 'fixture.json').write_text(json.dumps({'stage': stage, 'appSha256': binary_hash,
        'audioHelperSha256': audio_hash, 'inputHelperSha256': input_hash, 'crepeModelSha256': model_hash,
        'testSourceSha256': source_hash, 'sourceFilesSha256': {str(p.relative_to(source.parent.parent)): sha(p) for p in [source, source.with_name('main.rs'), source.with_name('microphone.rs'), source.with_name('training_recording.rs'), source.with_name('training_recording_host.rs'), source.with_name('training_recording_store.rs'), source.with_name('recording_recovery.rs')]},
        'syntheticPcmSha256': fixture_hash, 'sampleRate': 16000, 'frequencyHz': 330, 'platform': platform.platform(),
        'isolatedProfilesAndLibrary': True, 'oneAppProcess': True, 'noNode': True, 'hidden': True, 'muted': True,
        'hardwareMicrophoneQualified': False, 'nativeOsDialogQualified': False, 'diskFullQualified': False,
        'faultScope': result['faultScope'], 'chooserScope': result['chooserScope'],
        'productionParity': 'not evaluated'}, indent=2))
print('PASS: controlled ' + stage + ' publication collision retains validated native WAV; failed Save preserves recovery; successful/repeated Save promotes one stable flat file and exact exports')
