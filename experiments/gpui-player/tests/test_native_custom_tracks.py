"""Actual native helper lane transactions; fake AUDIO HOST only, real decoder/DSP.

No UI, Node or synthetic helper replies. Every lane is decoded from an ordinary
fixture file. The unmuted test has the explicit fake-host flag and no hardware.
"""
import argparse
import json
import math
import os
from pathlib import Path
import queue
import struct
import subprocess
import tempfile
import threading
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('helper', type=Path)
parser.add_argument('--out', type=Path)
args = parser.parse_args()
helper = args.helper.resolve()
receipts = []


def audio(path, seconds, amplitude=.1, frequency=220):
    rate = 48000
    block = b''.join(struct.pack('<h', round(amplitude * 32767 * math.sin(index * math.tau * frequency / rate)))
                     for index in range(rate))
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        stream.writeframes(block * seconds)


class Session:
    def __init__(self, lanes, muted=True):
        environment = dict(os.environ)
        if muted:
            environment['SINGZ_MUTE'] = '1'
        else:
            environment.pop('SINGZ_MUTE', None)
        self.child = subprocess.Popen([str(helper), '--test-fake-host',
            *[part for lane in lanes for part in [lane[0], str(lane[1])]]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=environment)
        self.lines = queue.Queue()

        def reader():
            for line in self.child.stdout:
                self.lines.put(line)
            self.lines.put(None)

        self.thread = threading.Thread(target=reader, daemon=True)
        self.thread.start()
        self.initial = self.read()
        assert self.initial['ok'], self.initial

    def read(self):
        try:
            line = self.lines.get(timeout=55)
        except queue.Empty:
            raise AssertionError('Native lane helper did not reply within its bounded prepare deadline')
        assert line, ('Native helper exited', self.child.poll(), self.child.stderr.read())
        value = json.loads(line)
        assert value['protocol'] == 1, value
        receipts.append(value)
        if args.out:
            args.out.mkdir(parents=True, exist_ok=True)
            (args.out / 'native-custom-lanes.json').write_text(json.dumps({'receipts': receipts, 'completed': False}, indent=2, ensure_ascii=False))
        return value

    def command(self, text, ok=True):
        self.child.stdin.write(text + '\n')
        self.child.stdin.flush()
        value = self.read()
        assert value['ok'] == ok, (text[:160], value)
        return value

    def eventually(self, predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            value = self.command('status')
            if predicate(value):
                return value
            time.sleep(.02)
        raise AssertionError(value)

    def replace(self, lanes, ok=True):
        self.command(f'lanes-begin {len(lanes)}')
        for identifier, path in lanes:
            self.command(f'lanes-add {identifier.encode().hex()} {str(path).encode().hex()}')
        value = self.command('lanes-apply', ok=ok)
        assert value['lanesCommitted'] == ok, value
        if ok:
            assert value['laneIds'] == [identifier for identifier, _ in lanes]
        return value

    def close(self):
        if self.child.poll() is None:
            self.child.stdin.write('quit\n')
            self.child.stdin.flush()
            try:
                assert self.child.wait(timeout=8) == 0
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=3)
                raise AssertionError('Native helper did not cleanly unload')
        self.thread.join(timeout=1)


def f32(value):
    return struct.unpack('<f', struct.pack('<f', value))[0]


def assert_waveforms(status, sources):
    """Native `peaks` is the unchanged 96-bucket source RMS envelope.

    Decode integer PCM independently with Python wave; compare every bucket,
    not an amplitude threshold. These fixtures match the fake host's 48kHz,
    so no resampling oracle or renderer implementation is involved.
    """
    assert status['sampleRate'] == 48000, status
    assert len(status['peaks']) == len(sources), status
    for index, path in enumerate(sources):
        with wave.open(str(path), 'rb') as source:
            assert source.getnchannels() == 1 and source.getsampwidth() == 2
            assert source.getframerate() == 48000
            frames = source.getnframes()
            values = struct.unpack(f'<{frames}h', source.readframes(frames))
        expected = []
        for bucket in range(96):
            begin = bucket * frames // 96
            end = min(frames, max(begin + 1, (bucket + 1) * frames // 96))
            energy = sum((value / 32768) ** 2 for value in values[begin:end])
            expected.append(f32(math.sqrt(energy / (end - begin))))
        actual = status['peaks'][index]
        assert len(actual) == 96
        errors = [abs(left - right) for left, right in zip(actual, expected)]
        assert max(errors) < 1e-7, {
            'lane': status['laneIds'][index], 'path': str(path), 'scale': 'source PCM RMS per bucket',
            'actual': actual, 'expected': expected, 'maximumError': max(errors)}


def lanes(status):
    return {lane['id']: (lane['gain'], lane['muted'], lane['solo']) for lane in status['lanes']}


with tempfile.TemporaryDirectory(prefix='singz-native-custom-lanes-') as temporary:
    root = Path(temporary).resolve()
    base, longer, alternate, broken = [root / name for name in
        ['Vocals — голос.wav', 'longer custom 🎤.wav', 'same-ID new bytes.wav', 'corrupt.wav']]
    audio(base, 4)
    audio(longer, 8, .2, 330)
    audio(alternate, 4, .3, 440)
    broken.write_bytes(b'not an audio container')
    truncated = root / 'truncated.wav'
    truncated.write_bytes(base.read_bytes()[:144])
    session = Session([('vocals', base)])
    try:
        assert abs(session.initial['duration'] - 4) < .001
        # Initially Prepared (no callback yet): safe candidate adoption must
        # keep transport paused and preserve controls on the retained ID.
        session.command('lane 0 .37 1 1')
        added = session.replace([('vocals', base), ('custom-🎤', longer)])
        assert not added['playing'] and abs(added['duration'] - 8) < .001, added
        assert lanes(added)['vocals'] == (f32(.37), True, True), added
        assert lanes(added)['custom-🎤'] == (1, False, False), added
        assert len(added['peaks']) == 2 and all(len(row) == 96 for row in added['peaks'])
        assert_waveforms(added, [base, longer])
        session.command('lane 0 .37 0 0')
        session.command('lane 1 .61 1 0')
        session.command('rate .8 -2')
        session.command('met-begin 1 0 .4 1 4 0 8 2')
        session.command('met-beats 0 8 0 1 2 3 4 5 6 7')
        session.command('met-bars 0 2 0 4')
        session.command('met-apply')
        session.command('loop 1 7')
        session.command('play')
        running = session.eventually(lambda s: s['playing'] and s['position'] > .1)
        same = session.replace([('custom-🎤', longer), ('vocals', alternate)])
        assert same['playing'] and same['graphGeneration'] > running['graphGeneration'], same
        assert same['streamGeneration'] == running['streamGeneration'], 'Lane update reopened physical stream'
        assert abs(same['playbackRate'] - .8) < 1e-8 and same['transpose'] == -2
        assert same['looping'] and abs(same['loopStart'] - 1) < .001 and abs(same['loopEnd'] - 7) < .001
        assert lanes(same) == {'custom-🎤': (f32(.61), True, False), 'vocals': (f32(.37), False, False)}, same
        assert_waveforms(same, [longer, alternate])
        assert same['metronomeClick'] and same['metronomeAccent'] and same['metronomeBeats'] == 8
        assert abs(same['metronomeVolume'] - .4) < 1e-8
        # Rewrite the identical path after it has been decoded. Replacement
        # must consume new bytes, not adopt prior PCM based only on its path.
        audio(alternate, 4, .24, 440)
        same = session.replace([('custom-🎤', longer), ('vocals', alternate)])
        assert_waveforms(same, [longer, alternate])
        old_generation, old_stream = same['graphGeneration'], same['streamGeneration']
        # Failures must retain prior lane identities, mix, duration and live
        # commands, rather than retiring the usable graph before decoding.
        for bad in [root / 'missing.wav', broken, truncated, root]:
            rejected = session.replace([('vocals', alternate), ('bad-candidate', bad)], ok=False)
            assert rejected['graphGeneration'] == old_generation and rejected['streamGeneration'] == old_stream
            assert rejected['playing'] and abs(rejected['duration'] - 8) < .001
            assert lanes(rejected) == lanes(same)
            session.command('pause')
            session.eventually(lambda s: not s['playing'])
            session.command('play-flat')
            session.eventually(lambda s: s['playing'])
        # Every malformed transaction is discarded; apply cannot consume its
        # valid prefix, and subsequent status/pause/play remain usable.
        invalid_rows = [
            f'lanes-add {"duplicate".encode().hex()} {str(base).encode().hex()}',
            'lanes-add 00 00',
            f'lanes-add c0af {str(base).encode().hex()}',
            f'lanes-add {("x" * 129).encode().hex()} {str(base).encode().hex()}',
            f'lanes-add 61 {"relative.wav".encode().hex()}',
            f'lanes-add 61 {("/" + "a" * 1800).encode().hex()}',
        ]
        for row in invalid_rows:
            session.command('lanes-begin 2')
            session.command(f'lanes-add {"duplicate".encode().hex()} {str(base).encode().hex()}')
            session.command(row, ok=False)
            invalid = session.command('lanes-apply', ok=False)
            assert invalid['graphGeneration'] == old_generation and lanes(invalid) == lanes(same)
        session.command('lanes-begin 17', ok=False)
        session.command('lanes-apply', ok=False)
        session.command('lanes-begin 1')
        session.command('x' * 4097, ok=False)
        session.command('lanes-apply', ok=False)
        session.command('lanes-begin 1')
        session.command('lanes-cancel')
        session.command('lanes-apply', ok=False)
        # Removing the longest lane changes duration and clamps an existing
        # loop to that real duration; no lane index is mistaken for its ID.
        removed = session.replace([('vocals', alternate)])
        assert abs(removed['duration'] - 4) < .001 and lanes(removed) == {'vocals': (f32(.37), False, False)}
        assert removed['looping'] and abs(removed['loopStart'] - 1) < .001 and abs(removed['loopEnd'] - 4) < .001
        assert_waveforms(removed, [alternate])
        # No built-in roles are required: all sixteen stable IDs are legal.
        capacity = session.replace([(f'custom-{index}', base) for index in range(16)])
        assert len(capacity['lanes']) == len(capacity['peaks']) == 16
        assert set(lanes(capacity)) == {f'custom-{index}' for index in range(16)}
        assert all(control == (1, False, False) for control in lanes(capacity).values())
        assert capacity['masterGain'] == 0
        assert_waveforms(capacity, [base] * 16)
    finally:
        session.close()
    # The argv open path must match the native graph's sixteen-lane bound.
    capacity = Session([(f'initial-{index}', base) for index in range(16)])
    try:
        assert len(capacity.initial['lanes']) == 16 and len(capacity.initial['peaks']) == 16
    finally:
        capacity.close()
    # Exercise real nonzero master preservation only on the EXPLICIT fake
    # output backend. This never requests or opens a physical audio endpoint.
    gain = Session([('vocals', base)], muted=False)
    try:
        gain.command('master .63')
        gain.command('play')
        gain.eventually(lambda s: s['playing'])
        adopted = gain.replace([('vocals', base), ('new', longer)])
        assert abs(adopted['masterGain'] - .63) < 1e-6 and adopted['playing'], adopted
    finally:
        gain.close()
if args.out:
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'native-custom-lanes.json').write_text(json.dumps({'receipts': receipts,
        'realHelper': True, 'realNativeDecodeAndDsp': True, 'audioBackend': 'explicit fake host; no hardware qualification',
        'peakScale': '96-bucket source PCM RMS, independently decoded per bucket with Python wave and compared at1e-7',
        'completed': True, 'liveFps': 'not applicable; protocol test'}, indent=2, ensure_ascii=False))
print('PASS: real native lane replacement, stable-ID controls, atomic failure, longest duration/peaks and sixteen-lane capacity')
