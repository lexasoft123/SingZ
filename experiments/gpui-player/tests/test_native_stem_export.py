"""Actual offline zCore encoders/mixer/cancellation; no fake helper or host.

Python independently checks PCM, container signatures, output publication and
cleanup. Encoded FLAC/MP3 round-trips use the real native offline decoder.
"""
import argparse
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('helper', type=Path)
parser.add_argument('--out', type=Path)
args = parser.parse_args()
helper = args.helper.resolve()
receipts = []


def evidence(completed=False):
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / 'native-stem-export.json').write_text(json.dumps({
            'completed': completed, 'engine': 'actual zCore exportAudio/exportAudioMix',
            'audioHost': 'not constructed by offline CLI', 'receipts': receipts}, indent=2))


def fixture(path, seconds=1, amplitudes=(.15,), frequencies=(220,)):
    rate = 44100
    block = b''.join(struct.pack('<h', round(amplitude * 32767 * math.sin(frame * math.tau * frequency / rate)))
                     for frame in range(rate) for amplitude, frequency in zip(amplitudes, frequencies))
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((len(amplitudes), 2, rate, 0, 'NONE', 'not compressed'))
        audio.writeframes(block * seconds)


def pcm(path):
    with wave.open(str(path), 'rb') as stream:
        assert stream.getsampwidth() == 2
        data = stream.readframes(stream.getnframes())
        return stream.getframerate(), stream.getnchannels(), list(struct.unpack(f'<{len(data)//2}h', data))


def receipt(child, staging, ok, *, cancelled=False):
    assert child.returncode == (0 if ok else 1), (child.returncode, child.stderr, child.stdout)
    lines = child.stdout.splitlines()
    assert len(lines) == 1, child.stdout
    result = json.loads(lines[0])
    receipts.append(result)
    evidence()
    assert result['protocol'] == 1 and result['ok'] == ok and result['cancelled'] == cancelled, result
    assert isinstance(result['error'], str) and len(result['error']) <= 2048, result
    if ok:
        assert staging.exists() and result['bytes'] == staging.stat().st_size > 0, result
        assert result['sampleRate'] > 0 and result['channels'] in (1, 2) and result['frames'] > 0, result
        assert abs(result['duration'] - result['frames'] / result['sampleRate']) < 1e-9, result
    else:
        assert result['error'] and result['bytes'] == result['frames'] == result['sampleRate'] == result['channels'] == 0, result
    return result


def export(format, staging, sources, *, ok=True, control=''):
    child = subprocess.run([str(helper), '--export-audio', format, str(staging), *map(str, sources)],
                           input=control, capture_output=True, text=True, timeout=45)
    result = receipt(child, staging, ok, cancelled=control == 'cancel\n')
    return result


def decode(path, target):
    child = subprocess.run([str(helper), '--render-input', str(path), str(target)],
                           capture_output=True, text=True, timeout=20)
    assert child.returncode == 0, (child.stderr, child.stdout)
    return pcm(target)


