"""One real historical singing recording: production LRCLIB Apply -> native Precise -> Save/reopen.

Uses an already successful, exclusively leased private model cache. It neither
copies gigabytes of models nor downloads them again, invents a prior failure,
starts fixture servers, or prints the fetched lyrics. No model/quality claim is
made beyond this actual full-mix recording and executed workflow.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time
import wave

QUERY = 'Frank C. Stanley Auld Lang Syne'
CANDIDATE = 12618083
SOURCE_URL = 'https://commons.wikimedia.org/wiki/File:Auld_Lang_Syne.ogg'
AUDIO_URL = 'https://upload.wikimedia.org/wikipedia/commons/e/e3/Auld_Lang_Syne.ogg'
SOURCE_SHA1 = '73829e0e2d0037c74309063739c51e3170740e50'
MODEL_SHA256 = '159b5fdb82ef20762849671e3188a890a5ebe82ccf89157cfd92d060975acb80'


def process_table() -> dict:
    reply = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,lstart=,comm='],
                           capture_output=True, text=True, timeout=3, check=True, env={**os.environ, 'LC_ALL': 'C'})
    records = {}
    for line in reply.stdout.splitlines():
        fields = line.strip().split(None, 7)
        if len(fields) == 8:
            pid, parent = map(int, fields[:2])
            records[pid] = {'pid': pid, 'parent': parent, 'start': ' '.join(fields[2:7]), 'command': fields[7]}
    return records


def same_process(left: dict, right: dict | None) -> bool:
    return right is not None and left['pid'] == right['pid'] and ' '.join(left['start'].split()) == right['start'] and left['command'] == right['command']


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--source-project', type=Path, default=Path('/tmp/singz-gpui-live-lyrics-20261109/source-project'))
    parser.add_argument('--prior-evidence', type=Path, default=Path('/tmp/singz-gpui-precise-real-20261108'))
    parser.add_argument('--pack', type=Path, default=Path.home() / 'Library/Application Support/SingZ/gpu-splitter')
    parser.add_argument('--timeout', type=int, default=1200)
    parser.add_argument('--pitch-label-review', action='store_true', help='Capture bar/frame pitch labels at both desktop sizes after the real workflow')
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This actual native-engine/cache qualification is macOS-only')
    if not 60 <= args.timeout <= 1200:
        parser.error('--timeout must be between 60 and 1200 seconds')
    import fcntl
    spec = importlib.util.spec_from_file_location('real_lyrics_inputs', Path(__file__).with_name('test_native_lyrics_real.py'))
    inputs = importlib.util.module_from_spec(spec); spec.loader.exec_module(inputs)
    sha, ordinary = inputs.sha, inputs.ordinary
    app, prior = args.app.resolve(strict=True), args.prior_evidence.resolve(strict=True)
    ordinary(app); ordinary(prior, True)
    out = args.out.absolute(); out.mkdir(parents=True, exist_ok=True); ordinary(out, True); out = out.resolve()
    assert out != prior, 'New workflow output must not replace prior successful proof'
    output_lease = (out / 'driver.lock').open('a+b'); fcntl.flock(output_lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    # Cooperates with the original real driver: the successful cache must not be
    # in use by a retry/another test while this process borrows it for inference.
    cache_lease = (prior / 'driver.lock').open('a+b'); fcntl.flock(cache_lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    proof_paths = {'downloadReceipt': prior / 'real-model-download.json', 'successfulResult': prior / 'result.json', 'terminalReceipt': prior / 'process-exit.json'}
    proofs = {}
    for name, path in proof_paths.items():
        ordinary(path); assert path.stat().st_size <= 1024 * 1024, 'Unreasonable prior proof size'
        proofs[name] = json.loads(path.read_text())
    terminal, old_result, download = proofs['terminalReceipt'], proofs['successfulResult'], proofs['downloadReceipt']
    assert terminal.get('terminal') is True and terminal.get('returncode') == 0 and terminal.get('pid', 0) > 0, 'Prior process did not finish successfully'
    assert all(old_result.get(key) is True for key in ('realInference', 'precisePreview', 'explicitSave', 'reopenedEditor', 'reopenedPlayer', 'nativePlayback')), 'Prior real workflow was not successful'
    assert old_result.get('fixtureInference') is False, 'Fixture results cannot authorize this cache'
    assert download.get('downloadThisRun') is True and download.get('resumedModel') is False, 'Prior proof is not an actual first download'
    models = (prior / 'work/models').resolve(strict=True); ordinary(models, True)
    model = models / 'mms-fa.onnx'
    inputs.verify_download(download, model)
    assert download['modelSha256'] == MODEL_SHA256 and old_result['modelSha256'] == MODEL_SHA256, 'Unexpected verified model'
    assert Path(old_result['modelFile']).resolve() == model.resolve() and old_result['modelBytes'] == model.stat().st_size
    retired_path = prior / 'observed-processes.json'; ordinary(retired_path)
    retired = json.loads(retired_path.read_text()); assert isinstance(retired, list) and retired, 'Prior owned process retirement evidence missing'
    current = process_table()
    assert all(not same_process(owner, current.get(owner['pid'])) for owner in retired), 'A prior model-cache owner is still live'
    prior_pins = {name: {'path': str(path), 'sha256': sha(path)} for name, path in proof_paths.items()}
    work = out / 'work'; work.mkdir(mode=0o700)  # exclusive: use a fresh OUT after a failed live attempt
    project = work / 'project'
    source = args.source_project.resolve(strict=True)
    source_records = inputs.copy_project(source, project)
    original_metadata = json.loads((project / 'project.json').read_text())
    attribution = original_metadata['sourceAttribution']
    assert attribution['sourcePage'] == SOURCE_URL and attribution['audioUrl'] == AUDIO_URL and attribution['sha1'] == SOURCE_SHA1
    encoded = project / original_metadata['songFile']
    assert encoded.parent == project and encoded.stat().st_size == 1943425
    assert hashlib.sha1(encoded.read_bytes()).hexdigest() == SOURCE_SHA1, 'Historical source bytes differ from pinned Commons recording'
    with wave.open(str(project / 'stems/vocals.wav'), 'rb') as stream:
        duration = stream.getnframes() / stream.getframerate()
        assert stream.getframerate() == 44100 and stream.getnchannels() == 2 and abs(duration - 141.54569160997733) < 1e-6
    baseline = json.loads((project / 'lyrics.json').read_text())
    assert baseline['source'] == 'edited' and baseline['lines'], 'Explicit manual baseline must prevent automatic lookup before Search'
    prefs, library, scratch, cache = (work / name for name in ('prefs', 'library', 'tmp', 'cache'))
    for directory in (prefs, library, scratch, cache): directory.mkdir(mode=0o700)
    pack = args.pack.resolve(strict=True); ordinary(pack, True)
    pack_descriptor = pack / 'python/pack.json'; ordinary(pack_descriptor)
    assert json.loads(pack_descriptor.read_text())['target'] == 'darwin-x64', 'Expected existing Intel/ONNX pack'
    helper = app.with_name('singz-gpui-audio'); ordinary(helper)
    engines = Path('/Applications/SingZ.app/Contents/Resources/engines')
    engine_pins = {}
    for name in ('llama-server', 'crispasr'):
        path = engines / name; ordinary(path); assert os.access(path, os.X_OK)
        engine_pins[name] = {'path': str(path), 'sha256': sha(path)}
    repo = Path(__file__).resolve().parents[3]
    code_paths = [Path(__file__).resolve(), repo / 'experiments/gpui-player/src/ui_lyrics_sidebar.rs', repo / 'experiments/gpui-player/src/ui_lyrics_align.rs', repo / 'experiments/gpui-player/src/main.rs']
    selection = {'app': str(app), 'appSha256': sha(app), 'helperSha256': sha(helper), 'nativeEngines': engine_pins,
                 'priorModelEvidence': prior_pins, 'modelPath': str(model), 'modelSha256': MODEL_SHA256,
                 'sourceFiles': source_records, 'sourceAttribution': attribution, 'audioSeconds': duration,
                 'pack': str(pack), 'packDescriptorSha256': sha(pack_descriptor),
                 'sourceIdentity': {str(path.relative_to(repo)): sha(path) for path in code_paths},
                 'scope': 'Historical full mix decoded as vocal input; not stem-isolation or general singing-quality proof'}
    (out / 'inputs.json').write_text(json.dumps(selection, indent=2) + '\n')
    env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_GPUI_') and key not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'SINGZ_GPU_PACK_URL')}
    if args.pitch_label_review:
        env['SINGZ_GPUI_PITCH_LABEL_TEST'] = '1'
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1', SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_LYRICS_SIDEBAR_TEST=str(out), SINGZ_GPUI_LYRICS_LIVE_TEST=str(out),
               SINGZ_GPUI_LYRICS_LIVE_QUERY=QUERY, SINGZ_GPUI_LYRICS_LIVE_CANDIDATE_ID=str(CANDIDATE),
               SINGZ_GPUI_LYRICS_REAL_UI='1', SINGZ_GPUI_LYRICS_REAL_PROJECT=str(project), SINGZ_GPUI_LYRICS_REAL_PREINSTALLED='1',
               SINGZ_GPUI_LYRICS_REAL_PRIOR_DOWNLOAD_RECEIPT=str(proof_paths['downloadReceipt']),
               SINGZ_GPUI_LYRICS_REAL_PRIOR_RESULT=str(proof_paths['successfulResult']), SINGZ_GPUI_LYRICS_REAL_PRIOR_EXIT=str(proof_paths['terminalReceipt']),
               SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library), SINGZ_MODELS_DIR=str(models), SINGZ_PACK_DIR=str(pack),
               SINGZ_LLAMA_SERVER=str(engines / 'llama-server'), SINGZ_CRISPASR=str(engines / 'crispasr'),
               PYTHONDONTWRITEBYTECODE='1', TORCH_HOME=str(models / 'torch-home'), HF_HOME=str(cache / 'huggingface'),
               HF_HUB_CACHE=str(cache / 'huggingface/hub'), HUGGINGFACE_HUB_CACHE=str(cache / 'huggingface/hub'),
               TRANSFORMERS_CACHE=str(cache / 'transformers'), HF_HUB_OFFLINE='1', HF_DATASETS_OFFLINE='1', XDG_CACHE_HOME=str(cache), TMPDIR=str(scratch))
    assert 'SINGZ_GPUI_LYRICS_ALIGN_TEST' not in env and 'SINGZ_GPUI_LYRICS_REAL_RESUME' not in env, 'Live sidebar must own the only handoff'
    before, observations, owners = inputs.foreground(), [], {}
    stop = threading.Event(); started = time.monotonic(); observation_errors = []
    log_path = out / 'live-lyrics.log'
    with log_path.open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        def observe():
            while not stop.is_set():
                try:
                    table = process_table()
                    active = {child.pid} | {owner['pid'] for owner in owners.values() if same_process(owner, table.get(owner['pid']))}
                    changed = True
                    while changed:
                        changed = False
                        for row in table.values():
                            if row['pid'] in active or row['parent'] in active:
                                if row['pid'] not in active: active.add(row['pid']); changed = True
                                owners[(row['pid'], row['start'], row['command'])] = row
                    observations.append({'elapsedSeconds': time.monotonic() - started, **inputs.foreground()})
                except (OSError, subprocess.SubprocessError, ValueError) as error:
                    observation_errors.append(str(error))
                if stop.wait(1): break
        monitor = threading.Thread(target=observe, daemon=True); monitor.start()
        try:
            deadline = started + args.timeout
            while child.poll() is None:
                if time.monotonic() >= deadline: raise TimeoutError('Live LRCLIB/Precise UI exceeded bounded same-process deadline; retained OUT/work')
                time.sleep(.25)
        finally:
            forced_stop = child.poll() is None
            if forced_stop:
                child.terminate()
                try: child.wait(timeout=8)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
            stop.set(); monitor.join(timeout=6)
            if forced_stop:
                # Abort only observed descendants whose start+command identity
                # still matches. Never target the earlier cache-owner PIDs.
                for sig, delay in ((signal.SIGTERM, 2), (signal.SIGKILL, 0)):
                    table = process_table()
                    for owner in list(owners.values()):
                        if owner['pid'] != child.pid and same_process(owner, table.get(owner['pid'])):
                            try: os.kill(owner['pid'], sig)
                            except ProcessLookupError: pass
                    if delay: time.sleep(delay)
            after = inputs.foreground(); fronts = [before, *observations, after]
            available = all(item.get('available') is True for item in fronts)
            stable = available and all(item['identity'] == before['identity'] for item in fronts)
            verdict = 'stable-observed-foreground' if stable else 'observation-unavailable' if not available else 'external-interruption; focus-steal verdict unqualified'
            (out / 'foreground.json').write_text(json.dumps({'before': before, 'after': after, 'samples': observations, 'allAvailable': available, 'unchanged': stable, 'verdict': verdict}, indent=2))
            (out / 'observed-processes.json').write_text(json.dumps(list(owners.values()), indent=2))
            (out / 'process-exit.json').write_text(json.dumps({'pid': child.pid, 'terminal': True, 'returncode': child.returncode, 'wallSeconds': time.monotonic() - started, 'observationErrors': observation_errors}, indent=2))
    assert child.returncode == 0 and not (out / 'failure.txt').exists() and not (out / 'precise/failure.txt').exists(), 'Actual UI failed; inspect retained live-lyrics.log/work'
    deadline = time.monotonic() + 10
    while True:
        table = process_table(); remaining = [owner for owner in owners.values() if same_process(owner, table.get(owner['pid']))]
        if not remaining or time.monotonic() >= deadline: break
        time.sleep(.25)
    assert owners and not remaining and not observation_errors, 'Owned process retirement is not fully verified'
    live = json.loads((out / 'live-lyrics-search.json').read_text())
    assert live['productionEndpoint'] == 'https://lrclib.net/api' and live['query'] == QUERY and live['candidateId'] == CANDIDATE
    candidate = live['candidate']
    assert candidate['id'] == CANDIDATE and candidate['track'] == 'Auld Lang Syne' and candidate['artist'] == 'Frank C. Stanley'
    assert candidate['synced'] is True and candidate['duration'] == 140
    for key in ('candidateApplied', 'immediatePublication', 'historicalFullMixNotIsolatedStem', 'hidden', 'muted'): assert live[key] is True
    assert live['headerSaveUsed'] is False and live['lyricSource'] == 'lrclib' and live['recordingSourceUrl'] == SOURCE_URL
    assert Path(live['project']).resolve() == project.resolve() and live['lyricsSnapshot'] == 'live-lyrics-selected.json'
    snapshot = out / live['lyricsSnapshot']; ordinary(snapshot)
    assert snapshot.stat().st_size == live['lyricsBytes'] and sha(snapshot) == live['lyricsSha256'], 'Actual Apply publication snapshot identity changed'
    applied = json.loads(snapshot.read_text()); assert applied['source'] == 'lrclib' and applied['credit'] == live['credit']
    assert live['credit'] == 'Frank C. Stanley — Auld Lang Syne' and len(applied['lines']) == live['lineCount'] > 0
    result = json.loads((out / 'precise/result.json').read_text())
    for key in ('realInference', 'precisePreview', 'finiteWordTimings', 'previewDoesNotWrite', 'explicitSave', 'reopenedEditor', 'reopenedPlayer', 'nativePlayback', 'modelCacheUsed', 'hidden', 'muted'): assert result[key] is True
    for key in ('fixtureInference', 'downloadThisRun', 'resumedModel', 'preciseConsentThisRun'): assert result[key] is False
    assert Path(result['project']).resolve() == project.resolve()
    prior_evidence = result['priorModelEvidence']
    for name, pin in prior_pins.items():
        assert Path(prior_evidence[name]['path']).resolve() == Path(pin['path']).resolve() and prior_evidence[name]['sha256'] == pin['sha256'] == sha(proof_paths[name])
    assert prior_evidence['modelSha256'] == MODEL_SHA256 and Path(prior_evidence['modelPath']).resolve() == model.resolve()
    inputs.verify_download(download, model)
    final = json.loads((project / 'lyrics.json').read_text())
    assert final['source'] == 'edited' and final['credit'] == live['credit'], 'Explicit editor Save did not preserve live source credit'
    words = [word for line in final['lines'] for word in line.get('words', [])]
    assert words and len(words) == result['wordCount']; previous_start = -1.
    for word in words:
        start, end = word['s'], word['e']
        assert all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in (start, end))
        assert 0 <= start <= end <= duration + 2 and start >= previous_start
        previous_start = start
    for record in source_records: assert sha(Path(record['source'])) == record['sha256'], 'Original historical source/draft changed'
    assert json.loads((project / 'project.json').read_text())['sourceAttribution'] == attribution
    assert sha(pack_descriptor) == selection['packDescriptorSha256']
    (out / 'evidence.json').write_text(json.dumps({'selection': selection, 'liveApply': live, 'precise': result,
        'savedLyricsSha256': sha(project / 'lyrics.json'), 'savedProjectSha256': sha(project / 'project.json'), 'finiteWordCount': len(words),
        'ownedProcessesRetired': True, 'foregroundVerdict': verdict, 'liveFps': 'unmeasured',
        'scope': 'Actual public LRCLIB selected candidate, immediate native publication, fresh native CTC preview/Save/reopen/playback on historical full mix; no isolation/general alignment-quality claim'}, indent=2) + '\n')
    print('PASS: actual LRCLIB Apply and new real Precise Save/reopen workflow; evidence at ' + str(out))


if __name__ == '__main__':
    main()
