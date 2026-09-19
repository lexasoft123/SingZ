#!/usr/bin/env python3
"""Full-duration recording evaluation with bounded, resumable audio chunks.

Run only after the regular corpus finishes. No entire-recording PCM array is
loaded: model stages see at most195.04 seconds. Native/CREPE tracks are stitched
on exact shared hop boundaries; context predictions are discarded. This is an
explicit chunked evaluation protocol, not whole-recording Viterbi decoding.
"""
import argparse
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from types import SimpleNamespace

sys.dont_write_bytecode = True

import numpy as np
import soundfile as sf

spec = importlib.util.spec_from_file_location('corpus', Path(__file__).with_name('pitch-corpus.py'))
corpus = importlib.util.module_from_spec(spec)
spec.loader.exec_module(corpus)

SR = 44100
COMMON = 162288  # lcm(1104 native input hop, 882 CREPE input hop)
CORE = COMMON * 49  #180.32 seconds, exact hop boundaries for both trackers
CONTEXT = COMMON * 2  #7.36 seconds each side


def ensure_input_wav(source, destination, decoder=None):
    """Reuse only a complete decode bound to both source and decoded bytes.

    The final WAV is published atomically before its completion record. A kill
    between those operations causes a conservative regeneration on the next run.
    The injectable decoder is used by the interruption/provenance regression.
    """
    source_hash = corpus.sha256(source)
    completion = destination.with_suffix('.wav.complete.json')
    if destination.exists() and completion.exists():
        try:
            saved = json.loads(completion.read_text())
            if (saved['source_sha256'] == source_hash
                    and saved['decoded_bytes'] == destination.stat().st_size
                    and saved['decoded_sha256'] == corpus.sha256(destination)):
                info = sf.info(destination)
                if (info.samplerate == SR and info.channels == 2
                        and info.frames == saved['samples'] and info.frames > 0):
                    return destination, info, saved
        except (ValueError, KeyError, OSError, RuntimeError):
            pass  # A damaged or incomplete completion record is never a hit.
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.decode-incomplete.wav')
    try:
        if decoder is None:
            subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-y', '-i', str(source),
                            '-ar', str(SR), '-ac', '2', '-c:a', 'pcm_f32le', str(temporary)], check=True)
        else:
            decoder(source, temporary)
        info = sf.info(temporary)
        if info.samplerate != SR or info.channels != 2 or info.frames <= 0:
            raise ValueError('Decoded recording must be nonempty44100Hz stereo audio')
        last, _ = sf.read(temporary, start=info.frames-1, frames=1, always_2d=True)
        if len(last) != 1:
            raise ValueError('Decoded recording has a truncated final frame')
        if corpus.sha256(source) != source_hash:
            raise ValueError('Source recording changed during decoding; retry with a stable source')
        saved = {'source_path': str(source), 'source_sha256': source_hash,
                 'decoded_sha256': corpus.sha256(temporary), 'decoded_bytes': temporary.stat().st_size,
                 'samples': info.frames, 'sample_rate': SR, 'channels': 2}
        temporary.replace(destination)
        corpus.write_json(completion, saved)
        return destination, info, saved
    finally:
        if temporary.exists():
            temporary.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=Path('/private/tmp/singz-pitch-eval'))
    parser.add_argument('--id', default='downloads-727a78936b19')
    parser.add_argument('--updated-bin', type=Path, default=Path('/private/tmp/singz-pitch-eval/conservative/singz-analyze'))
    parser.add_argument('--wait-for-regular', action='store_true')
    args = parser.parse_args()
    root = args.output
    manifest = json.loads((root / 'manifest.json').read_text())
    entry = next(e for e in manifest['entries'] if e['id'] == args.id)
    excluded = root / 'master-recording-excluded.json'

    def check_excluded():
        if excluded.exists():
            raise SystemExit('Recording excluded by user; stopped before next bounded chunk.')

    if args.wait_for_regular:
        print(json.dumps({'waiting': 'All regular native and vocal/lead reference results'}), flush=True)
        while True:
            check_excluded()
            pending = []
            for other in manifest['entries']:
                if other['id'] == args.id:
                    continue
                labels = ['baseline', 'updated']
                if other['role'] != 'backing_track':
                    labels += ['updated-lead', 'reference', 'reference-lead']
                if any(not (root / label / (other['id'] + '.json')).exists() for label in labels):
                    pending.append(other['id'])
            if not pending:
                break
            time.sleep(5)
    check_excluded()
    work = root / 'long-recording'
    work.mkdir(parents=True, exist_ok=True)
    original_wav, info, decoded = ensure_input_wav(Path(entry['path']), root / 'demucs' / args.id / 'input.wav')
    total = info.frames
    options = SimpleNamespace(output=work, input_kind='original', threads=2, model='full',
        device='mps', batch_size=128, baseline_bin=root / 'baseline/singz-analyze',
        updated_bin=args.updated_bin, bin=None, label='baseline',
        separator_model=root / 'models/UVR_MDXNET_KARA_2.onnx',
        separator_runner=Path(__file__).resolve().parents[1] / 'scripts/vocal_split_runner.py',
        demucs_pack=Path.home() / 'Library/Application Support/SingZ/gpu-splitter/python')
    protocol = {'source': entry['path'], 'source_sha256': decoded['source_sha256'],
                'decoded_input_sha256': decoded['decoded_sha256'],
                'sample_rate': SR, 'total_samples': total, 'core_samples': CORE,
                'context_samples': CONTEXT, 'core_seconds': CORE / SR,
                'context_seconds': CONTEXT / SR, 'native_hop_samples': 1104,
                'reference_hop_samples': 882, 'demucs_seed': 0,
                'note': 'Each stage runs on overlapping bounded chunks. Context is discarded; Viterbi does not span the entire recording. All samples are covered.'}
    corpus.write_json(work / 'protocol.json', protocol)
    results = []
    for chunk_index, start in enumerate(range(0, total, CORE)):
        check_excluded()
        end = min(total, start + CORE)
        low, high = max(0, start - CONTEXT), min(total, end + CONTEXT)
        chunk_id = f'{args.id}-chunk{chunk_index:03d}'
        dest = work / 'demucs' / chunk_id
        dest.mkdir(parents=True, exist_ok=True)
        vocals = dest / 'htdemucs_6s/vocals.wav'
        done = dest / 'complete.json'
        marker = {'source_sha256': protocol['source_sha256'], 'decoded_input_sha256': decoded['decoded_sha256'],
                  'start': start, 'end': end,
                  'low': low, 'high': high, 'model': 'htdemucs_6s', 'seed': 0}
        if not done.exists() or json.loads(done.read_text()) != marker or not vocals.exists():
            audio, rate = sf.read(original_wav, start=low, frames=high-low,
                                  dtype='float32', always_2d=True)
            source_chunk = dest / 'input.wav'
            sf.write(source_chunk, audio, rate, subtype='FLOAT')
            del audio
            env = dict(os.environ, HF_HUB_OFFLINE='1', PYTHONUNBUFFERED='1',
                       TORCH_HOME=str(options.demucs_pack / 'torch-home'),
                       HF_HOME=str(options.demucs_pack / 'hf-home'))
            # Keep the model's standard shift average but make each retry repeatable.
            seeded_module = 'import random,torch,runpy;random.seed(0);torch.manual_seed(0);runpy.run_module("demucs",run_name="__main__")'
            with (dest / 'run.log').open('w') as log:
                subprocess.run([str(options.demucs_pack / 'bin/python3'), '-c', seeded_module,
                    '-n', 'htdemucs_6s', '-d', 'mps', '--float32', '--clip-mode', 'none',
                    '--two-stems', 'vocals', '--other-method', 'none', '--filename', '{stem}.{ext}',
                    '-o', str(dest), str(source_chunk)], env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
            corpus.write_json(done, marker)
            source_chunk.unlink()
        chunk_entry = dict(entry, id=chunk_id, path=str(vocals), role='vocal_stem',
                           name=f"{entry['name']} chunk{chunk_index+1}")
        tracks = {}
        options.input_kind, options.bin, options.label = 'original', options.baseline_bin, 'baseline'
        tracks['baseline'] = corpus.native(chunk_entry, options)
        options.bin, options.label = options.updated_bin, 'updated'
        tracks['updated'] = corpus.native(chunk_entry, options)
        tracks['reference'] = corpus.reference(chunk_entry, options)
        separation = corpus.separate(chunk_entry, options)
        lead_entry = dict(chunk_entry, path=separation['lead'], role='lead_vocal_stem')
        options.input_kind, options.label = 'lead', 'updated-lead'
        tracks['updated-lead'] = corpus.native(lead_entry, options)
        tracks['reference-lead'] = corpus.reference(lead_entry, options)
        row = dict(marker, id=chunk_id, vocals=str(vocals), separation=separation,
                   track_files={label: str(work / label / (chunk_id + '.json')) for label in tracks})
        results.append(row)
        corpus.write_json(work / 'completed-chunks.json', results)
        print(json.dumps({'completed_chunk': chunk_index + 1,
                          'chunks': (total + CORE - 1) // CORE,
                          'covered_seconds': end / SR}), flush=True)
    check_excluded()
    assemble(root, work, entry, results, protocol)


def assemble(root, work, entry, chunks, protocol):
    """Stream core audio to final WAVs and splice exact-hop prediction arrays."""
    total = protocol['total_samples']
    vocal_destination = root / 'demucs' / entry['id'] / 'htdemucs_6s/vocals.wav'
    separation_destination = root / 'lead-backing' / entry['id']
    vocal_destination.parent.mkdir(parents=True, exist_ok=True)
    separation_destination.mkdir(parents=True, exist_ok=True)
    destinations = {'vocals': vocal_destination, 'lead': separation_destination / 'lead.wav',
                    'backing': separation_destination / 'backing.wav'}
    hashes = {'vocals': hashlib.sha256(), 'lead': hashlib.sha256()}
    for kind, destination in destinations.items():
        temporary = destination.with_suffix('.assembling.wav')
        with sf.SoundFile(temporary, 'w', samplerate=SR, channels=2, subtype='FLOAT') as writer:
            for row in chunks:
                source = row['vocals'] if kind == 'vocals' else row['separation'][kind]
                low = row['start'] - row['low']
                count = row['end'] - row['start']
                audio, _ = sf.read(source, start=low, frames=count, dtype='float32', always_2d=True)
                if len(audio) != count:
                    raise ValueError('Incomplete chunk while assembling audio')
                writer.write(audio)
                if kind in hashes:
                    pcm = work / 'decoded' / (row['id'] + ('-lead' if kind == 'lead' else '') + '.f32')
                    values = np.memmap(pcm, dtype='<f4', mode='r')
                    hashes[kind].update(values[low:low+count].tobytes())
                    del values
                del audio
        temporary.replace(destination)
    for label in ['baseline', 'updated', 'reference', 'updated-lead', 'reference-lead']:
        is_reference = label.startswith('reference')
        step_samples = 882 if is_reference else 1104
        frame_count = (total + 881) // 882 if is_reference else max(0, (total // 3 - 1024) // 368)
        fields = ['f0', 'periodicity'] if is_reference else ['f0', 'raw', 'rms']
        arrays = {key: np.zeros(frame_count, dtype=np.float32) for key in fields}
        assigned = np.zeros(frame_count, dtype=bool)
        template, elapsed = None, 0
        for row in chunks:
            data = json.loads(Path(row['track_files'][label]).read_text())
            template = data
            elapsed += data['seconds']
            count = len(data['f0'])
            indices = row['low'] // step_samples + np.arange(count)
            centers = indices * step_samples + (0 if is_reference else 1536)
            keep = (centers >= row['start']) & (centers < row['end']) & (indices < frame_count)
            for field in fields:
                arrays[field][indices[keep]] = np.asarray(data[field], dtype=np.float32)[keep]
            assigned[indices[keep]] = True
        if not assigned.all():
            raise ValueError(f'{label}: {int((~assigned).sum())} missing assembled frames')
        result = {key: value for key, value in template.items() if key not in ['f0', 'raw', 'rms', 'times', 'periodicity']}
        result.update({key: values.astype(float).tolist() for key, values in arrays.items()})
        kind = 'lead' if label.endswith('-lead') else 'vocals'
        result.update(id=entry['id'], frames=frame_count, seconds=elapsed, duration=total/SR,
                      pcm_sha256=hashes[kind].hexdigest(), input_path=str(destinations[kind]),
                      input_role='lead_vocal_stem' if kind == 'lead' else 'vocal_stem',
                      bounded_chunk_protocol=protocol)
        if is_reference:
            result['times'] = (np.arange(frame_count) * .02).tolist()
        corpus.write_json(root / label / (entry['id'] + '.json'), result)
    corpus.write_json(root / 'prepared' / (entry['id'] + '.json'),
        {'id': entry['id'], 'vocals': str(vocal_destination), 'method': 'htdemucs_6s_bounded_chunks',
         'source_sha256': protocol['source_sha256'], 'bounded_chunk_protocol': protocol})
    import onnxruntime as ort
    corpus.write_json(separation_destination / 'evaluation.json',
        {'id': entry['id'], 'seconds': sum(row['separation']['seconds'] for row in chunks),
         'lead': str(destinations['lead']), 'backing': str(destinations['backing']),
         'signature': {'source_sha256': corpus.sha256(vocal_destination),
                       'model_sha256': chunks[0]['separation']['signature']['model_sha256'],
                       'onnxruntime_version': ort.__version__, 'bounded_chunk_protocol': protocol}})
    print(json.dumps({'complete': entry['name'], 'duration_seconds': total/SR,
                      'chunks': len(chunks), 'protocol': str(work / 'protocol.json')}), flush=True)


if __name__ == '__main__':
    main()
