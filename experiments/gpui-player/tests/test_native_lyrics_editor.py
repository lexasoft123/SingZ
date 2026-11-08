"""Hidden native lyric editing, independent Save and publication checks.

The actual native controls and playback helper run in isolated fixtures. No
Node, OS input, microphone capture, user library or unmuted output is involved.
New screenshots are candidates without matched production references.
"""
import argparse
import contextlib
import hashlib
import http.server
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
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)

@contextlib.contextmanager
def lyrics_miss_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            search = self.path.startswith('/api/search')
            body = b'[]' if search else b'{"message":"Not found"}'
            self.send_response(200 if search else 404)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f'http://127.0.0.1:{server.server_port}/api'
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


with tempfile.TemporaryDirectory(prefix='singz-native-lyrics-editor-') as temp, lyrics_miss_server() as lyrics_url:
    root = Path(temp).resolve()
    source = root / 'song.wav'
    with wave.open(str(source), 'wb') as audio:
        audio.setparams((2, 2, 44100, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<hh', int(4500 * math.sin(i * math.tau * 220 / 44100)),
            int(3500 * math.sin(i * math.tau * 330 / 44100))) for i in range(44100 * 12)))
    original_audio = sha(source)
    lines = [
        {'start': 1, 'end': 3, 'text': 'Hello,   world!', 'words': [
            {'w': 'Hello,', 's': 1, 'e': 1.6}, {'w': 'world!', 's': 1.7, 'e': 2.8}]},
        {'start': 4, 'end': 6.5, 'text': 'Sing with me', 'words': [
            {'w': 'Sing', 's': 4, 'e': 4.6}, {'w': 'with', 's': 4.8, 'e': 5.2}, {'w': 'me', 's': 5.5, 'e': 6.5}]},
        {'start': 8, 'end': 10, 'text': 'Третий припев', 'words': [
            {'w': 'Третий', 's': 8, 'e': 8.8}, {'w': 'припев', 's': 9, 'e': 10}]},
    ]
    initial = {}
    names = ['project-1280', 'project-1060', 'absent', 'absent-race', 'conflict', 'stale', 'other', 'working-target', 'long-1280', 'long-1060', 'mid-save']
    for name in names:
        folder = root / name
        folder.mkdir()
        shutil.copyfile(source, folder / 'song.wav')
        project = {'version': 2, 'name': name, 'songFile': 'song.wav',
            'foreignProject': {'keep': name}, 'settings': {
                'metronome': {'grid': False, 'click': False, 'countInBars': 1, 'volume': .7, 'accent': True}}}
        (folder / 'project.json').write_text(json.dumps(project, ensure_ascii=False))
        (folder / 'notes.txt').write_text('preserve unrelated notes\n')
        if not name.startswith('absent'):
            lyric_lines = lines if name != 'other' else [
                {'start': 2, 'end': 5, 'text': 'Other project stays here', 'words': [
                    {'w': 'Other', 's': 2, 'e': 2.5}, {'w': 'project', 's': 2.5, 'e': 3.5},
                    {'w': 'stays', 's': 3.5, 'e': 4}, {'w': 'here', 's': 4, 'e': 5}]}]
            if name.startswith('long-'):
                lyric_lines = [{'start': round(.2 + i * .5, 2), 'end': round(.55 + i * .5, 2),
                    'text': f'Long line {i + 1:02d}', 'words': [
                        {'w': 'Long', 's': round(.2 + i * .5, 2), 'e': round(.3 + i * .5, 2)},
                        {'w': 'line', 's': round(.3 + i * .5, 2), 'e': round(.4 + i * .5, 2)},
                        {'w': f'{i + 1:02d}', 's': round(.4 + i * .5, 2), 'e': round(.55 + i * .5, 2)}]}
                    for i in range(20)]
            lyrics = {'source': 'other-source' if name == 'other' else 'fixture-source',
                'credit': 'other-credit' if name == 'other' else 'fixture-credit',
                'foreignLyrics': {'keep': name}, 'lines': lyric_lines}
            (folder / 'lyrics.json').write_text(json.dumps(lyrics, ensure_ascii=False))
        initial[name] = {'project': project,
            'projectSha256': sha(folder / 'project.json'),
            'lyricsSha256': sha(folder / 'lyrics.json') if (folder / 'lyrics.json').exists() else None}
    # A prepared split output needs a real stem member so targeted Save also
    # exercises the native compaction/publication path. No drums or vocals are
    # needed for this publication fixture; unrelated analysis stays out of it.
    (root / 'working-target/stems').mkdir()
    shutil.copyfile(source, root / 'working-target/stems/other.wav')
    shutil.copytree(root / 'working-target', root / 'working-copy')
    prefs = root / 'prefs'
    prefs.mkdir()
    (prefs / 'metronome.json').write_text(json.dumps({'version': 1, 'grid': False,
        'click': False, 'countInBars': 1, 'volume': .7, 'accent': True}))
    gate = root / 'receipt.gate'
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_') and k not in ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR']}
    env.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_LRCLIB_URL=lyrics_url,
        SINGZ_GPUI_LYRICS_EDITOR_TEST=str(out), SINGZ_GPUI_LYRICS_EDITOR_FIXTURES=str(root),
        SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE=str(gate),
        SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
        SINGZ_PACK_DIR=str(root / 'missing-pack'))
    resources, stop, started = [], threading.Event(), time.monotonic()
    with (out / 'lyrics-editor.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)
        def sample():
            previous = None
            while not stop.wait(.5):
                try:
                    if platform.system() != 'Darwin':
                        resources.append({'available': False, 'reason': 'macOS resource counters unavailable'})
                        return
                    cpu, memory = perf.process_usage(child.pid)
                    now = time.monotonic()
                    if previous:
                        resources.append({'elapsedSeconds': now-started,
                            'processCpuPercent': (cpu-previous[0]) / ((now-previous[1])*1e9)*100,
                            'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                    previous = cpu, now
                except OSError:
                    return
        sampling = threading.Thread(target=sample, daemon=True)
        sampling.start()
        try:
            child.wait(timeout=240)
        finally:
            gate.unlink(missing_ok=True)
            if child.poll() is None:
                child.kill()
                child.wait(timeout=5)
            stop.set()
            sampling.join(timeout=4)
    (out / 'performance.json').write_text(json.dumps({'scope': 'main GPUI CPU/footprint; excludes helper; GPU system-wide',
        'wallSeconds': time.monotonic()-started, 'samples': resources,
        'liveFps': {'available': False, 'reason': 'hidden static renders do not measure live display cadence'}}, indent=2))
    shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True)
    assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'lyrics-editor.log').read_text()
    result = json.loads((out / 'result.json').read_text())
    required = ['twoSizes', 'rawLineText', 'textInput', 'splitMerge', 'addStampRemoveUndo', 'replace',
        'helpEscape', 'dirtyDismissal', 'focusTrap', 'wordClickNoOp', 'wordDrag', 'wordKeyboardNudge',
        'independentSave', 'saveReopen', 'noCountInAudition', 'absentCreate', 'absentRaceRefused',
        'externalConflictRefused', 'staleReceiptIgnored', 'workingCopyPublication', 'longListFocusVisible',
        'midSaveEditRetained', 'secondSaveAfterEdit', 'hidden', 'muted']
    assert all(result.get(k) is True for k in required), result
    for name in ['project-1280', 'project-1060']:
        folder = root / name
        lyrics = json.loads((folder / 'lyrics.json').read_text())
        assert lyrics['source'] == 'edited' and lyrics['credit'] == 'fixture-credit'
        assert lyrics['foreignLyrics'] == {'keep': name}
        assert lyrics['lines'][0]['text'] == 'Hello native world'
        assert sha(folder / 'project.json') == initial[name]['projectSha256'], 'Editor Save rewrote mix metadata'
        assert sha(folder / 'song.wav') == original_audio
    for name in ['long-1280', 'long-1060']:
        assert sha(root / name / 'lyrics.json') == initial[name]['lyricsSha256'], 'Focus/Undo/discard wrote long lyrics'
        assert sha(root / name / 'project.json') == initial[name]['projectSha256']
    mid_save = json.loads((root / 'mid-save/lyrics.json').read_text())
    assert mid_save['source'] == 'edited' and mid_save['lines'][0]['text'] == 'Newer draft stays open'
    assert sha(root / 'mid-save/project.json') == initial['mid-save']['projectSha256']
    absent = json.loads((root / 'absent/lyrics.json').read_text())
    assert absent['source'] == 'edited' and absent['lines'][0]['text'] == 'Create missing lyrics'
    assert sha(root / 'absent/project.json') == initial['absent']['projectSha256']
    conflict = json.loads((root / 'conflict/lyrics.json').read_text())
    assert conflict['externalChange'] == 'keep' and conflict['source'] == 'fixture-source'
    assert json.loads((root / 'absent-race/lyrics.json').read_text())['externalCreate'] == 'keep'
    assert sha(root / 'other/lyrics.json') == initial['other']['lyricsSha256']
    working = json.loads((root / 'working-target/lyrics.json').read_text())
    assert working['source'] == 'edited' and working['lines'][0]['text'] == 'Working correction survives publication'
    assert (root / 'working-target/notes.txt').read_text() == 'preserve unrelated notes\n'
    assert sha(root / 'working-target/song.wav') == original_audio
    assert (root / 'working-target/stems/other.flac').is_file(), 'Working stem was not compacted/published'
    (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
        'helperSha256': sha(app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')),
        'sourceSha256': original_audio, 'initial': initial, 'initialLines': lines,
        'logicalViewports': [[1280, 800], [1060, 640]], 'scale': 2,
        'platform': platform.platform(), 'requestedLocale': os.environ.get('SINGZ_LANG', 'en'), 'noNode': True,
        'capture': 'hidden native content, muted, app-local input',
        'workingCopySetup': 'prepared private working output fixture; publication path real, no separation model replay',
        'staleReceiptSetup': 'UI-tests-only postcommit receipt gate',
        'visualReference': 'candidate only; matching production captures absent'}, indent=2, ensure_ascii=False))
print('PASS: hidden native lyric editor controls, timing, independent Save, conflicts, stale receipts and working publication')
