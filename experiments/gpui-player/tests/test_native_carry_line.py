"""Carry scheduling on the actual native graph/DSP, fake audio device only.

Peak observations allow the native meter's documented 20dB/s decay; no renderer
clock, synthetic status, manual offsets or mocked audio processing participates.
"""
import argparse
import json
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
commands = []
measurements = {}


def evidence(completed=False):
    if args.out:
        args.out.mkdir(parents=True, exist_ok=True)
        (args.out / 'native-carry-line.json').write_text(json.dumps({
            'completed': completed, 'audioHost': 'actual fake backend',
            'DSP': 'actual native scheduled gain', 'meter': 'native held peak, 20dB/s decay',
            'measurements': measurements, 'commands': commands, 'receipts': receipts}, indent=2))


def fixture(path, value):
    with wave.open(str(path), 'wb') as audio:
        audio.setparams((1, 2, 48000, 0, 'NONE', 'not compressed'))
        audio.writeframes(struct.pack('<h', round(value * 32767)) * 48000 * 8)


class Session:
    def __init__(self, lanes):
        environment = dict(os.environ)
        environment.pop('SINGZ_MUTE', None)
        self.child = subprocess.Popen([str(helper), '--test-fake-host',
            *[part for identifier, path in lanes for part in (identifier, str(path))]],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, env=environment)
        self.lines = queue.Queue()
        self.revision = 0

        def reader():
            for line in self.child.stdout:
                self.lines.put(line)
            self.lines.put(None)

        threading.Thread(target=reader, daemon=True).start()
        initial = self.read()
        assert initial['ok'] and not initial['carryEnabled'] and initial['carryRevision'] == 1, initial

    def read(self):
        try:
            line = self.lines.get(timeout=15)
        except queue.Empty:
            raise AssertionError('Native carry command did not settle within 15 seconds')
        assert line, ('Helper exited', self.child.poll(), self.child.stderr.read())
        status = json.loads(line)
        receipts.append(status)
        evidence()
        assert status['protocol'] == 1 and status['carryRevision'] >= max(1, self.revision), status
        self.revision = status['carryRevision']
        return status

    def command(self, command, ok=True):
        commands.append({'receiptIndex': len(receipts), 'command': command})
        self.child.stdin.write(command + '\n')
        self.child.stdin.flush()
        status = self.read()
        assert status['ok'] == ok, (command, status)
        return status

    def carry(self, on=True, mode=0, period=1., lanes=('vocals',), windows=(), arming=True):
        prior = self.revision
        self.command(f'carry-begin {int(on)} {mode} {period} {len(lanes)} {len(windows)}' + ('' if arming else ' 0'))
        for lane in lanes:
            self.command('carry-lane ' + lane.encode().hex())
        for start, end in windows:
            self.command(f'carry-window {start} {end}')
        status = self.command('carry-apply')
        assert status['carryCommitted'] and status['carryRevision'] == prior + 1, status
        assert status['carryRequested'] == on and status['carryMode'] == mode, status
        assert status['carryPeriod'] == period and status['carryLaneIds'] == list(lanes), status
        assert status['carryWindows'] == [list(window) for window in windows], status
        return status

    def replace(self, lanes):
        self.command(f'lanes-begin {len(lanes)}')
        for identifier, path in lanes:
            self.command(f'lanes-add {identifier.encode().hex()} {str(path).encode().hex()}')
        status = self.command('lanes-apply')
        assert status['lanesCommitted'], status
        return status

    def wait(self, predicate, timeout=3):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            status = self.command('status')
            if predicate(status):
                return status
            time.sleep(.01)
        raise AssertionError(status)

    def seek_peak(self, name, position, target, boundary):
        self.command('pause')
        before = self.command('unloop')
        self.command(f'seek {position}')
        self.command('play')
        # Command receipts acknowledge queue admission, not callback delivery.
        # An old paused projection may already lie in the new position range,
        # with a held peak matching the target. Require this actual seek and
        # resume to be rendered before evaluating the scheduled output.
        status = self.wait(lambda s: s['playing'] and s['seekCount'] > before['seekCount']
                           and position + .12 <= s['position'] < boundary
                           and abs(s['outputPeak'] - target) < .012, timeout=1.4)
        assert status['playing'] and status['seekCount'] > before['seekCount'] and status['position'] < boundary, status
        measurements[name] = {'sourcePosition': status['position'], 'actualPeak': status['outputPeak'],
                              'expectedPeak': target, 'carryRevision': status['carryRevision']}
        return status

    def close(self):
        if self.child.poll() is None:
            self.child.stdin.write('quit\n')
            self.child.stdin.flush()
            self.child.wait(timeout=8)
        assert self.child.returncode == 0, self.child.stderr.read()


def mix(status):
    return {lane['id']: (lane['gain'], lane['muted'], lane['solo']) for lane in status['lanes']}


