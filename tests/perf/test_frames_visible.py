import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("frames_visible", Path(__file__).with_name("frames_visible.py"))
fv = importlib.util.module_from_spec(spec); spec.loader.exec_module(fv)

OK = {"timeSource": "presentedTime", "stallsInjected": 59, "fps": 60.0, "frameTimeMs": {"p50": 16.7, "p99": 16.7, "max": 18}, "dropped": 0, "reason": None, "presentedSamples": 3600}


class EvaluateTests(unittest.TestCase):
    def test_static_passes_within_one_percent_and_zero_dropped(self):
        self.assertEqual(fv.evaluate("static", 60, 60, OK), [])
        self.assertEqual(fv.evaluate("static", 60, 60, {**OK, "fps": 59.41}), [])

    def test_static_fails_outside_one_percent_or_any_drop(self):
        self.assertTrue(fv.evaluate("static", 60, 60, {**OK, "fps": 59.39}))
        self.assertTrue(fv.evaluate("static", 60, 60, {**OK, "fps": 60.61}))
        self.assertTrue(fv.evaluate("static", 60, 60, {**OK, "dropped": 1}))
        self.assertTrue(fv.evaluate("static", 60, 60, {"fps": None, "reason": fv.perf.HIDDEN_REASON}))

    def test_p99_is_gated_so_a_slow_tail_cannot_pass(self):
        slow = {**OK, "frameTimeMs": {"p50": 16.7, "p99": 100.0, "max": 120}}
        failures = fv.evaluate("static", 60, 60, slow)
        self.assertTrue(any("p99" in f for f in failures), failures)
        self.assertEqual(fv.gate("static", failures, slow, busy=False), "fail")
        edge = {**OK, "frameTimeMs": {"p50": 16.7, "p99": 16.7, "max": 17}}
        self.assertEqual(fv.evaluate("static", 60, 60, edge), [])
        self.assertTrue(fv.evaluate("static", 60, 60, {**OK, "frameTimeMs": {"p50": 16.7, "p99": 16.71, "max": 17}}))

    def test_callback_clock_runs_are_unvalidated_never_a_timing_pass(self):
        callback = {**OK, "timeSource": "handler-callback-time"}
        self.assertEqual(fv.gate("static", [], callback, busy=False), "unvalidated")
        self.assertEqual(fv.gate("stall", [], callback, busy=False), "unvalidated")
        self.assertEqual(fv.gate("static", [], OK, busy=False), "pass")
        # Presence counts do not depend on the time source.
        self.assertEqual(fv.gate("idle", [], {"timeSource": "handler-callback-time", "presentedSamples": 0}, busy=False), "pass")
        self.assertEqual(fv.gate("launch", [], callback, busy=False), "diagnostic")

    def test_stall_control_is_checked_against_the_injection_count(self):
        self.assertEqual(fv.evaluate("stall", 60, 60, {**OK, "dropped": 59}), [])
        self.assertTrue(fv.evaluate("stall", 60, 60, {**OK, "dropped": 58}))
        self.assertTrue(fv.evaluate("stall", 60, 60, {**OK, "stallsInjected": 0}))
        self.assertTrue(fv.evaluate("stall", 60, 60, {**OK, "stallsInjected": None}))
        self.assertTrue(fv.evaluate("stall", 60, 60, OK))  # a clean run is not a stall

    def test_idle_requires_zero_samples_and_notify_control_about_ten_per_second(self):
        self.assertEqual(fv.evaluate("idle", 60, 60, {"presentedSamples": 0}), [])
        self.assertTrue(fv.evaluate("idle", 60, 60, {"presentedSamples": 1}))
        self.assertEqual(fv.evaluate("notify100", 60, 60, {"presentedSamples": 598}), [])
        self.assertTrue(fv.evaluate("notify100", 60, 60, {"presentedSamples": 0}))


if __name__ == "__main__":
    unittest.main()