with tempfile.TemporaryDirectory(prefix='singz-native-export-') as directory:
    root = Path(directory)
    mono = root / 'Голос 🎤 source.wav'
    stereo = root / 'stereo source.wav'
    loud = root / 'loud.wav'
    fixture(mono)
    fixture(stereo, 2, (.12, .08), (440, 550))
    fixture(loud, amplitudes=(.8,))
    original = pcm(mono)[2]
    for format in ('wav', 'flac', 'mp3'):
        staging = root / f'Экспорт 🎵.{format}'
        result = export(format, staging, [mono])
        assert result['sampleRate'] == 44100 and result['channels'] == 1 and result['frames'] == 44100, result
        signature = staging.read_bytes()[:4]
        assert (format == 'wav' and signature == b'RIFF') or (format == 'flac' and signature == b'fLaC') or (
            format == 'mp3' and signature[0] == 255 and signature[1] & 224 == 224), signature
        rate, channels, decoded = decode(staging, root / f'decoded-{format}.wav')
        assert rate == 44100 and channels == 2 and len(decoded) == len(original) * 2
        left = decoded[::2]
        assert decoded[1::2] == left
        error = math.sqrt(sum((a - b) ** 2 for a, b in zip(original, left)) / len(original))
        if format != 'mp3':
            assert error <= 2, (format, error)
        else:
            # Lossy quality and real decoded PCM, not just a file signature.
            signal = math.sqrt(sum(a * a for a in original) / len(original))
            assert error / signal < .08, (format, error, signal)
    # Mix aligns sources at zero and extends to the longest; mono duplicates
    # to both stereo channels. These fixtures never require peak limiting.
    mixed = root / 'mixed.wav'
    result = export('wav', mixed, [mono, stereo])
    assert result['channels'] == 2 and result['frames'] == 88200, result
    rate, channels, actual = pcm(mixed)
    backing = pcm(stereo)[2]
    expected = [value + (original[index // 2] if index // 2 < len(original) else 0)
                for index, value in enumerate(backing)]
    assert rate == 44100 and channels == 2 and len(actual) == len(expected)
    assert max(abs(a - b) for a, b in zip(actual, expected)) <= 2
    limited = root / 'limited.wav'
    export('wav', limited, [loud, loud])
    source = pcm(loud)[2]
    actual = pcm(limited)[2]
    peak = max(abs(value) for value in source)
    expected = [round(value / peak * 32768) for value in source]
    expected = [max(-32768, min(32767, value)) for value in expected]
    assert max(abs(a - b) for a, b in zip(actual, expected)) <= 2
    assert max(actual) == 32767 and min(actual) == -32768
    capacity = root / 'all-64-sources.wav'
    result = export('wav', capacity, [mono] * 64)
    assert result['frames'] == 44100 and result['channels'] == 1, result
    capacity_pcm = pcm(capacity)[2]
    maximum = max(abs(value) for value in original)
    capacity_expected = [max(-32768, min(32767, round(value / maximum * 32768))) for value in original]
    assert max(abs(a - b) for a, b in zip(capacity_pcm, capacity_expected)) <= 2
    # Destination exclusivity and failures never erase an existing file.
    existing = root / 'existing.wav'
    existing.write_bytes(b'original user content')
    export('wav', existing, [mono], ok=False)
    assert existing.read_bytes() == b'original user content'
    broken = root / 'corrupt.wav'
    broken.write_bytes(b'not audio')
    for name, format, sources in (
        ('decode-failed.wav', 'wav', [broken]), ('missing.wav', 'wav', [root / 'absent.wav']),
        ('bad-format.wav', 'ogg', [mono]), ('no-sources.wav', 'wav', []),
        ('too-many.wav', 'wav', [mono] * 65)):
        target = root / name
        export(format, target, sources, ok=False)
        assert not target.exists(), target
    # Compacted builtin compatibility applies only to missing builtin stems,
    # never arbitrary custom tracks, corrupt existing WAVs or symlinks.
    stems = root / 'stems'
    stems.mkdir()
    compact = stems / 'vocals.flac'
    export('flac', compact, [mono])
    fallback = root / 'fallback.wav'
    export('wav', fallback, [stems / 'vocals.wav'])
    assert pcm(fallback)[2] == original
    custom = stems / 'custom.flac'
    export('flac', custom, [mono])
    export('wav', root / 'not-custom-fallback.wav', [stems / 'custom.wav'], ok=False)
    assert not (root / 'not-custom-fallback.wav').exists()
    (stems / 'vocals.wav').write_bytes(b'corrupt existing WAV, not absent')
    export('wav', root / 'not-corrupt-fallback.wav', [stems / 'vocals.wav'], ok=False)
    assert not (root / 'not-corrupt-fallback.wav').exists()
    if hasattr(os, 'symlink'):
        link = root / 'linked.wav'
        try:
            link.symlink_to(mono)
        except OSError:
            pass  # Windows hosts may not grant symlink creation.
        else:
            export('wav', root / 'not-symlink.wav', [link], ok=False)
            assert not (root / 'not-symlink.wav').exists()
        destination_link = root / 'linked-output.wav'
        try:
            destination_link.symlink_to(existing)
        except OSError:
            pass
        else:
            export('wav', destination_link, [mono], ok=False)
            assert destination_link.is_symlink() and existing.read_bytes() == b'original user content'
    if hasattr(os, 'mkfifo'):
        pipe = root / 'not-audio.wav'
        os.mkfifo(pipe)
        export('wav', root / 'not-fifo.wav', [pipe], ok=False)
        assert not (root / 'not-fifo.wav').exists()
    # A prequeued cancellation also owns disposal for tiny exports.
    cancelled = root / 'pre-cancelled.wav'
    export('wav', cancelled, [mono], ok=False, control='cancel\n')
    assert not cancelled.exists()
    # Cancel after observing the actual exclusive stage. Thirty seconds times
    # 32 sources keeps native decoding busy without a fake gate or fake PCM.
    long_source = root / 'long.wav'
    fixture(long_source, 30)
    target = root / 'cancelled-in-flight.flac'
    child = subprocess.Popen([str(helper), '--export-audio', 'flac', str(target), *([str(long_source)] * 32)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        deadline = time.monotonic() + 10
        while not target.exists() and child.poll() is None and time.monotonic() < deadline:
            time.sleep(.002)
        assert target.exists() and child.poll() is None, 'Actual export staging was not observed while native worker was active'
        stdout, stderr = child.communicate('cancel\n', timeout=15)
        completed = subprocess.CompletedProcess(child.args, child.returncode, stdout, stderr)
        receipt(completed, target, False, cancelled=True)
        assert not target.exists(), 'Cancelled native export retained partial staging'
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
    invalid_control = root / 'invalid-control.wav'
    result = export('wav', invalid_control, [mono], ok=False, control='unknown\n')
    assert result['error'] == 'Invalid export control command' and not invalid_control.exists(), result
    # Sources retain their exact original PCM throughout all operations.
    assert pcm(mono)[2] == original
    assert existing.read_bytes() == b'original user content'
evidence(completed=True)
print('PASS native stem export: real WAV/FLAC/MP3, mix/limiter, Unicode, exclusive staging, cancellation and cleanup')
