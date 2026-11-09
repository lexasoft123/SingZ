"""Observer identity race checks with owned real CLI children; no GUI launches."""
import importlib.util
from pathlib import Path
import subprocess
import unittest

spec = importlib.util.spec_from_file_location('lyrics_scroll_observer', Path(__file__).with_name('test_native_lyrics_scroll.py'))
observer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(observer)


class AppIdentityTests(unittest.TestCase):
    def live_child(self):
        child = subprocess.Popen(['/bin/sleep', '10'])
        self.addCleanup(self.retire, child)
        # Identity is a controlled ps-row fixture; child liveness/exit is real.
        identity = {'pid': child.pid, 'start': 'controlled child start', 'command': '/bin/sleep'}
        return child, identity

    @staticmethod
    def retire(child):
        if child.poll() is None:
            child.terminate()
        child.wait(timeout=2)

    def test_stable_live_identity_is_accepted(self):
        child, expected = self.live_child()
        records = []
        actual = dict(expected)
        self.assertFalse(observer.observe_app_identity(child, expected, actual, .2, records))
        self.assertEqual(records, [])
        self.assertIsNone(child.poll())

    def test_live_mismatch_fails_and_keeps_raw_identity(self):
        child, expected = self.live_child()
        # Deliberate process-table mismatch, while the actual owned child stays live.
        actual = dict(expected, command='different process-table command')
        records = []
        with self.assertRaisesRegex(AssertionError, 'remains live'):
            observer.observe_app_identity(child, expected, actual, 1.25, records)
        self.assertIsNone(child.poll())
        self.assertEqual(records[0]['expected'], expected)
        self.assertEqual(records[0]['actual'], actual)
        self.assertEqual(records[0]['elapsedSeconds'], 1.25)
        self.assertFalse(records[0]['terminalVerified'])
        self.assertEqual(records[0]['status'], 'rejected-live-identity-mismatch')

    def test_terminal_mismatch_is_verified_and_discarded(self):
        child = subprocess.Popen(['/usr/bin/true'])
        self.addCleanup(self.retire, child)
        expected = {'pid': child.pid, 'start': 'previously observed identity', 'command': '/usr/bin/true'}
        records = []
        self.assertTrue(observer.observe_app_identity(child, expected, None, 2.5, records))
        self.assertEqual(child.returncode, 0)
        self.assertEqual(records[0]['expected'], expected)
        self.assertIsNone(records[0]['actual'])
        self.assertTrue(records[0]['terminalVerified'])
        self.assertEqual(records[0]['returncode'], 0)
        self.assertEqual(records[0]['status'], 'discarded-verified-terminal-identity-mismatch')


class ResourceCounterTests(unittest.TestCase):
    live_child = AppIdentityTests.live_child
    retire = staticmethod(AppIdentityTests.retire)
    @staticmethod
    def raw(footprint=1024):
        return {'elapsedSeconds': 2.5, 'cpuNanoseconds': 1234.,
                'footprintBytes': footprint, 'cpuPercent': 0.}

    def test_valid_resource_read_is_accepted(self):
        child, _ = self.live_child()
        raw = self.raw()
        errors, discards = [], []
        self.assertTrue(observer.valid_resource_or_terminal(child, raw, errors, discards))
        self.assertEqual(errors, [])
        self.assertEqual(discards, [])
        self.assertIsNone(child.poll())

    def test_live_invalid_resource_fails_and_preserves_raw(self):
        child, _ = self.live_child()
        raw = self.raw(footprint=0)
        errors, discards = [], []
        with self.assertRaisesRegex(AssertionError, 'remains live'):
            observer.valid_resource_or_terminal(child, raw, errors, discards)
        self.assertIsNone(child.poll())
        self.assertEqual(discards, [])
        self.assertEqual(errors[0]['footprintBytes'], 0)
        self.assertEqual(errors[0]['cpuNanoseconds'], raw['cpuNanoseconds'])
        self.assertFalse(errors[0]['terminalVerified'])

    def test_terminal_invalid_resource_is_discarded_not_measured(self):
        child = subprocess.Popen(['/usr/bin/true'])
        self.addCleanup(self.retire, child)
        raw = self.raw(footprint=0)
        errors, discards = [], []
        self.assertFalse(observer.valid_resource_or_terminal(child, raw, errors, discards))
        self.assertEqual(child.returncode, 0)
        self.assertEqual(errors, [])
        self.assertEqual(discards[0]['footprintBytes'], 0)
        self.assertEqual(discards[0]['returncode'], 0)
        self.assertTrue(discards[0]['terminalVerified'])
        self.assertEqual(discards[0]['status'], 'discarded-verified-terminal-invalid-resource')


if __name__ == '__main__':
    unittest.main()
