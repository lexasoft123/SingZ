"""Native helper integration, no Node. Hardware mode remains muted throughout.
Run: python3 .../test_native_audio.py <helper> [--hardware]
"""
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

helper = str(Path(sys.argv[1]).resolve())
hardware = '--hardware' in sys.argv[2:]
inventory = json.loads(subprocess.check_output([helper, *([] if hardware else ['--test-fake-host']), '--devices'], text=True))
assert inventory['protocol'] == 1 and inventory['ok']
assert inventory['devices']
with tempfile.TemporaryDirectory(prefix='singz-gpui-native-') as folder:
    source = Path(folder) / 'Stem with spaces — голос.wav'
    with wave.open(str(source), 'wb') as stream:
        stream.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        stream.writeframes(b''.join(struct.pack('<h', int(5000 * math.sin(i * math.tau * 220 / 48000))) for i in range(48000 * 4)))
    child = subprocess.Popen([helper, *([] if hardware else ['--test-fake-host']), 'vocals', str(source)],
                             stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
                             env={**os.environ, 'SINGZ_MUTE': '1'})
    selector = selectors.DefaultSelector()
    selector.register(child.stdout, selectors.EVENT_READ)
    def reply():
        assert selector.select(10), 'Native helper reply timed out'
        line = child.stdout.readline()
        assert line, 'Native helper exited unexpectedly'
        value = json.loads(line)
        assert value['protocol'] == 1, value
        assert value.get('masterGain', 0) == 0, ('SINGZ_MUTE was bypassed', value)
        return value
    def command(text, ok=True):
        child.stdin.write(text + '\n')
        child.stdin.flush()
        result = reply()
        assert result['ok'] == ok, (text, result)
        return result
    def eventually(predicate):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            status = command('status')
            if predicate(status):
                return status
            time.sleep(.025)
        raise AssertionError(status)
    try:
        prepared = reply()
        assert prepared['ok'] and not prepared['playing'], prepared
        assert abs(prepared['duration'] - 4) < .001, prepared
        assert len(prepared['peaks']) == 1 and len(prepared['peaks'][0]) == 96
        assert max(prepared['peaks'][0]) > .01, 'Decoded waveform is missing'
        command('master 4')  # Mute must survive subsequent volume changes.
        command('lane 0 0.4 1 0')
        for invalid in ['master nan', 'master 5', 'lane 6 1 0 0', 'lane 0 1 2 0', 'seek -1', 'seek 20', 'status junk', 'loop 2 1', 'rate nan 0', 'rate 0.1 0', 'rate 5 0', 'rate 1 25', 'rate 1 1.5']:
            command(invalid, ok=False)
        changed = command('rate 0.8 2')
        assert abs(changed['playbackRate'] - .8) < .001 and changed['transpose'] == 2 and not changed['playing'], changed
        command('rate 1 0')
        if hardware:
            command('loop 0 4')  # Arming before the first play must stay paused.
            assert not command('status')['playing']
            command('unloop')
        command('play')
        if hardware:
            running = eventually(lambda s: s['playing'] and s['position'] > .05)
            command('pause')
            paused = eventually(lambda s: not s['playing'])
            time.sleep(.12)
            assert abs(command('status')['position'] - paused['position']) < .03
            changed = command('rate 1.2 -3')
            assert not changed['playing'] and changed['transpose'] == -3, changed
            assert changed['position'] > .01, changed
            assert changed['streamGeneration'] == paused['streamGeneration'], changed
            assert changed['swapLandings'] > paused['swapLandings'], changed
            command('seek 1.5')
            eventually(lambda s: not s['playing'] and abs(s['position'] - 1.5) < .02)
            command('loop 1.5 3.5')
            command('play')
            before = command('status')
            changed = command('rate 1 0')
            assert changed['playing'] and changed['looping'], changed
            assert changed['streamGeneration'] == before['streamGeneration'], changed
            assert changed['swapLandings'] > before['swapLandings'], changed
            time.sleep(.5)
            eventually(lambda s: s['playing'] and 1.49 <= s['position'] <= 3.52)
            command('unloop')
            command('seek 3.8')
            eventually(lambda s: not s['playing'] and s['position'] >= 3.95)
            command('play')  # Play after completion restarts without a separate seek.

            eventually(lambda s: s['playing'] and .01 < s['position'] < 1)
            # Invalid routes retain the working output. Applying a real route pauses,
            # preserves project seconds across rates and requires explicit Play.
            command('loop 0 4')
            command('rate 0.8 2')
            before = command('status')
            command('output ' + 'missing-device'.encode().hex(), ok=False)
            assert command('status')['outputUid'] == before['outputUid']
            assert command('status')['playing']
            outputs = [d for d in inventory['devices'] if d['outputChannels'] > 0]
            different = next((d for d in outputs if d['sampleRate'] != before['sampleRate']), None)
            targets = ([different] if different else []) + [next(d for d in outputs if d['uid'] == before['outputUid'])]
            for target in targets:
                before = command('status')
                changed = command('output ' + target['uid'].encode().hex())
                assert not changed['playing'] and changed['outputUid'] == target['uid'], changed
                assert abs(changed['position'] - before['position']) < .12, (before, changed)
                assert abs(changed['duration'] - 4) < .01 and abs(changed['playbackRate'] - .8) < .001 and changed['transpose'] == 2, changed
                assert changed['looping'] and abs(changed['loopStart']) < .01 and abs(changed['loopEnd'] - 4) < .01, changed
                assert abs(changed['lanes'][0]['gain'] - .4) < .001 and changed['lanes'][0]['muted'], changed
                command('play')
                eventually(lambda s: s['playing'])
            print('PASS: native output route pause/position/rate/loop/mix preservation; cross-rate=' + str(different is not None))
        child.stdin.write('quit\n')
        child.stdin.flush()
        assert child.wait(timeout=10) == 0
        print('PASS: native decode, Unicode path, waveform, bounded controls, mute invariant' +
              (', hardware transport/pause/seek/loop/end/restart' if hardware else ' (fake host; no hardware qualification)'))
    finally:
        selector.close()
        child.stdin.close()
        child.stdout.close()
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)
