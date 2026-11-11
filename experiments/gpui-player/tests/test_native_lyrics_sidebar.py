"""Hidden actual native lyrics sidebar search, publication and model protocols.

The app's native decoding, HTTP model installer, subprocess runner, cancellation,
outcome domain and sidebar controls are real. Tiny model headers and deterministic
runtime protocol processes replace inference. This does not measure NN quality.
"""
import argparse
import hashlib
import http.server
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import struct
import subprocess
import sys
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
sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
heard_text = 'The song is with you And this is all your lovely song today'
names = ['Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
    'qwen3-forced-aligner-0.6b-q8_0.gguf']

def foreground():
    if platform.system() != 'Darwin': return {'available': False, 'reason': 'macOS-only observation'}
    try:
        r = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=2)
        return {'available': r.returncode == 0, 'front': r.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired) as error: return {'available': False, 'reason': str(error)}
foreground_before = foreground()

with tempfile.TemporaryDirectory(prefix='singz-native-lyrics-sidebar-') as temp:
    root = Path(temp).resolve()
    prefs, project = root / 'prefs', root / 'project-1280'
    models, pack = prefs / 'models', prefs / 'gpu-splitter'
    models.mkdir(parents=True)
    (project / 'stems').mkdir(parents=True)
    (pack / 'python/bin').mkdir(parents=True)
    control = root / 'control.json'
    control.write_text(json.dumps({'download': 'good', 'runtime': 'success', 'delayMs': 0}))
    calls = root / 'calls.jsonl'
    calls.write_text('')
    requests = root / 'requests.jsonl'
    requests.write_text('')
    shared = '''import json, os, sys, time
from pathlib import Path
control = Path(os.environ['SINGZ_GPUI_LYRICS_ALIGN_CONTROL'])
mode = json.loads(control.read_text())
def record(kind, **data):
    with (control.parent / 'calls.jsonl').open('a') as log:
        log.write(json.dumps(dict(kind=kind, pid=os.getpid(), **data)) + '\\n')
'''
    crisp = root / 'crispasr-protocol'
    crisp.write_text(f'#!{sys.executable}\n' + shared + '''
args = sys.argv[1:]
if '--align-only' not in args or '--align-output' not in args or '--ref-text' not in args:
    raise SystemExit('Unexpected word-aligner protocol: ' + repr(args))
text = args[args.index('--ref-text') + 1]
out = Path(args[args.index('--align-output') + 1])
record('crisp', args=args, text=text, mode=mode)
time.sleep(mode.get('delayMs', 0) / 1000)
if mode.get('runtime') == 'fail':
    print('Deterministic word-aligner protocol failure', file=sys.stderr, flush=True)
    raise SystemExit(3)
words = text.split()
out.write_text(json.dumps([{'start': round(.8 + i * .8, 3), 'end': round(1.3 + i * .8, 3)} for i in range(len(words))]))
''')
    crisp.chmod(0o700)
    python = pack / 'python/bin/python3'
    python.write_text(f'#!{sys.executable}\n' + shared + '''
args = sys.argv[1:]
if len(args) < 3 or Path(args[2]).name != 'tokens.json':
    # Capability/probe requests are not model inference.
    print('isolated fixture Python protocol', flush=True)
    raise SystemExit(0)
tokens = json.loads(Path(args[2]).read_text())
record('precise', args=args, tokens=tokens, mode=mode)
print('P 23', file=sys.stderr, flush=True)
time.sleep(mode.get('delayMs', 0) / 1000)
if mode.get('runtime') == 'fail':
    print('Deterministic precise-aligner protocol failure', file=sys.stderr, flush=True)
    raise SystemExit(3)
print('P 100', file=sys.stderr, flush=True)
print(json.dumps({'words': [{'i': token['i'], 's': round(.9 + i * .75, 3),
    'e': round(1.4 + i * .75, 3), 'score': 1.0, 'v': 1.0} for i, token in enumerate(tokens)]}), flush=True)
''')
    python.chmod(0o700)
    is_intel = platform.system() == 'Darwin' and platform.machine().lower() not in ['arm64', 'aarch64']
    flavor = 'intel-mac' if is_intel else 'apple-silicon'
    (pack / 'python/pack.json').write_text(json.dumps({'formatVersion': 10,
        'target': 'darwin-x64' if is_intel else 'darwin-arm64', 'fixtureOnly': True}))
    llama = root / 'llama-server-protocol'
    llama.write_text(f'#!{sys.executable}\n' + shared + '''
import http.server
args = sys.argv[1:]
port = int(args[args.index('--port') + 1])
record('server', args=args)
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def do_GET(self):
        body = b'{"status":"ok"}'
        self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        request = json.loads(body)
        record('asr-request', bytes=len(body), inputAudio='input_audio' in body.decode())
        time.sleep(mode.get('delayMs', 0) / 1000)
        response = json.dumps({'choices': [{'message': {'content': 'language English<asr_text>HEARD_TEXT'}, 'finish_reason': 'stop'}]}).encode()
        self.send_response(200); self.send_header('Content-Length', str(len(response))); self.end_headers(); self.wfile.write(response)
http.server.HTTPServer(('127.0.0.1', port), Handler).serve_forever()
'''.replace('HEARD_TEXT', heard_text))
    llama.chmod(0o700)
    vocals = project / 'stems/vocals.wav'
    with wave.open(str(vocals), 'wb') as audio:
        audio.setparams((1, 2, 44100, 0, 'NONE', 'not compressed'))
        audio.writeframes(b''.join(struct.pack('<h', int(7000 * math.sin(i * math.tau * 220 / 44100))) for i in range(44100 * 12)))
    lines = [
        {'start': 1, 'end': 3.5, 'text': 'The song is with you', 'words': [
            {'w': text, 's': 1 + i * .5, 'e': 1.4 + i * .5} for i, text in enumerate('The song is with you'.split())]},
        {'start': 5, 'end': 9, 'text': 'And this is all your lovely song today', 'words': [
            {'w': text, 's': 5 + i * .5, 'e': 5.4 + i * .5} for i, text in enumerate('And this is all your lovely song today'.split())]},
    ]
    original_project = {'version': 2, 'name': 'project-1280', 'songFile': 'song.wav', 'foreignProject': {'keep': True}, 'settings': {'transpose': 2, 'tempo': 1, 'masterVolume': .7,
        'metronome': {'grid': False, 'click': False, 'countInBars': 0, 'volume': .7, 'accent': True}, 'melody': {'detVersion': 4, 'hopSec': .025, 'f0': 'x480'}}}
    original_lyrics = {'source': 'lrclib', 'credit': 'keep-credit', 'foreignLyrics': {'keep': True}, 'lines': lines}
    (project / 'project.json').write_text(json.dumps(original_project))
    (project / 'lyrics.json').write_text(json.dumps(original_lyrics))
    shutil.copyfile(vocals, project / 'song.wav')
    original_bytes = (project / 'lyrics.json').read_bytes()
    original_project_bytes = (project / 'project.json').read_bytes()
    stat = vocals.stat()
    heard = {'version': 1, 'engine': 'qwen3-asr-1.7b', 'language': 'English',
        'vocals': {'size': stat.st_size, 'mtimeMs': stat.st_mtime_ns / 1_000_000},
        'chunks': [{'start': 0, 'end': 12, 'text': heard_text, 'label': 'English'}]}
    (project / 'heard-words.json').write_text(json.dumps(heard))
    (root / 'heard-original.json').write_text(json.dumps(heard))
    fixture_names = ['project-1280', 'project-1060', 'cancel-http', 'stale-http', 'conflict', 'other', 'transcribe', 'postcommit', 'working-target', 'blocked-target', 'oversized']
    for fixture_name in fixture_names[1:]:
        folder = root / fixture_name
        shutil.copytree(project, folder)
        metadata = dict(original_project, name=fixture_name)
        (folder / 'project.json').write_text(json.dumps(metadata))
        if fixture_name == 'other':
            doc = dict(original_lyrics, credit='other-credit', source='edited')
            (folder / 'lyrics.json').write_text(json.dumps(doc))
    for target_name, copy_name in [('working-target', 'working-copy'), ('blocked-target', 'blocked-copy')]:
        shutil.copyfile(vocals, root / target_name / 'stems/other.wav')
        shutil.copytree(root / target_name, root / copy_name)
    with (root / 'oversized/lyrics.json').open('wb') as sparse:
        sparse.truncate(8 * 1024 * 1024 + 1)
    initial_hashes = {name: {'project': sha(root/name/'project.json'), 'lyrics': sha(root/name/'lyrics.json'),
        'song': sha(root/name/'song.wav'), 'vocals': sha(root/name/'stems/vocals.wav')} for name in fixture_names}
    model_requests = []
    request_lock = threading.Lock()
    data = b'GGUF' + bytes(1024 * 1024 - 4)
    precise_data = (b'ONNX' if is_intel else b'PK\x03\x04') + bytes(1024 * 1024 - 4)
    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def do_GET(self):
            if self.path.startswith('/api/'):
                from urllib.parse import urlparse, parse_qs
                parsed = urlparse(self.path)
                query = parse_qs(parsed.query).get('q', [''])[0]
                with request_lock:
                    with requests.open('a') as log:
                        log.write(json.dumps({'path': self.path, 'mode': 'lyrics', 'query': query}) + '\n')
                if (root / 'http-hold').exists():
                    (root / 'http-ready.json').write_text(json.dumps({'path': self.path, 'query': query}))
                    deadline = time.monotonic() + 12
                    while (root / 'http-hold').exists() and time.monotonic() < deadline:
                        time.sleep(.02)
                lrc = '[00:01.00]The song is with you\n[00:05.00]And this is all your lovely song today'
                records = [
                    {'id': 101, 'trackName': 'Selected recording', 'artistName': 'Fixture artist', 'duration': 12, 'syncedLyrics': lrc},
                    {'id': 102, 'trackName': 'Text only version', 'artistName': 'Fixture artist', 'duration': 12, 'plainLyrics': 'no timings'},
                    {'id': 103, 'trackName': 'Different length recording', 'artistName': 'Fixture artist', 'duration': 20, 'syncedLyrics': lrc},
                ]
                working_record = {'id': 104, 'trackName': 'Working copy version', 'artistName': 'Fixture artist', 'duration': 12, 'syncedLyrics': '[00:01.00]Selected words survive the saved copy\n[00:05.00]New words arrive before publication'}
                if parsed.path.endswith('/search'):
                    answer = [] if query == 'nothing' else ([working_record, records[1], records[2]] if 'working' in query else records)
                else:
                    selected = int(parsed.path.rsplit('/', 1)[-1])
                    answer = next((r for r in records + [working_record] if r['id'] == selected), {})
                body = json.dumps(answer).encode()
                self.send_response(200); self.send_header('Content-Length', str(len(body))); self.end_headers()
                try: self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass
                return
            mode = json.loads(control.read_text())['download']
            with request_lock:
                item = {'path': self.path, 'mode': mode}
                model_requests.append(item)
                with requests.open('a') as log:
                    log.write(json.dumps(item) + '\n')
            body = precise_data if self.path == '/precise' else data
            self.send_response(200)
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            try:
                if mode == 'truncated':
                    self.wfile.write(body[:100]); self.wfile.flush(); self.close_connection = True
                    return
                for i in range(32):
                    self.wfile.write(body[len(body)*i//32:len(body)*(i+1)//32]); self.wfile.flush()
                    if mode == 'slow': time.sleep(.08)
            except (BrokenPipeError, ConnectionResetError):
                pass
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    server.daemon_threads = True
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    base = f'http://127.0.0.1:{server.server_port}'
    part = lambda file, url, kind: {'file': file, 'url': base + url, 'mb': 1,
        'minBytes': 1024 * 1024, 'kind': kind}
    fixture = {'flavor': flavor, 'entries': [
        {'id': 'qwen-asr', 'label': 'Speech model · lyrics', 'description': 'Protocol fixture',
            'optional': True, 'archive': False, 'parts': [part(name, f'/qwen-{i}', 'gguf') for i, name in enumerate(names)]},
        {'id': 'aligner', 'label': 'Precise word aligner', 'description': 'Protocol fixture',
            'optional': True, 'archive': False, 'parts': [part('mms-fa.onnx' if is_intel else 'torch-home/hub/checkpoints/model.pt',
                '/precise', 'onnx' if is_intel else 'torch')]},
    ]}
    catalog = root / 'catalog.json'
    catalog.write_text(json.dumps(fixture))
    env = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_GPUI_')
        and k not in ['SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_CRISPASR', 'SINGZ_LLAMA_SERVER']}
    env.update(SINGZ_MUTE='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
        SINGZ_GPUI_LYRICS_SIDEBAR_TEST=str(out), SINGZ_GPUI_LYRICS_SIDEBAR_FIXTURES=str(root), SINGZ_GPUI_LRCLIB_URL=base + '/api',
        SINGZ_GPUI_SOURCE_SAVE_PREPARE_GATE=str(root / 'source-save-gate'), SINGZ_GPUI_LYRICS_RESOLVE_RECEIPT_GATE=str(root / 'resolve-gate'), SINGZ_GPUI_LYRICS_ALIGN_CONTROL=str(control), SINGZ_GPUI_MODEL_FIXTURE=str(catalog),
        SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(root / 'library'),
        SINGZ_PACK_DIR=str(pack), SINGZ_MODELS_DIR=str(models),
        SINGZ_CRISPASR=str(crisp), SINGZ_LLAMA_SERVER=str(llama))
    spec = importlib.util.spec_from_file_location('interface_perf', Path(__file__).with_name('interface-perf.py'))
    perf = importlib.util.module_from_spec(spec); spec.loader.exec_module(perf)
    resources, stop, started = [], threading.Event(), time.monotonic()
    child = None
    try:
        with (out / 'lyrics-sidebar.log').open('w') as log:
            child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT)
            def sample():
                previous = None
                while not stop.wait(.5):
                    try:
                        if platform.system() != 'Darwin': return
                        cpu, memory = perf.process_usage(child.pid); now = time.monotonic()
                        if previous:
                            resources.append({'elapsedSeconds': now-started,
                                'processCpuPercent': (cpu-previous[0])/((now-previous[1])*1e9)*100,
                                'processFootprintBytes': memory, 'gpuSystem': perf.gpu_usage()})
                        previous = cpu, now
                    except OSError: return
            sampling = threading.Thread(target=sample, daemon=True); sampling.start()
            try: child.wait(timeout=300)
            finally:
                if child.poll() is None: child.kill(); child.wait(timeout=5)
                stop.set(); sampling.join(timeout=4)
        assert child.returncode == 0 and (out / 'result.json').is_file(), (out / 'lyrics-sidebar.log').read_text()
        result = json.loads((out / 'result.json').read_text())
        required = ['twoSizes', 'inlineChange', 'realKeyboardSpaces', 'searchEnter', 'disabledTextOnly',
            'durationMatches', 'emptyResults', 'backCached', 'immediateApply', 'foreignMixPreserved',
            'editorAction', 'consentCancelRestores', 'alignPublishes', 'precisePublishes', 'runtimeCancel',
            'transcribeReturnsProgress', 'whisperActions', 'mismatchNoWrite', 'cancelHttpNoWrite', 'staleHttpNoWrongSong',
            'externalConflict', 'retryControl', 'postcommitCancelAdopts', 'queuedEditAfterReceipt', 'editorSaveAfterCommittedCancel', 'pendingApplyWorkingSave', 'blockedSaveApplyRefused', 'oversizedLyricsPlayable', 'hidden', 'muted']
        assert all(result.get(key) is True for key in required), result
        for name in fixture_names:
            folder = root / name
            if name not in ['working-target', 'blocked-target']:
                assert sha(folder/'project.json') == initial_hashes[name]['project'], f'Mix/project metadata changed: {name}'
            else:
                metadata = json.loads((folder/'project.json').read_text())
                assert metadata['foreignProject'] == {'keep': True} and metadata['settings']['transpose'] == 2 and metadata['settings']['tempo'] == 1
                assert (folder/'stems/vocals.flac').is_file() and (folder/'stems/other.flac').is_file()
            assert sha(folder/'song.wav') == initial_hashes[name]['song']
            if name not in ['working-target', 'blocked-target']: assert sha(folder/'stems/vocals.wav') == initial_hashes[name]['vocals']
            if name != 'oversized': assert json.loads((folder/'lyrics.json').read_text())['foreignLyrics'] == {'keep': True}
        for name in ['cancel-http', 'stale-http', 'other', 'oversized']:
            assert sha(root/name/'lyrics.json') == initial_hashes[name]['lyrics'], f'Cancelled/stale request wrote {name}'
        for name in ['project-1280', 'project-1060']:
            document = json.loads((root/name/'lyrics.json').read_text())
            assert document['credit'] == 'Fixture artist — Selected recording'
        assert json.loads((root/'project-1280/lyrics.json').read_text())['aligned'] is True
        assert json.loads((root/'conflict/lyrics.json').read_text())['externalChange'] == 'keep'
        assert json.loads((root/'postcommit/lyrics.json').read_text())['lines'][0]['text'] == 'A later editor correction'
        assert json.loads((root/'working-target/lyrics.json').read_text())['lines'][0]['text'] == 'Selected words survive the saved copy'
        assert json.loads((root/'blocked-target/lyrics.json').read_text())['credit'] == 'keep-credit'
        assert (root/'oversized/lyrics.json').stat().st_size == 8 * 1024 * 1024 + 1
        records = [json.loads(line) for line in calls.read_text().splitlines()]
        assert any(r['kind'] == 'crisp' for r in records) and any(r['kind'] == 'precise' for r in records)
        assert any(r['kind'] == 'asr-request' and r['inputAudio'] for r in records)
        request_records = [json.loads(line) for line in requests.read_text().splitlines()]
        assert any(r.get('query') == 'artist song' for r in request_records), request_records
        for record in records:
            if record['kind'] == 'asr-request': continue
            process = subprocess.run(['ps', '-p', str(record['pid']), '-o', 'command='], capture_output=True, text=True)
            assert not any(str(path) in process.stdout for path in [crisp, python, llama]), f'Owned runtime survived cleanup: {record}'
        (out / 'fixture.json').write_text(json.dumps({'appSha256': sha(app),
            'helperSha256': sha(app.with_name('singz-gpui-audio.exe' if os.name == 'nt' else 'singz-gpui-audio')),
            'vocalsSha256': sha(vocals), 'runtimeHashes': {str(p.relative_to(root)): sha(p) for p in [crisp, python, llama]},
            'modelCatalog': fixture, 'modelRequests': model_requests, 'calls': records, 'platform': platform.platform(), 'architecture': platform.machine(),
            'sourceHashes': {str(p): sha(p) for p in [Path(__file__).resolve(), Path(__file__).resolve().parents[1]/'src/lyrics_sidebar.rs', Path(__file__).resolve().parents[1]/'src/ui_lyrics_sidebar.rs', Path(__file__).resolve().parents[4]/'singz-ui/gpui/src/lyrics_sidebar_controls.rs'] if p.is_file()},
            'originalProject': original_project, 'originalLyrics': original_lyrics, 'warmHeard': heard,
            'noNode': True, 'hiddenConfigured': True, 'mutedConfigured': True,
            'scope': 'real sidebar controls, LRCLIB HTTP, publication and model protocols with deterministic runtime fixtures; no neural inference quality claim', 'requests': request_records, 'initialHashes': initial_hashes,
            'visualReference': 'candidate captures only; production reference absent'}, indent=2))
    finally:
        stop.set()
        if child is not None and child.poll() is None: child.kill(); child.wait(timeout=5)
        for gate_name in ['http-hold', 'resolve-gate', 'source-save-gate']:
            (root / gate_name).unlink(missing_ok=True)
        server.shutdown(); server.server_close()
        for line in calls.read_text().splitlines():
            record = json.loads(line)
            if record['kind'] == 'asr-request': continue
            pid = record['pid']
            command = subprocess.run(['ps', '-p', str(pid), '-o', 'command='], capture_output=True, text=True)
            if any(str(path) in command.stdout for path in [crisp, python, llama]):
                try: os.killpg(pid, signal.SIGKILL)
                except ProcessLookupError: pass
        (out / 'performance.json').write_text(json.dumps({'scope': 'main GPUI CPU/footprint; helper excluded; GPU system-wide',
            'wallSeconds': time.monotonic()-started, 'samples': resources,
            'liveFps': {'available': False, 'reason': 'hidden static captures do not measure live cadence'}}, indent=2))
        foreground_after = foreground()
        (out / 'foreground.json').write_text(json.dumps({'before': foreground_before, 'after': foreground_after}, indent=2))
        shutil.copytree(root, out / 'fixtures', dirs_exist_ok=True)
print('PASS: hidden native sidebar LRCLIB/publication/model protocols; no neural quality claim')
