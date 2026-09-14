#!/usr/bin/env python3
"""Read-only song corpus evaluation; all decoded audio and results go to --output.

Requires ffmpeg/ffprobe and numpy; reference additionally requires torchcrepe.
The independent reference is a disagreement detector, NOT annotated ground truth.
Example:
  python eval/pitch-corpus.py manifest --output /tmp/pitch-eval
  python eval/pitch-corpus.py native --label baseline --bin /path/singz-analyze
  python eval/pitch-corpus.py reference --device cpu
  python eval/pitch-corpus.py compare --label baseline
Use --scope all to include Downloads (full mixes remain explicitly labeled).
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

import numpy as np

AUDIO = {'.wav', '.flac', '.mp3', '.m4a', '.aac', '.ogg', '.aif', '.aiff'}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False, allow_nan=False) + '\n')
    temp.replace(path)


def fingerprint(path):
    s = path.stat()
    return {'bytes': s.st_size, 'mtime_ns': s.st_mtime_ns}


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def manifest(args):
    entries = []
    for project in sorted(args.library.iterdir()):
        if not (project / 'project.json').exists():
            continue
        files = []
        for path in sorted(project.rglob('*')):
            if path.is_file() and path.suffix.lower() in AUDIO:
                role = ('vocal_stem' if path.parent.name == 'stems' and path.stem == 'vocals'
                        else 'custom_track_unverified' if path.parent.name == 'stems' and path.stem.startswith('custom-')
                        else 'instrument_stem' if path.parent.name == 'stems' and path.stem in ['drums', 'bass', 'other', 'guitar', 'piano']
                        else 'auxiliary_audio_unverified' if path.parent.name == 'stems'
                        else 'source_mix')
                files.append({'path': str(path), 'role': role, **fingerprint(path)})
        vocals = [f for f in files if f['role'] == 'vocal_stem']
        # Match the application's v2 preference when both formats exist.
        vocals.sort(key=lambda f: Path(f['path']).suffix != '.flac')
        entries.append({'id': 'library-' + hashlib.sha256(str(project).encode()).hexdigest()[:12],
                        'name': project.name, 'origin': 'library', 'role': 'vocal_stem',
                        'path': vocals[0]['path'] if vocals else None, 'files': files})
    for path in sorted(args.downloads.iterdir()):
        if not path.is_file() or path.suffix.lower() not in AUDIO:
            continue
        name = path.stem.lower()
        role = ('vocal_stem' if '[vocals]' in name else
                'backing_track' if any(t in name for t in ['[music]', 'backing_track', 'minus'])
                else 'source_mix_unverified')
        entries.append({'id': 'downloads-' + hashlib.sha256(str(path).encode()).hexdigest()[:12],
                        'name': path.name, 'origin': 'downloads', 'role': role,
                        'path': str(path), 'files': [{'path': str(path), 'role': role, **fingerprint(path)}]})
    for entry in entries:
        if entry['path']:
            try:
                probe = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                                        '-of', 'json', entry['path']], capture_output=True, text=True, check=True)
                entry['duration_seconds'] = float(json.loads(probe.stdout)['format']['duration'])
            except Exception as exc:
                entry['duration_error'] = str(exc)
    result = {'created_unix': time.time(), 'role_note': 'Downloads roles inferred from filenames; source mixes are not isolated vocal ground truth.',
              'entries': entries}
    write_json(args.output / 'manifest.json', result)
    return result


def decoded(entry, args):
    if not entry['path']:
        raise ValueError('No vocal stem found')
    source = Path(entry['path'])
    identity = fingerprint(source)
    root = args.output / 'decoded'
    root.mkdir(parents=True, exist_ok=True)
    target = root / (entry['id'] + ('-lead' if args.input_kind == 'lead' else '') + '.f32')
    meta_path = target.with_suffix('.json')
    if target.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        if meta['source'] == identity and target.stat().st_size == meta['samples'] * 4:
            return target, meta
    probe = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
                            '-show_entries', 'stream=sample_rate,channels', '-of', 'json', str(source)],
                           capture_output=True, text=True, check=True)
    stream = json.loads(probe.stdout)['streams'][0]
    temporary = target.with_suffix('.partial')
    subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(source),
                    '-map', '0:a:0', '-ac', '1', '-ar', '44100', '-f', 'f32le', str(temporary)],
                   capture_output=True, check=True)
    temporary.replace(target)
    meta = {'source': identity, 'source_sha256': sha256(source), 'source_stream': stream,
            'sample_rate': 44100, 'samples': target.stat().st_size // 4,
            'decode': 'ffmpeg mono float32, 44100 Hz', 'pcm_sha256': sha256(target)}
    write_json(meta_path, meta)
    return target, meta


def native(entry, args):
    pcm, meta = decoded(entry, args)
    out = args.output / args.label / (entry['id'] + '.json')
    binary_hash = sha256(args.bin)
    if out.exists():
        cached = json.loads(out.read_text())
        if cached.get('binary_sha256') == binary_hash and cached.get('pcm_sha256') == meta['pcm_sha256']:
            return cached
    start = time.monotonic()
    run = subprocess.run([str(args.bin), 'melody', '--f32', str(pcm), '--sr', '44100', '--raw'],
                         capture_output=True, text=True, check=True)
    result = json.loads(run.stdout)
    result.update({'id': entry['id'], 'seconds': time.monotonic() - start,
                   'binary_sha256': binary_hash, 'pcm_sha256': meta['pcm_sha256'],
                   'input_path': entry['path'], 'input_role': entry['role'],
                   'duration': meta['samples'] / 44100})
    write_json(out, result)
    return result


def reference(entry, args):
    import torch
    import torchcrepe
    import scipy.signal
    import importlib.metadata
    torch.set_num_threads(args.threads)
    pcm, meta = decoded(entry, args)
    out = args.output / ('reference-lead' if args.input_kind == 'lead' else 'reference') / (entry['id'] + '.json')
    config = {'model': args.model, 'device': args.device, 'hopSec': .02, 'fmin': 50,
              'fmax': 1600, 'periodicity_threshold': .21, 'silence_db': -60,
              'torchcrepe_version': importlib.metadata.version('torchcrepe'),
              'decoder': 'viterbi', 'chunk_seconds': 30, 'context_seconds': 1}
    if out.exists():
        cached = json.loads(out.read_text())
        if cached.get('config') == config and cached.get('pcm_sha256') == meta['pcm_sha256']:
            return cached
    audio = scipy.signal.resample_poly(np.fromfile(pcm, dtype='<f4'), 160, 441).astype(np.float32)
    sr, hop, chunk, context = 16000, 320, 480000, 16000
    pitches, confidences, times = [], [], []
    start_time = time.monotonic()
    for start in range(0, len(audio), chunk):
        low, high = max(0, start-context), min(len(audio), start+chunk+context)
        tensor = torch.from_numpy(audio[low:high]).unsqueeze(0)
        with torch.inference_mode():
            pitch, periodicity = torchcrepe.predict(tensor, sr, hop, 50, 1600,
                args.model, batch_size=args.batch_size, device=args.device, return_periodicity=True)
            periodicity = torchcrepe.filter.median(periodicity, 3)
            periodicity = torchcrepe.threshold.Silence(-60)(periodicity, tensor, sr, hop)
        p = pitch.cpu().numpy().ravel()
        c = periodicity.cpu().numpy().ravel()
        t = low + np.arange(len(p)) * hop
        keep = (t >= start) & (t < min(start+chunk, len(audio)))
        p[(c < .21) | ~np.isfinite(p)] = 0
        pitches.extend(p[keep].astype(float).tolist())
        confidences.extend(c[keep].astype(float).tolist())
        times.extend((t[keep] / sr).tolist())
        print(json.dumps({'progress': entry['name'], 'reference_seconds': min(start+chunk, len(audio))/sr}), flush=True)
    result = {'id': entry['id'], 'config': config, 'pcm_sha256': meta['pcm_sha256'],
              'input_path': entry['path'], 'input_role': entry['role'],
              'f0': pitches, 'periodicity': confidences, 'times': times, 'hopSec': .02,
              'seconds': time.monotonic()-start_time, 'duration': len(audio)/sr}
    write_json(out, result)
    return result


def compare(entry, args):
    native_path = args.output / args.label / (entry['id'] + '.json')
    ref_path = args.output / ('reference-lead' if args.input_kind == 'lead' else 'reference') / (entry['id'] + '.json')
    a, b = json.loads(native_path.read_text()), json.loads(ref_path.read_text())
    if a['pcm_sha256'] != b['pcm_sha256']:
        raise ValueError('Reference and native PCM differ')
    f = np.asarray(a['f0'])
    ref = np.asarray(b['f0'])
    # Native frame i starts at i*hop; CREPE pads and timestamps the center.
    # At the evaluation rate 44100, native uses 1024 decimated samples.
    idx = np.rint((np.arange(len(f)) * a['hopSec'] + args.native_window / (44100 / 3) / 2) / b['hopSec']).astype(int)
    valid = idx < len(ref)
    f, g = f[valid], ref[idx[valid]]
    both = (f > 0) & (g > 0)
    cents = 1200 * np.log2(f[both] / g[both])
    return {'id': entry['id'], 'name': entry['name'], 'role': entry['role'],
            'frames': len(f), 'both_voiced': int(both.sum()),
            'native_voiced': int((f > 0).sum()), 'reference_voiced': int((g > 0).sum()),
            'within_50c': int((abs(cents) <= 50).sum()),
            'native_octave_above': int((abs(cents - 1200) <= 50).sum()),
            'native_octave_below': int((abs(cents + 1200) <= 50).sum()),
            'median_absolute_cents': float(np.median(abs(cents))) if len(cents) else None,
            'native_seconds': a['seconds'], 'reference_seconds': b['seconds']}


def separate(entry, args):
    if entry['role'] != 'vocal_stem':
        raise ValueError('Lead/backing separation requires a resolved vocal stem, not a full mix')
    source = Path(entry['path'])
    output = args.output / 'lead-backing' / entry['id']
    metadata_path = output / 'evaluation.json'
    import onnxruntime as ort
    import platform
    signature = {'source_sha256': sha256(source), 'model_sha256': sha256(args.separator_model),
                 'runner_sha256': sha256(args.separator_runner), 'onnxruntime_version': ort.__version__,
                 'provider_request': 'CoreMLExecutionProvider+CPUExecutionProvider' if platform.system() == 'Darwin' else 'CPUExecutionProvider'}
    if metadata_path.exists() and (output / 'lead.wav').exists() and (output / 'backing.wav').exists():
        saved = json.loads(metadata_path.read_text())
        if saved['signature'] == signature:
            return saved
    output.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    import sys
    with (output / 'run.log').open('w') as log:
        subprocess.run([sys.executable, str(args.separator_runner), '--model', str(args.separator_model),
                        '--input', str(source), '--output', str(output), '--threads', str(args.threads)],
                       stdout=log, stderr=subprocess.STDOUT, check=True)
    result = {'id': entry['id'], 'signature': signature, 'seconds': time.monotonic()-start,
              'lead': str(output / 'lead.wav'), 'backing': str(output / 'backing.wav')}
    write_json(metadata_path, result)
    return result


def prepare(entry, args):
    """Resolve cached vocals or extract them into scratch with the installed pack."""
    source = Path(entry['path'])
    record = args.output / 'prepared' / (entry['id'] + '.json')
    if record.exists():
        cached = json.loads(record.read_text())
        if cached.get('source_sha256') == sha256(source) and Path(cached.get('vocals', '')).is_file():
            return cached
    if entry['role'] == 'backing_track':
        return {'id': entry['id'], 'skipped': 'Instrumental backing track; no vocal pitch ground truth'}
    if entry['role'] == 'vocal_stem':
        result = {'id': entry['id'], 'vocals': str(source), 'method': 'supplied_vocal_stem'}
    else:
        digest = hashlib.sha1(source.read_bytes()).hexdigest()[:16]
        paths = []
        for identity in ['SingZ', 'singz', 'Electron']:
            cache = Path.home() / 'Library/Application Support' / identity / 'stems' / digest
            paths.extend(cache.glob('**/vocals.wav'))
            paths.extend(cache.glob('**/vocals.flac'))
        if paths:
            result = {'id': entry['id'], 'vocals': str(paths[0]), 'method': 'source_sha1_cache', 'source_sha1': digest}
        else:
            dest = args.output / 'demucs' / entry['id']
            vocal = dest / 'htdemucs_6s' / 'vocals.wav'
            done = dest / 'evaluation.json'
            if done.exists() and vocal.exists():
                previous = json.loads(done.read_text())
                if previous.get('source_sha1') == digest:
                    previous['source_sha256'] = sha256(source)
                    write_json(record, previous)
                    return previous
            dest.mkdir(parents=True, exist_ok=True)
            wav = dest / 'input.wav'
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(source),
                            '-ar', '44100', '-c:a', 'pcm_f32le', str(wav)], capture_output=True, check=True)
            env = dict(os.environ, HF_HUB_OFFLINE='1', PYTHONUNBUFFERED='1',
                       TORCH_HOME=str(args.demucs_pack / 'torch-home'), HF_HOME=str(args.demucs_pack / 'hf-home'))
            start = time.monotonic()
            with (dest / 'run.log').open('w') as log:
                subprocess.run([str(args.demucs_pack / 'bin/python3'), '-m', 'demucs', '-n', 'htdemucs_6s',
                                '-d', args.device, '--float32', '--two-stems', 'vocals', '--other-method', 'none',
                                '--filename', '{stem}.{ext}', '-o', str(dest), str(wav)],
                               stdout=log, stderr=subprocess.STDOUT, check=True, env=env)
            if not vocal.exists():
                raise ValueError('Demucs reported success without vocals.wav')
            result = {'id': entry['id'], 'vocals': str(vocal), 'method': 'htdemucs_6s',
                      'source_sha1': digest, 'seconds': time.monotonic()-start}
            write_json(done, result)
            wav.unlink()
    result['source_sha256'] = sha256(source)
    write_json(record, result)
    return result


def pipeline(entry, args):
    """Consume prepared Downloads as they arrive; each song runs sequentially."""
    from types import SimpleNamespace
    options = SimpleNamespace(**vars(args))
    entry = dict(entry)
    control = entry['role'] == 'backing_track'
    if not control and entry['role'] != 'vocal_stem':
        record = args.output / 'prepared' / (entry['id'] + '.json')
        deadline = time.monotonic() + args.wait_seconds
        while not record.exists():
            summary_path = args.output / 'prepare-baseline-downloads-summary.json'
            if summary_path.exists():
                summary = json.loads(summary_path.read_text())
                failure = next((f for f in summary.get('failures', []) if f['id'] == entry['id']), None)
                if failure:
                    raise ValueError('Vocal preparation failed: ' + failure['error'])
            if time.monotonic() >= deadline:
                raise TimeoutError('Timed out waiting for prepared vocal stem')
            time.sleep(2)
        prepared = json.loads(record.read_text())
        entry.update(path=prepared['vocals'], role='vocal_stem')
    options.bin, options.label = args.baseline_bin, 'baseline'
    old = native(entry, options)
    options.bin, options.label = args.updated_bin, 'updated'
    new = native(entry, options)
    result = {'id': entry['id'], 'baseline_seconds': old['seconds'], 'updated_seconds': new['seconds'],
              'control': control}
    if not control:
        if args.await_separation:
            metadata_path = args.output / 'lead-backing' / entry['id'] / 'evaluation.json'
            deadline = time.monotonic() + args.wait_seconds
            while not metadata_path.exists():
                if time.monotonic() >= deadline:
                    raise TimeoutError('Timed out waiting for lead/backing separation')
                time.sleep(2)
        separated = separate(entry, options)
        result['separation_seconds'] = separated['seconds']
        ref = reference(entry, options)
        result['reference_seconds'] = ref['seconds']
        lead_entry = dict(entry, path=separated['lead'], role='lead_vocal_stem')
        options.input_kind, options.label = 'lead', 'updated-lead'
        lead_track = native(lead_entry, options)
        result['lead_native_seconds'] = lead_track['seconds']
        lead_ref = reference(lead_entry, options)
        result['lead_reference_seconds'] = lead_ref['seconds']
    return result


def report(index, args):
    """Generate an honest, live snapshot without requiring unfinished jobs."""
    lines = ['# Pitch and vocal separation corpus evaluation', '',
             'This is a snapshot of files completed on this Mac, not a claim of pitch accuracy. '
             'The songs have no manually annotated fundamental-frequency reference. CREPE is '
             'an independent model: agreement and octave disagreement can flag inspection targets, '
             'but either detector can follow a harmony or make an octave error.', '',
             'Every successful native/reference row covers the entire decoded file. Native trailing '
             'frames shorter than its analysis window are omitted. CREPE runs in 30-second segments '
             'with one second of context, full model, Viterbi decoding, 20 ms hops, 50–1600 Hz range, '
             'median periodicity filter, 0.21 periodicity threshold and −60 dB silence gate. '
             'Comparison aligns CREPE centers to native forward-window centers.', '',
             'All originals remain unchanged; decoded audio, extracted vocals and lead/backing outputs '
             'are under this report directory. Filename-derived Downloads roles are provisional. '
             'Instrumental backing tracks are inventory entries, not vocal pitch ground truth.', '',
             f'| Song/file | Original role | Full duration, s | Native ({args.label}) | CREPE | Lead/backing | Native within 50 cents of CREPE | Native octave above/below CREPE |',
             '|---|---|---:|---|---|---|---:|---:|']
    counts = {'inventory': len(index['entries']), 'baseline': 0, 'reference': 0, 'separated': 0}
    executable_counts = {}
    for label in ['baseline', 'updated', 'updated-lead']:
        hashes = {}
        for entry in index['entries']:
            path = args.output / label / (entry['id'] + '.json')
            if path.exists():
                digest = json.loads(path.read_text()).get('binary_sha256', 'unknown')
                hashes[digest] = hashes.get(digest, 0) + 1
        executable_counts[label] = hashes
    for entry in index['entries']:
        identifier = entry['id']
        a_path = args.output / args.label / (identifier + '.json')
        b_path = args.output / ('reference-lead' if args.input_kind == 'lead' else 'reference') / (identifier + '.json')
        sep_path = args.output / 'lead-backing' / identifier / 'evaluation.json'
        a = json.loads(a_path.read_text()) if a_path.exists() else None
        b = json.loads(b_path.read_text()) if b_path.exists() else None
        counts['baseline'] += a is not None
        counts['reference'] += b is not None
        counts['separated'] += sep_path.exists()
        duration = a.get('duration') if a else b.get('duration') if b else None
        agreement, octaves = '—', '—'
        if a and b:
            try:
                metric = compare(entry, args)
                n = metric['both_voiced']
                if n:
                    agreement = f"{metric['within_50c']/n:.1%} ({n:,} shared voiced frames)"
                    octaves = f"{metric['native_octave_above']/n:.1%} / {metric['native_octave_below']/n:.1%}"
            except ValueError:
                agreement = 'Different input PCM; not compared'
        row = [entry['name'].replace('|', '\\|'), entry['role'], f'{duration:.1f}' if duration else '—',
               f"Done ({a['seconds']:.1f}s)" if a else 'Not yet evaluated',
               f"Done ({b['seconds']:.1f}s)" if b else 'Not yet evaluated',
               'Done' if sep_path.exists() else 'Not yet evaluated', agreement, octaves]
        lines.append('| ' + ' | '.join(row) + ' |')
    lines.extend(['', 'Completed counts: ' + ', '.join(f'{k}: {v}' for k, v in counts.items()) + '.', '',
                  'The [exact manifest](manifest.json) lists absolute paths, original sizes/mtimes and '
                  'roles for all audio files in every library project plus every top-level Downloads '
                  'audio file. Native outputs include executable SHA-256, detector stamp and decoded '
                  'PCM SHA-256. Per-file reference outputs include model/runtime configuration. '
                  'Separation outputs include source, model and runner SHA-256; their local logs contain progress.', '',
                  '## Recorded failures', ''])
    lines.insert(3, 'Native executable provenance by result count: ' + json.dumps(executable_counts) +
                 '\n\nIf a label has multiple hashes, its results are a work-in-progress snapshot; final refresh must use the selected production executable.\n')
    failures = []
    for path in sorted(args.output.glob('*-summary.json')):
        value = json.loads(path.read_text())
        for failure in value.get('failures', []):
            failures.append(f"- {path.name}: {failure['name']}: {failure['error']}")
    lines.extend(failures or ['No failures recorded in completed summary snapshots. Pending jobs are not passes.'])
    lines.extend(['', '## Baseline versus updated detector on the same vocal input', '',
                  'These percentages use exactly the frames voiced by both native versions and CREPE. '
                  'This avoids comparing different frame populations after the updated detector voices more frames. '
                  'This comparison measures agreement with CREPE, not annotated accuracy.', '',
                  '| Song | Shared voiced frames | Baseline within 50c | Updated within 50c | Baseline octave below CREPE | Updated octave below CREPE |',
                  '|---|---:|---:|---:|---:|---:|'])
    comparisons = []
    for entry in index['entries']:
        paths = [args.output / label / (entry['id'] + '.json') for label in ['baseline', args.candidate_label, 'reference']]
        if not all(path.exists() for path in paths):
            continue
        a, b, ref = [json.loads(path.read_text()) for path in paths]
        if len({x['pcm_sha256'] for x in [a, b, ref]}) != 1 or a['hopSec'] != b['hopSec'] or len(a['f0']) != len(b['f0']):
            continue
        old, new = np.asarray(a['f0']), np.asarray(b['f0'])
        reference_hz = np.asarray(ref['f0'])
        indices = np.rint((np.arange(len(old)) * a['hopSec'] + args.native_window / 14700 / 2) / ref['hopSec']).astype(int)
        valid = indices < len(reference_hz)
        old, new, truth = old[valid], new[valid], reference_hz[indices[valid]]
        common = (old > 0) & (new > 0) & (truth > 0)
        count = int(common.sum())
        metrics = {}
        for name, values in [('baseline', old), ('updated', new)]:
            cents = 1200 * np.log2(values[common] / truth[common])
            metrics[name] = {'within50': int((abs(cents) <= 50).sum()),
                             'octave_below': int((abs(cents + 1200) <= 50).sum()),
                             'octave_above': int((abs(cents - 1200) <= 50).sum()),
                             'voiced': int((values > 0).sum())}
        comparisons.append({'id': entry['id'], 'name': entry['name'], 'common': count, **metrics})
        fraction = lambda value: f'{value/count:.1%}' if count else '—'
        lines.append('| ' + ' | '.join([entry['name'].replace('|', '\\|'), str(count),
                     fraction(metrics['baseline']['within50']), fraction(metrics['updated']['within50']),
                     fraction(metrics['baseline']['octave_below']), fraction(metrics['updated']['octave_below'])]) + ' |')
    write_json(args.output / ('comparison-versions.json' if args.candidate_label == 'updated' else f'comparison-{args.candidate_label}.json'), comparisons)
    lines.extend(['', '## Updated detector on mixed vocals and separated lead', '',
                  'Each column compares the detector with CREPE on the same input waveform. '
                  'The two columns have different waveforms and voiced frame populations; a larger '
                  'agreement percentage is evidence of simpler pitch tracking, not proof that the model '
                  'correctly identified the lead singer.', '',
                  '| Song | Mixed vocals: within 50c | Shared voiced frames | Lead: within 50c | Shared voiced frames |',
                  '|---|---:|---:|---:|---:|'])
    from types import SimpleNamespace
    lead_comparisons = []
    for entry in index['entries']:
        paths = [args.output / label / (entry['id'] + '.json') for label in ['updated', 'reference', 'updated-lead', 'reference-lead']]
        if not all(path.exists() for path in paths):
            continue
        options = SimpleNamespace(**vars(args))
        options.label, options.input_kind = 'updated', 'original'
        original = compare(entry, options)
        options.label, options.input_kind = 'updated-lead', 'lead'
        lead = compare(entry, options)
        lead_comparisons.append({'id': entry['id'], 'name': entry['name'], 'vocals': original, 'lead': lead})
        fraction = lambda row: f"{row['within_50c']/row['both_voiced']:.1%}" if row['both_voiced'] else '—'
        lines.append('| ' + ' | '.join([entry['name'].replace('|', '\\|'), fraction(original),
                     str(original['both_voiced']), fraction(lead), str(lead['both_voiced'])]) + ' |')
    write_json(args.output / 'comparison-lead.json', lead_comparisons)
    desktop_path = args.output / 'desktop-verification.json'
    if desktop_path.exists():
        desktop = json.loads(desktop_path.read_text())
        lines.extend(['', '## Real desktop app verification', '',
                      f"Status: {desktop['status']}. Evidence: [desktop-verification.json](desktop-verification.json).", ''])
        lines.extend('- ' + check for check in desktop.get('checks', []))
    long_protocol = args.output / 'long-recording/protocol.json'
    if long_protocol.exists():
        lines.extend(['', '## Long recording protocol', '',
                      'MASTER REC_01 is a159-minute recording. Its full-duration test uses180.32-second cores '
                      'with7.36 seconds of context on each side, processed sequentially to bound memory. '
                      'All audio samples and both exact pitch grids are assembled after discarding context. '
                      'This differs from whole-recording Viterbi decoding. See [protocol.json](long-recording/protocol.json).'])
    report_name = 'report.md' if args.candidate_label == 'updated' else f'report-{args.candidate_label}.md'
    lines.insert(2, f'Candidate detector directory: `{args.candidate_label}`.\n')
    (args.output / report_name).write_text('\n'.join(lines) + '\n')
    print(json.dumps(counts))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('command', choices=['manifest', 'native', 'reference', 'compare', 'separate', 'prepare', 'report', 'pipeline'])
    p.add_argument('--library', type=Path, default=Path.home() / 'Library/Mobile Documents/com~apple~CloudDocs/SingZ')
    p.add_argument('--downloads', type=Path, default=Path.home() / 'Downloads')
    p.add_argument('--output', type=Path, default=Path('/private/tmp/singz-pitch-eval'))
    p.add_argument('--scope', choices=['library', 'downloads', 'all'], default='library')
    p.add_argument('--match', default='', help='Case insensitive name substring')
    p.add_argument('--exclude-match', default='', help='Exclude names containing this case insensitive substring')
    p.add_argument('--exclude-id', default='', help='Exclude one exact manifest ID')
    p.add_argument('--label', default='baseline')
    p.add_argument('--candidate-label', default='updated', help='Candidate directory for the common-frame baseline comparison')
    p.add_argument('--bin', type=Path, default=Path('/private/tmp/singz-pitch-eval/baseline/singz-analyze'))
    p.add_argument('--device', default='cpu')
    p.add_argument('--model', choices=['tiny', 'full'], default='full')
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--batch-size', type=int, default=128)
    p.add_argument('--native-window', type=int, default=1024, help='Native decimated window samples, used to align frame centers')
    p.add_argument('--separator-model', type=Path, default=Path('/private/tmp/singz-pitch-eval/models/UVR_MDXNET_KARA_2.onnx'))
    p.add_argument('--separator-runner', type=Path, default=Path(__file__).resolve().parents[1] / 'scripts/vocal_split_runner.py')
    p.add_argument('--demucs-pack', type=Path, default=Path.home() / 'Library/Application Support/SingZ/gpu-splitter/python')
    p.add_argument('--input-kind', choices=['original', 'vocals', 'lead'], default='original')
    p.add_argument('--available-only', action='store_true', help='Incremental evaluation: skip inputs not yet prepared or separated')
    p.add_argument('--shards', type=int, default=1)
    p.add_argument('--shard', type=int, default=0)
    p.add_argument('--baseline-bin', type=Path, default=Path('/private/tmp/singz-pitch-eval/baseline/singz-analyze'))
    p.add_argument('--updated-bin', type=Path, default=Path('/private/tmp/singz-pitch-native/singz-analyze'))
    p.add_argument('--wait-seconds', type=int, default=3600, help='Pipeline wait limit per missing prepared input')
    p.add_argument('--await-separation', action='store_true', help='Wait for a separate corpus separation job before consuming each song')
    args = p.parse_args()
    if args.shards < 1 or not 0 <= args.shard < args.shards:
        p.error('--shard must be between zero and --shards minus one')
    if any(not re.fullmatch(r'[A-Za-z0-9_-]+', label) for label in [args.label, args.candidate_label]):
        p.error('--label and --candidate-label must be simple directory names')
    # Disallow placing artifacts among originals, including through a symlink.
    for source in [args.library.resolve(), args.downloads.resolve()]:
        if args.output.resolve() == source or source in args.output.resolve().parents:
            p.error('--output must be outside the source library and Downloads')
    index = manifest(args) if args.command == 'manifest' or not (args.output / 'manifest.json').exists() else json.loads((args.output / 'manifest.json').read_text())
    if args.command == 'manifest':
        print(json.dumps({'entries': len(index['entries']), 'library': sum(e['origin'] == 'library' for e in index['entries']), 'manifest': str(args.output / 'manifest.json')}))
        return
    if args.command == 'report':
        report(index, args)
        return
    selected = [e for e in index['entries'] if (args.scope == 'all' or e['origin'] == args.scope) and args.match.lower() in e['name'].lower()]
    if args.exclude_match:
        selected = [e for e in selected if args.exclude_match.lower() not in e['name'].lower()]
    if args.exclude_id:
        selected = [e for e in selected if e['id'] != args.exclude_id]
    if args.input_kind in ['vocals', 'lead']:
        selected = [e for e in selected if e['role'] != 'backing_track']
    if args.available_only:
        if args.input_kind == 'lead':
            selected = [e for e in selected if (args.output / 'lead-backing' / e['id'] / 'lead.wav').exists()]
        elif args.input_kind == 'vocals':
            selected = [e for e in selected if e['role'] == 'vocal_stem' or (args.output / 'prepared' / (e['id'] + '.json')).exists()]
    selected = selected[args.shard::args.shards]
    results, failures = [], []
    for entry in selected:
        try:
            entry = dict(entry)
            if args.input_kind == 'vocals' and entry['role'] != 'vocal_stem':
                prepared = json.loads((args.output / 'prepared' / (entry['id'] + '.json')).read_text())
                entry.update(path=prepared['vocals'], role='vocal_stem')
            elif args.input_kind == 'lead':
                entry.update(path=str(args.output / 'lead-backing' / entry['id'] / 'lead.wav'), role='lead_vocal_stem')
            result = globals()[args.command](entry, args)
            summary = {k: v for k, v in result.items() if k not in ['f0', 'raw', 'rms', 'times', 'periodicity']}
            summary.update({'name': entry['name'], 'role': entry['role']})
            results.append(summary)
            print(json.dumps({'done': summary}, ensure_ascii=False), flush=True)
        except Exception as exc:
            failure = {'id': entry['id'], 'name': entry['name'], 'error': str(exc)}
            if isinstance(exc, subprocess.CalledProcessError):
                failure['stderr'] = str(exc.stderr)[-4000:]
            failures.append(failure)
            print(json.dumps({'failed': failure}, ensure_ascii=False), flush=True)
        suffix = f'-shard{args.shard}' if args.shards > 1 else ''
        write_json(args.output / f'{args.command}-{args.label}-{args.scope}{suffix}-summary.json',
                   {'note': 'Independent-model disagreement is not ground-truth accuracy.',
                    'selected': len(selected), 'completed': len(results), 'failures': failures, 'results': results})
    raise SystemExit(bool(failures))


if __name__ == '__main__':
    main()
