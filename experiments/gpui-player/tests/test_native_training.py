"""Native training protocol and shared owner checks; no Node, hardware muted."""
import json
import math
import os
from pathlib import Path
import selectors
import struct
import subprocess
import sys
import tempfile
import time
import wave

helper = Path(sys.argv[1]).resolve()
output = Path(sys.argv[2]).resolve()
output.mkdir(parents=True, exist_ok=True)
hardware = '--hardware' in sys.argv[3:]
with tempfile.TemporaryDirectory(prefix='singz-native-training-') as folder:
    source = Path(folder) / 'paused song.wav'
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(4000 * math.sin(i * math.tau * 220 / 48000))) for i in range(48000 * 8)))
    child = subprocess.Popen([str(helper), *([] if hardware else ['--test-fake-host']), 'vocals', str(source)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, 'SINGZ_MUTE': '1'})
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    receipts = []
    def read():
        assert selector.select(15), 'Native training reply timed out'
        line = child.stdout.readline()
        assert line, 'Native helper exited'
        value = json.loads(line)
        assert value['protocol'] == 1 and value['cueGain'] == 0 and value['masterGain'] == 0, value
        receipts.append(value)
        return value
    def command(text, ok=True):
        child.stdin.write(text + '\n')
        child.stdin.flush()
        value = read()
        assert value['ok'] == ok, (text, value)
        return value
    def eventually(predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            value = command('status')
            if predicate(value):
                return value
            time.sleep(.02)
        raise AssertionError(value)
    try:
        assert read()['ok']
        # A cue starts native callbacks while preserving paused song transport.
        # Schema: cue generation instrument gain cueCount (purpose together count notes)...
        first = command('cue 1 0 .65 1 1 0 1 60')
        assert not first['playing'] and first['cueActive']
        assert first['cueNotes'] == [{'midi': 60, 'cueIndex': 0, 'start': 0, 'end': .55}]
        assert int(first['cueEndHostNs']) - int(first['cueStartHostNs']) == 550000000
        stream = first['streamGeneration']
        for sound in range(4):
            generation = sound + 2
            value = command(f'cue {generation} {sound} 2 2 0 1 3 60 64 67 1 0 2 67 72')
            assert value['cueGeneration'] == generation and value['cueActive'] and not value['playing']
            assert value['streamGeneration'] == stream, 'Cue opened another physical stream'
            assert len(value['cueNotes']) == 5 and abs(value['cueNotes'][3]['start'] - .9) < 1e-9
            command(f'cue-gain {generation} 2')  # Mute must survive live volume.
        # Stale controls cannot retire a replacement. Invalid protocol cannot
        # mutate the current generation or queued notes.
        command('cue-cancel 1')
        command('cue-gain 1 0')
        for bad in ['cue 5 0 1 1 1 0 1 60', 'cue -1 0 1 1 1 0 1 60', 'cue 6 4 1 1 1 0 1 60', 'cue 6 0 nan 1 1 0 1 60', 'cue 6 0 1 1 1 0 0', 'cue 6 0 1 1 1 0 1 128', 'cue 6 0 1 1 1 0 1 60 junk', 'cue-cancel -1', 'cue-gain 5 3']:
            rejected = command(bad, False)
            assert rejected['cueGeneration'] == 5 and len(rejected['cueNotes']) == 5
        if hardware:
            complete = eventually(lambda status: not status['cueActive'])
            assert complete['baseCallbacks'] > first['baseCallbacks'], 'No real native callbacks'
        cancelled = command('cue-cancel 5')
        assert not cancelled['cueActive'] and cancelled['cueNotes'] == []
        assert cancelled['cueStartHostNs'] == cancelled['cueEndHostNs'] == '0'
        command('play')
        eventually(lambda status: status['playing'] and status['position'] > .05)
        additive = command('cue 6 3 1 1 1 0 1 60')
        assert additive['playing'] and additive['streamGeneration'] == stream
        command('cue-cancel 6')
        assert command('status')['playing'], 'Cue cancellation paused song playback'
        command('cue 7 0 1 1 1 0 1 60')
        parked = command('park')
        assert parked['physicalOutputReleased'] and parked['parked'] and not parked['cueActive'] and parked['cueNotes'] == []
        # Base host Stopped/Closed/Unsupported; client unload alone is insufficient.
        assert parked['baseHostState'] in (0, 3, 6), parked
        command('cue 8 0 1 1 1 0 1 60', False)
        command('unpark')
        assert not command('status')['playing']
        command('cue 8 0 1 1 1 0 1 60')
        command('cue-cancel 8')
        child.stdin.write('quit\n')
        child.stdin.flush()
        assert child.wait(timeout=10) == 0
        (output / 'receipts.json').write_text(json.dumps(receipts, indent=2))
        (output / 'result.json').write_text(json.dumps({'hardwareMuted': hardware, 'sharedOwner': True, 'allInstruments': True, 'generationGuards': True, 'cueCancellation': True, 'parkReleasesBase': True, 'audibleQualified': False}, indent=2))
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=10)
        selector.close()
        child.stdin.close()
        child.stdout.close()
print('PASS: native training cues, one shared stream, all instruments, stale guards, mute, completion, cancellation and physical park')
