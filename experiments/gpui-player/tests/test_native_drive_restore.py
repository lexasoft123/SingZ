"""Read-only desktop Drive browse/download/native-open and cached restart.

Loopback PKCE and generated encoded project payloads only. Empty remote data is
an explicit reader fixture; this test does not qualify native empty publication.
"""
import argparse
import base64
import hashlib
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import platform
import shutil
import stat
import struct
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import urllib.request
import wave

sys.dont_write_bytecode = True
import test_native_training_keyboard as shared


def fixture_module():
    spec = importlib.util.spec_from_file_location('restore_drive_fixture', Path(__file__).with_name('drive_fixture.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def encoded_audio(frequency):
    output = io.BytesIO()
    rate = 16000
    with wave.open(output, 'wb') as audio:
        audio.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
        one = b''.join(struct.pack('<h', int(5000 * math.sin(i * math.tau * frequency / rate))) for i in range(rate))
        audio.writeframes(one * 12)
    return output.getvalue()


def fingerprint(content):
    return {'size': len(content), 'md5': hashlib.md5(content).hexdigest(), 'mtimeMs': 0}


def seed_projects(fixture, input_root):
    files = [{'id': 'root-singz', 'name': 'SingZ', 'mimeType': fixture.FOLDER, 'parents': ['root']}]
    expected = {}
    graph = (Path(__file__).resolve().parents[3] / 'tests/shared/native-playback-graph.json').read_bytes()
    vocals = encoded_audio(220)
    for identifier, name, kind in [('default', 'A Stem-only song', 'default'),
                                    ('custom', 'B Custom graph', 'custom'),
                                    ('empty', 'C Empty project', 'empty'),
                                    ('integrity', 'D Integrity retry', 'default')]:
        folder = f'project-{identifier}'
        files.append({'id': folder, 'name': name, 'mimeType': fixture.FOLDER, 'parents': ['root-singz']})
        payload = {}
        settings = {'masterVolume': .6, 'tempo': 1, 'transpose': 0,
                    'tracks': {'vocals': {'volume': .7, 'muted': False}},
                    'metronome': {'click': False, 'countInBars': 0, 'volume': .7, 'accent': True}}
        if kind == 'empty':
            settings = {'nativeEmptyTracks': True, 'nativeOriginalDisabled': True, 'custom': []}
        else:
            names = ('vocals', 'drums', 'bass', 'other', 'guitar', 'piano') if identifier == 'default' else ('vocals',)
            payload.update({f'stems/{stem}.wav': vocals if stem == 'vocals' else encoded_audio(110 + index * 55)
                            for index, stem in enumerate(names)})
            # Model an already-analyzed saved project with current key/melody
            # stamps. Otherwise normal missing-key analysis automatically Saves
            # the default project after native open, changing its downloaded
            # document before strict byte validation. Auto-analysis stays enabled.
            settings['key'] = {'pc': 4, 'minor': True, 'detVersion': 2}
            settings['melody'] = {'detVersion': 4, 'hopSec': .025, 'f0': ' '.join(['5700'] * 480)}
        doc = {'version': 2, 'name': name, 'settings': settings, 'foreign': {'restoreFixture': identifier},
               'stemHashes': {path[6:]: fingerprint(data) for path, data in payload.items()}}
        if kind == 'custom':
            payload['graph.json'] = graph
            doc['graphHash'] = {'format': 1, **fingerprint(graph)}
        lyrics = json.dumps({'source': 'edited', 'credit': 'Local restore fixture', 'lines': [
            {'start': 0, 'end': 12, 'text': 'Read-only native Drive fixture'}]}).encode()
        if kind != 'empty':
            payload['lyrics.json'] = lyrics
            doc['lyricsHash'] = fingerprint(lyrics)
        payload['project.json'] = json.dumps(doc).encode()
        if any(path.startswith('stems/') for path in payload):
            files.append({'id': f'stems-{identifier}', 'name': 'stems', 'mimeType': fixture.FOLDER, 'parents': [folder]})
        for path, content in payload.items():
            original = input_root / folder / path
            original.parent.mkdir(parents=True, exist_ok=True)
            original.write_bytes(content)
            remote_id = f'file-{identifier}-{Path(path).stem}'
            parent = f'stems-{identifier}' if path.startswith('stems/') else folder
            files.append({'id': remote_id, 'name': Path(path).name, 'parents': [parent],
                          'mimeType': 'application/json' if path.endswith('.json') else 'audio/wav',
                          'contentBase64': base64.b64encode(content).decode()})
        expected[folder] = {'kind': kind, 'name': name,
                            'files': {path: {'size': len(content), 'sha256': hashlib.sha256(content).hexdigest()}
                                      for path, content in payload.items()}}
    return files, expected


def input_checks(identities):
    checks = {}
    for name, (path, expected) in identities.items():
        record = {'path': str(path), 'expectedSha256': expected}
        try:
            record['actualSha256'] = shared.sha(path)
            record['unchanged'] = record['actualSha256'] == expected
        except BaseException as error:
            record.update(unchanged=False, error=repr(error))
        checks[name] = record
    return checks


def preserve_failure(root, out, server, error, identities):
    """Capture private state while TemporaryDirectory still owns its paths.

    Preservation errors are recorded without replacing the original assertion.
    Symlinks are retained as evidence and never followed into external paths.
    """
    failure = out / 'failure-evidence'
    failures = []
    try:
        failure.mkdir(mode=0o700, parents=True, exist_ok=True)
    except BaseException as preserve_error:
        print(f'Failure evidence directory could not be created: {preserve_error!r}', file=sys.stderr)
        return
    for name in ('prefs', 'cache', 'library'):
        source = root / name
        try:
            if source.exists():
                shutil.copytree(source, failure / name, symlinks=True, dirs_exist_ok=True)
        except BaseException as preserve_error:
            failures.append({'operation': 'copy-private-state', 'source': name, 'error': repr(preserve_error)})
    try:
        (failure / 'remote.json').write_text(json.dumps(server.state.snapshot(), indent=2))
    except BaseException as preserve_error:
        failures.append({'operation': 'capture-remote-state', 'error': repr(preserve_error)})
    report = {'error': repr(error), 'traceback': ''.join(traceback.format_exception(error)),
              'temporaryRoot': str(root), 'inputChecks': input_checks(identities),
              'preservationErrors': failures, 'passed': False}
    try:
        (failure / 'failure.json').write_text(json.dumps(report, indent=2))
    except BaseException as preserve_error:
        print(f'Failure diagnostic could not be written: {preserve_error!r}', file=sys.stderr)


class CallbackOnly(urllib.request.HTTPRedirectHandler):
    def __init__(self, callback):
        super().__init__()
        self.callback = callback

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        target = urllib.parse.urlsplit(newurl)
        assert (target.scheme, target.hostname, target.port, target.path) == (
            'http', '127.0.0.1', self.callback.port, '/oauth2/callback')
        assert not target.username and not target.password and not target.fragment
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def authorize(base, path):
    value = json.loads(path.read_text())['url']
    url, allowed = urllib.parse.urlsplit(value), urllib.parse.urlsplit(base)
    assert (url.scheme, url.hostname, url.port, url.path) == ('http', '127.0.0.1', allowed.port, '/o/oauth2/v2/auth')
    assert not url.username and not url.password and not url.fragment
    query = urllib.parse.parse_qs(url.query)
    assert query['client_id'] == ['fixture-client'] and query['code_challenge_method'] == ['S256']
    callback = urllib.parse.urlsplit(query['redirect_uri'][0])
    assert callback.scheme == 'http' and callback.hostname == '127.0.0.1' and callback.path == '/oauth2/callback'
    with urllib.request.build_opener(CallbackOnly(callback)).open(value, timeout=8) as response:
        assert response.status == 200


def published_ids(preferences):
    return {json.loads(path.read_text())['id'] for path in (preferences / 'gdrive/downloads').glob('project-*/.singz-drive-cache.json')}


def remote_files(snapshot):
    return sorted(snapshot['files'], key=lambda row: row['id'])


def assert_read_only(snapshot, initial):
    assert remote_files(snapshot) == initial, 'Reader mutated remote project bytes or metadata'
    drive = [row for row in snapshot['requests'] if row['path'].startswith(('/drive/', '/upload'))]
    assert drive and all(row['method'] == 'GET' for row in drive), 'Drive reader issued a write'


def media_counts(snapshot):
    counts = {}
    for row in snapshot['requests']:
        if row['method'] == 'GET' and row['query'].get('alt') == ['media']:
            identifier = row['path'].rsplit('/', 1)[-1]
            counts[identifier] = counts.get(identifier, 0) + 1
    return counts


def retained_stage_proof(preferences, identifier, initial, snapshot):
    """A failed transfer may retain verified private bytes, never a cache row."""
    root = preferences / 'gdrive/downloads'
    assert root.is_dir() and not root.is_symlink()
    stages = list(root.glob('.singz-download-*'))
    assert stages, 'Expected a resumable private stage after failed transfer'
    expected = {row['id']: row for row in initial}
    proof = None
    for stage in stages:
        metadata = stage.lstat()
        assert stat.S_ISDIR(metadata.st_mode) and not stage.is_symlink(), stage
        assert stat.S_IMODE(metadata.st_mode) == 0o700, 'Retained stage is not private'
        assert stage.resolve().parent == root.resolve(), 'Retained stage escaped private cache'
        assert not (stage / '.singz-drive-cache.json').exists(), 'Failed transfer has a completed cache marker'
        document = json.loads((stage / 'project.json').read_text())
        project_id = 'project-' + document['foreign']['restoreFixture']
        members = []
        for path in stage.rglob('*'):
            metadata = path.lstat()
            assert not path.is_symlink(), 'Linked member in retained stage'
            if stat.S_ISDIR(metadata.st_mode):
                assert stat.S_IMODE(metadata.st_mode) == 0o700, 'Retained nested directory is not private'
                continue
            assert stat.S_ISREG(metadata.st_mode), 'Non-regular member in retained stage'
            relative = path.relative_to(stage).as_posix()
            remote_id = 'file-' + project_id.removeprefix('project-') + '-' + path.stem
            remote = expected.get(remote_id)
            checksum = hashlib.md5(path.read_bytes()).hexdigest()
            verified = remote is not None and path.stat().st_size == int(remote['size']) and checksum == remote['md5Checksum']
            members.append({'path': relative, 'remoteId': remote_id, 'size': metadata.st_size,
                            'sha256': shared.sha(path), 'verified': verified})
        if project_id == identifier:
            assert proof is None, 'Multiple stages for one revision'
            proof = {'id': identifier, 'stageName': stage.name, 'privateMode': '0700',
                     'published': False, 'members': members, 'mediaCountsAtFailure': media_counts(snapshot)}
    assert proof is not None and any(member['verified'] for member in proof['members']), 'No verified resumable members retained'
    return proof


def run_sidecar(server, folder, preferences, initial, stop, errors):
    handled, authorized = set(), set()
    retries = {}
    try:
        while not stop.wait(.02):
            for path in folder.glob('authorization-url-*.json'):
                if path.name not in authorized:
                    authorize(server.base, path)
                    authorized.add(path.name)
            for path in sorted((folder / 'requests').glob('*.json')):
                if path.name in handled:
                    continue
                operation = json.loads(path.read_text())['operation']
                state = server.state.snapshot()
                if operation == 'arm-cancel':
                    server.state.control({'gates': {'download-first': True}, 'chunkGates': [
                        {'fileId': 'file-default-vocals', 'gate': 'download-first', 'afterBytes': 65536}]})
                elif operation == 'cancel-held':
                    if state['gates']['download-first']['waiting'] != 1:
                        continue
                    assert 'project-default' not in published_ids(preferences)
                elif operation == 'cancelled-proof':
                    if state['gates']['download-first']['waiting']:
                        continue
                    assert 'project-default' not in published_ids(preferences), 'Cancelled project became published'
                    retries['project-default'] = retained_stage_proof(preferences, 'project-default', initial, state)
                    (folder / 'cancelled-private-stage-proof.json').write_text(json.dumps(retries['project-default'], indent=2))
                elif operation == 'release-cancel':
                    server.state.control({'release': ['download-first'], 'chunkGates': []})
                elif operation == 'arm-integrity':
                    server.state.control({'failNext': [{'method': 'GET', 'path': '/drive/v3/files/file-integrity-vocals',
                                                       'status': 200, 'corruptBytes': True, 'count': 3}]})
                elif operation == 'integrity-proof':
                    assert 'project-integrity' not in published_ids(preferences), 'Hash failure published a cache entry'
                    retries['project-integrity'] = retained_stage_proof(preferences, 'project-integrity', initial, state)
                    (folder / 'integrity-private-stage-proof.json').write_text(json.dumps(retries['project-integrity'], indent=2))
                    downloads = [row for row in state['requests'] if row['path'] == '/drive/v3/files/file-integrity-vocals'
                                 and row['query'].get('alt') == ['media'] and row['status'] == 200]
                    expected_size = int(next(row for row in initial if row['id'] == 'file-integrity-vocals')['size'])
                    assert len(downloads) == 3 and all(row['responseBytes'] == expected_size for row in downloads), 'All three production retry attempts must receive complete, hash-invalid encoded WAVs'
                elif operation == 'readonly-proof':
                    assert set(retries) == {'project-default', 'project-integrity'}
                    counts = media_counts(state)
                    for identifier, proof in retries.items():
                        assert identifier in published_ids(preferences), 'Successful retry did not publish verified cache'
                        for member in proof['members']:
                            remote_id = member['remoteId']
                            before = proof['mediaCountsAtFailure'].get(remote_id, 0)
                            if member['verified']:
                                assert counts.get(remote_id, 0) == before, 'Retry downloaded an already verified retained member again'
                        if identifier == 'project-integrity':
                            # The production verifier can remove failed .part
                            # payloads; prove retry from the request ledger even
                            # when no hash-invalid file remains in the stage.
                            assert proof['mediaCountsAtFailure'].get('file-integrity-vocals', 0) == 3, 'Integrity refusal did not exhaust the three-attempt production retry budget'
                            assert counts.get('file-integrity-vocals', 0) == 4, 'Actual Retry must fetch and verify audio once after three corrupt attempts'
                    (folder / 'verified-retry-reuse.json').write_text(json.dumps({'passed': True, 'failures': retries, 'mediaCountsAfterRetry': counts}, indent=2))
                elif operation == 'clear-integrity':
                    pass
                else:
                    raise AssertionError(operation)
                assert_read_only(server.state.snapshot(), initial)
                (folder / f'{path.stem}-remote-proof.json').write_text(json.dumps(server.state.snapshot(), indent=2))
                pending = folder / 'acks' / (path.name + '.pending')
                pending.write_text(json.dumps({'ok': True}))
                pending.replace(folder / 'acks' / path.name)
                handled.add(path.name)
    except BaseException as error:
        errors.append(repr(error))
        (folder / 'sidecar-failure.json').write_text(json.dumps({'error': repr(error)}))
        for path in (folder / 'requests').glob('*.json'):
            (folder / 'acks' / path.name).write_text(json.dumps({'ok': False, 'error': repr(error)}))


def validate_output(folder, expected, offline):
    result = json.loads((folder / 'result.json').read_text())
    for key in ('passed', 'actualBrowserKeys', 'searchKeys', 'searchTransportOwned', 'nativeDefaultOpen', 'nativeCustomOpen', 'nativeEmptyOpen', 'hidden', 'muted'):
        assert result[key] is True, (key, result)
    assert result['offline'] is offline and result['physicalInput'] is False, result
    search = result['searchOwnership']
    assert search['query'] == search['searchValue'] == 'Custom graph' and search['searchFocused'] is True, search
    assert search['epochBefore'] == search['epochAfter'] and search['seekBefore'] == search['seekAfter'], search
    assert abs(search['positionBefore'] - search['positionAfter']) < .001, search
    assert search['playing'] is False and search['nativePlaying'] is False and search['playIntentPending'] is False, search
    if not offline:
        assert result['cancelledWithoutPublication'] and result['integrityRefusedWithoutPublication'] and result['actualRetry'], result
    opened = result['opened']
    required = {'project-default', 'project-custom', 'project-empty'} | (set() if offline else {'project-integrity'})
    assert {entry['id'] for entry in opened} == required, opened
    for entry in opened:
        directory = Path(entry['directory'])
        assert directory.is_dir() and not directory.is_symlink(), entry
        for relative, fingerprint in expected[entry['id']]['files'].items():
            path = directory / relative
            assert path.is_file() and path.stat().st_size == fingerprint['size'] and shared.sha(path) == fingerprint['sha256'], (entry, relative)
        assert entry['empty'] == (entry['id'] == 'project-empty'), entry
        if entry['empty']:
            assert entry['duration'] == 0 and entry['nativeGraph'] == 0 and entry['laneCount'] == 0 and entry['physicalOutputReleased'], entry
        else:
            assert entry['duration'] > 11 and entry['laneCount'] >= 1 and entry['nativePlayConfirmed'], entry
        assert entry['explicitGraph'] == (entry['id'] == 'project-custom'), entry
    wanted = {f'{name}-{width}' for width in (1280, 1060)
              for name in ('browser', 'search-miss', 'search-stem', 'native-default', 'native-custom', 'native-empty')}
    if not offline:
        wanted.update({'download-held-1060', 'download-cancelled-1060', 'integrity-refused-1060',
                       'native-integrity-1280', 'native-integrity-1060'})
    assert set(result['captures']) == wanted and result['captureCount'] == len(wanted), result
    from PIL import Image
    for path in folder.glob('*.png'):
        state = json.loads(path.with_suffix('.state.json').read_text())
        assert state['hidden'] is True and state['active'] is False and state['physicalInput'] is False, state
        assert state['viewport'] in ([1280, 800], [1060, 640]), state
        assert Image.open(path).size == tuple(round(value * state['scale']) for value in state['viewport']), state
        browser = state['browser']
        if path.stem.startswith('search-miss-'):
            assert state['browserOpen'] is True and browser['query'] == browser['searchValue'] == 'No matching fixture' and browser['visibleRows'] == [], state
        elif path.stem.startswith('search-stem-'):
            assert state['browserOpen'] is True and browser['query'] == browser['searchValue'] == 'Stem', state
            assert [row['id'] for row in browser['visibleRows']] == ['project-default'], state
        elif path.stem == 'download-held-1060':
            assert state['browserOpen'] is True and browser['busy'] is True, state
        elif path.stem in ('download-cancelled-1060', 'integrity-refused-1060'):
            assert state['browserOpen'] is True and browser['busy'] is False, state
            rejected = 'project-default' if path.stem.startswith('download-') else 'project-integrity'
            assert next(row for row in browser['rows'] if row['id'] == rejected)['songPath'] is None, state
        elif path.stem.startswith('native-'):
            assert state['browserOpen'] is False and state['pickerOpen'] is False and state['native'] is not None, state
    assert len(list(folder.glob('*.png'))) == result['captureCount'] > 0, result
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--timeout', type=int, default=240)
    args = parser.parse_args()
    if platform.system() != 'Darwin':
        parser.error('Strict observer currently requires macOS')
    app, out = args.app.resolve(strict=True), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    assert not any(out.iterdir()), 'Use a fresh OUT directory'
    assert 30 <= args.timeout <= 600
    fixture = fixture_module()
    server = fixture.Server()
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    app_hash, helper_hash = shared.sha(app), shared.sha(app.with_name('singz-gpui-audio'))
    server_closed = False
    try:
        with tempfile.TemporaryDirectory(prefix='singz-drive-restore-ui-') as temporary:
            root = Path(temporary).resolve()
            identities = {'application': (app, app_hash),
                          'nativeHelper': (app.with_name('singz-gpui-audio'), helper_hash)}
            try:
                for name in ('prefs', 'library', 'cache', 'tmp'):
                    (root / name).mkdir()
                files, expected = seed_projects(fixture, out / 'seeded-projects')
                server.state.control({'files': files, 'pageSize': 3})
                initial = remote_files(server.state.snapshot())
                (out / 'fixture-input.json').write_text(json.dumps({'projects': expected, 'emptyScope': 'Explicit strict reader fixture; native writer remains refused'}, indent=2))
                catalog = root / 'models.json'
                catalog.write_text(json.dumps({'flavor': 'linux', 'entries': []}))
                catalog_hash = shared.sha(catalog)
                identities['modelCatalog'] = (catalog, catalog_hash)
                for path in sorted((out / 'seeded-projects').rglob('*')):
                    if path.is_file():
                        identities['seed/' + path.relative_to(out / 'seeded-projects').as_posix()] = (path, shared.sha(path))
                (out / 'input-identities.json').write_text(json.dumps(input_checks(identities), indent=2))
                env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
                env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1',
                           SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_CONFIG_DIR=str(root / 'prefs'),
                           SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
                           SINGZ_PACK_DIR=str(root / 'missing-pack'), SINGZ_MODELS_DIR=str(root / 'missing-models'),
                           SINGZ_LLAMA_SERVER=str(root / 'missing-llama'), SINGZ_CRISPASR=str(root / 'missing-crispasr'),
                           SINGZ_GDRIVE_CONFIG=json.dumps({'clientId': 'fixture-client', 'clientSecret': 'fixture-secret',
                                                         'authBase': server.base, 'apiBase': server.base, 'uploadBase': server.base}),
                           TMPDIR=str(root / 'tmp'), XDG_CACHE_HOME=str(root / 'cache'), HF_HOME=str(root / 'cache/huggingface'),
                           TORCH_HOME=str(root / 'cache/torch'), PYTHONDONTWRITEBYTECODE='1')
                results = []
                for stage in ('online', 'offline'):
                    folder = out / stage
                    folder.mkdir(); (folder / 'acks').mkdir()
                    errors, stop = [], threading.Event()
                    sidecar = None
                    if stage == 'online':
                        sidecar = threading.Thread(target=run_sidecar, args=(server, folder, root / 'prefs', initial, stop, errors), daemon=True)
                        sidecar.start()
                    try:
                        observation = shared.run_observed(app, folder, {**env, 'SINGZ_GPUI_DRIVE_RESTORE_TEST': str(folder),
                                                                        'SINGZ_GPUI_DRIVE_RESTORE_STAGE': stage}, args.timeout, expect_input_helper=False)
                    finally:
                        stop.set()
                        if sidecar:
                            sidecar.join(timeout=10)
                            assert not sidecar.is_alive(), 'Fixture sidecar did not retire'
                    assert not errors, errors
                    result = validate_output(folder, expected, stage == 'offline')
                    results.append({'stage': stage, 'captureCount': result['captureCount'], 'resourceSamples': len(observation['samples'])})
                    if stage == 'online':
                        remote = server.state.snapshot()
                        assert_read_only(remote, initial)
                        (out / 'remote-after-online.json').write_text(json.dumps(remote, indent=2))
                        server.stop(); worker.join(timeout=5); server.server_close(); server_closed = True
                        assert not worker.is_alive(), 'Loopback fixture did not retire before offline restart'
                final_checks = input_checks(identities)
                (out / 'final-input-checks.json').write_text(json.dumps(final_checks, indent=2))
                assert all(record['unchanged'] for record in final_checks.values()), final_checks
                cache = root / 'prefs/gdrive/downloads'
                shutil.copytree(cache, out / 'verified-native-cache')
                (out / 'fixture.json').write_text(json.dumps({'passed': True, 'applicationSha256': app_hash, 'helperSha256': helper_hash,
                    'modelCatalogSha256': catalog_hash, 'stages': results, 'noNode': True, 'physicalInput': False,
                    'remoteReadOnly': True, 'freshProcessOfflineRestart': True, 'liveFps': 'unmeasured',
                    'scope': 'Read-only browser and verified native cache; strict empty is reader fixture, native empty writer remains unqualified; production visual parity unqualified'}, indent=2))
            except BaseException as error:
                preserve_failure(root, out, server, error, identities)
                raise
    finally:
        if not server_closed:
            server.stop(); worker.join(timeout=5); server.server_close()
    print('PASS: read-only native Drive browser, cancellation, integrity retry and offline cached native reopen')


if __name__ == '__main__':
    main()
