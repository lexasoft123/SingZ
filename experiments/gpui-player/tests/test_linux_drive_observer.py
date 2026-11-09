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
from unittest.mock import Mock

from PIL import Image


RUNNER = Path(__file__).with_name('run_linux_ui.py')
tree = ast.parse(RUNNER.read_text())
validator = next(node for node in tree.body
                 if isinstance(node, ast.FunctionDef) and node.name == 'qualify_drive_workflow')
CODE = compile(ast.Module(body=[validator], type_ignores=[]), str(RUNNER), 'exec')
PROCESS_CODE = compile(ast.Module(body=[node for node in tree.body
    if isinstance(node, ast.FunctionDef) and node.name in
    ('process', 'processes', 'same_live', 'stop_owned')], type_ignores=[]), str(RUNNER), 'exec')


class ProcessObserverTests(unittest.TestCase):
    def setUp(self):
        self.path = Mock()
        self.context = dict(Path=self.path, page=4096, owned={}, paths={Path('/app/player'): 'ui'},
                            os=Mock(), signal=Mock())
        exec(PROCESS_CODE, self.context)
        self.owner = dict(pid=22, startTicks='100', executable=Path('/app/player'))

    def inventory(self, *pids):
        self.path.return_value.iterdir.return_value = [SimpleNamespace(name=str(pid)) for pid in pids]

    def test_inaccessible_foreign_process_does_not_hide_observable_app(self):
        self.inventory(1, 22)
        self.context['process'] = Mock(side_effect=[PermissionError('/proc/1/exe'), self.owner])
        self.assertEqual(list(self.context['processes']()), [self.owner])

    def test_inaccessible_previously_owned_pid_is_not_reported_absent(self):
        self.inventory(22)
        self.context['owned'][(22, '100')] = self.owner
        self.context['process'] = Mock(side_effect=PermissionError('/proc/22/exe'))
        with self.assertRaises(PermissionError):
            list(self.context['processes']())

    def test_direct_identity_and_owned_liveness_keep_permission_failure(self):
        self.path.return_value.read_text.side_effect = PermissionError('/proc/22/stat')
        with self.assertRaises(PermissionError):
            self.context['process'](22)
        with self.assertRaises(PermissionError):
            self.context['same_live'](self.owner)

    def test_readable_stat_does_not_turn_denied_executable_into_absence(self):
        fields = ['S'] + ['0'] * 21
        fields[19], fields[21] = '100', '1'
        self.path.return_value.read_text.return_value = '22 (native player) ' + ' '.join(fields)
        self.path.return_value.resolve.side_effect = PermissionError('/proc/22/exe')
        with self.assertRaises(PermissionError):
            self.context['process'](22)

    def test_cleanup_closes_pidfd_but_never_signals_unverified_identity(self):
        self.context['os'].pidfd_open.return_value = 71
        self.context['process'] = Mock(side_effect=PermissionError('/proc/22/exe'))
        with self.assertRaises(PermissionError):
            self.context['stop_owned'](self.owner, 15)
        self.context['os'].close.assert_called_once_with(71)
        self.context['signal'].pidfd_send_signal.assert_not_called()

    def test_recycled_pid_still_cannot_receive_cleanup_signal(self):
        self.context['os'].pidfd_open.return_value = 71
        self.context['process'] = Mock(return_value={**self.owner, 'startTicks': '101', 'state': 'S'})
        self.context['stop_owned'](self.owner, 15)
        self.context['signal'].pidfd_send_signal.assert_not_called()
        self.context['os'].close.assert_called_once_with(71)

    def test_disappeared_process_remains_distinct_from_inaccessible(self):
        self.path.return_value.read_text.side_effect = FileNotFoundError('/proc/22/stat')
        self.assertIsNone(self.context['process'](22))


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
