"""Q-04 connected native races, numeric stamps, source rates and lyrics safety.

Build with cargo build --profile qualify --features ui-tests --offline --locked.
Usage: python3 tests/test_native_analysis_lyrics_races.py target/qualify/singz-gpui-player OUT
Optional --case selects one regression for a mutation run. Runtime protocol
fixtures replace neural inference only; decoding, HTTP, publication and UI are real.
The checked-in sample must have been copied to mobile/assets/sample by setup.
"""
import argparse
import hashlib
import http.server
import json
import math
import os
from pathlib import Path
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time

CASES = ['pitch-switch', 'lookup-switch', 'candidate-switch', 'rate-44100', 'rate-48000', 'beat-rate-44100', 'beat-rate-48000',
         'stamp-old', 'stamp-string', 'stamp-float', 'stamp-future', 'tolerant',
         'edited-backup', 'unreadable-backup', 'lyrics-cancel', 'align', 'precise-align', 'editor-align-draft']
STEP_SECONDS = 35
CASE_SECONDS = 185
TOTAL_SECONDS = 900
TEXT = 'The song is with you And this is all your lovely song today'
REPO = Path(__file__).resolve().parents[3]


def kill_tree(child):
    """Retire the owned session even when its parent has already exited."""
    if os.name == 'nt':
        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    else:
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    if child.poll() is None:
        child.wait(timeout=5)


class OwnedTree:
    """Track descendants that create their own process groups (curl/runtimes)."""
    def __init__(self, child):
        self.child = child
        self.owned = {}
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.sample, daemon=True)
        self.thread.start()

    def sample(self):
        if os.name == 'nt':
            return  # taskkill /T owns the Windows process-tree boundary.
        while not self.stop.is_set():
            try:
                output = subprocess.run(['ps', '-axo', 'pid=,ppid=,lstart='],
                    capture_output=True, text=True, timeout=2, check=True).stdout
                rows = {}
                for line in output.splitlines():
                    parts = line.split(None, 2)
                    if len(parts) == 3:
                        rows[int(parts[0])] = (int(parts[1]), parts[2].strip())
                parents = {self.child.pid} | set(self.owned)
                while True:
                    added = {pid: birth for pid, (parent, birth) in rows.items()
                             if parent in parents and pid not in parents}
                    if not added:
                        break
                    self.owned.update(added)
                    parents.update(added)
            except (OSError, subprocess.SubprocessError):
                pass
            self.stop.wait(.05)

    def close(self):
        self.stop.set()
        self.thread.join(timeout=3)
        kill_tree(self.child)
        for pid, birth in self.owned.items():
            live = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='],
                                  capture_output=True, text=True, timeout=2)
            if live.returncode == 0 and live.stdout.strip() == birth:
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass


class Budget:
    def __init__(self):
        self.started = time.monotonic()
        self.deadline = self.started + TOTAL_SECONDS
        self.lock = threading.Lock()
        self.children = {}
        self.timer = threading.Timer(TOTAL_SECONDS, self.expire)
        self.timer.daemon = True
        self.timer.start()

    def own(self, child, tree=None):
        with self.lock:
            self.children[child.pid] = (child, tree)

    def release(self, child):
        with self.lock:
            self.children.pop(child.pid, None)

    def expire(self):
        with self.lock:
            children = list(self.children.values())
        for child, tree in children:
            try:
                tree.close() if tree is not None else kill_tree(child)
            except (OSError, subprocess.SubprocessError):
                pass
        os.write(2, b'Q-04 total deadline expired; owned children killed\n')
        os._exit(124)

    def seconds(self, limit):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Q-04 total deadline expired')
        return min(limit, remaining)

    def run(self, argv, env=None, limit=STEP_SECONDS, input=None):
        child = subprocess.Popen([str(a) for a in argv], env=env, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL, start_new_session=os.name != 'nt')
        self.own(child)
        try:
            stdout, stderr = child.communicate(input=input, timeout=self.seconds(limit))
            if child.returncode:
                raise AssertionError(f'{argv[0]} exited {child.returncode}: {stderr.decode(errors="replace")}')
            return stdout
        finally:
            kill_tree(child)
            self.release(child)


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False))


def executable(path, source):
    path.write_text(f'#!{sys.executable}\n' + source)
    path.chmod(0o700)


