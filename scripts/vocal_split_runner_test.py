"""Numerical contract tests; no sound output, network or model needed.
Run with a Python containing numpy; optional --model exercises real silence.
"""
import unittest
import numpy as np
import vocal_split_runner as runner

class IdentitySession:
    def get_inputs(self):
        return [type('Input', (), {'name': 'input'})()]
    def run(self, _, inputs):
        return [inputs['input']]

class VocalSplitTests(unittest.TestCase):
    def test_roundtrip_bandlimited_stereo(self):
        t = np.arange(runner.CHUNK) / 44100
        audio = np.stack((.3*np.sin(2*np.pi*220*t), .2*np.cos(2*np.pi*440*t))).astype('float32')
        out = runner.istft(runner.stft(audio))
        # Band truncation can affect reflected boundaries; central samples must
        # reconstruct at their original index and channel.
        self.assertLess(np.max(np.abs(out[:, runner.FFT:-runner.FFT] - audio[:, runner.FFT:-runner.FFT])), 1e-5)

    def test_short_silence_and_real_length_reconstruct(self):
        for length in (1, 127, 4410, runner.CHUNK, runner.CHUNK + 17):
            audio = np.zeros((2, length), 'float32')
            if length > 1:
                t = np.arange(length)/44100
                audio[0] = .2*np.sin(2*np.pi*110*t)
                audio[1] = .1*np.sin(2*np.pi*330*t)
            lead, backing = runner.split(audio, IdentitySession())
            self.assertEqual(lead.shape, audio.shape)
            self.assertTrue(np.isfinite(lead).all() and np.isfinite(backing).all())
            self.assertLess(np.max(np.abs(lead + backing - audio)), 1e-7)

    def test_silence_stays_silent(self):
        lead, backing = runner.split(np.zeros((2, 1000), 'float32'), IdentitySession())
        self.assertEqual(np.count_nonzero(lead), 0)
        self.assertEqual(np.count_nonzero(backing), 0)

    def test_invalid_and_empty_audio_rejected(self):
        for bad in (np.empty((2, 0)), np.full((2, 10), np.nan), np.zeros((3, 10))):
            with self.assertRaises(ValueError):
                runner.split(bad, IdentitySession())

if __name__ == '__main__':
    unittest.main()
