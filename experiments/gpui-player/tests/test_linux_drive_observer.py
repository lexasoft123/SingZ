"""Adversarial receipt checks; no X server, app launch or platform qualification.

Compile the runner's validator alone because importing the entry point starts
its private display. Fixtures deliberately separate driver claims from the
independent process/window/resource observations that must substantiate them.
"""
import ast
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

from PIL import Image


RUNNER = Path(__file__).with_name('run_linux_ui.py')
tree = ast.parse(RUNNER.read_text())
validator = next(node for node in tree.body
                 if isinstance(node, ast.FunctionDef) and node.name == 'qualify_drive_workflow')
CODE = compile(ast.Module(body=[validator], type_ignores=[]), str(RUNNER), 'exec')


class DriveObserverTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='singz-drive-observer-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.out = Path(self.temporary.name)
        self.app = self.out / 'bin/singz-gpui-player'
        self.app.parent.mkdir()
        self.app.write_bytes(b'unit app identity')
        self.app.with_name('singz-gpui-audio').write_bytes(b'unit helper identity')
        self.sha = lambda path: hashlib.sha256(path.read_bytes()).hexdigest()
        self.context = dict(out=self.out, app=self.app, json=json, sha=self.sha, Image=Image,
                            args=SimpleNamespace(case='drive-retirement'),
                            artifacts=[{'file': path.name, 'sha256': self.sha(path)}
                                       for path in self.app.parent.iterdir()],
                            owned={}, samples=[], frames={}, workflow_evidence=[])
        exec(CODE, self.context)

    def write(self, relative, value):
        path = self.out / 'workflow' / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value))

    def change(self, relative, **values):
        path = self.out / 'workflow' / relative
        value = json.loads(path.read_text())
        value.update(values)
        self.write(relative, value)

    def fixture(self, empty=False):
        for key in ('owned', 'samples', 'frames', 'workflow_evidence'):
            self.context[key].clear()
        self.context['args'].case = 'drive-empty' if empty else 'drive-retirement'
        roles = ('writer', 'reader', 'offline') if empty else ('writer',)
        runs = []
        identities = {row['file']: row['sha256'] for row in self.context['artifacts']}
        hashes = dict(appSha256=identities[self.app.name],
                      helperSha256=identities['singz-gpui-audio'])
        for width in (1280, 1060):
            for role in roles:
                pid = 100 + len(runs)
                ticks = str(pid * 100)
                folder = f'{width}/{role}'
                runs.append(dict(width=width, role=role))
                self.write(f'{folder}/result.json', dict(passed=True, actualControls=True,
                           hidden=True, muted=True, physicalInput=False))
                self.write(f'{folder}/process-exit.json', dict(pid=pid, terminal=True,
                           returncode=0, forcedStop=False,
                           survivorsBeforeCleanup=[], survivorsAfterCleanup=[]))
                owner = dict(pid=pid, startTicks=ticks, role='ui', executable=str(self.app))
                self.context['owned'][(pid, ticks)] = owner
                self.context['samples'].append(dict(**owner, rssBytes=4096, cpuPercentOneCore=0.0))
                self.context['frames'][(pid, ticks, 1)] = dict(pid=pid, startTicks=ticks,
                                                            width=width * 2, height=1600)
                Image.new('1', (width * 2, (800 if width == 1280 else 640) * 2)).save(
                    self.out / 'workflow' / folder / 'capture.png')
            if empty:
                self.write(f'{width}/fixture.json', dict(passed=True, width=width, **hashes,
                           writerSyncDisabled=False, readerSyncDisabled=True))
                for path in ('writer/commit-proof.json', 'recovery-journals.json', 'readonly-reader-remote.json'):
                    self.write(f'{width}/{path}', {})
            else:
                self.write(f'{width}/lineage-proof.json', dict(passed=True))
                self.write(f'{width}/remote-final.json', {})
        self.write('result.json', dict(passed=True, noNode=True, **hashes, runs=runs,
                   requestedWidths=[1280, 1060], sizes=[dict(width=1280), dict(width=1060)]))

    def qualify(self):
        self.context['qualify_drive_workflow']()

    def test_complete_retirement_evidence(self):
        self.fixture()
        self.qualify()
        self.assertEqual(len(self.context['workflow_evidence']), 9)

    def test_complete_empty_evidence(self):
        self.fixture(empty=True)
        self.qualify()
        self.assertEqual(len(self.context['workflow_evidence']), 21)

    def test_rejects_driver_success_without_independent_evidence(self):
        for missing in ('owned', 'samples', 'frames'):
            with self.subTest(missing=missing):
                self.fixture()
                original = self.context[missing]
                self.context[missing] = [] if missing == 'samples' else {}
                with self.assertRaises(AssertionError):
                    self.qualify()
                self.context[missing] = original

    def test_rejects_recycled_pid_resource_sample(self):
        self.fixture()
        self.context['samples'][0]['startTicks'] = 'foreign process'
        with self.assertRaisesRegex(AssertionError, 'CPU/RSS'):
            self.qualify()

    def test_rejects_recycled_pid_window(self):
        self.fixture()
        next(iter(self.context['frames'].values()))['startTicks'] = 'foreign process'
        with self.assertRaisesRegex(AssertionError, 'window'):
            self.qualify()

    def test_rejects_missing_sample_for_one_run(self):
        self.fixture(empty=True)
        self.context['samples'].pop()
        with self.assertRaisesRegex(AssertionError, 'CPU/RSS'):
            self.qualify()

    def test_rejects_unexpected_input_helper(self):
        self.fixture()
        self.context['owned'][(999, '999')] = dict(pid=999, startTicks='999', role='helper',
                                                  executable=str(self.app.with_name('singz-gpui-input')))
        with self.assertRaisesRegex(AssertionError, 'input helper'):
            self.qualify()

    def test_rejects_forced_exit(self):
        self.fixture()
        self.change('1280/writer/process-exit.json', forcedStop=True)
        with self.assertRaises(AssertionError):
            self.qualify()

    def test_rejects_partial_matrix(self):
        self.fixture()
        self.change('result.json', requestedWidths=[1280])
        with self.assertRaises(AssertionError):
            self.qualify()

    def test_rejects_wrong_binary(self):
        self.fixture()
        self.change('result.json', helperSha256='unrelated helper')
        with self.assertRaises(AssertionError):
            self.qualify()

    def test_rejects_wrong_capture_dimensions(self):
        self.fixture()
        Image.new('1', (1, 1)).save(self.out / 'workflow/1060/writer/capture.png')
        with self.assertRaises(AssertionError):
            self.qualify()

    def test_rejects_reader_with_sync_enabled(self):
        self.fixture(empty=True)
        self.change('1060/fixture.json', readerSyncDisabled=False)
        with self.assertRaises(AssertionError):
            self.qualify()


if __name__ == '__main__':
    unittest.main()
