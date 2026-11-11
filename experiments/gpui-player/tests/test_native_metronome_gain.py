"""Canonical click gain checks on the fake host only; never opens hardware.

The native output meter holds peaks with a 20 dB/s release. Compare fresh click
peaks after the previous held peak has settled, and use its decay (not an
immediate zero) to verify a live mute after a nonzero click.
"""
import argparse
import hashlib
import json
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
helper_hash = hashlib.sha256(helper.read_bytes()).hexdigest()
receipts = []
measurements = {}
with tempfile.TemporaryDirectory(prefix='singz-met-gain-fake-') as folder:
    source = Path(folder) / 'silent reference song.wav'
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(bytes(48000 * 20 * 2))
    # This is the only unmuted launch in this file. Its fake-host switch is
    # unconditional, and no hardware-mode argument is accepted by the parser.
    environment = {k: v for k, v in os.environ.items() if k != 'SINGZ_MUTE'}
    with (out / 'helper.stderr.log').open('w') as stderr:
        child = subprocess.Popen(
            [str(helper), '--test-fake-host', 'vocals', str(source)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            env=environment, stderr=stderr,
        )
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)

        def read():
            assert selector.select(10), 'Native gain receipt timed out'
            line = child.stdout.readline()
            assert line, 'Native gain helper exited'
            value = json.loads(line)
            receipts.append(value)
            assert value['protocol'] == 1 and value['cueGain'] == 0, value
            assert value['outputUid'].startswith('singz:fake-'), value
            return value

        def command(text, ok=True):
            assert len(text) < 4096
            (out / 'last-command.txt').write_text(text)
            child.stdin.write(text + '\n')
            child.stdin.flush()
            value = read()
            assert value['ok'] == ok, (text, value)
            return value

        def eventually(predicate, timeout=4):
            deadline = time.monotonic() + timeout
            while time.monotonic() < deadline:
                value = command('status')
                if predicate(value):
                    return value
                time.sleep(.002)
            raise AssertionError(value)

        def gains(value, song, reference):
            assert abs(value['masterGain'] - song) < 1e-6, value
            assert abs(value['referenceGain'] - reference) < 1e-6, value

        def configure(volume=.4, click=False):
            values = [i * .25 for i in range(80)]
            command(f'met-begin {int(click)} 0 {volume} 0 4 0 {len(values)} 0')
            command(f'met-beats 0 {len(values)} ' + ' '.join(str(v) for v in values))
            return command('met-apply')

        def preview(name, ceiling=None):
            if ceiling is not None:
                eventually(lambda s: s['outputPeak'] <= ceiling, timeout=4)
            before = command('status')
            first = command('met-preview 0')
            assert not first['playing'], first
            target = first['previewClicksEnqueued']
            maximum = max(before['outputPeak'], first['outputPeak'])
            deadline = time.monotonic() + 3
            completed_at = None
            while time.monotonic() < deadline:
                value = command('status')
                maximum = max(maximum, value['outputPeak'])
                if value['previewClicksCompleted'] >= target and completed_at is None:
                    completed_at = time.monotonic()
                # Source completion precedes graph/PDC delivery when the
                # reference bus compensates a time/pitch branch. Keep observing
                # the real output meter beyond source completion, not just PCM
                # consumption. This does not assert physical audibility.
                if completed_at is not None and time.monotonic() - completed_at >= .5:
                    measurements[name] = {'outputPeak': maximum,
                                          'masterGain': value['masterGain'],
                                          'referenceGain': value['referenceGain']}
                    return maximum
                time.sleep(.001)
            raise AssertionError('Preview did not complete')

        def sample_peak(seconds):
            deadline = time.monotonic() + seconds
            values = []
            while time.monotonic() < deadline:
                values.append(command('status'))
                time.sleep(.003)
            return values

        def ratio(actual, expected, name):
            # Canonical PCM uses the same fake rate and block boundaries. This
            # allows only 3% for polling the held meter's short initial peak.
            assert expected > 0 and abs(actual / expected - 1) <= .03, (name, actual, expected)

        try:
            assert read()['ok']
            gains(command('master 0'), 0, 0)
            value = configure()
            gains(value, 0, 0)
            assert preview('zero-master-preview') == 0

            value = command('master 1')
            gains(value, 1, .4)
            eventually(lambda s: s['baseCallbacks'] >= value['baseCallbacks'] + 8)
            baseline = preview('unit-master-preview')
            assert .05 < baseline < .4, baseline
            gains(command('master .5'), .5, .2)
            half = preview('half-master-preview', ceiling=baseline * .05)
            ratio(half, baseline * .5, 'live half-master preview')

            # Refused commands must change neither gain nor graph identity.
            before = command('status')
            for invalid in ['master nan', 'master -1', 'master 5', 'master .2 junk',
                            'met-begin 0 0 2 0 4 0 0 0', 'met-apply']:
                value = command(invalid, ok=False)
                gains(value, .5, .2)
                assert value['graphGeneration'] == before['graphGeneration'], value

            # Candidate prepare must combine current master with the NEW click
            # volume, rather than inheriting an earlier reference override.
            gains(configure(volume=.2), .5, .1)
            changed = preview('changed-volume-preview')
            ratio(changed, baseline * .25, 'prepare volume/master product')
            gains(command('rate 1.25 2'), .5, .1)
            ratio(preview('tempo-preview'), baseline * .25, 'click bypasses time/pitch')
            gains(command('output default'), .5, .1)
            ratio(preview('route-preview'), baseline * .25, 'route retained reference gain')
            command('park')
            gains(command('unpark'), .5, .1)
            ratio(preview('unpark-preview'), baseline * .25, 'unpark retained reference gain')

            # Exercise the same master control against scheduled song clicks,
            # not only preview one-shots. The song file itself is exact silence.
            gains(configure(volume=.4, click=True), .5, .2)
            command('play')
            eventually(lambda s: s['playing'] and s['position'] > .05)
            peak = max(v['outputPeak'] for v in sample_peak(.7))
            measurements['ongoing-half-master'] = {'outputPeak': peak}
            ratio(peak, baseline * .5, 'scheduled half-master clicks')
            gains(command('master .25'), .25, .1)
            eventually(lambda s: s['outputPeak'] <= baseline * .255, timeout=3)
            peak = max(v['outputPeak'] for v in sample_peak(.7))
            measurements['ongoing-quarter-master'] = {'outputPeak': peak}
            ratio(peak, baseline * .25, 'scheduled quarter-master clicks')

            gains(command('master 0'), 0, 0)
            time.sleep(.08)  # beyond the 64-frame gain ramp
            first = command('status')
            quiet = sample_peak(.7)
            assert quiet[-1]['outputPeak'] < first['outputPeak'] * .3, (first, quiet[-1])
            assert all(v['masterGain'] == v['referenceGain'] == 0 for v in quiet)
            measurements['live-zero-meter-decay'] = {
                'initialHeldPeak': first['outputPeak'],
                'finalHeldPeak': quiet[-1]['outputPeak'],
            }
            command('pause')
            eventually(lambda s: not s['playing'])
            gains(configure(volume=.4, click=True), 0, 0)
            command('play')
            eventually(lambda s: s['playing'])
            assert all(v['outputPeak'] == 0 for v in sample_peak(.55))
            command('pause')
            child.stdin.write('quit\n')
            child.stdin.flush()
            assert child.wait(timeout=10) == 0
            assert hashlib.sha256(helper.read_bytes()).hexdigest() == helper_hash, 'Helper changed during verification'
            (out / 'result.json').write_text(json.dumps({
                'helperSha256': helper_hash, 'fakeHostOnly': True,
                'hardwareOpened': False, 'unmutedSignal': True,
                'previewGain': True, 'scheduledClickGain': True,
                'zeroGlobalMaster': True, 'rejectedControlsPreserveBothGains': True,
                'rateRouteParkPreservation': True,
                'physicalAudibleQualityQualified': False,
                'measurements': measurements,
            }, indent=2))
        finally:
            (out / 'receipts.json').write_text(json.dumps(receipts, indent=2))
            (out / 'measurements.json').write_text(json.dumps(measurements, indent=2))
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            selector.close()
            child.stdin.close()
            child.stdout.close()
print('PASS: fake-host canonical preview/scheduled click gain, global zero, refusal isolation and route/park retention')
