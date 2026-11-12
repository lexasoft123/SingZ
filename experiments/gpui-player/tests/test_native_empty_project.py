"""Real helper empty-document lifecycle; fake device only, real native PCM/DSP.

This tests graph ownership and file lifetimes, not Rust project Save/reopen.
The explicit fake-host switch permits a nonzero master without user hardware.
"""
import argparse
import json
import math
import os
from pathlib import Path
import queue
import shutil
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


def fixture(path, frequency):
    rate = 48000
    samples = b''.join(struct.pack('<h', round(6500 * math.sin(i * math.tau * frequency / rate)))
                       for i in range(rate))
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        stream.writeframes(samples * 2)


def record(completed=False):
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / 'native-empty-project.json').write_text(json.dumps({
            'completed': completed, 'device': 'actual fake AudioHostBackend',
            'decoder': 'actual native', 'scope': 'helper graph/lease/PCM/descriptor lifecycle',
            'receipts': receipts}, indent=2))


class Session:
    def __init__(self, lanes=None, output=None, *, stream_lanes=True):
        environment = dict(os.environ)
        environment.pop('SINGZ_MUTE', None)
        arguments = ['--empty-project'] if lanes is None else [
            value for identifier, path in lanes for value in (identifier, str(path))]
        if not stream_lanes:
            arguments.insert(0, '--no-stream-lanes')
        if output is not None:
            assert lanes is None, 'Output preference regression uses the explicit empty startup mode'
            arguments = ['--empty-project', '--output', output]
        self.child = subprocess.Popen([str(helper), '--test-fake-host', *arguments],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=environment)
        self.lines = queue.Queue()
        self.revision = 0

        def reader():
            for line in self.child.stdout:
                self.lines.put(line)
            self.lines.put(None)

        threading.Thread(target=reader, daemon=True).start()
        self.initial = self.read()
        assert self.initial['ok'], self.initial

    def read(self):
        try:
            line = self.lines.get(timeout=55)
        except queue.Empty:
            raise AssertionError('Helper failed to reply within bounded decode deadline')
        assert line, ('Helper exited', self.child.poll(), self.child.stderr.read())
        status = json.loads(line)
        receipts.append({'pid': self.child.pid, 'status': status})
        record()
        assert status['protocol'] == 1 and not status['trainingOnly'], status
        assert status['laneSetRevision'] >= max(1, self.revision), status
        self.revision = status['laneSetRevision']
        return status

    def command(self, command, ok=True):
        self.child.stdin.write(command + '\n')
        self.child.stdin.flush()
        status = self.read()
        assert status['ok'] == ok, (command, status)
        return status

    def replace(self, lanes, ok=True):
        self.command(f'lanes-begin {len(lanes)}')
        for identifier, path in lanes:
            self.command(f'lanes-add {identifier.encode().hex()} {str(path).encode().hex()}')
        return self.command('lanes-apply', ok=ok)

    def wait(self, predicate):
        deadline = time.monotonic() + 4
        while time.monotonic() < deadline:
            status = self.command('status')
            if predicate(status):
                return status
            time.sleep(.02)
        raise AssertionError(status)

    def close(self):
        if self.child.poll() is None:
            self.child.stdin.write('quit\n')
            self.child.stdin.flush()
            try:
                self.child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=10)
                raise AssertionError('Empty helper did not retire within bounded shutdown')
        assert self.child.returncode == 0, self.child.stderr.read()


def empty(status, *, never_claimed=None, released=True):
    assert status['emptyProject'] and status['graphGeneration'] == 0, status
    assert status['state'] == 0 and not status['parked'], status
    assert not status['playing'] and status['duration'] == 0 and status['position'] == 0, status
    assert not status['looping'] and status['loopStart'] == 0 and status['loopEnd'] == 0, status
    assert status['lanes'] == status['laneIds'] == status['laneDurations'] == status['peaks'] == [], status
    assert status['physicalOutputReleased'] == released and status['parkedLaneBytes'] == 0, status
    proof = status['cleanupProof']
    assert proof['retainedBytes'] == proof['parkedLaneBytes'] == proof['quarantineBytes'] == 0, proof
    assert not proof['physicalOwnershipRetained'] and not proof['quarantineReserved'] and not proof['quarantinePoisoned'], proof
    if never_claimed is not None:
        assert proof['neverClaimed'] == never_claimed, proof
    if proof['neverClaimed']:
        assert proof['generation'] == 0 and not proof['globallyComplete'] and proof['handoffLease'] == 0, proof
    else:
        assert proof['globallyComplete'] and proof['generation'] > 0 and proof['handoffLease'] > 0, proof
        assert proof['safety'] == 1 and proof['error'] == 0 and proof['state'] == 0 and proof['coordinatorState'] == 2, proof
    if released:
        assert status['baseHostState'] in (0, 3, 6), status
    else:
        assert status['baseHostState'] == 2, status