def encoded(melody):
    # Independent implementation of the documented shared f0 RLE format.
    result, gap = [], 0
    for hz in melody['f0'] + [None]:
        if hz == 0:
            gap += 1
            continue
        if gap:
            result.append('x' if gap == 1 else f'x{gap}')
            gap = 0
        if hz is not None:
            result.append(str(max(0, math.floor(1200 * math.log2(hz / 55) + .5))))
    return dict(detVersion=melody['detVersion'], hopSec=round(melody['hopSec'], 7), f0=' '.join(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--case', choices=CASES, action='append')
    parser.add_argument('--tools', type=Path, help='Local matching native helpers (defaults to app directory)')
    args = parser.parse_args()
    app, out = args.app.resolve(), args.out.resolve()
    tools = (args.tools or app.parent).resolve()
    assert 'qualify' in app.parts, 'Q-04 requires a qualify ui-tests build'
    out.mkdir(parents=True, exist_ok=True)
    (out / 'result.json').unlink(missing_ok=True)
    budget = Budget()
    env_base = {k: v for k, v in os.environ.items() if not k.startswith('SINGZ_')}
    env_base.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_GPUI_BACKGROUND='1',
                    SINGZ_GPUI_TEST_NO_CAPTURE='1', SINGZ_GPUI_AUDIO_HELPER=str(tools / 'singz-gpui-audio'),
                    SINGZ_GPUI_INPUT_HELPER=str(tools / 'singz-gpui-input'))
    analyzer = tools / 'singz-analyze'
    sample = REPO / 'mobile/assets/sample'
    assert (sample / 'stems/vocals.flac').is_file(), 'Copy main checkout mobile/assets/sample into this worktree first'
    source_hash = budget.run([REPO / 'scripts/analyze-source-hash.sh', REPO]).decode().strip()
    info = json.loads(budget.run([analyzer, 'build-info'], env_base))
    assert info['sourceHash'] == source_hash, 'Analyzer fingerprint differs from checkout'
    revision = budget.run(['git', '-C', REPO, 'rev-parse', 'HEAD']).decode().strip()
    results = []
    with tempfile.TemporaryDirectory(prefix='singz-q04-') as temp:
        root = Path(temp).resolve()
        # Prepare source-rate oracles using the *real* analyzer and separate
        # 44.1/48k files from the same complete bundled sample.
        rates, oracles, drums, bass, beat_oracles, key_oracles = {}, {}, {}, {}, {}, {}
        for rate in [44100, 48000]:
            wav = root / f'vocals-{rate}.wav'
            budget.run(['ffmpeg', '-v', 'error', '-i', sample / 'stems/vocals.flac',
                        '-ar', str(rate), '-ac', '1', wav])
            detected = json.loads(budget.run([analyzer, 'analyze', '--melody', '--vocals', wav], env_base))['melody']
            want_hop = math.floor(rate / 3 * .025 + .5) / (rate / 3)
            assert abs(detected['hopSec'] - want_hop) < 1e-7, detected
            assert abs(len(detected['f0']) * detected['hopSec'] - 40.8) < .1, detected.keys()
            assert any(hz > 0 for hz in detected['f0']), 'Nondiscriminating silent sample'
            rates[rate], oracles[rate] = wav, encoded(detected)
            for stem, target in [('drums',drums),('bass',bass)]:
                target[rate] = root / f'{stem}-{rate}.wav'
                budget.run(['ffmpeg','-v','error','-i',sample / f'stems/{stem}.flac',
                            '-ar',str(rate),'-ac','1',target[rate]])
            key_oracles[rate] = json.loads(budget.run([analyzer,'key','--bass',bass[rate]],env_base))
            assert key_oracles[rate]['key'] is not None, 'Sample must discriminate key upgrades'
            import struct
            f32 = lambda value: struct.unpack('f',struct.pack('f',value))[0]
            word_times = [v for start,words in [(1,'Keep these words'),(5,'And sing them again')]
                          for i,_ in enumerate(words.split()) for v in [f32(start+i*.8),f32(start+.6+i*.8)]]
            aux = ('lineStarts 2 1 5\nwords 14 ' + ' '.join(map(str,word_times))+'\n').encode()
            ndjson = budget.run([analyzer,'analyze','--beats','--vocals',wav,'--drums',drums[rate],
                                '--bass',bass[rate],'--ml-stdin'],env_base,input=aux)
            beat_oracles[rate] = next(json.loads(line)['beats'] for line in ndjson.splitlines()
                                      if 'beats' in json.loads(line))
            assert beat_oracles[rate]['ok'] and len(beat_oracles[rate]['beatsSec'])>8, 'Sample must discriminate beat framing'
        assert abs(beat_oracles[44100]['bpm']/beat_oracles[48000]['bpm']-1)<.05, 'Sample octave changes across source rates'
        # Pitch decimation uses an integer hop: 368/14700 versus 400/16000.
        # This explicit precondition prevents a device-clock implementation
        # from passing a vacuous same-hop fixture.
        assert oracles[44100]['hopSec'] != oracles[48000]['hopSec']
        shared = '''import json, os, sys, time
from pathlib import Path
root = Path(os.environ['SINGZ_GPUI_Q04_FIXTURES'])
def record(kind, **extra):
    with (root / 'children.jsonl').open('a') as log:
        log.write(json.dumps(dict(pid=os.getpid(),kind=kind,**extra))+'\\n')
def barrier(name):
    hold=root/(name+'.hold')
    if hold.exists():
        (root/(name+'.ready')).write_text('entered')
        end=time.monotonic()+30
        while hold.exists():
            if time.monotonic()>end: raise SystemExit('Q-04 fixture barrier deadline')
            time.sleep(.01)
'''
        for case in args.case or CASES:
            case_started = time.monotonic()
            folder = root / case
            folder.mkdir()
            receipt = out / case
            receipt.mkdir(exist_ok=True)
            (folder/'prefs').mkdir()
            write_json(folder/'prefs/release-highlights.json',dict(releaseNotesSeen=json.loads((REPO/'package.json').read_text())['version']))
            if case in ['lyrics-cancel','align','precise-align','editor-align-draft']:
                (folder/'prefs').mkdir(exist_ok=True)
                write_json(folder/'prefs/audio.json',dict(karaoke=True))
            (receipt / 'result.json').unlink(missing_ok=True)
            (receipt / 'failure.txt').unlink(missing_ok=True)
            rate = 44100 if case in ['rate-44100','beat-rate-44100'] else 48000
            current = oracles[rate]['detVersion']
            # Native headers are the stamp authority; key/beat values are read
            # from those same headers, not copied from TypeScript or magic IDs.
            import re
            header_root = REPO / 'zcore/include/zcore/legacy'
            def version(name):
                matches = []
                for header in header_root.rglob('*.h'):
                    match = re.search(r'\b' + name + r'\s*=\s*(\d+)', header.read_text(errors='replace'))
                    if match:
                        matches.append(int(match[1]))
                assert len(matches) == 1, (name, matches)
                return matches[0]
            key_version, beat_version = version('kKeyDetectVersion'), version('kBeatDetectVersion')
            key = dict(pc=8, minor=True, detVersion=float(key_version) + (.5 if case == 'stamp-future' else 0))
            beat_stamp = float(beat_version) + (.5 if case == 'stamp-future' else 0)
            beat = dict(beats=[i * .5 for i in range(24)], bpm=120, beatsPerBar=4,
                        downbeat=0, source='auto', detVersion=beat_stamp)
            lines = [dict(start=1, end=4, text='Keep these words', words=[
                dict(w=w, s=1+i*.8, e=1.6+i*.8) for i,w in enumerate('Keep these words'.split())]),
                dict(start=5, end=9, text='And sing them again', words=[
                dict(w=w, s=5+i*.8, e=5.6+i*.8) for i,w in enumerate('And sing them again'.split())])]
            if case in ['lyrics-cancel','align','precise-align','editor-align-draft']:
                lines=[dict(start=1,end=3.5,text='The song is with you',words=[dict(w=w,s=1+i*.5,e=1.4+i*.5) for i,w in enumerate('The song is with you'.split())]),
                       dict(start=5,end=9,text='And this is all your lovely song today',words=[dict(w=w,s=5+i*.5,e=5.4+i*.5) for i,w in enumerate('And this is all your lovely song today'.split())])]
            for name in ['a', 'b']:
                project = folder / name
                (project / 'stems').mkdir(parents=True)
                shutil.copyfile(rates[rate], project / 'stems/vocals.wav')
                if case in ['stamp-old','stamp-string','stamp-float','stamp-future','beat-rate-44100','beat-rate-48000']:
                    shutil.copyfile(drums[rate],project/'stems/drums.wav')
                    shutil.copyfile(bass[rate],project/'stems/bass.wav')
                melody = dict(detVersion=float(current), hopSec=.025, f0='x1632')
                if name == 'a':
                    if case in ['pitch-switch', 'rate-44100', 'rate-48000', 'stamp-old']:
                        melody['detVersion'] = current - 1
                    elif case == 'stamp-string':
                        melody['detVersion'] = str(current)
                    elif case == 'stamp-future':
                        melody['detVersion'] = current + .5
                project_key, project_beat = dict(key), dict(beat)
                if name=='a' and case in ['stamp-old','stamp-string','beat-rate-44100','beat-rate-48000']:
                    project_key['detVersion'] = str(key_version) if case=='stamp-string' else key_version-1
                    project_beat['detVersion'] = str(beat_version) if case=='stamp-string' else beat_version-1
                write_json(project / 'project.json', dict(version=2, name=f'Fixture artist - {case} {name}',
                    foreignProject={'keep': True}, settings={'melody': melody, 'key': project_key, 'beat': project_beat}))
                lyric = dict(source='lrclib', credit='A credit' if name=='a' else 'B credit',
                             foreignLyrics={'keep': True}, lines=lines if name=='a' else [dict(start=1, end=4, text='B stays here', words=[])])
                if name=='a':
                    if case=='lookup-switch':
                        lyric.update(source='whisper', lrclibPending=True, lookup=0)
                    if case in ['tolerant', 'edited-backup']:
                        lyric['source']='edited'
                    if case=='tolerant':
                        lyric['lines']=[dict(start=1,end=4,text='Keep these words',words=[dict(w='Keep',s=2,e=1),dict(w='these words',s=1,e=1)]),
                                        dict(start=-1,end=2,text='bad row',words=[])]
                if name=='a' and case=='unreadable-backup':
                    (project/'lyrics.json').write_bytes(b'{ unreadable lyrics\n')
                else:
                    write_json(project/'lyrics.json',lyric)
                stat=(project/'stems/vocals.wav').stat()
                write_json(project/'heard-words.json',dict(version=1,engine='qwen3-asr-1.7b',language='English',
                    vocals=dict(size=stat.st_size,mtimeMs=stat.st_mtime_ns/1e6),
                    chunks=[dict(start=0,end=40.8,text=TEXT.replace('you And','you together And') if case=='editor-align-draft' else TEXT,label='English')]))
            if case in ['lyrics-cancel','align','precise-align','editor-align-draft']:
                (folder/'a/heard-words.json').unlink()
            if case in ['edited-backup', 'unreadable-backup']:
                (folder/'a/lyrics.json.bak').write_bytes(b'existing backup')
            expected = dict(melody=oracles[rate] if case in ['rate-44100','rate-48000','stamp-old','stamp-string']
                else json.loads((folder/'a/project.json').read_text())['settings']['melody'],key=key,beatVersion=beat_stamp,beatTimes=beat['beats'],bpm=beat['bpm'])
            if case in ['stamp-old','stamp-string','beat-rate-44100','beat-rate-48000']:
                expected['key'] = dict(key_oracles[rate]['key'],detVersion=key_version)
                expected['beatVersion'] = beat_version
                expected['beatTimes'] = beat_oracles[rate]['beatsSec']
                intervals=sorted(b-a for a,b in zip(expected['beatTimes'],expected['beatTimes'][1:]))
                expected['bpm'] = 60 / intervals[len(intervals)//2]
            expected['frameCount'] = sum(int(t[1:] or 1) if t.startswith('x') else 1 for t in expected['melody']['f0'].split())
            write_json(folder/'expected.json',expected)
            # Analyzer wrapper changes timing only, then execs the matching
            # native binary. It never manufactures pitch frames.
            wrapped = folder/'analyzer'
            executable(wrapped, shared + f'''
args=sys.argv[1:]
if args and (args[0]=='key' or '--beats' in args):
    record('detector',args=args)
if '--melody' in args:
    record('pitch',args=args)
    barrier('pitch')
os.execv({str(analyzer)!r},[{str(analyzer)!r}]+args)
''')
            models = folder/'models'
            models.mkdir()
            for name in ['Qwen3-ASR-1.7B-Q8_0.gguf','mmproj-Qwen3-ASR-1.7B-Q8_0.gguf','qwen3-forced-aligner-0.6b-q8_0.gguf']:
                with (models/name).open('wb') as model:
                    model.write(b'GGUF')
                    model.truncate(1024*1024)
            crisp = folder/'crispasr'
            executable(crisp, shared + '''
args=sys.argv[1:]
if '--align-output' not in args or '--ref-text' not in args: raise SystemExit('Unexpected align protocol')
text=args[args.index('--ref-text')+1]
record('align',text=text)
barrier('align')
import wave
with wave.open(args[args.index('-f')+1]) as audio:
    duration=audio.getnframes()/audio.getframerate()
words=text.split()
step=duration/(len(words)+1)
Path(args[args.index('--align-output')+1]).write_text(json.dumps([
    dict(start=(i+.25)*step,end=(i+1)*step) for i,_ in enumerate(words)]))
''')
            pack = folder/'pack'
            (pack/'python/bin').mkdir(parents=True)
            write_json(pack/'python/pack.json',dict(formatVersion=10,target='darwin-x64' if platform.machine().lower() in ['x86_64','amd64'] else 'darwin-arm64',fixtureOnly=True))
            precise = pack/'python/bin/python3'
            executable(precise, shared + '''
args=sys.argv[1:]
if len(args)<3 or Path(args[2]).name!='tokens.json':
    print('isolated fixture Python protocol',flush=True)
    raise SystemExit(0)
tokens=json.loads(Path(args[2]).read_text())
record('precise',tokens=tokens)
print('P 100',file=sys.stderr,flush=True)
print(json.dumps({'words':[dict(i=t['i'],s=.9+i*.75,e=1.4+i*.75,score=1.,v=1.) for i,t in enumerate(tokens)]}),flush=True)
''')
            for part,magic in [('torch-home/hub/checkpoints/model.pt',b'PK\x03\x04'),('mms-fa.onnx',b'ONNX')]:
                model=models/part
                model.parent.mkdir(parents=True,exist_ok=True)
                with model.open('wb') as stream:
                    stream.write(magic)
                    stream.truncate(1024*1024)
            # Recognition speaks the production HTTP protocol on real decoded
            # sample chunks. Its text is deterministic, not a quality oracle.
            llama = folder/'llama-server'
            transcript=TEXT.replace('you And','you together And') if case=='editor-align-draft' else TEXT
            executable(llama, shared + '''
import http.server
args=sys.argv[1:]
port=int(args[args.index('--port')+1])
record('server')
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        data=b'{"status":"ok"}'
        self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('Content-Length','0')))
        record('asr-request',inputAudio=b'input_audio' in body)
        data=json.dumps({'choices':[{'message':{'content':'language English<asr_text>TRANSCRIPT'},'finish_reason':'stop'}]}).encode()
        self.send_response(200);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
http.server.HTTPServer(('127.0.0.1',port),Handler).serve_forever()
'''.replace('TRANSCRIPT',transcript))
            stop = threading.Event()
            requests = []
            class Handler(http.server.BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass
                def do_GET(self):
                    requests.append(self.path)
                    with (folder/'http.jsonl').open('a') as log:
                        log.write(json.dumps(self.path)+'\n')
                    if (folder/'http.hold').exists():
                        (folder/'http.ready').write_text(self.path)
                        end=time.monotonic()+30
                        while (folder/'http.hold').exists() and not stop.wait(.01):
                            if time.monotonic()>=end:
                                return
                    record=dict(id=101,trackName='Selected recording',artistName='Fixture artist',duration=40.8,
                                syncedLyrics='[00:01.00] Keep these words\n[00:05.00] And sing them again')
                    body=json.dumps([record] if self.path.startswith('/search') else record).encode()
                    try:
                        self.send_response(200)
                        self.send_header('Content-Length',str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                    except (BrokenPipeError,ConnectionResetError):
                        pass
            server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
            server.daemon_threads=True
            thread=threading.Thread(target=server.serve_forever,daemon=True)
            thread.start()
            env=dict(env_base,SINGZ_GPUI_Q04_TEST=str(receipt),SINGZ_GPUI_Q04_FIXTURES=str(folder),
                     SINGZ_GPUI_Q04_CASE=case,SINGZ_GPUI_CONFIG_DIR=str(folder/'prefs'),
                     SINGZ_GPUI_PROJECTS_ROOT=str(folder/'library'),SINGZ_MODELS_DIR=str(models),
                     SINGZ_PACK_DIR=str(pack),SINGZ_GPUI_ANALYZER=str(wrapped),
                     SINGZ_CRISPASR=str(crisp),SINGZ_LLAMA_SERVER=str(llama),
                     SINGZ_GPUI_LRCLIB_URL=f'http://127.0.0.1:{server.server_port}')
            child=None
            owned=None
            try:
                with (receipt/'app.log').open('wb') as log:
                    child=subprocess.Popen([str(app)],env=env,stdout=log,stderr=subprocess.STDOUT,
                                           start_new_session=os.name!='nt')
                    owned=OwnedTree(child)
                    budget.own(child,owned)
                    child.wait(timeout=budget.seconds(CASE_SECONDS))
                assert child.returncode==0 and (receipt/'result.json').is_file(), (receipt/'app.log').read_text()
                result=json.loads((receipt/'result.json').read_text())
                assert result['case']==case and result['hidden'] and result['muted'], result
                if case in ['edited-backup','unreadable-backup','candidate-switch']:
                    assert any(path=='/get/101' for path in requests), 'No candidate protocol call'
                if case=='lookup-switch':
                    assert any(path.startswith(('/get?','/search?')) for path in requests), 'No lookup protocol call'
                if case in ['stamp-float','stamp-future']:
                    assert not (folder/'children.jsonl').exists(), 'Current/newer stamps unnecessarily rederived'
                if case in ['lyrics-cancel','align','precise-align','editor-align-draft']:
                    records=[json.loads(line) for line in (folder/'children.jsonl').read_text().splitlines()]
                    if case=='precise-align':
                        assert any(r['kind']=='precise' for r in records), 'No CTC protocol invocation'
                    else:
                        assert any(r['kind']=='asr-request' and r['inputAudio'] for r in records), 'No real native ASR audio request'
                        assert any(r['kind']=='align' for r in records), 'No word alignment protocol invocation'
                if case=='editor-align-draft':
                    records=[json.loads(line) for line in (folder/'children.jsonl').read_text().splitlines()]
                    assert any(r['kind']=='align' and 'together' in r['text'] for r in records), 'Align runtime received saved lyrics instead of editor draft'
                results.append(dict(case=case,passed=True,seconds=time.monotonic()-case_started))
                print(f'PASS: Q-04 {case}',flush=True)
            finally:
                stop.set()
                if owned is not None:
                    owned.close()
                elif child is not None:
                    kill_tree(child)
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)
                # Native runtime launchers own separate process groups. Their
                # fixture receipt gives exact PIDs; verify identity before any
                # fallback kill, never kill an unrelated recycled PID.
                if (folder/'children.jsonl').exists():
                    shutil.copyfile(folder/'children.jsonl',receipt/'children.jsonl')
                    for record in map(json.loads,(folder/'children.jsonl').read_text().splitlines()):
                        if os.name=='nt':
                            continue
                        cmd=subprocess.run(
                            ['ps','-p',str(record['pid']),'-o','command='],capture_output=True,text=True,timeout=2)
                        if str(folder) in cmd.stdout:
                            try:
                                os.killpg(record['pid'],signal.SIGKILL)
                            except ProcessLookupError:
                                pass
                            raise AssertionError(f'Owned native runtime survived app teardown: {record}')
                if child is not None:
                    budget.release(child)
                # Keep only small persistence evidence, never copied models.
                for name in ['a','b']:
                    destination=receipt/name
                    destination.mkdir(exist_ok=True)
                    for member in (folder/name).glob('*.json*'):
                        if member.is_file():
                            shutil.copyfile(member,destination/member.name)
    write_json(out/'result.json',dict(passed=results,profile='qualify',displayMode='hidden',
        machine=dict(system=platform.system(),architecture=platform.machine()),commit=revision,
        appSha256=hashlib.sha256(app.read_bytes()).hexdigest(),analyzerBuildInfo=info,
        sampleSha256=hashlib.sha256((sample/'stems/vocals.flac').read_bytes()).hexdigest(),
        perStepSeconds=STEP_SECONDS,perCaseSeconds=CASE_SECONDS,totalDeadlineSeconds=TOTAL_SECONDS,
        elapsedSeconds=time.monotonic()-budget.started,inference='deterministic alignment protocol; real native pitch'))
    budget.timer.cancel()


if __name__=='__main__':
    main()
