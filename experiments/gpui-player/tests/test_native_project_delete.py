"""Actual hidden native library deletion, identity, audio ownership and conflicts."""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import wave

parser = argparse.ArgumentParser()
parser.add_argument('app', type=Path)
parser.add_argument('out', type=Path)
args = parser.parse_args()
app, out = args.app.resolve(), args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
for name in ['result.json', 'failure.txt']:
    (out / name).unlink(missing_ok=True)


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree(path):
    return {member.relative_to(path).as_posix(): sha(member)
            for member in sorted(path.rglob('*')) if member.is_file()}


def path_identity(value):
    # Deleted members need lexical comparison of the two Win32 namespace forms.
    value = os.fspath(value)
    if os.name == 'nt':
        if value.startswith('\\\\?\\UNC\\'):
            value = '\\\\' + value[8:]
        elif value.startswith('\\\\?\\'):
            value = value[4:]
    return os.path.normcase(os.path.normpath(value))

def foreground():
    if platform.system() != 'Darwin':
        return {'available': False, 'reason': 'lsappinfo unavailable'}
    try:
        process = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True,
                                 text=True, timeout=2, check=False)
        return {'available': process.returncode == 0, 'front': process.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'available': False, 'reason': str(error)}


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

with tempfile.TemporaryDirectory(prefix='singz-native-project-delete-') as temporary:
    root = Path(temporary).resolve()
    library, prefs = root / 'library', root / 'preferences'
    library.mkdir()
    prefs.mkdir()
    sentinel = root / 'must-survive.txt'
    sentinel.write_text('Outside the library. Never a deletion target.\n')
    inside = library / 'unrelated-library-note.txt'
    inside.write_text('Not a project and not a deletion target.\n')
    block = b''.join(struct.pack('<h', int(3000 * math.sin(index * math.tau * 220 / 16000)))
                     for index in range(16000))
    identities = {}
    # Same visible title, different authoritative directories and audio members.
    # The "other" projects are stems-only, so audio paths cannot stand in for dir.
    for width, order in [(1280, 4), (1060, 2)]:
        for role in ['current', 'other']:
            folder = library / f'{role}-{width}'
            folder.mkdir()
            metadata = {'version': 2, 'name': 'Identical song title 🎤',
                        'savedAt': f'2026-11-{order:02d}T12:00:00Z',
                        'foreign': {'mustSurviveFailure': f'{role}-{width}'}, 'settings': {}}
            if role == 'current':
                metadata['songFile'] = 'song.wav'
                audio_path = folder / 'song.wav'
                seconds = 120
            else:
                (folder / 'stems').mkdir()
                audio_path = folder / 'stems' / 'vocals.wav'
                seconds = 1
                (folder / 'lyrics.json').write_text(json.dumps({'version': 1, 'lines': []}))
            with wave.open(str(audio_path), 'wb') as audio:
                audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
                audio.writeframes(block * seconds)
            (folder / 'project.json').write_text(json.dumps(metadata, ensure_ascii=False))
            (folder / 'notes.txt').write_text(f'Private project notes: {role}-{width}\n')
            identities[folder.name] = {'path': str(folder), 'title': metadata['name'],
                'files': tree(folder), 'audioMember': audio_path.relative_to(folder).as_posix()}
    before_tree = tree(library)
    (out / 'fixture-before.json').write_text(json.dumps(identities, indent=2, ensure_ascii=False))
    catalog = root / 'catalog.json'
    catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('SINGZ_GPUI_') and key not in
           ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'OneDrive']}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
        SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library),
        SINGZ_GPUI_PROJECT_DELETE_FIXTURES=str(library), SINGZ_GPUI_PROJECT_DELETE_TEST=str(out),
        SINGZ_GPUI_DELETE_PREPARE_GATE=str(root / 'delete-prepare.gate'),
        SINGZ_GPUI_MODEL_FIXTURE=str(catalog), SINGZ_PACK_DIR=str(root / 'missing-pack'),
        SINGZ_MODELS_DIR=str(root / 'missing-models'), PYTHONDONTWRITEBYTECODE='1')
    before = foreground()
    samples, stopped, started = [], threading.Event(), time.monotonic()
    with (out / 'project-delete.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)

        def sample():
            previous = None
            while not stopped.wait(.3):
                try:
                    if platform.system() != 'Darwin':
                        samples.append({'available': False, 'reason': 'Native process counters are macOS-only'})
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        samples.append({'elapsedSeconds': now - started,
                            'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except OSError as error:
                    if child.poll() is None:
                        samples.append({'available': False, 'reason': str(error)})
                    return

        sampling = threading.Thread(target=sample, daemon=True)
        sampling.start()
        try:
            returncode = child.wait(timeout=85)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=4)
            raise AssertionError('Hidden native delete exceeded 85 seconds')
        finally:
            stopped.set()
            sampling.join(timeout=3)
            after = foreground()
            (out / 'foreground.json').write_text(json.dumps({'before': before, 'after': after}, indent=2))
            (out / 'performance.json').write_text(json.dumps({'samples': samples,
                'scope': 'GPUI app process CPU/footprint; native audio helper is separate; GPU counters system-wide',
                'liveFps': {'available': False, 'reason': 'hidden event-driven rendering cannot establish live display cadence'}}, indent=2))
            after_tree = tree(library)
            (out / 'filesystem-outcome.json').write_text(json.dumps({'before': before_tree,
                'after': after_tree, 'remainingDirectories': [path.name for path in library.iterdir() if path.is_dir()],
                'sentinelSha256': sha(sentinel), 'libraryNoteSha256': sha(inside)}, indent=2))
            # Preserve modified metadata even on a failing run before cleanup.
            for member in library.rglob('project.json'):
                shutil.copyfile(member, out / f'failure-retained-{member.parent.name}.json')
    assert returncode == 0, (returncode, (out / 'project-delete.log').read_text()[-18000:])
    assert not (out / 'failure.txt').exists()
    result = json.loads((out / 'result.json').read_text())
    assert result and all(value is True for value in result.values()), result
    assert sentinel.read_text() == 'Outside the library. Never a deletion target.\n'
    assert inside.read_text() == 'Not a project and not a deletion target.\n'
    assert not [path for path in library.iterdir() if path.is_dir()], 'Deleted project or hidden cleanup remained'
    for name in identities:
        assert not (library / name).exists()
    ledger = json.loads((prefs / 'sync.json').read_text())
    dirty = ledger['gdriveDirty']
    assert dirty['seq'] == 4 and dirty.get('allSeq', 0) == 0, dirty
    actual_dirs = {path_identity(value) for value in dirty['dirs']}
    assert len(actual_dirs) == len(dirty['dirs']) == 4, dirty
    assert actual_dirs == {path_identity(item['path']) for item in identities.values()}, dirty
    assert set(dirty['dirs'].values()) == {1, 2, 3, 4}, dirty
    (out / 'durable-deletion-intent.json').write_text(json.dumps(ledger, indent=2))
    if before['available'] and after['available']:
        assert before['front'] == after['front'], (before, after)
    if platform.system() == 'Darwin':
        cpu = [row['processCpuPercent'] for row in samples if 'processCpuPercent' in row]
        assert len(cpu) >= 2 and all(math.isfinite(value) and value >= 0 for value in cpu), samples
    for width in [1280, 1060]:
        changed = json.loads((out / f'conflict-preserved-{width}.json').read_text())
        assert changed['externalDeleteFixture'] == f'external-{width}'
        assert changed['foreign']['mustSurviveFailure'] == f'current-{width}'
        for case in ['confirm-other', 'busy-other', 'conflict-inline', 'writer-refused', 'confirm-loaded', 'deleted-loaded']:
            path = out / f'{case}-{width}.state.json'
            snapshot = json.loads(path.read_text())
            assert not snapshot['windowPresented'] and not snapshot['windowActive']
            assert snapshot['hiddenConfigured'] and snapshot['mutedConfigured']
            assert snapshot['viewport'] == [width, 800 if width == 1280 else 640]
            with path.with_name(path.name.replace('.state.json', '.png')).open('rb') as stream:
                header = stream.read(24)
            assert header[:8] == b'\x89PNG\r\n\x1a\n'
            assert struct.unpack('>II', header[16:24]) == tuple(round(value * snapshot['scale']) for value in snapshot['viewport'])
            state = snapshot['delete']
            assert state['notice'] is None
            if case == 'confirm-other':
                assert state['dialog']['details']['opened'] is False
                assert state['dialog']['details']['stem_count'] == 1 and state['dialog']['details']['has_lyrics']
                assert path_identity(state['project']) == path_identity(identities[f'current-{width}']['path'])
                assert state['playing']
            elif case == 'busy-other':
                assert state['dialog']['busy'] and state['dialog']['open'] and state['playing']
                assert state['deletePending']['loaded'] is False
            elif case in ['conflict-inline', 'writer-refused']:
                assert not state['dialog']['open'] and state['error'].startswith('Could not delete it: ')
                assert path_identity(state['project']) == path_identity(identities[f'current-{width}']['path']) and not state['playing']
            elif case == 'confirm-loaded':
                assert state['dialog']['details']['opened'] is True
                assert state['dialog']['details']['stem_count'] == 0
            elif case == 'deleted-loaded':
                assert not state['loadedSong'] and state['project'] is None and not state['playing']
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
        'platform': platform.platform(), 'noNode': True, 'hidden': True, 'muted': True,
        'hardwareInput': False, 'fixtures': identities,
        'interaction': 'real native card Open/Delete, transport Play, modal controls and local keyboard; no injected delete receipts',
        'conflict': 'actual metadata file changed while backend BeforeHide gate holds the confirmed request',
        'writer': 'actual native zero-byte saved-project writer lease held after inspection',
        'audio': 'unrelated gated delete must retain epoch and advance both native status anchor and position; loaded failures recover paused; committed loaded delete clears playback and resists late status',
        'copyDeviations': ['Opened project deletion stops playback and closes it.', 'Delete failure warning remains visible offline without a Drive account.'],
        'visualReference': 'candidate-only; matched production reference absent'}, indent=2, ensure_ascii=False))
print('PASS: hidden actual project deletion, identity, playback ownership and recoverable failure at two sizes')
