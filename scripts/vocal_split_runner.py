#!/usr/bin/env python3
"""UVR MDX Karaoke 2: an existing vocal stem -> lead + backing, locally.

The primary Instrumental output becomes backing on vocal-only input; the
sample-aligned residual is lead. UVR model parameters and STFT conventions:
https://github.com/TRvlvr/application_data/blob/main/mdx_model_data/model_data.json
https://github.com/Anjok07/ultimatevocalremovergui/blob/master/separate.py
https://github.com/Anjok07/ultimatevocalremovergui/blob/master/lib_v5/tfc_tdf_v3.py
UVR and its developers: MIT; see docs/licenses/UVR-MDX-Karaoke-2.txt.
"""
import argparse
import hashlib
import json
from pathlib import Path
import os
import struct
import sys
import numpy as np

MODEL_SHA256 = 'bf32e15105a09c0f7dddd2b67346146334d6f3ecb399ed7638eba2ab07cbf5f4'
FFT, HOP, BINS, FRAMES = 5120, 1024, 2048, 256
CHUNK = HOP * (FRAMES - 1)
TRIM = FFT // 2
WINDOW = np.hanning(FFT + 1)[:-1].astype(np.float32)  # periodic Hann


def stft(audio):
    padded = np.pad(audio, ((0, 0), (TRIM, TRIM)), mode='reflect')
    frames = np.lib.stride_tricks.sliding_window_view(padded, FFT, axis=-1)[:, ::HOP]
    spectrum = np.fft.rfft(frames * WINDOW, axis=-1).transpose(0, 2, 1)[:, :BINS]
    return np.stack((spectrum.real, spectrum.imag), axis=1).reshape(1, 4, BINS, FRAMES).astype(np.float32)


