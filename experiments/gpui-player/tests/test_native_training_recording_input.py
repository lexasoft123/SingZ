#!/usr/bin/env python3
"""Actual native capture/recording protocol; PCM replay, no hardware/Node/UI input.

Parent builds/runs this explicitly. Arguments: INPUT_HELPER CREPE_MODEL OUTPUT_DIR.
The 30-second take makes the entire suite roughly 33 seconds; hard timeout 44s.
"""
import hashlib
import json
import os
from pathlib import Path
import queue
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave

helper, model, out = map(lambda p: Path(p).resolve(), sys.argv[1:4])
assert helper.is_file() and model.is_file()
out.mkdir(parents=True, exist_ok=True)
started = time.monotonic()
# Every source sample has an independent expected PCM16 value. Use positive
# unique values: shared readWavMono divides by32768; CaptureRecording truncates
# float32(sample/32768)*32767 towards zero before any CREPE resampling.
source = list(range(1000, 3000))
expected = [int(struct.unpack('<f', struct.pack('<f', value / 32768))[0] * 32767) for value in source]
fixture = out / 'raw-input-8000.wav'
with wave.open(str(fixture), 'wb') as stream:
    stream.setnchannels(1)
    stream.setsampwidth(2)
    stream.setframerate(8000)
    stream.writeframes(struct.pack('<' + 'h' * len(source), *source))
receipts = []
processes = []

class Input:
    def __init__(self, *, paused=False, monitoring=False):
        args = [str(helper), '--generation', '7001']
        if monitoring:
            args += ['--monitor', '--test-fake-host']
        else:
            args += ['--model', str(model), '--test-input', str(fixture)]
            if paused:
                args += ['--test-paused']
        self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True,
                                        env={**os.environ, 'SINGZ_MUTE': '1'})
        processes.append(self.process)
        self.messages = queue.Queue()
        def read():
            try:
                for line in self.process.stdout:
                    self.messages.put(json.loads(line))
            except Exception as error:
                self.messages.put(error)
            self.messages.put(EOFError('native helper closed stdout'))
        threading.Thread(target=read, daemon=True).start()
        ready = self.read()
        assert ready['ok'] and ready['active'], ready
        assert ready['monitoring'] == monitoring, ready
    def read(self, timeout=5):
        value = self.messages.get(timeout=timeout)
        if isinstance(value, Exception):
            raise value
        receipts.append(value)
        return value
    def command(self, text):
        self.process.stdin.write(text + '\n')
        self.process.stdin.flush()
        return self.read()
    def record(self, take, path, generation=7001):
        return self.command(f'record {generation} {take} {json.dumps(str(path), ensure_ascii=False)}')
    def finish(self, take, generation=7001):
        return self.command(f'finish {generation} {take}')
    def quit(self, expect_take=None):
        self.process.stdin.write('quit\n')
        self.process.stdin.flush()
        if expect_take is not None:
            saved = self.read()
            assert saved['ok'] and saved['recording']['state'] == 'finished', saved
            assert saved['recording']['takeId'] == expect_take, saved
        stopped = self.read()
        assert stopped['ok'] and not stopped['active'], stopped
        assert self.process.wait(timeout=5) == 0

def path_for(root, take):
    return root / f'SingZ-microphone-20261107T010203004Z-7001-take-{take}.wav'

def assert_audio(path, receipt, capped=False):
    assert path.is_file()
    info = receipt['recording']
    assert info['path'] == str(path) and info['filename'] == path.name, info
    assert info['sampleRate'] == 8000, info  # CREPE operates at16k; raw recording mustnot.
    with wave.open(str(path), 'rb') as stream:
        assert stream.getnchannels() == 1 and stream.getsampwidth() == 2
        assert stream.getframerate() == 8000
        frames = stream.getnframes()
        raw = stream.readframes(frames)
    samples = struct.unpack('<' + 'h' * frames, raw)
    assert samples, info
    phase = expected.index(samples[0])
    assert all(value == expected[(phase + i) % len(expected)] for i, value in enumerate(samples)), 'Raw mono changed before CREPE'
    assert abs(info['seconds'] - frames / 8000) < 1e-9, info
    assert len(raw) + 44 == path.stat().st_size
    if capped:
        assert frames == 30 * 8000 and info['seconds'] == 30, info
    else:
        assert 0 < frames < 30 * 8000, info

