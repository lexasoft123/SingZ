"""Real native final custom Remove -> Save -> Drive -> fresh and offline empty.

One isolated loopback account and three actual app processes per viewport. Remote
empty documents are produced only by the production writer, never fixture-seeded.
No Node, Google account, capture, OS chooser or global input is used.
"""
import argparse
import base64
import copy
import hashlib
import io
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import sys
import threading
import traceback
import wave

sys.dont_write_bytecode = True
import drive_fixture as fixture
import test_native_training_keyboard as shared
from test_native_drive_restore import authorize


def body(row):
    return base64.b64decode(row['contentBase64'], validate=True)


def rows(state):
    return {row['id']: row for row in state['files']}


def children(files, parent):
    return [row for row in files.values() if not row['trashed'] and parent in row['parents']]


def ancestors(files, identity):
    result, seen = set(), set()
    while identity in files:
        assert identity not in seen, 'Remote folder cycle'
        seen.add(identity)
        parents = files[identity]['parents']
        assert len(parents) == 1, 'Ambiguous remote parent'
        identity = parents[0]
        result.add(identity)
    return result


def strict_empty(doc):
    settings = doc['settings']
    return (settings.get('nativeEmptyTracks') is True and settings.get('nativeOriginalDisabled') is True
            and settings.get('custom') == [] and doc.get('stemHashes') == {}
            and not any(key in doc for key in ('songFile', 'songHash', 'graphHash')))


def mobile_manifest_visible(doc):
    """Bounded valid-ProjectDoc model: gdrive.ts entryFromDoc -> current.ts:53.

    filesOfProject includes every stemHashes key. With no stems it includes a
    source only when both songHash and songFile exist. entryFromDoc supplies no
    lyrics/graph options, and custom-array presence alone declares no payload.
    This is a compatibility model, not execution of the mobile application.
    """
    hashes = doc.get('stemHashes', {})
    # An empty hash object is truthy in JavaScript; valid ProjectDoc hashes are
    # objects, so do not apply Python's empty-dict truthiness to songHash.
    return bool(hashes) or (isinstance(doc.get('songHash'), dict) and bool(doc.get('songFile')))


def mobile_walk_visible(doc, active_top, active_stems):
    """Bounded buildEntry model, mobile/src/gdrive.ts 485-523, 746-788."""
    builtins = ('vocals', 'drums', 'bass', 'guitar', 'piano', 'other', 'custom-backing-vocals')
    names = {row['name'] for row in active_stems}
    if any(f'{stem}.{extension}' in names for stem in builtins for extension in ('flac', 'wav')):
        return True
    if any(Path(track['file']).name in names for track in doc.get('settings', {}).get('custom', [])):
        return True
    return doc.get('songFile') in {row['name'] for row in active_top}


