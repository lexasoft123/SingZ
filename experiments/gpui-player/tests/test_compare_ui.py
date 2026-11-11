"""Verify that the parity comparator cannot silently accept small/missing defects."""
import importlib.util
from pathlib import Path
import tempfile
import subprocess
import sys
import json
import unittest
from PIL import Image

spec = importlib.util.spec_from_file_location('compare_ui', Path(__file__).with_name('compare-ui.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class CompareTests(unittest.TestCase):
    def run_pair(self, first, second):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first.save(root / 'reference.png')
            second.save(root / 'candidate.png')
            return module.compare(root / 'reference.png', root / 'candidate.png', root / 'diff')

    def test_identical(self):
        image = Image.new('RGBA', (8, 8), (12, 24, 36, 255))
        self.assertTrue(self.run_pair(image, image.copy())['pixel_exact'])

    def test_one_channel_one_pixel_is_failure(self):
        first = Image.new('RGBA', (8, 8), (12, 24, 36, 255))
        second = first.copy()
        second.putpixel((3, 5), (13, 24, 36, 255))
        report = self.run_pair(first, second)
        self.assertFalse(report['pixel_exact'])
        self.assertEqual(report['different_pixels'], 1)
        self.assertEqual(report['difference_bounds'], (3, 5, 4, 6))

    def test_alpha_only_difference_is_failure(self):
        first = Image.new('RGBA', (2, 2), (12, 24, 36, 255))
        second = Image.new('RGBA', (2, 2), (12, 24, 36, 254))
        self.assertEqual(self.run_pair(first, second)['different_pixels'], 4)

    def test_size_mismatch_is_invalid(self):
        with self.assertRaisesRegex(ValueError, 'dimensions differ'):
            self.run_pair(Image.new('RGB', (8, 8)), Image.new('RGB', (9, 8)))

    def test_missing_candidate_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new('RGB', (2, 2)).save(root / 'reference.png')
            with self.assertRaises(FileNotFoundError):
                module.compare(root / 'reference.png', root / 'missing.png', root / 'diff')

    def test_colour_profile_mismatch_is_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new('RGB', (2, 2))
            image.save(root / 'reference.png', icc_profile=b'profile-a')
            image.save(root / 'candidate.png', icc_profile=b'profile-b')
            result = module.compare(root / 'reference.png', root / 'candidate.png', root / 'diff')
            self.assertEqual(result['different_pixels'], 0)
            self.assertFalse(result['pixel_exact'])

    def test_invalid_cli_clears_previous_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'report.json').write_text('{"pixel_exact":true}')
            result = subprocess.run([sys.executable, str(Path(__file__).with_name('compare-ui.py')),
                '--reference', str(root / 'missing.png'), '--candidate', str(root / 'missing2.png'),
                '--out', str(root)], capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertFalse(json.loads((root / 'report.json').read_text())['pixel_exact'])

    def test_same_path_is_invalid(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'same.png'
            Image.new('RGB', (2, 2)).save(path)
            with self.assertRaisesRegex(ValueError, 'separate files'):
                module.compare(path, path, Path(directory) / 'diff')


if __name__ == '__main__':
    unittest.main()