def no_source_handles(session, paths):
    """Check the process, not just the helper's retained-byte counter."""
    proc = Path(f'/proc/{session.child.pid}/fd')
    if proc.exists():
        opened = []
        for entry in proc.iterdir():
            try:
                opened.append(os.readlink(entry))
            except OSError:
                pass
    elif shutil.which('lsof'):
        result = subprocess.run(['lsof', '-n', '-P', '-a', '-p', str(session.child.pid), '-F', 'n'],
                                capture_output=True, text=True, timeout=5)
        assert result.returncode in (0, 1), result.stderr
        opened = [line[1:] for line in result.stdout.splitlines() if line.startswith('n')]
    else:
        return 'unavailable: no /proc process fds or lsof'
    for path in paths:
        assert not any(value == str(path) or value.startswith(str(path) + ' ') for value in opened), (path, opened)
    return 'actual process source descriptors released'


with tempfile.TemporaryDirectory(prefix='singz-native-empty-') as directory:
    root = Path(directory)
    first = root / 'first.wav'
    second = root / 'second.wav'
    broken = root / 'broken.wav'
    fixture(first, 220)
    fixture(second, 330)
    broken.write_bytes(b'not audio')
    # A remembered disconnected route must not become permission to play
    # through system default when the first lane is added to an empty project.
    missing_uid = 'singz-empty-regression-disconnected-output'
    session = Session(output=missing_uid)
    try:
        empty(session.initial, never_claimed=True)
        assert session.initial['outputUid'] == missing_uid and session.initial['baseCallbacks'] == 0, session.initial
        rejected = session.replace([('custom-first', first)], ok=False)
        empty(rejected, never_claimed=True)
        assert not rejected['lanesCommitted'] and rejected['laneSetRevision'] == 1, rejected
        assert rejected['outputUid'] == missing_uid and rejected['baseCallbacks'] == 0, rejected
        assert rejected['error'] == 'Selected native output device is unavailable', rejected
        no_source_handles(session, (first,))
        # Only an explicit real route change enables the subsequent prepare.
        selected = session.command('output default')
        empty(selected, never_claimed=True)
        assert selected['outputUid'] and selected['outputUid'] != missing_uid, selected
        added = session.replace([('custom-first', first)])
        assert added['lanesCommitted'] and not added['emptyProject'] and not added['playing'], added
        assert added['laneSetRevision'] == 2 and added['duration'] == 2, added
    finally:
        session.close()
    session = Session()
    try:
        initial = session.initial
        empty(initial, never_claimed=True)
        assert initial['laneSetRevision'] == 1 and initial['baseCallbacks'] == 0, initial
        revision = initial['laneSetRevision']
        for command in ('play', 'play-flat', 'seek 0', 'loop 0 1', 'met-preview 0'):
            refused = session.command(command, ok=False)
            empty(refused, never_claimed=True)
            assert refused['laneSetRevision'] == revision and refused['baseCallbacks'] == 0, refused
        for command in ('pause', 'park', 'unpark', 'unloop', 'master 0.63', 'rate 0.8 -2'):
            empty(session.command(command), never_claimed=True)
        updated = session.command('status')
        assert abs(updated['masterGain'] - .63) < 1e-6 and updated['playbackRate'] == .8 and updated['transpose'] == -2, updated
        # Invalid candidates cannot acquire a graph or invalidate the empty lease.
        refused = session.replace([('custom-a', broken)], ok=False)
        empty(refused, never_claimed=True)
        assert not refused['lanesCommitted'] and refused['laneSetRevision'] == revision, refused
        # Standalone training renders actual PCM on the shared service, without
        # a song graph, trainingOnly lie, generation-zero open or silent lane.
        cue = session.command('cue 1 0 0.2 1 0 0 1 60')
        empty(cue, never_claimed=True, released=False)
        assert cue['cueActive'], cue
        session.wait(lambda s: s['baseCallbacks'] > 0)
        empty(session.command('cue-cancel 1'), never_claimed=True)
        assert session.command('status')['laneSetRevision'] == revision
        added = session.replace([('custom-a', first)])
        assert added['lanesCommitted'] and not added['emptyProject'] and added['laneSetRevision'] == revision + 1, added
        assert not added['playing'] and added['position'] == 0 and added['duration'] == 2 and added['cleanupProof'] is None, added
        assert abs(added['masterGain'] - .63) < 1e-6 and added['playbackRate'] == .8 and added['transpose'] == -2, added
        # Release a real running nonzero-master graph, then consume the exact
        # handoff in a fresh paused prepare. Repeated cycles catch stale PCM,
        # loop/position resurrection, consumed-lease reuse and pinned file FDs.
        prior_generation = added['graphGeneration']
        for cycle in range(3):
            session.command('loop 0.2 1.5')
            session.command('play')
            playing = session.wait(lambda s: s['playing'] and s['position'] > .03)
            assert playing['masterGain'] > 0, playing
            previous_revision = playing['laneSetRevision']
            removed = session.replace([])
            empty(removed, never_claimed=False)
            assert removed['lanesCommitted'] and removed['laneSetRevision'] == previous_revision + 1, removed
            assert removed['cleanupProof']['generation'] == prior_generation, removed
            descriptor_proof = no_source_handles(session, (first, second))
            receipts.append({'cycle': cycle, 'descriptorProof': descriptor_proof})
            stopped = session.command('status')
            time.sleep(.03)
            unchanged = session.command('status')
            empty(unchanged, never_claimed=False)
            assert stopped['baseCallbacks'] == unchanged['baseCallbacks'], (stopped, unchanged)
            refused = session.replace([('custom-b', broken)], ok=False)
            empty(refused, never_claimed=False)
            assert refused['laneSetRevision'] == removed['laneSetRevision'] and not refused['lanesCommitted'], refused
            # Training also works after an actual Release, retaining that exact
            # native fallback capability while the shared service owns output.
            generation = cycle + 2
            cue = session.command(f'cue {generation} 0 0.2 1 0 0 1 64')
            empty(cue, never_claimed=False, released=False)
            empty(session.command(f'cue-cancel {generation}'), never_claimed=False)
            if cycle == 1:
                # Valid output selection persists while empty without opening.
                route = session.command('output default')
                empty(route, never_claimed=False)
            added = session.replace([('custom-b', second if cycle % 2 == 0 else first)])
            assert added['lanesCommitted'] and not added['emptyProject'] and not added['playing'], added
            assert added['laneSetRevision'] == removed['laneSetRevision'] + 1 and added['graphGeneration'] > prior_generation, added
            assert added['position'] == 0 and not added['looping'] and added['duration'] == 2, added
            assert abs(added['masterGain'] - .63) < 1e-6 and added['playbackRate'] == .8 and added['transpose'] == -2, added
            assert added['laneIds'] == ['custom-b'] and len(added['peaks']) == 1 and max(added['peaks'][0]) > 0, added
            prior_generation = added['graphGeneration']
        # Streamed lanes retain no decoded PCM while parked; final removal
        # must still release the source graph and its file handles.
        parked = session.command('park')
        assert parked['parked'] and parked['parkedLaneBytes'] == 0 and parked['lanes'][0]['streamed'], parked
        removed = session.replace([])
        empty(removed, never_claimed=False)
        no_source_handles(session, (first, second))
    finally:
        session.close()
    # Keep the decoded-PCM retention contract covered independently of the
    # desktop streaming default: Park retains PCM, unpark adopts it, and a
    # subsequent removal releases the cache.
    session = Session([('custom-only', first)], stream_lanes=False)
    try:
        assert not session.initial['lanes'][0]['streamed'], session.initial
        parked = session.command('park')
        assert parked['parked'] and parked['parkedLaneBytes'] > 0, parked
        repeated = session.command('park')
        assert repeated['parkedLaneBytes'] == parked['parkedLaneBytes'] > 0, repeated
        restored = session.command('unpark')
        assert not restored['parked'] and restored['graphGeneration'] > parked['graphGeneration'], restored
        assert restored['parkedLaneBytes'] == 0 and not restored['lanes'][0]['streamed'], restored
        assert restored['parkedPcmAdopted'], restored
        parked = session.command('park')
        assert parked['parkedLaneBytes'] > 0, parked
        removed = session.replace([])
        empty(removed, never_claimed=False)
        assert removed['cleanupProof']['parkedLaneBytes'] == 0, removed
        # Releasing parked decoded PCM must also drop the source descriptors.
        no_source_handles(session, (first,))
    finally:
        session.close()
    # A normal argv graph can also retire straight from Prepared with no
    # output ever opened; the cleanup proof cannot depend on having played.
    session = Session([('custom-only', first)])
    try:
        assert session.initial['baseCallbacks'] == 0, session.initial
        removed = session.replace([])
        empty(removed, never_claimed=False)
        assert removed['baseCallbacks'] == 0 and removed['laneSetRevision'] == 2, removed
        no_source_handles(session, (first,))
    finally:
        session.close()
record(completed=True)
print('PASS native empty project: real Release, lease re-add, zero graph, decoded PCM adoption, standalone PCM, source descriptor lifetimes')
