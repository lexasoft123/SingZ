"""Real automatic missing-lyrics UI: production LRCLIB lookup -> Qwen fallback.

Copies the explicit spoken project into an exclusive private library and removes
only copied lyrics/heard-cache files and copied songFile metadata. The actual
production lookup may find a usable LRCLIB hit; that produces explicit bypass
status and exit 77, never a Qwen pass. Existing GGUF/native inputs remain pinned
read-only. No fake endpoint, inference protocol, model, or manual Transcribe.
"""
from __future__ import annotations

import argparse
import errno
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


def sibling_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('app', type=Path)
    parser.add_argument('out', type=Path)
    parser.add_argument('--source-project', type=Path, required=True)
    parser.add_argument('--models', type=Path, required=True)
    parser.add_argument('--llama-server', type=Path, required=True)
    parser.add_argument('--crispasr', type=Path, required=True)
    parser.add_argument('--audio-helper', type=Path, help='Defaults to app-adjacent singz-gpui-audio')
    parser.add_argument('--timeout', type=int, default=900)
    args = parser.parse_args()
    if sys.platform != 'darwin':
        parser.error('This real native-engine/foreground qualification is macOS-only')
    if not 60 <= args.timeout <= 1200:
        parser.error('--timeout must be between 60 and 1200 seconds')
    import fcntl
    sys.dont_write_bytecode = True
    inputs = sibling_module('qwen_real_inputs', 'test_native_lyrics_real.py')
    processes = sibling_module('qwen_real_processes', 'test_native_lyrics_live.py')
    perf = sibling_module('qwen_real_resources', 'interface-perf.py')
    sha, ordinary, stamp = inputs.sha, inputs.ordinary, inputs.stamp

    def identity(path: Path, kind: str) -> dict:
        before = ordinary(path)
        if kind == 'native':
            assert os.access(path, os.X_OK) and before.st_size > 256 * 1024, f'Native executable unavailable: {path}'
            with path.open('rb') as reader:
                magic = reader.read(4)
            assert magic in (b'\xcf\xfa\xed\xfe', b'\xfe\xed\xfa\xcf', b'\xca\xfe\xba\xbe', b'\xbe\xba\xfe\xca'), f'Expected native Mach-O, not a script: {path}'
        elif kind == 'gguf':
            assert before.st_size > 8 * 1024 * 1024, f'Expected actual installed GGUF model: {path}'
            with path.open('rb') as reader:
                assert reader.read(4) == b'GGUF', f'Invalid GGUF input: {path}'
        digest = sha(path)
        assert stamp(ordinary(path)) == stamp(before), f'Input changed while hashing: {path}'
        return {'path': str(path), 'bytes': before.st_size, 'sha256': digest, 'stamp': list(stamp(before))}

    app = args.app.resolve(strict=True)
    helper = (args.audio_helper or app.with_name('singz-gpui-audio')).resolve(strict=True)
    llama, crisp = args.llama_server.resolve(strict=True), args.crispasr.resolve(strict=True)
    source, models = args.source_project.resolve(strict=True), args.models.resolve(strict=True)
    ordinary(source, True); ordinary(models, True)
    out = args.out.absolute()
    out.mkdir(parents=True, exist_ok=True)
    ordinary(out, True)
    out = out.resolve()
    assert not out.is_relative_to(source) and not out.is_relative_to(models), 'OUT must not write into source project or model roots'
    lease = (out / 'driver.lock').open('a+b')
    fcntl.flock(lease, fcntl.LOCK_EX | fcntl.LOCK_NB)
    assert all(path.name == 'driver.lock' for path in out.iterdir()), 'Automatic Qwen attempts require a fresh OUT; never adopt an old lyric/cache/result'
    work = out / 'work'; work.mkdir(mode=0o700)
    prefs, library, scratch, cache = (work / name for name in ('prefs', 'library', 'tmp', 'cache'))
    for path in (prefs, library, scratch, cache): path.mkdir(mode=0o700)
    # Production lookup falls back to the project directory name when metadata
    # has no usable name/sourceFileName. Preserve that identity in the copy too.
    project = library / source.name
    source_records = inputs.copy_project(source, project)
    lyrics_path, metadata_path = project / 'lyrics.json', project / 'project.json'
    ordinary(metadata_path)
    removed_files = []
    for filename in ('lyrics.json', 'heard-words.json'):
        path = project / filename
        if path.exists():
            meta = ordinary(path)
            removed_files.append({'file': filename, 'bytes': meta.st_size, 'sha256': sha(path)})
            path.unlink()
    assert not lyrics_path.exists() and not (project / 'heard-words.json').exists(), 'Automatic fixture must start without lyrics or heard cache'
    metadata_before = sha(metadata_path)
    metadata = json.loads(metadata_path.read_text())
    removed_song = metadata.pop('songFile', None)
    # Remove only copied artifacts that bypass production lookup/recognition.
    # The original project, its name and sourceFileName remain pinned untouched.
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False) + '\n')
    preparation = {'fixtureOnly': True, 'changedMetadataField': 'songFile', 'removedValue': removed_song,
                   'removedFiles': removed_files, 'beforeMetadataSha256': metadata_before,
                   'afterMetadataSha256': sha(metadata_path),
                   'reason': 'Private missing-lyrics/stem-only copy excludes saved lyrics and legacy original-song heard-cache reuse; original project/name/sourceFileName unchanged'}
    vocals = project / 'stems/vocals.wav'; ordinary(vocals)
    with wave.open(str(vocals), 'rb') as audio:
        duration = audio.getnframes() / audio.getframerate()
        assert 0 < duration <= 60 and audio.getnchannels() in (1, 2), 'Use a bounded spoken fixture, not a long/general-song benchmark'
    model_root_stamp = list(stamp(ordinary(models, True)))
    model_pins = [identity(models / name, 'gguf') for name in inputs.QWEN]
    runtime_pins = {name: identity(path, 'native') for name, path in
                    (('app', app), ('audioHelper', helper), ('llamaServer', llama), ('crispasr', crisp))}
    selection = {'project': str(project), 'projectSource': str(source), 'projectSourceFiles': source_records,
                 'preparedMetadata': preparation, 'modelsRoot': str(models), 'modelsRootStamp': model_root_stamp,
                 'models': model_pins, 'runtimes': runtime_pins, 'speechSeconds': duration,
                 'modelScope': 'Three existing GGUF files and model-root metadata pinned before/after; no download or permissions change',
                 'cacheScope': 'Private project starts without lyrics/heard-words; copied songFile removed; HF/Torch/temp roots private; production LRCLIB lookup unmodified'}
    (out / 'inputs.json').write_text(json.dumps(selection, indent=2) + '\n')

    env = {key: value for key, value in os.environ.items() if not key.startswith('SINGZ_')}
    env.update(SINGZ_MUTE='1', SINGZ_NO_SYNC='1', SINGZ_NO_SYSTEM_ENGINES='1',
               SINGZ_GPUI_BACKGROUND='1', SINGZ_GPUI_TEST_NO_CAPTURE='1',
               SINGZ_GPUI_LYRICS_QWEN_AUTO_UI='1', SINGZ_GPUI_LYRICS_SIDEBAR_TEST=str(out),
               SINGZ_GPUI_LYRICS_REAL_PROJECT=str(project),
               SINGZ_GPUI_CONFIG_DIR=str(prefs), SINGZ_GPUI_PROJECTS_ROOT=str(library),
               SINGZ_GPUI_AUDIO_HELPER=str(helper), SINGZ_MODELS_DIR=str(models),
               SINGZ_PACK_DIR=str(work / 'missing-pack'), SINGZ_LLAMA_SERVER=str(llama), SINGZ_CRISPASR=str(crisp),
               PYTHONDONTWRITEBYTECODE='1', TORCH_HOME=str(cache / 'torch'), HF_HOME=str(cache / 'huggingface'),
               HF_HUB_CACHE=str(cache / 'huggingface/hub'), HUGGINGFACE_HUB_CACHE=str(cache / 'huggingface/hub'),
               TRANSFORMERS_CACHE=str(cache / 'transformers'), HF_HUB_OFFLINE='1', HF_DATASETS_OFFLINE='1',
               XDG_CACHE_HOME=str(cache), TMPDIR=str(scratch))
    before, observations, observation_errors, owners = inputs.foreground(), [], [], {}
    resource_samples, resource_errors = [], []
    stop, owner_lock = threading.Event(), threading.Lock()
    started = time.monotonic()

    def owner_snapshot():
        with owner_lock: return list(owners.values())

    with (out / 'qwen-auto-ui.log').open('w') as log:
        child = subprocess.Popen([str(app)], env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        (out / 'process-exit.json').write_text(json.dumps({'pid': child.pid, 'terminal': False}))

        def observe():
            previous_usage, next_usage = None, started
            while not stop.is_set():
                try:
                    table = processes.process_table()
                    active = ({child.pid} if child.poll() is None else set()) | {row['pid'] for row in owner_snapshot() if processes.same_process(row, table.get(row['pid']))}
                    changed = True
                    while changed:
                        changed = False
                        for row in table.values():
                            if row['pid'] in active or row['parent'] in active:
                                if row['pid'] not in active: active.add(row['pid']); changed = True
                                with owner_lock: owners[(row['pid'], row['start'], row['command'])] = row
                    observations.append({'elapsedSeconds': time.monotonic() - started, **inputs.foreground()})
                except (OSError, subprocess.SubprocessError, ValueError) as error:
                    observation_errors.append(str(error))
                now = time.monotonic()
                if now >= next_usage and child.poll() is None:
                    next_usage = now + .5
                    try:
                        cpu, footprint = perf.process_usage(child.pid)
                        sampled = time.monotonic()
                        if previous_usage is not None:
                            previous_cpu, previous_time = previous_usage
                            seconds = sampled - previous_time
                            percent = (cpu - previous_cpu) / (seconds * 1e9) * 100 if seconds > 0 else float('nan')
                            if not math.isfinite(percent) or percent < 0 or footprint <= 0:
                                raise RuntimeError('Invalid app CPU/physical-footprint resource counters')
                            resource_samples.append({'elapsedSeconds': sampled - started, 'appCpuPercent': percent,
                                'appFootprintBytes': footprint, 'gpuSystem': perf.gpu_usage()})
                        previous_usage = cpu, sampled
                    except (OSError, RuntimeError, ValueError) as error:
                        # The process can exit between poll and proc_pid_rusage.
                        # A confirmed terminal child is expected, not a failed
                        # last sample; genuine live-process failures are retained.
                        gone = isinstance(error, OSError) and error.errno in (errno.ESRCH, errno.ENOENT)
                        if gone and child.poll() is None:
                            try: child.wait(timeout=.1)
                            except subprocess.TimeoutExpired: pass
                        if not gone or child.poll() is None:
                            resource_errors.append({'elapsedSeconds': time.monotonic() - started,
                                                    'operation': 'app-resource-sample', 'error': str(error)})
                        previous_usage = None
                if stop.wait(.25): break

        monitor = threading.Thread(target=observe, daemon=True); monitor.start()
        try:
            while child.poll() is None:
                if time.monotonic() - started >= args.timeout:
                    raise TimeoutError('Automatic Qwen UI exceeded bounded deadline; retained OUT/work')
                time.sleep(.2)
        finally:
            forced_stop = child.poll() is None
            if forced_stop:
                child.terminate()
                try: child.wait(timeout=8)
                except subprocess.TimeoutExpired: child.kill(); child.wait(timeout=5)
            stop.set(); monitor.join(timeout=6)
            if monitor.is_alive(): observation_errors.append('Process/foreground observer did not retire')
            observed = owner_snapshot()
            deadline = time.monotonic() + 10
            while True:
                table = processes.process_table()
                remaining = [row for row in observed if processes.same_process(row, table.get(row['pid']))]
                if not remaining or time.monotonic() >= deadline: break
                time.sleep(.2)
            survivors = list(remaining)
            # A failed owner must not strand a model server. Cleanup targets
            # only observed PIDs whose start time and command still match.
            for sig, delay in ((signal.SIGTERM, 2), (signal.SIGKILL, 0)):
                if not remaining: break
                for row in remaining:
                    if row['pid'] != child.pid:
                        try: os.kill(row['pid'], sig)
                        except ProcessLookupError: pass
                if delay: time.sleep(delay)
                table = processes.process_table()
                remaining = [row for row in remaining if processes.same_process(row, table.get(row['pid']))]
            after = inputs.foreground(); fronts = [before, *observations, after]
            available = all(row.get('available') is True for row in fronts)
            stable = available and all(row['identity'] == before['identity'] for row in fronts)
            verdict = 'stable-observed-foreground' if stable else 'observation-unavailable' if not available else 'external-interruption; focus-steal verdict unqualified'
            (out / 'foreground.json').write_text(json.dumps({'before': before, 'after': after, 'samples': observations,
                'allAvailable': available, 'unchanged': stable, 'verdict': verdict}, indent=2))
            (out / 'observed-processes.json').write_text(json.dumps(observed, indent=2))
            (out / 'process-exit.json').write_text(json.dumps({'pid': child.pid, 'terminal': True, 'returncode': child.returncode,
                'wallSeconds': time.monotonic() - started, 'forcedStop': forced_stop,
                'survivorsBeforeCleanup': survivors, 'survivorsAfterCleanup': remaining,
                'observationErrors': observation_errors}, indent=2))
            metric_summary = {'sampleCount': len(resource_samples), 'sampleErrors': len(resource_errors),
                'appCpuPercent': perf.summarize([row['appCpuPercent'] for row in resource_samples]),
                'appFootprintBytes': perf.summarize([row['appFootprintBytes'] for row in resource_samples]),
                'systemGpuAvailableSamples': sum(row['gpuSystem'].get('available') is True for row in resource_samples),
                'systemGpuUnavailableReasons': sorted({row['gpuSystem'].get('reason', 'unavailable')
                    for row in resource_samples if row['gpuSystem'].get('available') is not True}),
                'cpuScope': 'App process only; 100 percent is one CPU core',
                'helperCpuIncluded': False, 'gpuScope': 'System-wide IOAccelerator counters, including other processes',
                'liveFps': 'unmeasured', 'performanceVerdict': 'Resource observation only; hidden live display cadence is unqualified'}
            (out / 'interface-metrics.json').write_text(json.dumps({'schema': 1, 'appPid': child.pid,
                'targetIntervalSeconds': .5, 'samples': resource_samples, 'errors': resource_errors,
                'summary': metric_summary}, indent=2))

    assert child.returncode == 0 and not forced_stop and not any((out / name).exists() for name in ('failure.txt', 'qwen-auto-failure.txt')), 'Automatic UI failed; inspect qwen-auto-ui.log and retained work'
    assert observed and not survivors and not remaining and not observation_errors, 'Observed native-process retirement is not fully verified'
    assert resource_samples and not resource_errors, 'Resource observation requires a valid sample and no live-process sampling errors'
    result = json.loads((out / 'qwen-auto-result.json').read_text())
    assert Path(result['project']).resolve() == project.resolve(), 'UI adopted a different project'
    assert result['sizes'] == [[1280, 800], [1060, 640]]
    assert result.get('productionEndpoint') == 'https://lrclib.net/api', 'Not the production LRCLIB endpoint'
    assert result.get('manualTranscribe') is False and result.get('headerSave') is False, 'Automatic path used manual controls'
    assert result.get('fixtureInference') is False, 'Fixture inference cannot qualify real recognition'
    # Check original inputs on both Qwen success and legitimate LRCLIB bypass.
    for record in source_records:
        path = Path(record['source'])
        assert list(stamp(ordinary(path))) == record['sourceStamp'] and sha(path) == record['sha256'], 'Original source project changed'
    for pin in model_pins + list(runtime_pins.values()):
        path = Path(pin['path'])
        assert list(stamp(ordinary(path))) == pin['stamp'] and sha(path) == pin['sha256'], f'Supplied input changed: {path}'
    assert list(stamp(ordinary(models, True))) == model_root_stamp, 'Supplied model-root metadata changed'
    saved_metadata = json.loads(metadata_path.read_text())
    assert 'songFile' not in saved_metadata, 'Private project restored legacy original-song lookup'
    for key in ('name', 'sourceFileName'):
        assert saved_metadata.get(key) == metadata.get(key), f'Lookup identity changed: {key}'
    ordinary(lyrics_path)
    written = json.loads(lyrics_path.read_text())
    assert written == result['publishedLyrics'], 'Result does not describe persisted lyrics'
    assert written['lines'] and any(line.get('text', '').strip() for line in written['lines']), 'No published lyrics'
    bypassed = result.get('bypassed') is True
    if bypassed:
        assert result.get('passed') is False and result.get('source') == 'lrclib'
        assert result.get('lookupOutcome') == 'hit' and written['source'] == 'lrclib'
        assert isinstance(result.get('realInference'), bool), 'Bypass must disclose whether Qwen ran before a reopen hit'
        expected_reason = 'Live LRCLIB returned a usable hit' + (' during reopen recheck' if result['realInference'] else '')
        assert result.get('bypassReason') == expected_reason
        kinds = ['qwen-auto-lrclib-hit']
        if result['realInference']: kinds.insert(0, 'qwen-auto-ready')
    else:
        for key in ('passed', 'realInference', 'automaticPath', 'observedSearching', 'observedTranscribing',
                    'freshHeardCache', 'automaticPublication', 'reopenedPlayer', 'nativePlayback'):
            assert result.get(key) is True, f'Missing automatic Qwen evidence: {key}'
        assert result.get('lookupOutcome') in ('miss', 'down'), 'Qwen fallback needs an actual production miss/unavailability'
        assert any(row['command'] == str(llama) for row in observed), 'No supplied llama-server process observed'
        assert written['source'] == 'whisper', 'Automatic recognized lyrics have the wrong persisted source'
        initial = result['initialPublishedLyrics']
        assert initial['lines'] == written['lines'], 'Reopen changed automatically published Qwen lines'
        for raw, outcome in ((initial, result['lookupOutcome']), (written, result['finalLookupOutcome'])):
            assert outcome in ('miss', 'down') and raw['engine'] == 'qwen3-asr-1.7b' and raw['lookup'] == 3
            assert raw['lrclibPending'] is (outcome == 'down'), 'Lookup outcome differs from persisted pending metadata'
            assert all(key not in raw for key in ('aligned', 'base', 'check', 'credit')), 'Fresh automatic Qwen inherited derived alignment/credit'
        kinds = ['qwen-auto-ready', 'qwen-auto-reopened']
    from PIL import Image
    captures = []

    def capture(kind: str, width: int, height: int) -> dict:
        image = out / f'{kind}-{width}.png'
        state_path = out / f'{kind}-{width}.state.json'
        ordinary(image); ordinary(state_path)
        state = json.loads(state_path.read_text())
        assert state['viewport'] == [width, height] and state['windowPresented'] is False and state['windowActive'] is False
        assert state['hiddenConfigured'] is True and state['mutedConfigured'] is True
        with Image.open(image) as pixels:
            assert pixels.size == (round(width * state['scale']), round(height * state['scale']))
        captures.append({'path': str(image), 'sha256': sha(image), 'stateSha256': sha(state_path)})
        return state

    for kind in kinds:
        for width, height in ((1280, 800), (1060, 640)):
            capture(kind, width, height)
    # Production stages may finish between observations. Optional progress
    # captures supplement the required end states and never substitute for them.
    for phase in ('searching', 'transcribing'):
        kind = f'qwen-auto-{phase}'
        if (out / f'{kind}-1280.png').exists():
            state = capture(kind, 1280, 800)
            assert state['sidebar']['status'] == 'loading' and state['sidebar']['details']['progress']['stage'] == phase
    assert {path.name for path in out.glob('*.png')} == {Path(row['path']).name for row in captures}, 'Unexpected/missing root captures'
    evidence = {'status': 'bypassed' if bypassed else 'passed', 'qwenQualified': not bypassed,
        'inputs': selection, 'result': result, 'savedLyricsSha256': sha(lyrics_path),
        'savedProjectSha256': sha(metadata_path), 'captures': captures, 'suppliedInputsUnchanged': True,
        'ownedObservedProcessesRetired': True, 'foregroundVerdict': verdict, 'liveFps': 'unmeasured',
        'interfaceMetrics': {'path': str(out / 'interface-metrics.json'), 'summary': metric_summary},
        'scope': 'Production LRCLIB automatic lookup and real Qwen fallback on a spoken fixture; no general singing timing-quality, visual-parity or live-FPS qualification'}
    if not bypassed:
        words = [word for line in written['lines'] for word in line.get('words', [])]
        assert words and len(words) == result['wordCount'], 'Published words do not match Qwen result'
        previous_start = -1.
        for word in words:
            start, end = word['s'], word['e']
            assert isinstance(word.get('w'), str) and word['w'].strip()
            assert all(isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) for value in (start, end))
            assert 0 <= start <= end <= duration + 2 and start >= previous_start, 'Invalid automatic Qwen word timing'
            previous_start = start
        heard_path = project / 'heard-words.json'; ordinary(heard_path)
        heard = json.loads(heard_path.read_text())
        assert heard == result['heardCache'], 'Result does not describe the fresh persisted heard cache'
        assert heard['version'] == 1 and heard['engine'] == 'qwen3-asr-1.7b' and heard['vocals']['size'] == vocals.stat().st_size
        assert abs(heard['vocals']['mtimeMs'] - vocals.stat().st_mtime_ns // 1_000_000) <= 2
        assert any(isinstance(chunk.get('text'), str) and chunk['text'].strip() for chunk in heard['chunks']), 'No fresh recognized speech'
        evidence.update(finiteWordCount=len(words), heardCacheSha256=sha(heard_path))
    (out / 'evidence.json').write_text(json.dumps(evidence, indent=2) + '\n')
    if bypassed:
        print('BYPASS: production LRCLIB supplied lyrics; Qwen unqualified; evidence at ' + str(out))
        raise SystemExit(77)
    print('PASS: production LRCLIB fallback, real automatic Qwen publication/reopen/playback; evidence at ' + str(out))


if __name__ == '__main__':
    main()