def schedule(status):
    return [status[key] for key in ('carryRequested', 'carryEnabled', 'carryMode', 'carryPeriod',
                                   'carryLaneIds', 'carryWindows', 'carryRevision')]


with tempfile.TemporaryDirectory(prefix='singz-carry-native-') as directory:
    root = Path(directory)
    vocals, backing, silent = [root / name for name in ('Голос.wav', 'backing.wav', 'custom 🎤.wav')]
    fixture(vocals, .2)
    fixture(backing, .1)
    fixture(silent, 0)
    session = Session([('vocals', vocals), ('other', backing)])
    try:
        session.command('lane 0 .5 1 0')
        session.command('master .8')
        # Source Open restores the armed setting directly, not through the
        # user toggle. Saved guide mute/gain/solo must survive native prepare.
        restored_on = session.carry(arming=False)
        assert restored_on['carryEnabled'] and mix(restored_on)['vocals'] == (.5, True, False), restored_on
        session.seek_peak('restore-on-keeps-manual-mute', .2, .08, .9)
        session.command('pause')
        session.carry(on=False)
        session.command('lane 0 .5 1 1')
        armed = session.carry()
        assert armed['carryEnabled'] and not armed['playing'], armed
        assert mix(armed)['vocals'] == (.5, False, True), armed
        # Arming changes only mute; the user still owns gain and solo.
        session.command('lane 0 .5 0 0')
        session.seek_peak('period-hear', .2, .16, .9)
        session.seek_peak('period-sing', 1.2, .08, 1.95)
        session.seek_peak('period-next-hear', 2.2, .16, 2.95)
        session.command('loop 1.2 1.8')
        session.command('seek 1.3')
        looped = session.wait(lambda s: s['loopCount'] > 0 and abs(s['outputPeak'] - .08) < .012)
        assert looped['looping'] and looped['carryEnabled'], looped
        # Window scheduling uses original project seconds, including seeks.
        session.command('pause')
        session.command('unloop')
        windows = ((1., 3.), (5., 7.))
        windowed = session.carry(mode=1, period=0, windows=windows)
        assert windowed['carryEnabled'] and not windowed['playing'], windowed
        session.seek_peak('windows-hear', .2, .16, .95)
        session.seek_peak('windows-sing', 1.3, .08, 2.8)
        session.seek_peak('windows-next-hear', 3.2, .16, 4.8)
        before = session.command('status')
        # Rejected drafts never replace accepted config or its live graph.
        for bad in ('carry-begin 1 2 1 1 0', 'carry-begin 1 0 nan 1 0',
                    'carry-begin 1 0 0 1 0', 'carry-begin 1 0 1 17 0',
                    'carry-begin 1 1 0 1 16385', 'carry-begin 1 0 1 1 1',
                    'carry-begin 1 0 1 1 0 2', 'carry-begin 1 0 1 1 0 0 extra'):
            refused = session.command(bad, ok=False)
            assert schedule(refused) == schedule(before) and not refused['carryCommitted'], refused
            assert refused['graphGeneration'] == before['graphGeneration'], refused
        session.command('carry-begin 1 1 0 1 2')
        session.command('carry-lane ' + 'vocals'.encode().hex())
        session.command('carry-window 1 2')
        session.command('carry-window 1.5 3', ok=False)
        refused = session.command('carry-apply', ok=False)
        assert schedule(refused) == schedule(before), refused
        session.command('carry-begin 1 0 1 2 0')
        session.command('carry-lane ' + 'vocals'.encode().hex())
        session.command('carry-lane ' + 'vocals'.encode().hex(), ok=False)
        assert schedule(session.command('carry-apply', ok=False)) == schedule(before)
        session.command('carry-begin 1 0 1 1 0')
        session.command('carry-lane ' + 'unknown'.encode().hex(), ok=False)
        assert schedule(session.command('carry-apply', ok=False)) == schedule(before)
        session.command('carry-begin 1 1 0 1 1')
        session.command('carry-lane ' + 'vocals'.encode().hex())
        session.command('carry-window 1 1.00000000001')
        assert schedule(session.command('carry-apply', ok=False)) == schedule(before)
        session.command('carry-begin 1 1 0 1 1')
        session.command('carry-lane ' + 'vocals'.encode().hex())
        # Incomplete and explicit cancellation also leave the live graph intact.
        assert schedule(session.command('carry-apply', ok=False)) == schedule(before)
        session.command('carry-begin 0 0 1 0 0')
        session.command('carry-cancel')
        assert schedule(session.command('carry-apply', ok=False)) == schedule(before)
        # User mute remains independent while requested-on config changes.
        session.command('lane 0 .5 1 0')
        changed = session.carry(period=2)
        assert mix(changed)['vocals'] == (.5, True, False), changed
        disabled = session.carry(on=False)
        assert not disabled['carryEnabled'] and mix(disabled)['vocals'][1], disabled
        enabled = session.carry()
        assert enabled['carryEnabled'] and not mix(enabled)['vocals'][1], enabled
        session.seek_peak('off-on-unmute-sing', 1.2, .08, 1.95)
        # Empty synced line windows are true off, not a fake periodic plan.
        # The user's explicit arm still unmutes the selected source, as in the
        # source toggle; subsequent lyrics arriving must not repeat that arm.
        session.carry(on=False)
        session.command('lane 0 .5 1 0')
        empty_windows = session.carry(mode=1, period=0, windows=())
        assert empty_windows['carryRequested'] and not empty_windows['carryEnabled'], empty_windows
        assert not mix(empty_windows)['vocals'][1], empty_windows
        session.seek_peak('empty-lines-no-fallback', 1.2, .16, 2.8)
        # Desired remains on: lyric arrival must not undo a manual mute.
        session.command('lane 0 .5 1 0')
        arrived = session.carry(mode=1, period=0, windows=windows)
        assert arrived['carryEnabled'] and mix(arrived)['vocals'][1], arrived
        session.carry(on=False)
        enabled = session.carry(mode=1, period=0, windows=windows)
        assert not mix(enabled)['vocals'][1], enabled
        expected_schedule = schedule(enabled)
        session.command('pause')
        session.command('rate .8 -2')
        actual = session.command('status')
        assert schedule(actual) == expected_schedule and actual['playbackRate'] == .8 and actual['transpose'] == -2, actual
        session.command('rate 1 0')
        session.command('met-begin 0 0 .4 1 4 0 4 0')
        session.command('met-beats 0 4 0 2 4 6')
        actual = session.command('met-apply')
        assert schedule(actual) == expected_schedule and actual['metronomeBeats'] == 4, actual
        actual = session.command('output default')
        assert schedule(actual) == expected_schedule and not actual['playing'], actual
        session.command('loop 1.2 2.6')
        session.wait(lambda s: s['looping'] and not s['playing'])
        parked = session.command('park')
        assert parked['parked'] and parked['physicalOutputReleased'] and parked['parkedLaneBytes'] > 0, parked
        restored = session.command('unpark')
        assert schedule(restored) == expected_schedule and restored['carryEnabled'], restored
        assert restored['state'] == 2 and restored['baseHostState'] in (0, 3, 6) and restored['looping'], restored
        cleared = session.command('unloop')
        assert cleared['graphGeneration'] == restored['graphGeneration'] and not cleared['playing'], cleared
        delivered = session.wait(lambda s: s['state'] == 4 and not s['playing'] and not s['looping'])
        assert schedule(delivered) == expected_schedule, delivered
        session.seek_peak('park-unpark-windows', 1.3, .08, 2.8)
        # Adding a custom lane keeps the accepted schedule and manual mix.
        before_mix = mix(session.command('status'))
        added = session.replace([('vocals', vocals), ('other', backing), ('custom-🎤', silent)])
        assert schedule(added) == expected_schedule and added['carryEnabled'], added
        for identifier in before_mix:
            assert mix(added)[identifier] == before_mix[identifier], added
        # Stage a draft, then remove its target through another valid native
        # transaction. Apply must revalidate current lanes, not trust old IDs.
        session.command('carry-begin 1 0 1 1 0')
        session.command('carry-lane ' + 'vocals'.encode().hex())
        removed = session.replace([('other', backing), ('custom-🎤', silent)])
        assert removed['carryLaneIds'] == [] and not removed['carryEnabled'], removed
        assert removed['carryRevision'] == expected_schedule[-1] + 1, removed
        refused = session.command('carry-apply', ok=False)
        assert schedule(refused) == schedule(removed) and not refused['carryCommitted'], refused
        custom = session.carry(mode=1, period=0, lanes=('custom-🎤',), windows=((1., 3.),))
        assert custom['carryEnabled'], custom
        emptied = session.replace([])
        assert emptied['emptyProject'] and not emptied['carryEnabled'] and not emptied['carryRequested'], emptied
        assert emptied['carryLaneIds'] == emptied['carryWindows'] == [], emptied
        assert emptied['carryRevision'] == custom['carryRevision'] + 1, emptied
        readded = session.replace([('vocals', vocals)])
        assert not readded['carryEnabled'] and not readded['carryRequested'] and readded['carryLaneIds'] == [], readded
        assert readded['carryRevision'] == emptied['carryRevision'], readded
        # Clearing the last graph also retires its metronome reference-bus
        # override; a fresh Add cannot inherit gain without the removed plan.
        assert readded['referenceGain'] == 0 and readded['metronomeBeats'] == 0 and not readded['metronomeClick'], readded
        assert abs(readded['masterGain'] - .8) < 1e-6, readded
    finally:
        session.close()
evidence(completed=True)
print('PASS native Carry the line: actual period/window duck, mix, seeks/loop, transactions, rate/route/park/lanes/empty')
