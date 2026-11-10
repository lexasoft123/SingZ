import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("perf_harness", Path(__file__).with_name("perf_harness.py"))
perf = importlib.util.module_from_spec(spec); spec.loader.exec_module(perf)


def report(**metadata):
    phases = [{"name": n, "durationS": 0, "deadlineS": 1} for n in perf.PHASES]
    return {"schema": perf.SCHEMA, "complete": True, "run": {"app": "native", "buildProfile": "release",
            "displayMode": "hidden", "machine": "mac", "commit": "abc", **metadata}, "phases": phases,
            "metrics": {"processTreeCpu": {"cpuPercent": 1}, "footprintBytes": 1, "startupMs": 1, "songOpenMs": 1,
                        "starvedBlocks": {"lanes": {}}, "packageSizeBytes": 1,
                        "frames": {"fps": None, "frameTimeMs": None, "dropped": None}}}


class SchemaTests(unittest.TestCase):
    def test_complete_report_is_valid(self):
        perf.validate_report(report())

    def test_missing_identity_is_rejected(self):
        for key in ("buildProfile", "displayMode", "machine", "commit"):
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                perf.validate_report(report(**{key: ""}))

    def test_frames_are_reserved_for_c07(self):
        value = report(); value["metrics"]["frames"]["fps"] = 60
        with self.assertRaisesRegex(ValueError, "null"):
            perf.validate_report(value)

    def test_incomplete_scenario_is_rejected(self):
        value = report(); value["phases"] = value["phases"][:-1]
        with self.assertRaises(ValueError): perf.validate_report(value)

    def test_cli_refuses_a_run_without_identity(self):
        with self.assertRaises(SystemExit):
            perf.main(["--app", "native", "--command", "true", "--out", "/tmp/unused.json"])


if __name__ == "__main__": unittest.main()

class RunnerSafetyTests(unittest.TestCase):
    def test_missing_action_driver_is_rejected_before_launch(self):
        from unittest.mock import patch
        args = __import__('argparse').Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=1, burst=1, pause=1, cycles=1, cycle_duration=1, deadline=120, command='true', action_command=None, package=None)
        with patch.object(perf.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(ValueError, 'action'):
                perf.run(args)
            launch.assert_not_called()

    def test_missing_frame_fields_are_rejected(self):
        value = report()
        del value['metrics']['frames']['fps']
        with self.assertRaisesRegex(ValueError, 'frame'):
            perf.validate_report(value)

    def test_deadline_must_cover_phase_duration(self):
        value = report()
        value['phases'][2]['durationS'] = 180
        with self.assertRaisesRegex(ValueError, 'deadline'):
            perf.validate_report(value)

    def test_open_timing_measures_action_not_time_since_launch(self):
        from unittest.mock import patch, MagicMock
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=120, command='true', action_command='driver', package=__file__)
        proc = MagicMock(pid=123); proc.poll.return_value = None
        clock = iter([0, 10, 11, 11, 13, 13, 13, 13, 13, 13, 13, 13, 13])
        with patch.object(perf.subprocess, 'Popen', return_value=proc), patch.object(perf, 'sample_tree', return_value={'footprintBytes': 1, 'cpuPercent': 1}), patch.object(perf, '_command'), patch.object(perf.os, 'killpg'), patch.object(perf.time, 'monotonic', side_effect=lambda: next(clock, 13)):
            result = perf.run(args)
        self.assertEqual(result['metrics']['songOpenMs'], 2000)
        self.assertEqual(result['phases'][1]['durationS'], 2)

    def test_launch_enforces_hidden_and_muted(self):
        from unittest.mock import patch, MagicMock
        from argparse import Namespace
        args = Namespace(app='electron', profile='build', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=120, command='true', action_command='driver', package=__file__)
        proc = MagicMock(pid=123); proc.poll.return_value = None
        with patch.object(perf.subprocess, 'Popen', return_value=proc) as launch, patch.object(perf, 'sample_tree', return_value={'footprintBytes': 1, 'cpuPercent': 1}), patch.object(perf, '_command'), patch.object(perf.os, 'killpg'):
            perf.run(args)
        env = launch.call_args.kwargs['env']
        self.assertEqual(env['SINGZ_MUTE'], '1')
        self.assertEqual(env['SINGZ_NO_SYNC'], '1')
        self.assertEqual(env['SINGZ_E2E_HIDDEN'], '1')
        self.assertEqual(env['SINGZ_GPUI_BACKGROUND'], '1')

