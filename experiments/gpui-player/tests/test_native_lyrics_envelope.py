"""Offline vocal-envelope and alignment-input checks through the real helper.

No audio host is constructed by these two helper subcommands. Expected energy
uses the production first-two-channel/Float32/p90 algorithm, not RMS.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import wave

parser = argparse.ArgumentParser()
parser.add_argument('helper', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
helper, out = args.helper.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
f32 = lambda value: struct.unpack('<f', struct.pack('<f', value))[0]


def expected_envelope(rows, rate, hop_seconds):
    mono = [f32(sum(row[:2]) / 2) if len(row) > 1 else row[0] for row in rows]
    hop = max(1, math.floor(rate * hop_seconds + .5))
    result = []
    for begin in range(0, len(mono), hop):
        end = min(len(mono), begin + hop)
        total = 0.
        for index in range(begin, end):
            total += abs(mono[index])
        result.append(f32(total / (end - begin)))
    if not result:
        result = [0.]
    sorted_values = sorted(result)
    p90 = sorted_values[min(len(sorted_values) - 1, math.floor(len(sorted_values) * .9))]
    if p90 > 0:
        result = [f32(value / p90) for value in result]
    return result


def write_pcm(path, rate, rows):
    quantized = [tuple(max(-32768, min(32767, int(value))) for value in row) for row in rows]
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((len(quantized[0]), 2, rate, 0, 'NONE', 'not compressed'))
        stream.writeframes(b''.join(struct.pack('<' + 'h' * len(row), *row) for row in quantized))
    return [tuple(value / 32768 for value in row) for row in quantized]


def call(*arguments):
    return subprocess.run([str(helper), *map(str, arguments)], capture_output=True, text=True, timeout=30)


with tempfile.TemporaryDirectory(prefix='singz-lyrics-envelope-') as temp:
    root = Path(temp).resolve()
    cases = []
    patterns = [
        ('mono-silence-and-tail', 44100, [(0 if i < 4410 else math.sin(i * .13) * (1700 if i < 8820 else 19000),) for i in range(11293)]),
        ('stereo-anti-phase', 48000, [(math.sin(i * .23) * 19000, -math.sin(i * .23) * 19000) for i in range(12001)]),
        ('first-two-of-three', 16000, [(0, 0, 24000) for _ in range(3203)]),
        ('rounded-hop-at-11025', 11025, [(math.sin(i * .11) * (300 if i < 2000 else 21000), math.cos(i * .07) * 3300) for i in range(11703)]),
    ]
    fixtures = out / 'fixtures'
    fixtures.mkdir(exist_ok=True)
    for name, rate, samples in patterns:
        path = root / (name + '.wav')
        rows = write_pcm(path, rate, samples)
        result = call('--vocal-envelope', path)
        assert result.returncode == 0, (name, result.stderr)
        data = json.loads(result.stdout)
        assert data['protocol'] == 1 and data['ok'] is True
        assert data['sampleRate'] == rate and data['channels'] == len(rows[0]) and data['frames'] == len(rows)
        for key, hop in [('coarse', .05), ('fine', .01)]:
            expected = expected_envelope(rows, rate, hop)
            assert data[key]['hop'] == hop and data[key]['env'] == expected, (name, key, data[key], expected)
        if name in ['stereo-anti-phase', 'first-two-of-three']:
            assert all(value == 0 for value in data['coarse']['env'] + data['fine']['env'])
        shutil.copy2(path, fixtures / path.name)
        cases.append({'case': name, 'fixtureSha256': sha(path), 'sourceRate': rate, 'sourceChannels': len(rows[0]),
            'frames': len(rows), 'coarseFrames': len(data['coarse']['env']), 'fineFrames': len(data['fine']['env']),
            'float32Exact': True, 'result': data})

    # The alignment renderer writes exclusive source-independent float32 mono
    # at16kHz. An already16kHz stereo file has an exact downmix oracle.
    alignment = root / 'alignment.wav'
    rows = write_pcm(alignment, 16000, [(math.sin(i * .17) * 21000, math.cos(i * .09) * 13000) for i in range(8001)])
    rendered = root / 'alignment.f32'
    result = call('--render-lyrics-input', alignment, rendered)
    assert result.returncode == 0, result.stderr
    data = json.loads(result.stdout)
    assert data == {'protocol': 1, 'ok': True, 'sampleRate': 16000, 'channels': 1, 'frames': len(rows)}, data
    values = list(struct.unpack('<' + 'f' * len(rows), rendered.read_bytes()))
    assert values == [f32((row[0] + row[1]) / 2) for row in rows]
    existing_hash = sha(rendered)
    assert call('--render-lyrics-input', alignment, rendered).returncode != 0
    assert sha(rendered) == existing_hash, 'Exclusive alignment output was overwritten'
    resampled = root / 'resampled.f32'
    source = root / 'stereo-anti-phase.wav'
    result = call('--render-lyrics-input', source, resampled)
    assert result.returncode == 0, result.stderr
    resample_inventory = json.loads(result.stdout)
    assert resample_inventory['sampleRate'] == 16000 and resample_inventory['channels'] == 1
    assert resample_inventory['frames'] == math.floor(12001 * 16000 / 48000 + .5)
    assert resampled.stat().st_size == resample_inventory['frames'] * 4
    assert all(value == 0 for (value,) in struct.iter_unpack('<f', resampled.read_bytes()))

    bad = root / 'truncated.wav'
    bad.write_bytes(alignment.read_bytes()[:20])
    for command in [('--vocal-envelope', bad), ('--render-lyrics-input', bad, root / 'must-not-exist.f32')]:
        result = call(*command)
        assert result.returncode != 0, 'Truncated native input was accepted'
    assert not (root / 'must-not-exist.f32').exists()
    assert call('--vocal-envelope', root / 'missing.wav').returncode != 0
    assert call('--vocal-envelope').returncode != 0
    assert call('--render-lyrics-input', alignment).returncode != 0

    # A sparse physical-size refusal exercises the encoded cap without reading
    # or allocating a gigabyte. It is deleted before artifact copying.
    oversized = root / 'oversized.wav'
    with oversized.open('wb') as stream:
        stream.write(alignment.read_bytes()[:44])
        stream.truncate((1 << 30) + 1)
    result = call('--vocal-envelope', oversized)
    assert result.returncode != 0, 'Native encoded byte limit was not enforced'
    oversized.unlink()
    if os.name != 'nt':
        foreign = root / 'foreign.f32'
        foreign.write_bytes(b'private')
        link = root / 'linked.f32'
        link.symlink_to(foreign)
        assert call('--render-lyrics-input', alignment, link).returncode != 0
        assert foreign.read_bytes() == b'private'

    (out / 'result.json').write_text(json.dumps({'helperSha256': sha(helper), 'cases': cases,
        'exactSourceRateEnvelope': True, 'firstTwoChannels': True, 'antiPhaseCancels': True,
        'float32BeforeQuantileAndNormalization': True, 'alignment16kExactDownmix': True,
        'alignmentNativeResampling': resample_inventory, 'alignmentExclusiveOutput': True,
        'truncatedAndMissingRefused': True, 'encodedLimitRefused': True,
        'noNode': True, 'scope': 'offline helper subcommands; no musical-quality or UI-performance claim'}, indent=2))
print('PASS: source-rate vocal envelopes, exact Float32 energy and exclusive native16k alignment input')