def verify_commit(baseline, current):
    before, after = rows(baseline), rows(current)
    active = children(after, 'project-empty-drive')
    documents = [row for row in active if row['name'] == 'project.json']
    assert len(documents) == 1 and documents[0]['id'] != 'old-document', 'Empty generation reused old document identity'
    document = json.loads(body(documents[0]))
    assert strict_empty(document), document
    assert not any(row['mimeType'] == fixture.FOLDER or row['name'].lower().endswith(('.wav', '.flac', '.mp3', '.m4a')) for row in active), 'Audio or stems remained reachable in active project'
    for identity in ('old-document', 'old-stems', 'old-audio'):
        original, retired = before[identity], after[identity]
        assert not retired['trashed'] and retired['id'] == original['id'] and body(retired) == body(original), identity
        assert retired.get('md5Checksum') == original.get('md5Checksum') and retired.get('size') == original.get('size'), identity
        assert 'root-singz' not in ancestors(after, identity), 'Archived media remains in active library roster'
    catalog = json.loads(body(after['catalog']))
    assert catalog['format'] == 2
    own = [row for row in catalog['projects'] if row['dir'] == before['project-empty-drive']['name']]
    assert len(own) == 1
    declared = [row for row in own[0]['files'] if row['name'] == 'project.json']
    assert len(declared) == 1 and declared[0]['id'] == documents[0]['id']
    assert declared[0]['md5Checksum'] == documents[0]['md5Checksum'] and int(declared[0]['size']) == int(documents[0]['size'])
    baseline_sequence = max((row['sequence'] for row in baseline['requests']), default=0)
    requests = [row for row in current['requests'] if row['sequence'] > baseline_sequence]
    mutations = [(row['sequence'], event) for row in requests for event in row.get('events', []) if event['phase'] == 'mutation-applied']
    assert mutations and mutations[-1][1]['file']['id'] == 'catalog', 'Catalog was not the last persistent mutation'
    retire = {event['file']['id']: sequence for sequence, event in mutations if event['operation'] == 'move' and event['file']['id'] in ('old-document', 'old-stems')}
    assert retire['old-document'] < retire['old-stems'], 'Old document was not retired before dependencies'
    activate = [sequence for sequence, event in mutations if event['operation'] == 'move' and event['file']['id'] == documents[0]['id']]
    assert len(activate) == 1 and retire['old-stems'] < activate[0] < mutations[-1][0]
    assert not any(row['method'] == 'DELETE' for row in requests)
    assert not any(event['file']['trashed'] for _, event in mutations), 'Transaction trashed recovery payload'
    assert not mobile_manifest_visible(document) and not mobile_walk_visible(document, active, [])
    assert not mobile_manifest_visible({'settings': {'custom': [{'id': 'custom-only', 'file': 'stems/custom-only.wav'}]}}), 'Custom roster alone is not a manifest dependency'
    assert not mobile_manifest_visible({'songFile': 'source.wav'}), 'Unhashed source must remain invisible to manifest path'
    assert not mobile_manifest_visible({'songHash': {'size': 1, 'md5': 'fixture'}}), 'Source hash alone names no source file'
    assert mobile_manifest_visible({'songFile': 'source.wav', 'songHash': {}}), 'Source fallback requires hash object plus path'
    assert mobile_manifest_visible({'stemHashes': {'arbitrary-declared.bin': {'size': 1, 'md5': 'fixture'}}}), 'Manifest path must include arbitrary declared stemHash keys'
    negative = [{'name': 'vocals.wav', 'size': '1'}]
    assert mobile_walk_visible(document, active, negative), 'Compatibility model failed active-leftover-audio negative control'
    # Old ID maps still retrieve old media after relocation. This is explicitly
    # stale-reader behavior; the bounded guarantee is a refreshed committed read.
    assert body(after['old-audio']) == body(before['old-audio'])
    return {'newDocumentId': documents[0]['id'], 'retiredIds': ['old-document', 'old-stems', 'old-audio'],
            'catalogLast': True, 'mobileManifestOmits': True, 'mobileForcedWalkOmits': True,
            'activeLeftoverNegativeControl': True, 'manifestDependencyNegativeControls': True, 'staleIdStillReadable': True,
            'mobileModelSource': 'mobile/src/current.ts:53; mobile/src/gdrive.ts:485,617,746,803; source-derived only'}


def encoded_audio():
    data = io.BytesIO()
    with wave.open(data, 'wb') as audio:
        audio.setparams((1, 2, 16000, 0, 'NONE', 'not compressed'))
        second = b''.join(struct.pack('<h', int(1800 * math.sin(i * math.tau * 220 / 16000))) for i in range(16000))
        audio.writeframes(second * 12)
    return data.getvalue()


