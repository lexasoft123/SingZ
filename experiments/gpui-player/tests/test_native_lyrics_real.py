"""Real hidden Precise editor/download/Save/reopen workflow, using installed native engines.

No protocol processes or tiny model fixtures are constructed. The caller's OUT/work
is retained after failure. --resume reuses only a model whose first real UI download
receipt and previous terminal failure match; it still executes new real inference.
The speech fixture demonstrates plumbing, not alignment quality on general singing.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import stat
import subprocess
import sys
import threading
import time
import wave

QWEN = ('Qwen3-ASR-1.7B-Q8_0.gguf', 'mmproj-Qwen3-ASR-1.7B-Q8_0.gguf',
        'qwen3-forced-aligner-0.6b-q8_0.gguf')


def sha(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def ordinary(path: Path, directory: bool = False):
    meta = path.lstat()
    if not (stat.S_ISDIR(meta.st_mode) if directory else stat.S_ISREG(meta.st_mode)):
        raise AssertionError(f'Expected ordinary {"directory" if directory else "file"}: {path}')
    return meta


def stamp(meta):
    return (meta.st_dev, meta.st_ino, meta.st_size, meta.st_mtime_ns, meta.st_ctime_ns)


def copy_pinned(source: Path, destination: Path) -> dict:
    before = ordinary(source)
    assert before.st_size > 0, f'Empty real input: {source}'
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    fd = os.open(source, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as reader, destination.open('xb') as writer:
        assert stamp(os.fstat(reader.fileno())) == stamp(before), f'Input changed before copy: {source}'
        for chunk in iter(lambda: reader.read(1024 * 1024), b''):
            writer.write(chunk)
            digest.update(chunk)
        writer.flush()
        os.fsync(writer.fileno())
        assert stamp(os.fstat(reader.fileno())) == stamp(before) == stamp(ordinary(source)), f'Input changed during copy: {source}'
    return {'source': str(source), 'copy': str(destination), 'bytes': before.st_size,
            'sha256': digest.hexdigest(), 'sourceStamp': list(stamp(before))}


def copy_project(source: Path, destination: Path) -> list[dict]:
    ordinary(source, True)
    destination.mkdir(mode=0o700)
    records = []
    for path in sorted(source.rglob('*')):
        meta = path.lstat()
        relative = path.relative_to(source)
        if stat.S_ISDIR(meta.st_mode):
            (destination / relative).mkdir(mode=0o700)
        else:
            ordinary(path)
            records.append(copy_pinned(path, destination / relative))
    return records


def foreground() -> dict:
    try:
        reply = subprocess.run(['/usr/bin/lsappinfo', 'front'], capture_output=True, text=True, timeout=2)
        if reply.returncode or not reply.stdout.strip():
            return {'available': False, 'reason': 'No lsappinfo foreground identity'}
        return {'available': True, 'identity': reply.stdout.strip()}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'available': False, 'reason': str(error)}


def verify_download(receipt: dict, model: Path) -> None:
    ordinary(model)
    assert receipt.get('preciseConsent') is True and receipt.get('modelDownload') is True, 'No actual prior UI model consent/download'
    assert Path(receipt['modelFile']).resolve() == model.resolve(), 'Download receipt names another model'
    assert model.stat().st_size > 1024 * 1024 and receipt['modelBytes'] == model.stat().st_size, 'Downloaded model size changed'
    assert receipt['modelSha256'] == sha(model), 'Downloaded model hash changed'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--source-project', type=Path, default=Path('/tmp/singz-lyrics-real-project'))
    base = Path.home() / 'Library/Application Support/SingZ'
    parser.add_argument('--qwen-models', type=Path, default=base / 'models')
    parser.add_argument('--pack', type=Path, default=base / 'gpu-splitter')
    parser.add_argument('--resume', action='store_true', help='Retry a verified terminal failure with its previously UI-downloaded private model')
    parser.add_argument('--timeout', type=int, default=3900)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This real-engine qualification uses the installed macOS SingZ native engines')
    import fcntl
    if not 60 <= args.timeout <= 3900:
        parser.error('--timeout must be between 60 and 3900 seconds')
    app, out = args.app.resolve(strict=True), args.out.absolute()
    ordinary(app)
    out.mkdir(parents=True, exist_ok=True)
    ordinary(out, True)
    out = out.resolve()
    # One retained workspace must never serve two concurrent UI processes.
    lease = (out / 'driver.lock').open('a+b')
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    work = out / 'work'
    model_receipt_path = out / 'real-model-download.json'
    failure_path, terminal_path = out / 'failure.txt', out / 'process-exit.json'
    if args.resume:
        ordinary(work, True)
        assert failure_path.is_file() and model_receipt_path.is_file(), 'Resume requires the prior actual failure and UI model download receipt'
        terminal = json.loads(terminal_path.read_text())
        assert terminal.get('terminal') is True, 'Previous UI process has not reached verified terminal state'
        assert not (out / 'result.json').exists(), 'Resume cannot adopt an earlier successful result'
    else:
        assert not work.exists() and not model_receipt_path.exists() and not failure_path.exists(), 'Use a fresh OUT or explicit --resume after terminal failure'
        work.mkdir(mode=0o700)
    models, prefs, library, scratch, cache = (work / name for name in ('models', 'prefs', 'library', 'tmp', 'cache'))
    for directory in (models, prefs, library, scratch, cache):
        if directory.exists(): ordinary(directory, True)
        else: directory.mkdir(mode=0o700)
    optional_model = models / 'mms-fa.onnx'
    if args.resume:
        verify_download(json.loads(model_receipt_path.read_text()), optional_model)
    else:
        assert not optional_model.exists(), 'Precise model must be absent before real UI consent/download'
    source_models, pack = args.qwen_models.resolve(strict=True), args.pack.resolve(strict=True)
    ordinary(source_models, True); ordinary(pack, True)
    descriptor = pack / 'python/pack.json'
    ordinary(descriptor)
    assert json.loads(descriptor.read_text()).get('target') == 'darwin-x64', 'This qualification requires the existing Intel/ONNX pack'
    python = pack / 'python/bin/python3'
    assert python.is_file(), 'Installed pack interpreter is unavailable'
    qwen_records = []
    old_inputs_path = work / 'real-inputs.json'
    previous = json.loads(old_inputs_path.read_text()) if args.resume else None
    for name in QWEN:
        source, destination = source_models / name, models / name
        ordinary(source)
        if args.resume:
            record = next(row for row in previous['qwen'] if Path(row['copy']) == destination)
            ordinary(destination)
            assert destination.stat().st_size == record['bytes'] and sha(destination) == record['sha256'], 'Retained real Qwen cache changed'
        else:
            record = copy_pinned(source, destination)
        qwen_records.append(record)
    attempt = str(time.time_ns())
    project = work / ('project-' + attempt)
    project_records = copy_project(args.source_project.resolve(strict=True), project)
    with wave.open(str(project / 'stems/vocals.wav'), 'rb') as audio:
        duration = audio.getnframes() / audio.getframerate()
        assert abs(duration - 9.014739229024944) < 1e-6 and audio.getnchannels() == 2, 'Unexpected real speech fixture'
    assert json.loads((project / 'lyrics.json').read_text()).get('lines'), 'Manual fixture draft is missing'
    helper = app.with_name('singz-gpui-audio')
    ordinary(helper)
    engines = Path('/Applications/SingZ.app/Contents/Resources/engines')
    engine_hashes = {}
    for name in ('llama-server', 'crispasr'):
        path = engines / name
        ordinary(path)
        assert os.access(path, os.X_OK), f'Native engine is not executable: {name}'
        engine_hashes[name] = {'path': str(path), 'sha256': sha(path)}
    inputs = {'app': str(app), 'appSha256': sha(app), 'helperSha256': sha(helper),
              'qwen': qwen_records, 'projectSourceFiles': project_records, 'project': str(project),
              'pack': str(pack), 'packDescriptorSha256': sha(descriptor), 'packPythonSha256': sha(python),
              'nativeEngines': engine_hashes, 'speechSeconds': duration,
              'inferenceScope': 'Real Precise CTC only; copied Qwen files do not claim ASR execution',
              'sharedPackScope': 'Interpreter/libraries read by native Precise; Torch/HF/temp caches private. Startup --help probe may inspect shared pack-local cache paths; no exhaustive pack mutation audit.'}
    if not args.resume:
        old_inputs_path.write_text(json.dumps(inputs, indent=2) + '\n')
    (out / ('inputs-' + attempt + '.json')).write_text(json.dumps(inputs, indent=2) + '\n')
    env = {key: value for key, value in os.environ.items()
           if not key.startswith('SINGZ_GPUI_') and key not in ('SINGZ_PACK_DIR', 'SINGZ_MODELS_DIR', 'SINGZ_DEMUCS', 'SINGZ_GPU_PACK_URL')}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_LYRICS_REAL_UI='1', SINGZ_GPUI_LYRICS_ALIGN_TEST=str(out),
               SINGZ_GPUI_LYRICS_REAL_PROJECT=str(project), SINGZ_GPUI_CONFIG_DIR=str(prefs),
               SINGZ_GPUI_PROJECTS_ROOT=str(library), SINGZ_MODELS_DIR=str(models), SINGZ_PACK_DIR=str(pack),
               SINGZ_LLAMA_SERVER=str(engines / 'llama-server'), SINGZ_CRISPASR=str(engines / 'crispasr'),
               PYTHONDONTWRITEBYTECODE='1', TORCH_HOME=str(models / 'torch-home'),
               HF_HOME=str(cache / 'huggingface'), HF_HUB_CACHE=str(cache / 'huggingface/hub'),
               HUGGINGFACE_HUB_CACHE=str(cache / 'huggingface/hub'), TRANSFORMERS_CACHE=str(cache / 'transformers'),
               HF_HUB_OFFLINE='1', HF_DATASETS_OFFLINE='1', XDG_CACHE_HOME=str(cache), TMPDIR=str(scratch))
    if args.resume:
        env['SINGZ_GPUI_LYRICS_REAL_RESUME'] = '1'
    (out / 'result.json').unlink(missing_ok=True)
    front_before, front_samples = foreground(), []
    stop = threading.Event()
    started = time.monotonic()
    def observe_foreground():
        while not stop.wait(1):
            front_samples.append({'elapsedSeconds': time.monotonic() - started, **foreground()})
    log_path = out / ('real-lyrics-' + attempt + '.log')
    with log_path.open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        terminal_path.write_text(json.dumps({'pid': child.pid, 'terminal': False, 'attempt': attempt, 'log': str(log_path)}))
        monitor = threading.Thread(target=observe_foreground, daemon=True); monitor.start()
        try:
            deadline = started + args.timeout
            while child.poll() is None:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Real Precise UI process exceeded its bounded deadline; retained OUT/work and log')
                time.sleep(.25)
        finally:
            if child.poll() is None:
                child.terminate()
                try: child.wait(timeout=8)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
            stop.set(); monitor.join(timeout=4)
            front_after = foreground()
            observations = [front_before, *front_samples, front_after]
            available = all(item.get('available') is True for item in observations)
            stable = available and all(item['identity'] == front_before['identity'] for item in observations)
            verdict = 'stable-observed-foreground' if stable else 'observation-unavailable' if not available else 'external-interruption; focus-steal verdict unqualified'
            (out / 'foreground.json').write_text(json.dumps({'before': front_before, 'after': front_after, 'samples': front_samples, 'allAvailable': available, 'unchanged': stable, 'verdict': verdict}, indent=2))
            terminal_path.write_text(json.dumps({'pid': child.pid, 'terminal': True, 'returncode': child.returncode, 'attempt': attempt, 'log': str(log_path), 'wallSeconds': time.monotonic() - started}, indent=2))
    assert child.returncode == 0 and not failure_path.exists() and (out / 'result.json').is_file(), f'Real lyrics UI failed; inspect {log_path} and retained OUT/work'
    result = json.loads((out / 'result.json').read_text())
    for name in ('realInference', 'preciseConsent', 'modelDownload', 'precisePreview', 'finiteWordTimings', 'previewDoesNotWrite', 'explicitSave', 'reopenedEditor', 'reopenedPlayer', 'nativePlayback', 'hidden', 'muted'):
        assert result.get(name) is True, f'Missing executed real workflow evidence: {name}'
    assert result.get('fixtureInference') is False, 'Fixture inference cannot qualify this workflow'
    assert result.get('downloadThisRun') is (not args.resume) and result.get('resumedModel') is args.resume, 'Wrong fresh/resumed model provenance'
    assert Path(result['project']).resolve() == project.resolve(), 'UI adopted another project'
    verify_download(json.loads(model_receipt_path.read_text()), optional_model)
    written = json.loads((project / 'lyrics.json').read_text())
    words = [word for line in written['lines'] for word in line.get('words', [])]
    assert words and result['wordCount'] == len(words), 'Saved finite words do not match executed preview'
    previous_start = -1.
    for word in words:
        start, end = word['s'], word['e']
        assert isinstance(word.get('w'), str) and word['w'], 'Empty saved word'
        assert all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in (start, end))
        assert 0 <= start <= end <= duration + 2 and start >= previous_start, 'Invalid saved word timing'
        previous_start = start
    for record in project_records:
        assert sha(Path(record['source'])) == record['sha256'], 'Original speech/draft fixture changed'
    for record in qwen_records:
        assert list(stamp(ordinary(Path(record['source'])))) == record['sourceStamp'], 'Original installed Qwen input changed'
    assert sha(descriptor) == inputs['packDescriptorSha256'] and sha(python) == inputs['packPythonSha256'], 'Selected installed pack files changed'
    (out / 'evidence.json').write_text(json.dumps({'inputs': inputs, 'result': result,
        'preciseModel': {'path': str(optional_model), 'bytes': optional_model.stat().st_size, 'sha256': sha(optional_model)},
        'savedLyricsSha256': sha(project / 'lyrics.json'), 'savedProjectSha256': sha(project / 'project.json'),
        'finiteWordCount': len(words), 'foregroundVerdict': verdict, 'liveFps': 'unmeasured',
        'scope': 'Real speech fixture Precise GUI/download/Save/reopen/native playback; no general singing-quality or Qwen inference claim'}, indent=2) + '\n')
    print('PASS: real Precise native GUI, finite saved words, explicit Save/reopen and playback; evidence at ' + str(out))


if __name__ == '__main__':
    main()
