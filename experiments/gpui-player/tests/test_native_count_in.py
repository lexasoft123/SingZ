"""Actual native count-in clock/click oracle; fake audio host only, never hardware."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import selectors
import subprocess
import tempfile
import time
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('helper', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
helper = args.helper.resolve()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
receipts = []
measurements = []
with tempfile.TemporaryDirectory(prefix='singz-count-in-native-') as temp:
    source = Path(temp) / 'silent song — счёт.wav'
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(bytes(48000 * 8 * 2))
    environment = {k: v for k, v in os.environ.items() if k != 'SINGZ_MUTE'}
    with (out / 'helper.stderr.log').open('w') as stderr:
        child = subprocess.Popen([str(helper), '--test-fake-host', 'vocals', str(source)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 text=True, env=environment, stderr=stderr)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        def read():
            assert selector.select(10), 'Native count-in receipt timeout'
            line = child.stdout.readline()
            assert line, 'Native count-in helper exited'
            value = json.loads(line)
            receipts.append(value)
            assert value['protocol'] == 1 and value['ok'], value
            assert value['outputUid'].startswith('singz:fake-'), value
            heard = value['countInHeard']
            if heard is not None:
                assert value['countingIn'] and value['playing'], value
                assert heard['total'] == value['countInEvents'] > 0
                assert heard['perBar'] == value['countInBeatsPerBar'] > 0
                rate = value['sampleRate']
                latency = math.floor(value['presentationLatencyFrames'] * value['playbackRate'] + .5)
                reported = value['renderedProjectFrame']
                if reported < 0:
                    expected = min(0, reported - latency) / rate
                else:
                    since = reported - math.floor(heard['landingSeconds'] * rate + .5)
                    assert 0 <= since < latency, value
                    expected = -(latency - since) / rate
                assert abs(expected - heard['secondsToLanding']) < 1e-8, value
                assert abs(heard['preRollSeconds'] - abs(value['preRollFrames']) / rate) < 1e-8
            return value
        def command(text):
            (out / 'last-command.txt').write_text(text)
            child.stdin.write(text + '\n')
            child.stdin.flush()
            return read()
        def eventually(predicate, timeout=6):
            end = time.monotonic() + timeout
            while time.monotonic() < end:
                value = command('status')
                if predicate(value):
                    return value
                time.sleep(.005)
            raise AssertionError(value)
        try:
            read()
            beats = [.23 + i * .25 for i in range(28)]
            for rate, anchor, bars in [(1., 0., []), (1.5, 1.24, [0, 4, 6, 10, 14, 18, 22, 26])]:
                command('pause')
                eventually(lambda v: not v['playing'])
                command(f'rate {rate} 0')
                command(f'seek {anchor}')
                eventually(lambda v: abs(v['position'] - anchor) < .002)
                command(f'met-begin 0 1 .7 1 4 0 {len(beats)} {len(bars)}')
                command(f'met-beats 0 {len(beats)} ' + ' '.join(map(str, beats)))
                if bars:
                    command(f'met-bars 0 {len(bars)} ' + ' '.join(map(str, bars)))
                command('met-apply')
                first = command('play')
                run = [first]
                end = time.monotonic() + 6
                while time.monotonic() < end:
                    value = command('status')
                    run.append(value)
                    if not value['countingIn'] and value['playing'] and value['position'] > anchor + .05:
                        break
                    time.sleep(.005)
                else:
                    raise AssertionError(run[-1])
                clocks = [v for v in run if v['countInHeard'] is not None]
                assert clocks, 'Real preroll clock was never reported'
                expected_total = 2 if bars else 4
                assert all(v['countInHeard']['total'] == expected_total for v in clocks)
                assert all(abs(v['countInHeard']['landingSeconds'] - anchor) < .002 for v in clocks)
                assert max(v['outputPeak'] for v in run) > .001, 'Core count-in generated no actual click signal'
                assert run[-1]['countInHeard'] is None
                # Once the actual latency tail ended, scrubbing back cannot revive dots.
                command('pause')
                command(f'seek {anchor}')
                assert command('status')['countInHeard'] is None
                measurements.append({'rate': rate, 'anchor': anchor, 'expectedTotal': expected_total,
                                     'clockSamples': len(clocks), 'tailSamples': sum(v['renderedProjectFrame'] >= 0 for v in clocks),
                                     'actualClickPeak': max(v['outputPeak'] for v in run)})
            # Cancellation during a live runway ends the row, without completing fake ticks.
            command('seek 0')
            command('play')
            eventually(lambda v: v['countInHeard'] is not None)
            assert command('pause')['countInHeard'] is None
            child.stdin.write('quit\n')
            child.stdin.flush()
            assert child.wait(timeout=10) == 0
        finally:
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            selector.close()
            child.stdin.close()
            child.stdout.close()
(out / 'result.json').write_text(json.dumps({'completed': True, 'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
    'scope': 'actual native preroll/latency telemetry and count-in DSP on fake host',
    'hardware': False, 'measurements': measurements}, indent=2))
print('PASS: actual native count-in clock, pickup, variable meter, rate, click signal and stop/seek lifecycle')