def seed(root, width):
    project = root / 'writer/library' / f'Empty Drive {width}'
    (project / 'stems').mkdir(parents=True)
    content = encoded_audio()
    source = root / 'immutable-source.wav'
    source.write_bytes(content)
    (project / 'stems/custom-initial.wav').write_bytes(content)
    doc = {'version': 2, 'name': project.name, 'savedAt': '2026-11-09T12:00:00Z', 'settings': {
        'nativeOriginalDisabled': True,
        'custom': [{'id': 'custom-initial', 'file': 'stems/custom-initial.wav', 'label': 'Remove this last track', 'color': '#c7e06a'}],
        'key': {'pc': 9, 'minor': True, 'detVersion': 2}}, 'foreign': {'emptyDriveFixture': width}}
    metadata = json.dumps(doc).encode()
    (project / 'project.json').write_bytes(metadata)
    def file(identity, name, parent, data, mime='application/json'):
        return {'id': identity, 'name': name, 'parents': [parent], 'mimeType': mime, 'contentBase64': base64.b64encode(data).decode()}
    catalog = {'format': 2, 'capabilities': {'adopt': 1}, 'projects': [{'dir': project.name, 'files': [
        {'id': 'old-document', 'name': 'project.json', 'size': str(len(metadata)), 'md5Checksum': hashlib.md5(metadata).hexdigest()},
        {'id': 'old-audio', 'name': 'stems/custom-initial.wav', 'size': str(len(content)), 'md5Checksum': hashlib.md5(content).hexdigest()}]}]}
    files = [{'id': 'root-singz', 'name': 'SingZ', 'mimeType': fixture.FOLDER, 'parents': ['root']},
        {'id': 'project-empty-drive', 'name': project.name, 'mimeType': fixture.FOLDER, 'parents': ['root-singz']},
        {'id': 'old-stems', 'name': 'stems', 'mimeType': fixture.FOLDER, 'parents': ['project-empty-drive']},
        file('old-document', 'project.json', 'project-empty-drive', metadata),
        file('old-audio', 'custom-initial.wav', 'old-stems', content, 'audio/wav'),
        file('catalog', 'catalog.json', 'root-singz', json.dumps(catalog).encode())]
    return project, source, files


def sidecar(server, folder, role, baseline, proof, stop, errors):
    authorized, handled = set(), set()
    try:
        while not stop.wait(.02):
            for path in folder.glob('authorization-url-*.json'):
                if path.name not in authorized:
                    authorize(server.base, path)
                    authorized.add(path.name)
            for path in (folder / 'requests').glob('*.json'):
                if path.name in handled:
                    continue
                operation = json.loads(path.read_text())['operation']
                if operation == 'baseline':
                    state = server.state.snapshot()
                    assert all(not rows(state)[identity]['trashed'] for identity in ('old-document', 'old-stems', 'old-audio'))
                    baseline.update(copy.deepcopy(state))
                    (folder / 'baseline-remote.json').write_text(json.dumps(state, indent=2))
                elif operation == 'committed':
                    state = server.state.snapshot()
                    proof.update(verify_commit(baseline, state))
                    (folder / 'committed-remote.json').write_text(json.dumps(state, indent=2))
                    (folder / 'commit-proof.json').write_text(json.dumps(proof, indent=2))
                elif operation == 'reader-proof':
                    pass  # Parent validates the actual native result and cache below.
                else:
                    raise AssertionError(operation)
                pending = folder / 'acks' / (path.name + '.pending')
                pending.write_text(json.dumps({'ok': True}))
                pending.replace(folder / 'acks' / path.name)
                handled.add(path.name)
    except BaseException as error:
        errors.append(repr(error))
        (folder / 'sidecar-failure.txt').write_text(traceback.format_exc())
        for path in (folder / 'requests').glob('*.json'):
            (folder / 'acks' / path.name).write_text(json.dumps({'ok': False, 'error': repr(error)}))