try:
    with tempfile.TemporaryDirectory(prefix='native-recording-', dir=out) as temporary:
        root = Path(temporary)
        app = Input()
        original = path_for(root, 1)
        bad = app.record(1, original, generation=7002)
        assert not bad['ok'] and not original.exists(), bad
        good = app.record(1, original)
        assert good['ok'] and good['recording']['state'] == 'started', good
        wrong = app.finish(2)
        assert not wrong['ok'], wrong
        other = path_for(root, 2)
        duplicate = app.record(2, other)
        assert not duplicate['ok'] and not other.exists(), duplicate
        time.sleep(0.18)
        saved = app.finish(1)
        assert saved['ok'], saved
        assert_audio(original, saved)
        snapshot = original.read_bytes()
        existing = app.record(3, original)
        assert not existing['ok'] and original.read_bytes() == snapshot, existing
        if os.name != 'nt':
            linked = path_for(root, 4)
            linked.symlink_to(original)
            assert not app.record(4, linked)['ok']
            assert original.read_bytes() == snapshot
        auto = path_for(root, 5)
        assert app.record(5, auto)['ok']
        time.sleep(0.18)
        app.quit(expect_take=5)
        assert_audio(auto, next(row for row in reversed(receipts) if row.get('recording', {}).get('takeId') == 5 and row['recording']['state'] == 'finished'))
        empty = Input(paused=True)
        empty_path = path_for(root, 6)
        assert empty.record(6, empty_path)['ok']
        rejected = empty.finish(6)
        assert not rejected['ok'] and 'No microphone audio' in rejected['error'], rejected
        assert not empty_path.exists()
        assert not (root / ".writing-6").exists(), "Empty take leaked its private writing directory"
        empty.quit()
        assert not (root / ".writing-6").exists()

        monitor = Input(monitoring=True)
        assert not monitor.record(7, path_for(root, 7))['ok']
        monitor.quit()
        cap = Input()
        cap_path = path_for(root, 8)
        assert cap.record(8, cap_path)['ok']
        time.sleep(30.4)
        cap_saved = cap.finish(8)
        assert cap_saved['ok'], cap_saved
        assert_audio(cap_path, cap_saved, capped=True)
        # The cap stops raw append, not capture or native analysis.
        status = cap.command('status')
        assert status['ok'] and status['active'], status
        cap.quit()
        shutil.copy2(original, out / 'raw-short-take.wav')
        shutil.copy2(auto, out / 'raw-stop-finished-take.wav')
        shutil.copy2(cap_path, out / 'raw-thirty-second-take.wav')
        (out / 'recording-output-sha256.json').write_text(json.dumps({
            original.name: hashlib.sha256(snapshot).hexdigest(),
            cap_path.name: hashlib.sha256(cap_path.read_bytes()).hexdigest(),
        }, indent=2))
    assert time.monotonic() - started < 44, 'recording transport exceeded suite deadline'
    (out / 'recording-protocol-receipt.json').write_text(json.dumps({
        'protocol': 1, 'ok': True, 'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
        'modelSha256': hashlib.sha256(model.read_bytes()).hexdigest(),
        'fixtureSha256': hashlib.sha256(fixture.read_bytes()).hexdigest(),
        'seconds': time.monotonic() - started, 'rawPcmOracle': '8000Hz mono deterministic PCM16 before CREPE',
        'realMicOpened': False, 'noNode': True, 'receipts': receipts,
    }, indent=2))
    print('PASS: native raw-mono recording, generation/take fences, exclusive publication, stop finalization and30-second cap')
finally:
    for process in processes:
        if process.poll() is None:
            process.kill()
        process.wait(timeout=5)
