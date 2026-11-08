"""Hidden native ProjectPicker, copied libraries and restart persistence.

Only app-local controls are dispatched. Fixture audio, preferences and library
roots are private; no Node, OS input, real folder dialog or unmuted output.
Captures are candidates until matched production references are reviewed.
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
import struct
import stat
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


def sha(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def tree(path):
    return {str(p.relative_to(path)): sha(p) for p in sorted(path.rglob('*')) if p.is_file()}


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
    metadata_after = {str(p.relative_to(root)): p.read_text(errors='replace')
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

with tempfile.TemporaryDirectory(prefix='singz-project-picker-') as temporary:
    root = Path(temporary).resolve()
    prefs, library, custom = [root / name for name in ['prefs', 'library', 'custom']]
    for folder in [prefs, library, custom]:
        folder.mkdir()
    (prefs / 'library.json').write_text(json.dumps({'foreign': {'preserve': True}}))
    source = root / 'short.wav'
    block = b''.join(struct.pack('<h', int(3200 * math.sin(i * math.tau * 220 / 44100))) for i in range(44100))
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
        audio.writeframes(block)

    def project(folder, name, order=0, active=False):
        folder.mkdir(parents=True)
        if active:
            with wave.open(str(folder / 'song.wav'), 'wb') as audio:
                audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
                audio.writeframes(block * 60)
        else:
            shutil.copyfile(source, folder / 'song.wav')
        metadata = {'version': 2, 'name': name, 'songFile': 'song.wav',
                    'savedAt': f'2026-11-{min(28, order + 1):02d}T12:00:00Z',
                    'foreign': {'preserve': name}, 'settings': {}}
        (folder / 'project.json').write_text(json.dumps(metadata, ensure_ascii=False))
        (folder / 'notes.txt').write_text(f'notes for {name}\n')

    project(root / 'active', 'Already playing external song', active=True)
    active_before = tree(root / 'active')
    environment = {k: v for k, v in os.environ.items()
                   if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'OneDrive']}
    environment.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
                       SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library),
                       SINGZ_GPUI_PROJECT_PICKER_FIXTURES=str(root),
                       SINGZ_GPUI_PICKER_CHOOSE_ROOT=str(custom),
                       SINGZ_GPUI_PICKER_MOVE_GATE=str(root / 'move.gate'),
                       SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'))
    receipts = {}

    def run(stage):
        stage_out = out / stage
        stage_out.mkdir(exist_ok=True)
        for filename in ['result.json', 'failure.txt']:
            (stage_out / filename).unlink(missing_ok=True)
        env = dict(environment, SINGZ_GPUI_PROJECT_PICKER_TEST=str(stage_out), SINGZ_GPUI_PICKER_STAGE=stage)
        integrity_before = tree(root)
        metadata_before = {str(p.relative_to(root)): p.read_text(errors='replace')
                           for p in sorted(root.rglob('*.json')) if p.is_file()}
        resources, stop, started = [], threading.Event(), time.monotonic()
        with (stage_out / 'picker.log').open('w') as log:
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
                child.wait(timeout=120)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                stop.set()
                worker.join(timeout=4)
                archive_integrity(stage_out, root, integrity_before, metadata_before)
        (stage_out / 'performance.json').write_text(json.dumps({
            'scope': 'GPUI process CPU/footprint; excludes audio helper; GPU system-wide',
            'wallSeconds': time.monotonic() - started, 'samples': resources,
            'liveFps': {'available': False, 'reason': 'hidden static captures do not measure live display cadence'}}, indent=2))
        assert child.returncode == 0 and (stage_out / 'result.json').is_file(), (stage_out / 'picker.log').read_text()
        result = json.loads((stage_out / 'result.json').read_text())
        assert all(value is True for value in result.values()), result
        if stage in ['empty', 'full']:
            required = ['twoSizes', 'focusTrap', 'escape', 'playbackPreserved', 'libraryStorageRoute', 'headerProjectsRoute']
            assert all(result.get(key) is True for key in required), result
        receipts[stage] = result
        for path in stage_out.glob('*.state.json'):
            state = json.loads(path.read_text())
            assert state['windowPresented'] is False and state['windowActive'] is False, state
            assert state['hiddenConfigured'] is True and state['mutedConfigured'] is True, state
        assert tree(root / 'active') == active_before, 'Picker changed active source project'
        return result

    assert run('empty')['empty'] is True
    assert json.loads((prefs / 'library.json').read_text()) == {'foreign': {'preserve': True}}
    for index in range(24):
        name = (f'{index + 1:02d} · Очень длинное название песни — ' + 'A long album version / Live edition ' * 3
                if index % 3 == 0 else f'{index + 1:02d} · Saved project')
        folder = library / f'project-{index:02d}'
        project(folder, name, index)
        if index == 1:
            (folder / 'lyrics.json').write_text(json.dumps({'source': 'edited', 'credit': 'fixture', 'lines': [
                {'start': 0, 'end': .8, 'text': 'Native lyrics', 'words': [
                    {'w': 'Native', 's': 0, 'e': .4}, {'w': 'lyrics', 's': .4, 'e': .8}]}]}))
        if index == 2:
            (folder / 'stems').mkdir()
            for stem in ['vocals', 'drums', 'bass', 'other']:
                shutil.copyfile(source, folder / 'stems' / f'{stem}.wav')
    project(custom / 'project-00', 'Existing destination collision stays unchanged', 0)
    (custom / 'project-00/notes.txt').write_text('destination collision sentinel\n')
    library_before, collision_before = project_data(library, library_root=True), project_data(custom / 'project-00')
    (root / 'move.gate').write_text('hold relocation before preference commit')
    full = run('full')
    assert all(full.get(key) is True for key in ['openItem', 'chooseRoot', 'closeDuringMoveContinues', 'longNamesAndScroll']), full
    assert project_data(library, library_root=True) == library_before, 'Copy-only relocation changed original library'
    assert project_data(custom / 'project-00') == collision_before, 'Relocation overwrote existing destination project'
    assert len(list(custom.glob('*/project.json'))) == 24
    expected_custom = {name: digest for name, digest in library_before.items()
                       if not name.startswith('project-00/')}
    expected_custom.update({f'project-00/{name}': digest for name, digest in collision_before.items()})
    assert project_data(custom, library_root=True) == expected_custom, 'Destination gained or changed project data'
    for index in range(1, 24):
        folder = f'project-{index:02d}'
        assert project_data(custom / folder) == project_data(library / folder), f'Relocation changed {folder}'
    config = json.loads((prefs / 'library.json').read_text())
    assert Path(config['projectsRoot']) == custom and config['foreign'] == {'preserve': True}, config
    assert run('restart')['resetDefault'] is True
    assert run('reset-restart')['restartPersistence'] is True
    config = json.loads((prefs / 'library.json').read_text())
    assert not config.get('projectsRoot') and config['foreign'] == {'preserve': True}, config
    assert project_data(library, library_root=True) == library_before and project_data(custom / 'project-00') == collision_before
    assert project_data(custom, library_root=True) == expected_custom, 'Reset changed destination project data'
    leftovers = [str(p.relative_to(root)) for p in root.rglob('*')
                 if any(part in p.name for part in ['.incoming', '.library-copy', '.part'])]
    assert not leftovers, leftovers
    shutil.copytree(prefs, out / 'final-preferences', dirs_exist_ok=True)
    (out / 'result.json').write_text(json.dumps({'stages': receipts, 'collisionPreserved': True,
        'sourceLibraryUnchanged': True, 'copyOnly': True, 'restartPersistence': True,
        'resetPersistence': True, 'activeProjectUnchanged': True, 'noStagedLeftovers': True}, indent=2))
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
        'helperSha256': sha(app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')),
        'sourceSha256': sha(source), 'libraryBefore': library_before, 'collisionBefore': collision_before,
        'logicalViewports': [[1280, 800], [1060, 640]], 'locale': 'en', 'platform': platform.platform(),
        'noNode': True, 'capture': 'hidden native content; muted; app-local input',
        'folderChooser': 'ui-tests-only interception at production choose-root callback',
        'closeDuringMove': 'ui-tests-only precommit move gate; Close hides modal and copy continues after release; UI has no Cancel route',
        'animation': 'settled source 250ms timestamp for static capture',
        'visualReference': 'candidate only; matched production references absent'}, indent=2, ensure_ascii=False))
print('PASS: hidden ProjectPicker list/empty, keyboard/scroll, playback preservation, real opening, root relocation/collision/close continuation and restart/reset persistence')
