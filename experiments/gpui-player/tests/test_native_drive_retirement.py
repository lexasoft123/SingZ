"""Actual Delete-last/Rename and same-name reuse against isolated native Drive.

Old recovery media and unrelated outside objects must survive every production
sync. New projects are explicit private filesystem fixtures recognized/opened by
the real ProjectPicker; no player, publication or journal state is assigned.
"""
import argparse
import base64
import copy
import io
import json
import math
import os
from pathlib import Path
import shutil
import struct
import sys
import threading
import traceback
import wave

sys.dont_write_bytecode = True
import drive_fixture as fixture
import test_native_empty_drive as base
import test_native_training_keyboard as shared
from test_native_drive_restore import authorize


def encoded(frequency):
    output = io.BytesIO()
    with wave.open(output, 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        second = b''.join(struct.pack('<h', int(1800 * math.sin(i * math.tau * frequency / 16000))) for i in range(16000))
        audio.writeframes(second * 12)
    return output.getvalue()


def project_folder(state, name):
    files = base.rows(state)
    matches = [row for row in base.children(files, 'root-singz') if row['name'] == name and row['mimeType'] == fixture.FOLDER]
    assert len(matches) == 1, (name, [(row['id'], row['name']) for row in base.children(files, 'root-singz')])
    return matches[0]


def document(state, folder):
    candidates = [row for row in base.children(base.rows(state), folder['id']) if row['name'] == 'project.json']
    assert len(candidates) == 1
    return candidates[0], json.loads(base.body(candidates[0]))


def subtree(files, parent):
    result = []
    for row in base.children(files, parent):
        result.append(row)
        if row['mimeType'] == fixture.FOLDER:
            result.extend(subtree(files, row['id']))
    return result


def journals(preferences):
    result = {}
    root = preferences / 'gdrive/empty-transactions'
    for path in root.rglob('*.json'):
        try:
            value = json.loads(path.read_text())
        except (ValueError, UnicodeError):
            continue
        if isinstance(value, dict) and isinstance(value.get('transaction'), str) and 'phase' in value:
            result.setdefault(value['transaction'], []).append({'path': str(path), 'value': value})
    return result


def committed_lineage(before, current, name, preferences, protected):
    old = project_folder(before, name)
    active = project_folder(current, name)
    assert active['id'] == old['id'], 'Empty commit changed its active folder identity'
    old_doc, _ = document(before, old)
    new_doc, raw = document(current, active)
    assert base.strict_empty(raw) and new_doc['id'] != old_doc['id']
    before_files, after_files = base.rows(before), base.rows(current)
    original_members = subtree(before_files, old['id'])
    assert original_members
    for member in original_members:
        actual = after_files[member['id']]
        assert not actual['trashed'] and base.body(actual) == base.body(member)
        assert actual.get('md5Checksum') == member.get('md5Checksum') and actual.get('size') == member.get('size')
        assert 'root-singz' not in base.ancestors(after_files, member['id']), 'Recovery member remains active'
        protected[member['id']] = copy.deepcopy(actual)
    candidates = [record['value'] for group in journals(preferences).values() for record in group
                  if record['value'].get('phase') == 'committed'
                  and record['value'].get('folder', {}).get('id') == active['id']
                  and record['value'].get('staged_ids', {}).get('project.json') == new_doc['id']]
    assert candidates, 'No production committed journal proves this active empty generation'
    transaction = candidates[0]['transaction']
    assert all(value['transaction'] == transaction for value in candidates)
    return {'transaction': transaction, 'folderId': active['id'], 'documentId': new_doc['id'],
            'project': name, 'recoveryIds': [member['id'] for member in original_members]}


def retirement_proof(preferences, lineage, current, kind):
    # Require both the empty-history hook and positive cloud retirement proof;
    # cached publications/localSuperseded/path absence are not retirement.
    records = journals(preferences).get(lineage['transaction'], [])
    empty_hooks = [record for record in records if record['value'].get('phase') == 'retired'
                   and record['value'].get('folder', {}).get('id') == lineage['folderId']]
    assert empty_hooks, 'Missing empty-history retired hook for exact transaction/folder'
    candidates = []
    root = preferences / 'gdrive/retirements/transactions'
    for path in root.glob('*/journal.json'):
        assert not path.is_symlink() and path.is_file() and path.stat().st_size <= 16 * 1024 * 1024
        value = json.loads(path.read_text())
        source = value.get('source') or {}
        # Metadata.entry is serde-flattened: its exact ID is folder.id on disk.
        if value.get('phase') == 'retired' and source.get('folder', {}).get('id') == lineage['folderId']:
            candidates.append((path, value))
    assert len(candidates) == 1, 'Missing or ambiguous affirmative retirement for the captured folder'
    path, value = candidates[0]
    source, terminal = value['source'], value['terminal']
    operation_id = value['operation']
    assert value['version'] == 1 and len(operation_id) == 64 and all(ch in '0123456789abcdef' for ch in operation_id)
    assert path.parent.name == operation_id and value['sequence'] > 0
    assert source['project'] == lineage['project'] and source['binding'] == value['binding']
    assert any(member['id'] == lineage['documentId'] and member['name'] == 'project.json' for member in source['members'])
    assert all(record['value']['binding'] == source['binding']['key'] for record in empty_hooks)
    assert terminal['folder']['id'] == lineage['folderId'] and terminal['folder']['trashed'] is True
    assert terminal['folder']['name'] == source['folder']['name']
    assert {member['id'] for member in terminal['members']} == {member['id'] for member in source['members']}
    assert terminal['catalog_document']['format'] == 2
    assert not any(row['dir'] == source['project'] for row in terminal['catalog_document']['projects'])
    matching = []
    for witness in value['witnesses']:
        operation = witness['operation']
        if operation['kind'] != kind or operation['old_path'] != str(Path(source['binding']['local_root']) / source['project']):
            continue
        assert operation['version'] == 1 and operation['binding'] == source['binding']['key']
        assert witness['operation_id'] == operation_id and witness['sequence'] == value['sequence']
        assert operation['root_identity'] == source['binding']['root_identity'] == source['capture']['root_identity']
        assert operation['local_identity'] == source['capture']['local_identity']
        assert operation['local_document'] == source['capture']['local_document']
        matching.append(witness)
    assert len(matching) == 1, 'Retirement has no exact captured Delete/Rename witness'
    actual = base.rows(current)
    assert actual[lineage['folderId']]['trashed'] is True, 'Terminal folder proof disagrees with actual Drive state'
    actual_catalog = actual[terminal['catalog']['id']]
    catalog = json.loads(base.body(actual_catalog))
    assert not actual_catalog['trashed'] and catalog['format'] == 2
    assert not any(row['dir'] == source['project'] for row in catalog['projects']), 'Actual catalog retained retired own row'
    return {'emptyHooks': empty_hooks, 'retirementJournal': {'path': str(path), 'value': value},
            'capturedKind': kind, 'actualFolderTrashed': True, 'actualCatalogOwnRowRemoved': True}


def verify_protected(current, protected):
    actual = base.rows(current)
    for identity, expected in protected.items():
        assert actual.get(identity) == expected, f'Retired recovery or foreign outside member changed: {identity}'


def fresh_fixture(root, project, stage, frequency):
    prepared = root / ('prepared-' + stage) / project.name
    (prepared / 'stems').mkdir(parents=True)
    pcm = encoded(frequency)
    filename = 'custom-' + stage + '.wav'
    (prepared / 'stems' / filename).write_bytes(pcm)
    raw = {'version': 2, 'name': project.name, 'savedAt': '2026-11-09T12:00:00Z',
           'foreign': {'retirementFixture': stage}, 'settings': {'nativeOriginalDisabled': True,
           'custom': [{'id': 'custom-' + stage, 'file': 'stems/' + filename, 'label': stage, 'color': '#c7e06a'}]}}
    (prepared / 'project.json').write_text(json.dumps(raw))
    return prepared


def serve(server, folder, root, project, preferences, stop, errors, evidence):
    callbacks, handled = set(), set()
    baseline, before_two, protected = {}, {}, {}
    protected.update({row['id']: row for row in server.state.snapshot()['files'] if row['id'].startswith('foreign-')})
    lineages = []
    try:
        while not stop.wait(.02):
            for path in folder.glob('authorization-url-*.json'):
                if path.name not in callbacks:
                    authorize(server.base, path); callbacks.add(path.name)
            for path in (folder / 'requests').glob('*.json'):
                if path.name in handled:
                    continue
                operation = json.loads(path.read_text())['operation']
                current = server.state.snapshot()
                if operation == 'baseline':
                    baseline = copy.deepcopy(current)
                    assert project.is_dir()
                elif operation == 'empty-one':
                    lineages.append(committed_lineage(baseline, current, project.name, preferences, protected))
                elif operation == 'deleted-last':
                    assert not project.exists()
                    assert not [row for row in base.children(base.rows(current), 'root-singz') if row['mimeType'] == fixture.FOLDER], 'Final project Delete left an active/resurrected project'
                    catalogs = [row for row in base.children(base.rows(current), 'root-singz') if row['name'] == 'catalog.json']
                    assert len(catalogs) == 1 and json.loads(base.body(catalogs[0]))['projects'] == []
                    evidence['deleteRetirement'] = retirement_proof(preferences, lineages[0], current, 'delete')
                elif operation in ('prepare-after-delete', 'prepare-after-rename'):
                    assert not project.exists(), 'Fixture reuse must create a new directory, never overwrite an existing project'
                    prepared = root / ('prepared-' + operation.removeprefix('prepare-')) / project.name
                    shutil.copytree(prepared, project)
                    assert json.loads((project / 'project.json').read_text())['foreign']['retirementFixture'] == operation.removeprefix('prepare-')
                elif operation == 'fresh-after-delete':
                    active = project_folder(current, project.name)
                    assert active['id'] != lineages[0]['folderId'], 'Deleted same-name folder identity was reused'
                    _, raw = document(current, active)
                    assert raw['foreign']['retirementFixture'] == 'after-delete' and not base.strict_empty(raw)
                    before_two = copy.deepcopy(current)
                elif operation == 'empty-two':
                    lineages.append(committed_lineage(before_two, current, project.name, preferences, protected))
                elif operation == 'renamed':
                    renamed = project.parent / ('Renamed Drive ' + folder.parent.name)
                    assert not project.exists() and renamed.is_dir()
                    renamed_remote = project_folder(current, renamed.name)
                    _, raw = document(current, renamed_remote)
                    assert base.strict_empty(raw)
                    assert not [row for row in base.children(base.rows(current), 'root-singz') if row['name'] == project.name and row['mimeType'] == fixture.FOLDER]
                    evidence['renameRetirement'] = retirement_proof(preferences, lineages[1], current, 'rename')
                    evidence['renamedFolderId'] = renamed_remote['id']
                elif operation == 'complete':
                    active = project_folder(current, project.name)
                    assert active['id'] not in {lineages[0]['folderId'], lineages[1]['folderId'], evidence['renamedFolderId']}, 'Rename same-name reuse did not create fresh lineage'
                    _, raw = document(current, active)
                    assert raw['foreign']['retirementFixture'] == 'after-rename' and not base.strict_empty(raw)
                    renamed = project_folder(current, 'Renamed Drive ' + folder.parent.name)
                    assert base.strict_empty(document(current, renamed)[1]), 'Old lineage retirement resurrected renamed empty audio'
                    evidence.update(passed=True, lineages=lineages, protectedIds=sorted(protected))
                else:
                    raise AssertionError(operation)
                verify_protected(current, protected)
                (folder / (operation + '-remote.json')).write_text(json.dumps(current, indent=2))
                pending = folder / 'acks' / (path.name + '.pending')
                pending.write_text(json.dumps({'ok': True})); pending.replace(folder / 'acks' / path.name)
                handled.add(path.name)
    except BaseException as error:
        errors.append(repr(error)); (folder / 'sidecar-failure.txt').write_text(traceback.format_exc())
        for path in (folder / 'requests').glob('*.json'):
            (folder / 'acks' / path.name).write_text(json.dumps({'ok': False, 'error': repr(error)}))


def main():
    parser = argparse.ArgumentParser(); parser.add_argument('app', type=Path); parser.add_argument('out', type=Path)
    parser.add_argument('--timeout', type=int, default=300)
    parser.add_argument('--width', type=int, choices=(1280, 1060), action='append',
                        help='Run a selected viewport; repeat to select both (default: both).')
    args = parser.parse_args()
    widths = tuple(args.width or (1280, 1060))
    if len(set(widths)) != len(widths):
        parser.error('Each viewport may be selected only once')
    app, out = args.app.resolve(strict=True), args.out.resolve(); out.mkdir(parents=True, exist_ok=True)
    assert not any(out.iterdir()), 'Use a fresh evidence directory'
    helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
    hashes = {'appSha256': shared.sha(app), 'helperSha256': shared.sha(helper)}
    reports = []
    for width in widths:
        case = out / str(width); root = case / 'private-fixture'; root.mkdir(mode=0o700, parents=True)
        for name in ('prefs', 'library', 'tmp', 'cache'):
            (root / 'writer' / name).mkdir(mode=0o700, parents=True)
        project, source, files = base.seed(root, width)
        prepared = [fresh_fixture(root, project, 'after-delete', 330), fresh_fixture(root, project, 'after-rename', 440)]
        sentinel = root / 'must-survive.txt'; sentinel.write_text('Outside retirement targets.\n')
        inputs = {str(path): shared.sha(path) for path in [source, sentinel, *(path for directory in prepared for path in directory.rglob('*') if path.is_file())]}
        foreign = [{'id': 'foreign-history', 'name': 'SingZ recovery unrelated', 'mimeType': fixture.FOLDER, 'parents': ['root']},
            {'id': 'foreign-audio', 'name': 'custom-initial.wav', 'parents': ['foreign-history'], 'mimeType': 'audio/wav', 'contentBase64': base64.b64encode(b'Unrelated foreign bytes').decode()}]
        server = fixture.Server(); server.state.control({'files': files + foreign, 'pageSize': 3})
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True); worker.start()
        folder = case / 'writer'; folder.mkdir(); (folder / 'acks').mkdir()
        catalog = root / 'models.json'; catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
        env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
        env.update(SINGZ_MUTE='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_BACKGROUND='1',
            SINGZ_GPUI_CONFIG_DIR=str(root / 'writer/prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'writer/library'),
            SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_GPUI_MODEL_FIXTURE=str(catalog), SINGZ_GPUI_LRCLIB_URL=server.base + '/api',
            SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
            SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
            SINGZ_GDRIVE_CONFIG=json.dumps({'clientId': 'fixture-client', 'clientSecret': 'fixture-secret', 'authBase': server.base, 'apiBase': server.base, 'uploadBase': server.base}),
            SINGZ_GPUI_DRIVE_RETIREMENT_TEST=str(folder), SINGZ_GPUI_DRIVE_RETIREMENT_WIDTH=str(width), SINGZ_GPUI_DRIVE_RETIREMENT_PROJECT=str(project),
            TMPDIR=str(root / 'writer/tmp'), TMP=str(root / 'writer/tmp'), TEMP=str(root / 'writer/tmp'), XDG_CACHE_HOME=str(root / 'writer/cache'),
            HF_HOME=str(root / 'writer/cache/huggingface'), TORCH_HOME=str(root / 'writer/cache/torch'), PYTHONDONTWRITEBYTECODE='1')
        stop, errors, evidence = threading.Event(), [], {}
        companion = threading.Thread(target=serve, args=(server, folder, root, project, root / 'writer/prefs', stop, errors, evidence), daemon=True); companion.start()
        try:
            observation = shared.run_observed(app, folder, env, args.timeout, expect_input_helper=False)
            assert not errors, errors
            result = json.loads((folder / 'result.json').read_text())
            assert result['passed'] and result['actualControls'] and result['hidden'] and result['muted'] and not result['physicalInput']
            assert evidence.get('passed')
            assert all(shared.sha(Path(path)) == digest for path, digest in inputs.items())
            assert shared.sha(app) == hashes['appSha256'] and shared.sha(helper) == hashes['helperSha256']
            for state in result['steps']:
                assert state['hidden'] and not state['active'] and state['micOwner'] == 0 and state['viewport'] == [width, 800 if width == 1280 else 640]
                assert (folder / (state['phase'] + '.png')).stat().st_size > 0
                if state['phase'] in ('empty-lineage-one', 'empty-lineage-two', 'renamed-synced'):
                    assert state['empty'] and state['laneCount'] == 0 and state['duration'] == 0
                    assert state['native']['empty'] and state['native']['generation'] == 0 and state['native']['physicalReleased']
                if state['phase'] == 'last-project-deleted-synced':
                    assert state['project'] is None and state['catalogRows'] == [] and not state['playing']
                if state['phase'] in ('fresh-after-delete-open', 'fresh-after-rename-open'):
                    assert state['hasAudio'] and state['laneCount'] == 1 and state['duration'] >= 12
                    assert not state['native']['empty'] and state['native']['generation'] > 0 and state['native']['fixture'] is False
            (case / 'lineage-proof.json').write_text(json.dumps(evidence, indent=2))
            reports.append({'width': width, 'resourceSamples': len(observation['samples']), 'observerScope': observation['scope'], 'captures': len(result['steps'])})
        except BaseException:
            (case / 'failure.txt').write_text(traceback.format_exc()); raise
        finally:
            stop.set(); companion.join(timeout=10); assert not companion.is_alive()
            (case / 'remote-final.json').write_text(json.dumps(server.state.snapshot(), indent=2))
            server.stop(); worker.join(timeout=5); server.server_close(); assert not worker.is_alive()
    (out / 'result.json').write_text(json.dumps({'passed': True, 'requestedWidths': list(widths), 'sizes': reports, **hashes, 'noNode': True,
        'hardwareInput': False, 'liveFps': 'unmeasured', 'scope': 'Actual native Delete/Rename/Save/Sync and filesystem-fixture ProjectPicker reuse; candidate captures only, no reference parity'}, indent=2))
    print('PASS: actual final-project Delete, same-name reuse, typed Rename and preserved recovery media at widths: ' + ', '.join(map(str, widths)))


if __name__ == '__main__':
    main()
