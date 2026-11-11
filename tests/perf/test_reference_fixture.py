import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

class ReferenceFixtureTest(unittest.TestCase):
    def test_reference_projects_have_complete_current_analysis(self):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / 'fixture'
            result = subprocess.run(['node', str(ROOT / 'tests/perf/make_reference.cjs'), str(dest)], capture_output=True, text=True, check=True)
            ref = json.loads(result.stdout)
            self.assertEqual(ref['durationS'], 300)
            self.assertEqual(ref['stemCount'], 6)
            headers = {'melody': ('melody.h', 'kPitchDetectVersion'), 'beat': ('beats.h', 'kBeatDetectVersion'), 'key': ('analysis.h', 'kKeyDetectVersion')}
            versions = {key: int(re.search(r'constexpr int ' + name + r'\s*=\s*(\d+)', (ROOT / 'zcore/include/zcore/legacy' / file).read_text()).group(1)) for key, (file, name) in headers.items()}
            for project, duration in zip(ref['projects'], (300, 720)):
                p = Path(project)
                doc = json.loads((p / 'project.json').read_text())
                lyrics = json.loads((p / 'lyrics.json').read_text())
                self.assertGreater(lyrics['lines'][-1]['start'], duration * .9)
                self.assertEqual(len(list((p / 'stems').glob('*.flac'))), 6)
                self.assertGreater(len(doc['settings']['melody']['f0'].split()), duration * 20)
                self.assertGreater(len(doc['settings']['beat']['beats']), duration)
                for key, version in versions.items():
                    self.assertEqual(doc['settings'][key]['detVersion'], version)
                measured = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(p / 'stems/vocals.flac')]))
                self.assertAlmostEqual(measured, duration, places=2)
