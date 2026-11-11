"""Native default-output churn with an explicit fake provider; never changes OS devices."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import struct
import subprocess
import tempfile
import time
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('helper', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--check-real-guard', action='store_true', help='Check rejection in a real empty session, without opening a stream')
args = parser.parse_args()
helper, out = args.helper.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
records = []


def run(source, selected=None, trigger='play', name='default-play'):
    options = ['--test-fake-host'] + (['--training-only'] if source is None else [])
    options += [] if selected is None else ['--output', selected]
    options += [] if source is None else ['vocals', str(source)]
    with (out / (name + '.stderr.log')).open('w') as stderr:
        child = subprocess.Popen([str(helper), *options],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr, text=True,
            env={**os.environ, 'SINGZ_MUTE': '1'})
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        try:
            def reply(command=None, ok=True):
                if command:
                    child.stdin.write(command + '\n')
                    child.stdin.flush()
                assert selector.select(10), f'Native reply timed out: {command}'
                value = json.loads(child.stdout.readline())
                records.append({'case': name,
                                'command': command, 'status': value})
                (out / 'receipts.json').write_text(json.dumps(records, indent=2) + '\n')
                assert value['protocol'] == 1 and value['ok'] == ok, value
                assert value['masterGain'] == 0, 'Mute was bypassed'
                return value

            def running():
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    value = reply('status')
                    if value['playing'] and value['position'] > .45:
                        return value
                    time.sleep(.01)
                raise AssertionError(value)

            initial = reply()
            original = initial['outputUid']
            assert original == 'singz:fake-duplex', initial
            assert [d['uid'] for d in initial['deviceInventory']['devices']] == [original]
            if source is not None:
                reply('lane 0 0.3 1 0')
                reply('loop 0.2 6')
                reply('rate 0.8 2')
                reply('met-begin 0 0 0.5 0 4 0 4 0')
                reply('met-beats 0 4 0 1 2 3')
                reply('met-apply')
                reply('seek 0.5')
            before = reply('status')
            if source is not None:
                deadline = time.monotonic() + 5
                while before['seekCount'] == 0 or abs(before['position'] - .5) >= .01:
                    assert time.monotonic() < deadline, before
                    time.sleep(.01)
                    before = reply('status')
            for invalid in ['test-default invalid', 'test-default alternate extra']:
                assert reply(invalid, ok=False)['outputUid'] == original
            reply('test-default alternate')
            changed = reply(trigger)
            expected = 'singz:fake-new-default' if selected is None else original
            assert changed['outputUid'] == expected, changed
            if source is not None:
                assert abs(changed['position'] - before['position']) < .12, (before, changed)
            if selected is None:
                assert 'deviceInventory' in changed, 'Implicit default route omitted its capability snapshot'
                inventory = changed['deviceInventory']
                assert inventory['defaultOutputUid'] == expected
                assert any(d['uid'] == expected and d['outputChannels'] > 0 and d['sampleRate'] == 44100 for d in inventory['devices'])
                assert changed['sampleRate'] == 44100, changed
            else:
                assert 'deviceInventory' not in changed, 'Unchanged explicit route enumerated devices'
            if trigger == 'play':
                active = running()
            else:
                deadline = time.monotonic() + 5
                while True:
                    active = reply('status')
                    if active['baseHostState'] == 2 and active['baseCallbacks'] > 0:
                        break
                    assert time.monotonic() < deadline, active
                    time.sleep(.01)
                assert not active['playing'], active
                if trigger.startswith('cue '):
                    assert active['cueGeneration'] == 1 and int(active['cueStartHostNs']) > 0, active
            assert active['outputUid'] == expected
            for key in ['playbackRate', 'transpose', 'looping', 'loopStart', 'loopEnd', 'lanes', 'duration']:
                assert active[key] == before[key], (key, before[key], active[key])
            assert active['laneSetRevision'] == before['laneSetRevision']
            for command in ['status', 'pause' if source is not None else 'cue-cancel 1', 'status']:
                assert 'deviceInventory' not in reply(command), 'Ordinary status/Pause enumerated devices'
            if selected is None:
                reply('test-default original')
                returned = reply(trigger.replace('cue 1 ', 'cue 2 '))
                assert returned['outputUid'] == original and returned['sampleRate'] == 48000, returned
                assert returned['deviceInventory']['defaultOutputUid'] == original
                assert [d['uid'] for d in returned['deviceInventory']['devices']] == [original]
                assert 'deviceInventory' not in reply('status')
            child.stdin.write('quit\n')
            child.stdin.flush()
            child.wait(timeout=10)
            assert child.returncode == 0
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            selector.close()


with tempfile.TemporaryDirectory(prefix='singz-default-route-') as temporary:
    source = Path(temporary) / 'fixture.wav'
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(struct.pack('<h', 2048) * (48000 * 8))
    run(source)
    run(source, selected='singz:fake-duplex', name='explicit-play')
    run(source, trigger='met-preview 1', name='default-preview')
    run(source, trigger='cue 1 0 .4 1 1 0 1 60', name='default-song-cue')
    run(None, trigger='cue 1 0 .4 1 1 0 1 60', name='default-training-cue')
if args.check_real_guard:
    with (out / 'real-empty-guard.stderr.log').open('w') as stderr:
        child = subprocess.Popen([str(helper), '--empty-project'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=stderr, text=True, env={**os.environ, 'SINGZ_MUTE': '1'})
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        try:
            assert selector.select(10), 'Empty session did not reply'
            before = json.loads(child.stdout.readline())
            assert before['ok'] and before['emptyProject'] and before['physicalOutputReleased'] and before['baseCallbacks'] == 0, before
            child.stdin.write('test-default alternate\n');child.stdin.flush()
            assert selector.select(10), 'Guard check did not reply'
            after = json.loads(child.stdout.readline())
            assert not after['ok'] and after['outputUid'] == before['outputUid'], after
            assert after['physicalOutputReleased'] and after['baseCallbacks'] == 0, after
            (out / 'real-empty-guard.json').write_text(json.dumps({'before':before,'after':after},indent=2)+'\n')
            child.stdin.write('quit\n');child.stdin.flush();child.wait(timeout=10)
            assert child.returncode == 0
        finally:
            if child.poll() is None:child.kill();child.wait(timeout=5)
            selector.close()

(out / 'result.json').write_text(json.dumps({'passed': True,
    'helperSha256': hashlib.sha256(helper.read_bytes()).hexdigest(),
    'nativeDecodeAndDsp': True, 'audioBackend': 'explicit fake only',
    'newDefaultSnapshot': True, 'explicitRouteRetained': True,
    'cases': sorted({r['case'] for r in records}), 'crossRate': [48000, 44100],
    'ordinaryStatusAndPauseNoInventory': True, 'realEmptyGuard': args.check_real_guard, 'hardwareHotplug': 'unqualified'}, indent=2) + '\n')
print('PASS: new-default capabilities, explicit-route retention, native mix/rate/loop and quiet status/Pause')