class EvaluatorTests(unittest.TestCase):
    def test_budget_checks_fail_on_regression_and_missing_measurement(self):
        self.assertEqual(perf.evaluate_budget({'startupMs': 90}, {'startupMs': 100}), [])
        self.assertTrue(perf.evaluate_budget({'startupMs': 101}, {'startupMs': 100}))
        self.assertTrue(perf.evaluate_budget({'startupMs': None}, {'startupMs': 100}))

    def test_sampler_failure_is_not_reported_as_empty_process_tree(self):
        from unittest.mock import patch
        with patch.object(perf.subprocess, 'check_output', side_effect=PermissionError('denied')):
            with self.assertRaises(PermissionError):
                perf._tree(123)

    def test_sampler_error_does_not_leave_launched_process_running(self):
        from unittest.mock import patch, MagicMock
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command='driver', package=__file__)
        proc = MagicMock(pid=123); proc.poll.return_value = None
        with patch.object(perf.subprocess, 'Popen', return_value=proc), patch.object(perf, 'sample_tree', side_effect=PermissionError('denied')), patch.object(perf, '_command'), patch.object(perf.os, 'killpg') as killpg:
            with self.assertRaises(PermissionError):
                perf.run(args)
        killpg.assert_called_once_with(123, perf.signal.SIGTERM)
        proc.wait.assert_called()

    def test_action_requires_explicit_matching_completion_receipt(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        with patch.object(perf.subprocess, 'run', return_value=SimpleNamespace(stdout='')):
            with self.assertRaisesRegex(ValueError, 'receipt'):
                perf._command('true', 'play', 123, 1)

    def test_unmeasured_core_numbers_are_rejected(self):
        for key in ('processTreeCpu', 'footprintBytes', 'startupMs', 'songOpenMs'):
            value = report()
            value['metrics'][key] = None
            with self.subTest(key=key), self.assertRaisesRegex(ValueError, key):
                perf.validate_report(value)

    def test_empty_cpu_measurement_is_rejected(self):
        value = report()
        value['metrics']['processTreeCpu'] = {}
        with self.assertRaisesRegex(ValueError, 'processTreeCpu'):
            perf.validate_report(value)

    def test_missing_root_process_cannot_be_reported_as_zero_cpu(self):
        from unittest.mock import patch
        import subprocess
        with patch.object(perf, '_tree', return_value=[123]), patch.object(perf.subprocess, 'check_output', side_effect=subprocess.CalledProcessError(1, 'ps')):
            with self.assertRaisesRegex(RuntimeError, 'process'):
                perf.sample_tree(123)

    def test_dead_app_cannot_be_reported_complete(self):
        from unittest.mock import patch, MagicMock
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command='driver', package=__file__)
        proc = MagicMock(pid=123); proc.poll.return_value = 1
        with patch.object(perf.subprocess, 'Popen', return_value=proc), patch.object(perf, 'sample_tree', return_value={'footprintBytes': 1, 'cpuPercent': 1}), patch.object(perf, '_command'), patch.object(perf.os, 'killpg'):
            with self.assertRaisesRegex(RuntimeError, 'exited'):
                perf.run(args)

    def test_macos_uses_physical_footprint_not_resident_set(self):
        from unittest.mock import patch
        with patch.object(perf.sys, 'platform', 'darwin'), patch.object(perf, '_tree', return_value=[123]), patch.object(perf.subprocess, 'check_output', return_value='5.0 10'), patch.object(perf, '_mac_usage', return_value=(0, 4321), create=True):
            self.assertEqual(perf.sample_tree(123)['footprintBytes'], 4321)

    def test_nonfinite_or_boolean_timing_is_rejected(self):
        for value in (float('nan'), float('inf'), True):
            document = report()
            document['phases'][2]['durationS'] = value
            with self.subTest(value=value), self.assertRaises(ValueError):
                perf.validate_report(document)

    def test_file_protocol_rejects_stale_receipt(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'receipt.json').write_text('{}')
            with self.assertRaisesRegex(FileExistsError, 'receipt'):
                perf.request_action(Path(directory), 'play', 0.01)

    def test_windows_sample_reports_dwm(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        responses = ['{"cpuPct":5,"memMb":10,"procs":2}', '[44]', '{"cpuPct":3,"memMb":4,"procs":1}']
        with patch.object(perf, 'os', SimpleNamespace(name='nt')), patch.object(perf.subprocess, 'check_output', side_effect=responses):
            value = perf.sample_tree(123)
        self.assertEqual(value['dwm']['cpuPercent'], 3)

    def test_receipt_roundtrip_delivers_action_and_consumes_receipt(self):
        import tempfile, threading, time, json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def reply():
                deadline = time.monotonic() + 2
                while not (root / 'request.json').exists() and time.monotonic() < deadline:
                    time.sleep(.005)
                request = json.loads((root / 'request.json').read_text())
                (root / 'request.json').unlink()
                (root / 'receipt.json').write_text(json.dumps({'action': request['action'], 'completed': True}))
            worker = threading.Thread(target=reply)
            worker.start()
            self.assertTrue(perf.request_action(root, 'open', 2)['completed'])
            worker.join()
            self.assertFalse((root / 'receipt.json').exists())

    def test_inaccessible_helper_does_not_disappear_from_tree(self):
        from unittest.mock import patch
        with patch.object(perf, '_tree', return_value=[123, 124]), patch.object(perf.subprocess, 'check_output', side_effect=['1 2', PermissionError('denied')]), patch.object(perf.sys, 'platform', 'linux'):
            with self.assertRaises(PermissionError):
                perf.sample_tree(123)

    def test_macos_cpu_is_a_delta_of_each_process_counter(self):
        from unittest.mock import patch
        with patch.object(perf, '_tree', return_value=[1, 2]), patch.object(perf, '_mac_usage', side_effect=[(0, 100), (0, 200), (1_000_000_000, 101), (500_000_000, 201)]), patch.object(perf.time, 'monotonic', side_effect=[0, 2]):
            sampler = perf.MacSampler()
            self.assertIsNone(sampler.sample(1)['cpuPercent'])
            value = sampler.sample(1)
        self.assertEqual(value['cpuPercent'], 75)
        self.assertEqual(value['footprintBytes'], 302)

    def test_package_is_checked_before_launch(self):
        from unittest.mock import patch
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command='driver', package='/nonexistent/c06/package')
        with patch.object(perf.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(ValueError, 'package'):
                perf.run(args)
            launch.assert_not_called()

    def test_failed_run_terminates_its_process_group(self):
        from unittest.mock import patch, MagicMock
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command='driver', package=__file__)
        proc = MagicMock(pid=123); proc.poll.return_value = None
        with patch.object(perf.subprocess, 'Popen', return_value=proc) as launch, patch.object(perf, 'sample_tree', side_effect=PermissionError('denied')), patch.object(perf, '_command'), patch.object(perf.os, 'killpg', create=True) as killpg:
            with self.assertRaises(PermissionError): perf.run(args)
        self.assertTrue(launch.call_args.kwargs['start_new_session'])
        killpg.assert_called_once_with(123, perf.signal.SIGTERM)

    def test_visible_label_cannot_describe_forced_hidden_run(self):
        from unittest.mock import patch
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='visible', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command='driver', package=__file__)
        with patch.object(perf.subprocess, 'Popen') as launch, patch.object(perf.os, 'killpg'):
            with self.assertRaisesRegex(ValueError, 'display'):
                perf.run(args)
            launch.assert_not_called()

    def test_invalid_scenario_duration_is_rejected_before_launch(self):
        from unittest.mock import patch
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=-1, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command='driver', package=__file__)
        with patch.object(perf.subprocess, 'Popen') as launch, patch.object(perf.os, 'killpg'):
            with self.assertRaisesRegex(ValueError, 'duration'):
                perf.run(args)
            launch.assert_not_called()

    def test_wrong_action_receipt_cannot_complete_a_phase(self):
        import tempfile, threading, time, json
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            def reply():
                deadline = time.monotonic() + 2
                while not (root / 'request.json').exists() and time.monotonic() < deadline:
                    time.sleep(.005)
                (root / 'request.json').unlink()
                (root / 'receipt.json').write_text(json.dumps({'action': 'pause', 'completed': True}))
            worker = threading.Thread(target=reply); worker.start()
            with self.assertRaisesRegex(ValueError, 'open'):
                perf.request_action(root, 'open', 2)
            worker.join()

    def test_control_driver_requires_explicit_app_configuration(self):
        import tempfile
        from unittest.mock import patch
        from argparse import Namespace
        with tempfile.TemporaryDirectory() as directory:
            args = Namespace(app='electron', profile='build', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command=None, control_dir=Path(directory), package=__file__)
            with patch.dict(perf.os.environ, {}, clear=True), patch.object(perf.subprocess, 'Popen') as launch, patch.object(perf.os, 'killpg'):
                with self.assertRaisesRegex(ValueError, 'SINGZ_USERDATA_DIR'):
                    perf.run(args)
                launch.assert_not_called()

    def test_report_must_be_complete(self):
        value = report(); value['complete'] = False
        with self.assertRaisesRegex(ValueError, 'complete'):
            perf.validate_report(value)

    def test_primary_sample_uses_steady_playback_not_post_cycle(self):
        samples = [{'phase': 'play', 'footprintBytes': 42}, {'phase': 'cycles', 'footprintBytes': 12}]
        self.assertEqual(perf.primary_sample(samples)['footprintBytes'], 42)

    def test_runner_executes_all_actions_against_a_protocol_driver(self):
        import os, sys, tempfile
        from argparse import Namespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); driver = root / 'driver.py'; control = root / 'control'
            reference = root / 'reference.json'; reference.write_text('{"reference":"fixture","stemCount":6,"durationS":40}')
            driver.write_text('''import json, os, pathlib, time\np = pathlib.Path(os.environ["SINGZ_PERF_CONTROL_DIR"])\nwhile True:\n r = p / "request.json"\n if not r.exists():\n  time.sleep(.01); continue\n x = json.loads(r.read_text()); r.unlink()\n (p / "receipt.json").write_text(json.dumps({"action": x["action"], "completed": True, "detail": {}}))\n if x["action"] == "quit": break\n''')
            args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=2, command=f'{sys.executable} {driver}', action_command=None, control_dir=control, package=__file__, reference_json=reference)
            env = {name: str(root) for name in ('SINGZ_GPUI_CONFIG_DIR', 'SINGZ_GPUI_PROJECTS_ROOT', 'SINGZ_GPUI_TEST_PROJECT', 'SINGZ_GPUI_PERF_SECOND_PROJECT', 'SINGZ_GPUI_AUDIO_HELPER')}
            env['SINGZ_GPUI_PERF_SECOND_PROJECT'] = str(root / 'second')
            with patch.dict(os.environ, env), patch.object(perf.sys, 'platform', 'linux'), patch.object(perf, 'sample_tree', return_value={'cpuPercent': 1, 'footprintBytes': 1}):
                result = perf.run(args)
            self.assertEqual(list(result['actionReceipts']), list(perf.PHASES))
            self.assertTrue(result['complete'])

    def test_retired_child_does_not_cancel_remaining_cpu(self):
        from unittest.mock import patch
        with patch.object(perf, '_tree', side_effect=[[1, 2], [1]]), patch.object(perf, '_mac_usage', side_effect=[(0, 100), (10_000_000_000, 200), (1_000_000_000, 101)]), patch.object(perf.time, 'monotonic', side_effect=[0, 2]):
            sampler = perf.MacSampler(); sampler.sample(1); result = sampler.sample(1)
        self.assertEqual(result['cpuPercent'], 50)
        self.assertEqual(result['pairedProcesses'], 1)

    def test_malformed_phase_is_rejected_as_schema_error(self):
        value = report(); value['phases'][2] = 'play'
        with self.assertRaises(ValueError): perf.validate_report(value)

    def test_boolean_package_size_is_not_a_measurement(self):
        value = report(); value['metrics']['packageSizeBytes'] = True
        with self.assertRaisesRegex(ValueError, 'packageSizeBytes'):
            perf.validate_report(value)

    def test_empty_package_is_not_a_measurement(self):
        value = report(); value['metrics']['packageSizeBytes'] = 0
        with self.assertRaisesRegex(ValueError, 'packageSizeBytes'):
            perf.validate_report(value)

    def test_control_run_requires_reference_song_metadata(self):
        import tempfile
        from unittest.mock import patch
        from argparse import Namespace
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command=None, control_dir=root, package=__file__)
            env = {name: str(root) for name in ('SINGZ_GPUI_CONFIG_DIR', 'SINGZ_GPUI_PROJECTS_ROOT', 'SINGZ_GPUI_TEST_PROJECT', 'SINGZ_GPUI_PERF_SECOND_PROJECT', 'SINGZ_GPUI_AUDIO_HELPER')}
            env['SINGZ_GPUI_PERF_SECOND_PROJECT'] = str(root / 'second')
            with patch.dict(perf.os.environ, env), patch.object(perf.subprocess, 'Popen') as launch, patch.object(perf.os, 'killpg'):
                with self.assertRaisesRegex(ValueError, 'reference'):
                    perf.run(args)
                launch.assert_not_called()

    def test_launch_does_not_inherit_unrelated_native_test_hooks(self):
        from unittest.mock import patch, MagicMock
        from argparse import Namespace
        args = Namespace(app='native', profile='release', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=0, cycle_duration=0, deadline=1, command='true', action_command='driver', package=__file__)
        proc = MagicMock(pid=123); proc.poll.return_value = None
        with patch.dict(perf.os.environ, {'SINGZ_GPUI_UNRELATED_TEST': '1'}), patch.object(perf.subprocess, 'Popen', return_value=proc) as launch, patch.object(perf, 'sample_tree', return_value={'footprintBytes': 1, 'cpuPercent': 1}), patch.object(perf, '_command'), patch.object(perf.os, 'killpg'):
            perf.run(args)
        self.assertFalse('SINGZ_GPUI_UNRELATED_TEST' in launch.call_args.kwargs['env'])

    def test_electron_requires_two_distinct_fixture_names(self):
        import tempfile, json
        from argparse import Namespace
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); reference = root/'reference.json'
            reference.write_text(json.dumps({'reference':'sample', 'stemCount':6, 'durationS':40}))
            args = Namespace(app='electron', profile='build', display='hidden', machine='mac', commit='abc', play=0, burst=0, pause=0, cycles=2, cycle_duration=0, deadline=2, command='true', action_command=None, control_dir=root, package=__file__, reference_json=reference)
            with patch.dict(perf.os.environ, {'SINGZ_USERDATA_DIR':str(root), 'SINGZ_PERF_SONGS':'["same","same"]'}), patch.object(perf.subprocess, 'Popen') as launch, patch.object(perf.os, 'killpg'):
                with self.assertRaisesRegex(ValueError, 'songs'):
                    perf.run(args)
                launch.assert_not_called()

    def test_lane_counter_parses_bridge_integers_and_rejects_invalid(self):
        self.assertEqual(perf.lane_counter('123'), 123)
        self.assertEqual(perf.lane_counter(0), 0)
        for value in (None, True, '-1', 'bad'):
            self.assertIsNone(perf.lane_counter(value))
