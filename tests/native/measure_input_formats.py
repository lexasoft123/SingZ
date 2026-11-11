#!/usr/bin/env python3
"""Qualify real --measure-input WAV streaming and FFmpeg-backed AIFF fallback.

Uses an already-built helper, writes real lossless PCM fixtures, never opens an
output/audio device, and does not build/download or synthesize successful replies.
Run with an FFmpeg-enabled helper; AIFF refusal is a qualification failure.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import wave


def write_aiff(path: Path, samples: list[int], *, silent: bool = False) -> None:
    frames = len(samples)
    # AIFF extended80: 44100 = (44100 << 48) * 2^(16398 - 16383 - 63).
    rate = struct.pack('>HQ', 16398, 44100 << 48)
    comm = struct.pack('>HIH', 2, frames, 16) + rate
    pcm = b''.join(struct.pack('>hh', 0 if silent else value, 0 if silent else -value) for value in samples)
    sound = struct.pack('>II', 0, 0) + pcm
    body = b'AIFF' + b'COMM' + struct.pack('>I', len(comm)) + comm + b'SSND' + struct.pack('>I', len(sound)) + sound
    path.write_bytes(b'FORM' + struct.pack('>I', len(body)) + body)


def invoke(helper: Path, source: Path) -> subprocess.CompletedProcess:
    flags = {'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}
    return subprocess.run([str(helper), '--measure-input', str(source)], stdin=subprocess.DEVNULL,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                          encoding='utf-8', errors='replace', timeout=145, **flags)


def success(helper: Path, source: Path, frames: int, expected: float) -> dict:
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    reply = invoke(helper, source)
    assert reply.returncode == 0, (source.name, reply.returncode, reply.stderr, reply.stdout)
    actual = json.loads(reply.stdout)
    assert actual['protocol'] == 1 and actual['ok'] is True, actual
    assert actual['sampleRate'] == 44100 and actual['channels'] == 2 and actual['frames'] == frames, actual
    assert math.isfinite(actual['rms']) and actual['rms'] >= 0, actual
    assert abs(actual['rms'] - expected) < 1e-6, (source.name, expected, actual)
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before, 'Measurement changed its source'
    return {'file': source.name, 'sha256': before, 'expectedRms': expected, 'actual': actual}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--helper', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True, help='JSON evidence file; parent must exist')
    args = parser.parse_args()
    helper = args.helper.resolve(strict=True)
    records = []
    with tempfile.TemporaryDirectory(prefix='singz-measure-formats-') as temporary:
        root = Path(temporary).resolve() / '音楽-🎵'
        root.mkdir()
        samples = [round(9000 * math.sin(i * math.tau * 220 / 44100)) for i in range(22050)]
        expected = math.sqrt(sum((value / 32768) ** 2 for value in samples) / len(samples))
        wav = root / 'anti-phase.wav'
        with wave.open(str(wav), 'wb') as output:
            output.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
            output.writeframes(b''.join(struct.pack('<hh', value, -value) for value in samples))
        records.append(success(helper, wav, len(samples), expected))
        aiff = root / '歌曲-🎵.aiff'
        write_aiff(aiff, samples)
        records.append(success(helper, aiff, len(samples), expected))
        # Format authority is the source bytes, not the extension.
        disguised = root / 'aiff-named-wav.wav'
        disguised.write_bytes(aiff.read_bytes())
        records.append(success(helper, disguised, len(samples), expected))
        silence = root / 'silent.aiff'
        write_aiff(silence, samples, silent=True)
        records.append(success(helper, silence, len(samples), 0.))
        refused = []
        for name, content in [('empty.aiff', b''), ('corrupt.aiff', b'FORM\x00\x00\x00\x20AIFFtruncated'), ('unknown.bin', b'not a supported container')]:
            source = root / name
            source.write_bytes(content)
            reply = invoke(helper, source)
            assert reply.returncode != 0, (name, reply.stdout)
            assert not reply.stdout.strip(), ('Refused input must not manufacture a successful measurement', name, reply.stdout)
            refused.append({'file': name, 'returncode': reply.returncode, 'stderr': reply.stderr.strip()})
        if os.name != 'nt':
            linked = root / 'linked.aiff'
            linked.symlink_to(aiff)
            reply = invoke(helper, linked)
            assert reply.returncode != 0 and not reply.stdout.strip(), 'Linked input was accepted'
            refused.append({'file': linked.name, 'returncode': reply.returncode, 'stderr': reply.stderr.strip()})
        evidence = {'helper': str(helper), 'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
                    'checks': records, 'refused': refused, 'outputDeviceOpened': False,
                    'qualification': 'real helper PCM RMS/format admission only; not full codec matrix or playback'}
    args.out.write_text(json.dumps(evidence, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
    print(args.out)


if __name__ == '__main__':
    main()