def istft(spectrum):
    values = spectrum.reshape(2, 2, BINS, FRAMES)
    full = np.zeros((2, FFT // 2 + 1, FRAMES), np.complex64)
    full[:, :BINS] = values[:, 0] + 1j * values[:, 1]
    frames = np.fft.irfft(full.transpose(0, 2, 1), n=FFT).astype(np.float32) * WINDOW
    audio = np.zeros((2, CHUNK + FFT), np.float32)
    norm = np.zeros(CHUNK + FFT, np.float32)
    for i in range(FRAMES):
        at = i * HOP
        audio[:, at:at + FFT] += frames[:, i]
        norm[at:at + FFT] += WINDOW * WINDOW
    audio /= np.maximum(norm, 1e-8)
    return audio[:, TRIM:-TRIM]


def split(audio, session, progress=lambda _: None):
    if audio.ndim != 2 or audio.shape[0] != 2 or not np.isfinite(audio).all():
        raise ValueError('Expected finite stereo audio.')
    length = audio.shape[1]
    if not length:
        raise ValueError('The vocal stem is empty.')
    # Same 25% overlap/Hann aggregation as UVR. Extra edge context is discarded.
    mixture = np.pad(audio, ((0, 0), (TRIM, CHUNK)))
    result = np.zeros_like(mixture)
    norm = np.zeros(mixture.shape[1], np.float32)
    step = int(CHUNK * 0.75)
    starts = range(0, length + TRIM, step)
    input_name = session.get_inputs()[0].name
    for index, start in enumerate(starts):
        part = mixture[:, start:start + CHUNK]
        spec = stft(part)
        spec[:, :, :3] = 0  # UVR removes sub-26Hz bins before inference
        prediction = session.run(None, {input_name: spec})[0]
        if prediction.shape != spec.shape or not np.isfinite(prediction).all():
            raise ValueError('The vocal model returned invalid samples.')
        waveform = istft(prediction)
        window = np.hanning(CHUNK).astype(np.float32)
        result[:, start:start + CHUNK] += waveform * window
        norm[start:start + CHUNK] += window
        progress((index + 1) / len(starts))
    backing = (result[:, TRIM:TRIM + length] / np.maximum(norm[TRIM:TRIM + length], 1e-8)) * 1.065
    return audio - backing, backing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', required=True)
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--threads', type=int, default=4)
    parser.add_argument('--cpu', action='store_true', help='Disable CoreML for reference comparison')
    args = parser.parse_args()
    if hashlib.sha256(Path(args.model).read_bytes()).hexdigest() != MODEL_SHA256:
        raise ValueError('The vocal model checksum is wrong. Download it again.')
    import onnxruntime as ort
    try:
        import soundfile as sf
        audio, rate = sf.read(args.input, dtype='float32', always_2d=True)
    except ImportError:
        # The Apple torch pack ships sphn instead of libsndfile. Both return
        # the original sample rate; sphn uses channels-first layout.
        import sphn
        audio, rate = sphn.read(args.input)
        audio = audio.T
    if rate != 44100:
        try:
            import soxr
            audio = soxr.resample(audio, rate, 44100, quality='HQ').astype(np.float32)
        except ImportError:
            from scipy.signal import resample_poly
            from math import gcd
            divisor = gcd(rate, 44100)
            audio = resample_poly(audio, 44100 // divisor, rate // divisor, axis=0).astype(np.float32)
    if audio.shape[1] == 1:
        audio = np.repeat(audio, 2, axis=1)
    if audio.shape[1] != 2:
        raise ValueError('Expected mono or stereo vocals.')
    # https://onnxruntime.ai/docs/api/python/api_summary.html
    opts = ort.SessionOptions()
    opts.intra_op_num_threads = max(1, min(8, args.threads))
    opts.inter_op_num_threads = 1
    # Freezing the exported batch dimension lets CoreML compile this graph.
    # Leaving it symbolic sends the whole graph to CPU with static-shapes=1.
    opts.add_free_dimension_override_by_name('batch_size', 1)
    providers = ['CPUExecutionProvider']
    if not args.cpu and sys.platform == 'darwin' and 'CoreMLExecutionProvider' in ort.get_available_providers():
        providers.insert(0, ('CoreMLExecutionProvider', {
            'ModelFormat': 'MLProgram', 'MLComputeUnits': 'ALL', 'RequireStaticInputShapes': '1'
        }))
    try:
        session = ort.InferenceSession(args.model, sess_options=opts, providers=providers)
    except Exception:
        if len(providers) == 1:
            raise
        print('CoreML could not load this model; using CPU.', file=sys.stderr, flush=True)
        session = ort.InferenceSession(args.model, sess_options=opts, providers=['CPUExecutionProvider'])
    report = lambda p: print(json.dumps({'percent': round(p * 95)}), flush=True)
    try:
        lead, backing = split(audio.T, session, report)
    except Exception:
        if 'CoreMLExecutionProvider' not in session.get_providers():
            raise
        print('CoreML inference failed; retrying on CPU.', file=sys.stderr, flush=True)
        session = ort.InferenceSession(args.model, sess_options=opts, providers=['CPUExecutionProvider'])
        report(0)
        lead, backing = split(audio.T, session, report)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    for name, samples in [('lead', lead), ('backing', backing)]:
        # FLOAT preserves mixture reconstruction even when a residual exceeds 1.
        temporary = output / (name + '.part.wav')
        data = np.ascontiguousarray(samples.T, dtype='<f4').tobytes()
        # Canonical IEEE-float RIFF, readable by desktop/mobile and sphn.
        header = struct.pack('<4sI4s4sIHHIIHH4sI', b'RIFF', 36 + len(data), b'WAVE', b'fmt ', 16,
                             3, 2, 44100, 44100 * 8, 8, 32, b'data', len(data))
        temporary.write_bytes(header + data)
        os.replace(temporary, output / (name + '.wav'))
    print(json.dumps({'percent': 100}), flush=True)


if __name__ == '__main__':
    main()