def validate_result(folder, role, width):
    value = json.loads((folder / 'result.json').read_text())
    assert value['passed'] and value['actualControls'] and value['hidden'] and value['muted'] and not value['physicalInput']
    assert value['role'] == role and value['width'] == width
    expected = ('before-remove', 'explicit-continuation-pending', 'synced-empty') if role == 'writer' else (('fresh-browser', 'fresh-empty-open') if role == 'reader' else ('offline-browser', 'offline-empty-open'))
    for name in expected:
        state = json.loads((folder / f'{name}.state.json').read_text())
        assert (folder / f'{name}.png').stat().st_size > 0
        assert state['hidden'] and not state['active'] and state['micOwner'] == 0 and not state['physicalInput']
        assert state['viewport'] == [width, 800 if width == 1280 else 640]
        if name == 'explicit-continuation-pending':
            assert state['libraryDrive']['upToDate'] is False, 'Pending continuation falsely presents Drive as up to date'
        if name == 'synced-empty':
            assert state['libraryDrive']['upToDate'] is True, 'Completed continuation must present Drive as up to date'
        if name.endswith('empty-open'):
            assert state['empty'] and state['hasAudio'] is False and state['laneCount'] == 0
            assert state['native']['empty'] and state['native']['generation'] == 0 and state['native']['physicalReleased']
            assert state['duration'] == state['position'] == 0 and not state['playing']
            directory = Path(state['project'])
            payloads = [path for path in directory.rglob('*') if path.is_file() and not path.name.startswith('.singz-')]
            assert payloads and all(path.name in ('project.json', 'lyrics.json') for path in payloads), 'Downloaded empty cache contains audio/graph payloads'
            assert strict_empty(json.loads((directory / 'project.json').read_text()))
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--timeout', type=int, default=240)
    args = parser.parse_args()
    app, out = args.app.resolve(strict=True), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert not any(out.iterdir()), 'Use a new evidence directory; existing failures are preserved'
    helper = app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')
    identities = {'appSha256': shared.sha(app), 'helperSha256': shared.sha(helper)}
    results = []
    for width in (1280, 1060):
        case = out / str(width)
        root = case / 'private-fixture'
        root.mkdir(mode=0o700, parents=True)
        server = fixture.Server()
        worker = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .02}, daemon=True)
        worker.start()
        closed = False
        try:
            for profile in ('writer', 'reader'):
                for directory in ('prefs', 'library', 'tmp', 'cache'):
                    (root / profile / directory).mkdir(mode=0o700, parents=True)
            project, source, files = seed(root, width)
            source_hash = shared.sha(source)
            sentinel = root / 'must-survive.txt'
            sentinel.write_text('Outside all project and cache roots.\n')
            sentinel_hash = shared.sha(sentinel)
            catalog = root / 'models.json'
            catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
            server.state.control({'files': files, 'pageSize': 3})
            (case / 'seed-remote.json').write_text(json.dumps(server.state.snapshot(), indent=2))
            baseline, proof, remote_committed = {}, {}, None
            for role in ('writer', 'reader', 'offline'):
                folder = case / role
                folder.mkdir(); (folder / 'acks').mkdir()
                profile = root / ('writer' if role == 'writer' else 'reader')
                env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
                env.update(SINGZ_MUTE='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_BACKGROUND='1',
                    SINGZ_GPUI_CONFIG_DIR=str(profile / 'prefs'), SINGZ_GPUI_PROJECTS_ROOT=str(profile / 'library'),
                    SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
                    SINGZ_GPUI_LRCLIB_URL=server.base + '/api',
                    SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
                    SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
                    SINGZ_GDRIVE_CONFIG=json.dumps({'clientId': 'fixture-client', 'clientSecret': 'fixture-secret',
                        'authBase': server.base, 'apiBase': server.base, 'uploadBase': server.base}),
                    SINGZ_GPUI_EMPTY_DRIVE_TEST=str(folder), SINGZ_GPUI_EMPTY_DRIVE_ROLE=role,
                    SINGZ_GPUI_EMPTY_DRIVE_WIDTH=str(width), SINGZ_GPUI_EMPTY_DRIVE_PROJECT=str(project),
                    TMPDIR=str(profile / 'tmp'), TMP=str(profile / 'tmp'), TEMP=str(profile / 'tmp'),
                    XDG_CACHE_HOME=str(profile / 'cache'), HF_HOME=str(profile / 'cache/huggingface'),
                    TORCH_HOME=str(profile / 'cache/torch'), PYTHONDONTWRITEBYTECODE='1')
                if role != 'writer':
                    env['SINGZ_NO_SYNC'] = '1'
                errors, stop = [], threading.Event()
                companion = threading.Thread(target=sidecar, args=(server, folder, role, baseline, proof, stop, errors), daemon=True)
                companion.start()
                try:
                    observation = shared.run_observed(app, folder, env, args.timeout, expect_input_helper=False,
                        sample_interval=.05, poll_interval=.02)
                finally:
                    stop.set(); companion.join(timeout=10)
                    assert not companion.is_alive(), 'OAuth/proof sidecar did not retire'
                assert not errors, errors
                value = validate_result(folder, role, width)
                results.append({'role': role, 'width': width, 'result': str(folder / 'result.json'),
                                'resourceSamples': len(observation['samples']), 'observerScope': observation['scope']})
                assert shared.sha(source) == source_hash and shared.sha(sentinel) == sentinel_hash
                assert shared.sha(app) == identities['appSha256'] and shared.sha(helper) == identities['helperSha256']
                if role == 'writer':
                    assert proof and baseline
                    remote_committed = server.state.snapshot()
                    journals = list((root / 'writer/prefs/gdrive/empty-transactions').rglob('journal.json'))
                    assert journals and all(json.loads(path.read_text())['phase'].lower() == 'committed' for path in journals)
                    (case / 'recovery-journals.json').write_text(json.dumps([json.loads(path.read_text()) for path in journals], indent=2))
                    server.state.control({'resetLedger': True})
                elif role == 'reader':
                    after = server.state.snapshot()
                    assert sorted(after['files'], key=lambda row: row['id']) == sorted(remote_committed['files'], key=lambda row: row['id']), 'Reader changed remote publication'
                    drive = [row for row in after['requests'] if row['path'].startswith(('/drive/', '/upload'))]
                    assert drive and all(row['method'] == 'GET' for row in drive), 'Reader issued a Drive mutation'
                    downloaded = {row['path'].rsplit('/', 1)[-1] for row in drive if row['query'].get('alt') == ['media']}
                    assert not downloaded.intersection({'old-audio', 'old-document'}), 'Fresh reader fetched retired generation'
                    (case / 'readonly-reader-remote.json').write_text(json.dumps(after, indent=2))
                    server.stop(); worker.join(timeout=5); server.server_close(); closed = True
                    assert not worker.is_alive(), 'Fixture survived into offline restart'
            (case / 'fixture.json').write_text(json.dumps({**identities, 'passed': True, 'width': width,
                'sourceSha256': source_hash, 'sentinelSha256': sentinel_hash, 'privateRoot': str(root),
                'writerSyncDisabled': False, 'readerSyncDisabled': True, 'proof': proof, 'noNode': True,
                'scope': 'Actual native desktop controls and production writer/read-only reader against loopback Drive; source-derived mobile compatibility model, no mobile execution'}, indent=2))
        except BaseException:
            (case / 'failure.txt').write_text(traceback.format_exc())
            (case / 'failure-remote.json').write_text(json.dumps(server.state.snapshot(), indent=2))
            raise
        finally:
            if not closed:
                server.stop(); worker.join(timeout=5); server.server_close()
    (out / 'result.json').write_text(json.dumps({'passed': True, 'runs': results, **identities,
        'noNode': True, 'physicalInput': False, 'liveFps': 'unmeasured',
        'windowsQualification': 'Requires independent run_windows_ui.ps1 foreground/helper/GPU observer' if platform.system() == 'Windows' else 'not run by this driver invocation'}, indent=2))
    print('PASS: actual final-track Remove, Save, production empty Drive publication and delayed continuation, fresh and offline native-empty open at both sizes')


if __name__ == '__main__':
    main()
