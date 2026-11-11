"""Hidden, muted native transport legs (Q-03): early and double Play, a loop ahead
of the playhead, a quarter-second loop, playing out then Play again, a scrub out
of the last seconds, and streamed-lane starvation counters.

A separate launch from test_native_transport_timing_ui.py, whose 120 s budget is
unchanged. Each of these legs is a real click on the transport controls with the
helper's accepted status as the authority (see src/ui_transport_legs.rs).
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import struct
import subprocess
import tempfile
import time
import wave

# Measured: one launch takes about 10 s (a 3 s loop-ahead lap, a 1 s play-out,
# the quarter-second loop's three laps, half-second starvation windows, app
# start-up and project load). The launch gets 60 s, six times the measurement,
# and the whole driver 90 s, well inside the timing driver's 120 s launch budget,
# which is unchanged. Every in-app wait also carries its own 25 s deadline.
LAUNCH_BUDGET = 60.0
TOTAL_DEADLINE = 90.0
started = time.monotonic()

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()


def audio(path, frequency):
    path.parent.mkdir(parents=True, exist_ok=True)
    rate = 16000
    second = b''.join(struct.pack('<h', round(1000 * math.sin(i * math.tau * frequency / rate))) for i in range(rate))
    with wave.open(str(path), 'wb') as stream:
        stream.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        stream.writeframes(second * 30)


with tempfile.TemporaryDirectory(prefix='singz-legs-ui-') as directory:
    root = Path(directory).resolve()
    library = root / 'library'
    project = library / 'Legs fixture'
    audio(project / 'stems/vocals.wav', 220)
    audio(project / 'stems/bass.wav', 110)
    beat = {'beats': [i * .5 for i in range(60)], 'bpm': 120, 'beatsPerBar': 4, 'downbeat': 0,
            'downbeats': list(range(0, 60, 4)), 'autoDownbeats': list(range(0, 60, 4)),
            'source': 'auto', 'detVersion': 23}
    (project / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Legs fixture', 'settings': {
        'tempo': 1, 'transpose': -2, 'masterVolume': .61, 'loop': False, 'selection': None,
        'tracks': {'vocals': {'volume': .37, 'muted': False, 'solo': False},
                   'bass': {'volume': .7, 'muted': True, 'solo': False}},
        'beat': beat, 'key': {'pc': 9, 'minor': False, 'detVersion': 2},
        'melody': {'detVersion': 4, 'hopSec': .01, 'f0': ' '.join(['2400'] * 3000)},
        'metronome': {'click': False, 'countInBars': 0, 'volume': .3, 'accent': True, 'grid': False}}}))
    warmup = library / 'Warmup fixture'
    shutil.copytree(project, warmup)
    warmup_raw = json.loads((project / 'project.json').read_text())
    warmup_raw['name'] = 'Warmup fixture'
    (warmup / 'project.json').write_text(json.dumps(warmup_raw))
    stems = {name: sha(project / 'stems' / name) for name in ('vocals.wav', 'bass.wav')}
    environment = {key: value for key, value in os.environ.items()
                   if not key.startswith('SINGZ_GPUI_') and key not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS')}
    folder = out / 'legs'
    folder.mkdir(parents=True, exist_ok=True)
    environment.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
                       SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
                       SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(library),
                       SINGZ_GPUI_TEST_PROJECT=str(project), SINGZ_GPUI_LEGS_WARMUP_PROJECT=str(warmup), SINGZ_GPUI_TRANSPORT_LEGS_TEST=str(folder),
                       SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app), 'helperSha256': sha(helper), 'hidden': True, 'muted': True,
                                                  'launchBudgetSeconds': LAUNCH_BUDGET, 'totalDeadlineSeconds': TOTAL_DEADLINE}, indent=2))
    launched = time.monotonic()
    with (folder / 'legs.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=environment, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            child.wait(timeout=min(LAUNCH_BUDGET, TOTAL_DEADLINE - (time.monotonic() - started)))
        finally:
            if child.poll() is None:
                try:
                    os.killpg(child.pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                child.wait(timeout=5)
    elapsed = time.monotonic() - launched
    assert child.returncode == 0 and (folder / 'result.json').exists(), (folder / 'legs.log').read_text()
    assert not (folder / 'failure.txt').exists(), (folder / 'failure.txt').read_text()
    result = json.loads((folder / 'result.json').read_text())
    assert result['spaceReachedLoadingRefusal'] is True and result['spaceRouteLiveBeforeOpen'] is True, result
    assert isinstance(result['clickReachedLoadingRefusal'], bool), result
    for case in ('pressedWhileLoadingRefusedCoherently', 'earlyPlayRealControl', 'doublePlayStateCoherent', 'loopAheadReachedStart',
                 'quarterSecondLoopWrapped', 'playAfterEnd', 'scrubFromTail', 'streamedLaneCounters', 'steadyStarvedBlocksZero'):
        assert result[case] is True, (case, result)
    assert {name: sha(project / 'stems' / name) for name in stems} == stems, 'stems changed'
    assert time.monotonic() - started < TOTAL_DEADLINE, 'total transport legs deadline expired'
    (out / 'summary.json').write_text(json.dumps({'launchSeconds': round(elapsed, 1), **result}, indent=2))
    print(f'PASS hidden transport legs in {elapsed:.1f}s: early/double Play, loop ahead, quarter-second loop, play-out and Play again, tail scrub, streamed-lane starvation')
