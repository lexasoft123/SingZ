"""Native no-song role, lazy output and park contract; hardware always muted."""
import json
import os
from pathlib import Path
import selectors
import subprocess
import sys

helper = Path(sys.argv[1]).resolve()
hardware = '--hardware' in sys.argv[2:]
child = subprocess.Popen([str(helper), *([] if hardware else ['--test-fake-host']), '--training-only'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True, env={**os.environ, 'SINGZ_MUTE': '1'})
selector = selectors.DefaultSelector()
selector.register(child.stdout, selectors.EVENT_READ)
def read():
    assert selector.select(10), 'Native training-only reply timed out'
    value = json.loads(child.stdout.readline())
    assert value['trainingOnly'] and value['duration'] == 0 and value['position'] == 0 and not value['playing']
    assert value['masterGain'] == value['cueGain'] == 0
    return value
def command(text, ok=True):
    child.stdin.write(text + '\n'); child.stdin.flush()
    value = read()
    assert value['ok'] == ok, (text, value)
    return value
try:
    initial = read()
    assert initial['ok'] and initial['baseCallbacks'] == 0 and initial['baseHostState'] in (0, 3)
    for invalid in ['met-begin 0 0 .7 1 4 0 0 0', 'met-preview 0', 'play', 'seek 1', 'rate 1 0', 'lane 0 1 0 0', 'cue-timed 1 0 1 -1 .1 .35 .45 .25 .032 .22 1 1 2 0 1 60']:
        rejected = command(invalid, False)
        assert rejected['baseCallbacks'] == 0 and rejected['cueGeneration'] == 0
    cue = command('cue-timed 1 0 .65 2.75 .1 .35 .45 .25 .032 .22 1 1 2 0 1 60')
    assert cue['cueActive'] and int(cue['cueEndHostNs']) - int(cue['cueStartHostNs']) == 2750000000
    assert cue['cueNotes'] == [{'midi': 60, 'cueIndex': 0, 'start': 0, 'end': 2.75}]
    confirmed = command('cue-confirm 1 2')
    assert confirmed['cueGeneration'] == 1 and confirmed['streamGeneration'] == cue['streamGeneration']
    assert confirmed['cueGain'] == 0, 'Confirmation bypassed mute'
    stale = command('cue-confirm 2 1')
    assert stale['cueGeneration'] == 1 and stale['cueNotes'] == cue['cueNotes']
    for invalid in ['cue-confirm -1 1', 'cue-confirm 1 nan', 'cue-confirm 1 3', 'cue-confirm 1 1 extra']:
        command(invalid, False)
    parked = command('park')
    assert parked['parked'] and parked['physicalOutputReleased'] and parked['parkedLaneBytes'] == 0 and not parked['cueActive']
    assert parked['baseHostState'] in (0, 3, 6)
    assert not command('cue-confirm 1 1', False)['cueActive'], 'Confirmation revived parked output'
    command('cue 2 0 1 1 2 0 1 60', False)
    restored = command('unpark')
    assert not restored['parked'] and not restored['cueActive'] and restored['baseHostState'] in (0, 3, 6)
    command('output ' + 'missing-device'.encode().hex(), False)
    route = command('output default')
    assert route['baseHostState'] in (0, 3, 6), 'Selecting a route opened output before Test'
    assert command('cue 2 3 1 1 2 0 1 60')['cueActive']
    stopped = command('cue-cancel 2')
    assert not stopped['cueActive'] and stopped['cueNotes'] == []
    child.stdin.write('quit\n'); child.stdin.flush()
    assert child.wait(timeout=5) == 0
finally:
    if child.poll() is None: child.kill(); child.wait(timeout=10)
    selector.close(); child.stdin.close(); child.stdout.close()
print('PASS: training-only lazy output, source Test timing, transport refusal, physical Park and paused restore')
