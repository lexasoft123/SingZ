"""Exercise actual ALSA underrun recovery on an explicitly selected fixture endpoint.

Only the spawned, muted helper is briefly stopped; no existing process or route is changed.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import struct
import subprocess
import tempfile
import time
import wave

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('helper', type=Path)
parser.add_argument('out', type=Path)
parser.add_argument('--output-uid', required=True)
args = parser.parse_args()
helper, out = args.helper.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=False)
assert args.output_uid.startswith('alsa:'), 'Select an explicit ALSA fixture output UID'
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
records = {}
with tempfile.TemporaryDirectory(prefix='singz-alsa-recovery-') as temp:
    source = Path(temp) / 'fixture.wav'
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((2, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(struct.pack('<hh', 4096, -4096) * (48000 * 12))
    with (out / 'helper.stderr.log').open('w') as stderr:
        child = subprocess.Popen([str(helper), '--output', args.output_uid, 'vocals', str(source)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=stderr,
            env={**os.environ, 'SINGZ_MUTE': '1'}, text=True, bufsize=1, start_new_session=True)
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        try:
            def reply(command=None):
                if command:
                    child.stdin.write(command + '\n')
                    child.stdin.flush()
                assert selector.select(timeout=10), f'No reply to {command}'
                line = child.stdout.readline()
                assert line and len(line) <= 1024 * 1024, 'Invalid native reply size'
                value = json.loads(line)
                assert value['protocol'] == 1 and value['ok'], value
                return value

            records['prepared'] = reply()
            proven = next(d for d in records['prepared']['deviceInventory']['devices']
                          if d['uid'] == args.output_uid)
            assert proven['outputChannels'] > 0, 'Prepare omitted proven output capabilities'
            reply('play')
            time.sleep(.08)
            inventory = subprocess.run([str(helper), '--devices'], capture_output=True,
                text=True, timeout=10, env={**os.environ, 'SINGZ_MUTE': '1'}, check=True)
            records['duringInventory'] = json.loads(inventory.stdout)
            busy = next(d for d in records['duringInventory']['devices']
                        if d['uid'] == args.output_uid)
            assert busy['outputProbeBusy'] and busy['outputChannels'] == 0, busy
            before = reply('status')
            assert before['playing'] and before['state'] == 4 and before['baseHostState'] == 2, before
            assert before['outputUid'] == args.output_uid
            stopped = time.monotonic()
            child.send_signal(signal.SIGSTOP)
            time.sleep(.15)  # Exceeds the negotiated four-period output buffer.
            child.send_signal(signal.SIGCONT)
            time.sleep(.10)
            after = reply('status')
            records.update(before=before, after=after, interruptionSeconds=time.monotonic() - stopped)
            (out / 'receipts.json').write_text(json.dumps(records, indent=2) + '\n')
            assert after['playing'] and after['state'] == 4 and after['baseHostState'] == 2, after
            assert after['baseHostXruns'] > before['baseHostXruns'], 'No actual ALSA underrun was observed'
            assert after['baseHostRenderFailures'] == 0 and after['baseHostTerminalReason'] == 0, after
            for key in ['graphGeneration', 'laneSetRevision', 'outputUid']:
                assert before[key] == after[key], (key, before[key], after[key])
            assert after['baseCallbacks'] > before['baseCallbacks'] and after['position'] >= before['position']
            reply('pause')
            child.stdin.close()
            child.wait(timeout=10)
            assert child.returncode == 0
        finally:
            # Popen retains this exact child's PID until wait reaps it.
            if child.poll() is None:
                child.send_signal(signal.SIGCONT)
                child.kill()
                child.wait(timeout=5)
            selector.close()
    (out / 'result.json').write_text(json.dumps({'passed': True, 'helperSha256': sha(helper),
        'sourceSha256': sha(source), 'outputUid': args.output_uid, 'muted': True,
        'actualKernelUnderrun': True, 'graphAndRoutePreserved': True,
        'noOtherProcessSignalled': True, 'physicalDeviceQuality': 'unqualified'}, indent=2) + '\n')
print('PASS: actual ALSA underrun recovered with graph, route and playback retained')
