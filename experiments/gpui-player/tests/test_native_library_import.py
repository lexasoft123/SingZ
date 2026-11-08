"""Actual hidden native Copy/Move library import, guarded filesystem handoff.

No Node, OS input, real folder dialog, global focus or unmuted audio. Captures
remain candidates until matching production screenshots are reviewed.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import stat
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
for filename in ['result.json', 'failure.txt']:
    (out / filename).unlink(missing_ok=True)

def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def tree(path):
    return {p.relative_to(path).as_posix(): sha(p) for p in sorted(path.rglob('*')) if p.is_file()}


def project_data(path, library_root=False):
    """Ignore only known, ordinary zero-byte coordination files at exact scopes."""
    files = tree(path)
    allowed = {'.singz-native-import.lock'} if library_root else {'.singz-native-write.lock'}
    if library_root:
        allowed.update(f'{p.parent.name}/.singz-native-write.lock'
                       for p in path.glob('*/project.json') if p.is_file())
    for relative in allowed:
        candidate = path / relative
        if candidate.exists() or candidate.is_symlink():
            metadata = candidate.lstat()
            assert stat.S_ISREG(metadata.st_mode) and metadata.st_size == 0, (
                'Coordination file must be ordinary and empty', str(candidate), metadata.st_size)
            files.pop(relative, None)
    return files


def archive_integrity(stage_out, root, before, metadata_before):
    after = tree(root)
    changes = [{'path': name, 'beforeSha256': before.get(name), 'afterSha256': after.get(name)}
               for name in sorted(before.keys() | after.keys()) if before.get(name) != after.get(name)]
    metadata_after = {p.relative_to(root).as_posix(): p.read_text(errors='replace')
                      for p in sorted(root.rglob('*.json')) if p.is_file()}
    # Write this before checking even process success: TemporaryDirectory cleanup
    # must never erase the identities or metadata that explain a failed stage.
    (stage_out / 'integrity-diff.json').write_text(json.dumps({
        'before': before, 'after': after, 'changes': changes,
        'metadataBefore': metadata_before, 'metadataAfter': metadata_after,
        'coordinationAllowance': {
            'libraryRoot': '.singz-native-import.lock',
            'immediateProjectRoot': '.singz-native-write.lock',
            'requirements': 'ordinary file, zero bytes; every other file compared exactly'}}, indent=2, ensure_ascii=False))
    changed_files = stage_out / 'integrity-after-files'
    for change in changes:
        source = root / change['path']
        if source.is_file():
            target = changed_files / change['path']
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)


spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

with tempfile.TemporaryDirectory(prefix='singz-library-import-') as temporary:
    root = Path(temporary).resolve()
    prefs, library, alternate = [root / name for name in ['prefs', 'library', 'alternate-library']]
    for folder in [prefs, library, alternate]:
        folder.mkdir()
    (prefs / 'library.json').write_text(json.dumps({'projectsRoot': str(library), 'foreign': {'keep': True}}))
    source = root / 'source.wav'
    block = b''.join(struct.pack('<h', int(2500 * math.sin(i * math.tau * 220 / 44100))) for i in range(44100))
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
        audio.writeframes(block * 30)
    names = ['Copy project', 'Move project', 'Collision project', 'Changed project', 'Stale project', 'Other project']
    initial = {}
    for name in names:
        folder = root / 'external' / name
        folder.mkdir(parents=True)
        shutil.copyfile(source, folder / 'song.wav')
        metadata = {'version': 2, 'name': name, 'songFile': 'song.wav', 'savedAt': '2026-11-07T12:00:00Z',
                    'foreign': {'keep': name}, 'settings': {}}
        (folder / 'project.json').write_text(json.dumps(metadata))
        (folder / '.private-note').write_text('ordinary dotfile must survive exactly\n')
        (folder / 'notes.txt').write_text(f'notes for {name}\n')
        (folder / 'lyrics.json').write_text(json.dumps({'source': 'edited', 'credit': 'fixture', 'lines': [
            {'start': 1, 'end': 2, 'text': 'Native words', 'words': [
                {'w': 'Native', 's': 1, 'e': 1.4}, {'w': 'words', 's': 1.5, 'e': 2}]}]}))
        initial[name] = project_data(folder)
    collision = library / 'Collision project'
    collision.mkdir()
    (collision / 'project.json').write_text(json.dumps({'version': 2, 'name': 'Existing collision', 'songFile': 'song.wav', 'settings': {}}))
    shutil.copyfile(source, collision / 'song.wav')
    (collision / 'notes.txt').write_text('Never overwrite destination collision\n')
    collision_before = project_data(collision)
    integrity_before = tree(root)
    metadata_before = {p.relative_to(root).as_posix(): p.read_text(errors='replace')
                       for p in sorted(root.rglob('*.json')) if p.is_file()}
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_')
           and k not in ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'OneDrive']}
    env.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library),
               SINGZ_GPUI_LIBRARY_IMPORT_TEST=str(out), SINGZ_GPUI_LIBRARY_IMPORT_FIXTURES=str(root),
               SINGZ_GPUI_IMPORT_PREPARE_GATE=str(root / 'import.gate'),
               SINGZ_GPUI_IMPORT_RECEIPT_GATE=str(root / 'receipt.gate'),
               SINGZ_GPUI_IMPORT_OLD_STATUS_GATE=str(root / 'old-status.gate'),
               SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'library-import.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)
        def sample():
            previous = None
            while not stop.wait(.5):
                try:
                    if platform.system() != 'Darwin':
                        resources.append({'available': False, 'reason': 'macOS process counters unavailable'})
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now - started,
                            'processCpuPercent': (cpu - previous[0]) / ((now - previous[1]) * 1e9) * 100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except OSError:
                    return
        worker = threading.Thread(target=sample, daemon=True)
        worker.start()
        try:
            child.wait(timeout=150)
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            worker.join(timeout=4)
            archive_integrity(out, root, integrity_before, metadata_before)
    (out / 'performance.json').write_text(json.dumps({
        'scope': 'GPUI CPU/footprint; excludes native helper; GPU system-wide',
        'wallSeconds': time.monotonic() - started, 'samples': resources,
        'liveFps': {'available': False, 'reason': 'hidden static captures cannot establish live cadence'}}, indent=2))
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'library-import.log').read_text()
    result = json.loads((out / 'result.json').read_text())
    required = ['twoSizes', 'escapeClose', 'focusTrap', 'busyDismissalBlocked', 'copy', 'move',
                'playingMixPositionPreserved', 'copyAudioAdvancedWhileHeld', 'oldStatusRaceExercised', 'successToastNonblocking',
                'successToastSixSecondExpiry', 'pausedMixPositionPreserved', 'capturedRootStable',
                'ownedSaveNewDirectory', 'collisionRefused', 'externalEditRefused', 'staleNavigationIgnored', 'hidden', 'muted']
    assert all(result.get(key) is True for key in required), result
    for path in out.glob('*.state.json'):
        state = json.loads(path.read_text())
        assert not state['windowPresented'] and not state['windowActive'], state
        assert state['mutedConfigured'] and state['hiddenConfigured'], state
    for name in ['Copy project', 'Collision project', 'Stale project', 'Other project']:
        assert project_data(root / 'external' / name) == initial[name], f'External project changed: {name}'
    assert not (root / 'external/Move project').exists(), 'Move left original directory'
    assert project_data(library / 'Move project') == initial['Move project'], 'Move changed project data'
    assert project_data(collision) == collision_before, 'Same-name destination overwritten'
    changed = root / 'external/Changed project'
    metadata = json.loads((changed / 'project.json').read_text())
    assert metadata.pop('externalChange') == 'preserve external edit'
    original_metadata = json.loads(metadata_before['external/Changed project/project.json'])
    assert metadata == original_metadata
    for name, digest in initial['Changed project'].items():
        if name != 'project.json':
            assert sha(changed / name) == digest, f'External-edit conflict changed {name}'
    assert not (library / 'Changed project').exists(), 'Conflicted project published'
    assert not list(alternate.iterdir()), 'Import destination followed preferences changed during operation'
    copied = project_data(library / 'Copy project')
    assert copied.keys() == initial['Copy project'].keys()
    for name, digest in initial['Copy project'].items():
        if name != 'project.json':
            assert copied[name] == digest, f'Copy/owned Save changed data member {name}'
    saved = json.loads((library / 'Copy project/project.json').read_text())
    assert saved['foreign'] == {'keep': 'Copy project'}
    assert abs(saved['settings']['masterVolume'] - .6) < 1e-6, 'Owned Save failed to write live mix to imported project'
    # The stale operation is superseded after publication. Whether its copied
    # output survives is explicit filesystem evidence, not a claim that Cancel
    # reverses a completed copy.
    stale = library / 'Stale project'
    if stale.exists():
        assert project_data(stale) == initial['Stale project'], 'Stale published copy changed source data'
    expected_library = {f'Collision project/{name}': digest for name, digest in collision_before.items()}
    for name in ['Copy project', 'Move project'] + (['Stale project'] if stale.exists() else []):
        expected_library.update({f'{name}/{member}': digest for member, digest in project_data(library / name).items()})
    assert project_data(library, library_root=True) == expected_library, 'Unexpected library data or artifacts'
    leftovers = [p.relative_to(root).as_posix() for p in root.rglob('*')
                 if any(marker in p.name for marker in ['.incoming', '.library-copy', '.part'])]
    assert not leftovers, leftovers
    (out / 'filesystem-result.json').write_text(json.dumps({'sourceCopyUnchanged': True,
        'moveSourceRemoved': True, 'moveDataExact': True, 'collisionPreserved': True,
        'externalEditPreserved': True, 'capturedRootStable': True, 'ownedSaveImportedMix': True,
        'stalePublishedCopyPresent': stale.exists(), 'noStagedLeftovers': True}, indent=2))
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
        'helperSha256': sha(app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')),
        'sourceSha256': sha(source), 'initialProjects': initial, 'initialCollision': collision_before,
        'logicalViewports': [[1280, 800], [1060, 640]], 'platform': platform.platform(), 'locale': 'en',
        'noNode': True, 'hidden': True, 'muted': True,
        'gates': 'ui-tests-only outstanding old-epoch status read, prepare CAS/publication, and postcommit receipt gates',
        'sameFilesystemMove': True, 'crossDeviceMove': 'not exercised by this UI suite',
        'visualReference': 'candidate only; matched production references absent'}, indent=2))
print('PASS: hidden native LibraryImport controls, Copy/Move, busy guards, transport/mix preservation, conflicts, captured root, stale receipt and imported Save')
