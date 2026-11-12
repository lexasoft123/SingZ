import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location("smoke_gate", HERE / "smoke_gate.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
SPEC = json.loads(gate.THRESHOLDS.read_text())
Q02 = json.loads((ROOT / "experiments/gpui-player/plan/Q-02-native-baseline.json").read_text())

# What a healthy hidden run on the reference Mac looks like (Q-02 medians; offscreen from the README receipt).
HEALTHY = {"idleLibraryDemandedFrames": 0, "pausedPlayerDemandedFrames": 0, "modalOpenDemandedFrames": 0,
           "steadyPlaybackPaintAllocations": 0, "steadyPlaybackMainThreadRasterizations": 0,
           "steadyPlaybackWaveformCacheMisses": 0, "starvedBlocksTotal": 0, "hiddenScenarioComplete": 1,
           "songOpenMs": 187.1, "startupMs": 269.1, "offscreenFramesPerSecond": 118.0, "offscreenPrepareDrawP95Ms": 4.0, "offscreenStructuralFailures": 0,
           "idleCpuPercent": 4.7, "playingCpuPercent": 6.1, "steadyFootprintBytes": 160e6, "packageSizeBytes": 60e6}


def statuses(measured):
    return {row["name"]: row["status"] for row in gate.evaluate(measured, SPEC)}


class ThresholdTests(unittest.TestCase):
    def test_healthy_run_passes_and_info_never_fails(self):
        rows = statuses(HEALTHY)
        self.assertEqual([name for name, status in rows.items() if status == "FAIL"], [])
        # CPU 50x over the reference is information, not a failure.
        self.assertEqual(statuses({**HEALTHY, "idleCpuPercent": 250.0, "steadyFootprintBytes": 4e9})["idleCpuPercent"], "info")

    def test_every_lower_is_better_limit_has_margin_over_q02_worst(self):
        cells = Q02["cells"]
        for gate_name, cell in (("songOpenMs", "songOpenMs"), ("startupMs", "startupMs")):
            self.assertGreater(SPEC["gates"][gate_name]["limit"], cells[cell]["worst"], gate_name)
            self.assertAlmostEqual(SPEC["gates"][gate_name]["q02"], cells[cell]["worst"], delta=0.1)
        self.assertEqual(sum(run["total"] for run in cells["starvedBlocks"]), SPEC["gates"]["starvedBlocksTotal"]["q02"])
        for info, cell in (("idleCpuPercent", "idleCpuPercent"), ("playingCpuPercent", "playingCpuPercent"),
                           ("steadyFootprintBytes", "steadyFootprintBytes")):
            self.assertAlmostEqual(SPEC["info"][info]["q02"], cells[cell]["median"], delta=cells[cell]["median"] * 0.001)

    def test_each_gated_metric_goes_red_with_its_delta(self):
        worse = {"idleLibraryDemandedFrames": 3, "pausedPlayerDemandedFrames": 1, "modalOpenDemandedFrames": 1,
                 "steadyPlaybackPaintAllocations": 7, "steadyPlaybackMainThreadRasterizations": 1,
                 "steadyPlaybackWaveformCacheMisses": 2, "starvedBlocksTotal": 4, "hiddenScenarioComplete": 0,
                 "songOpenMs": 9000, "startupMs": 60000, "offscreenFramesPerSecond": 20, "offscreenPrepareDrawP95Ms": 60,
                 "offscreenStructuralFailures": 1}
        for name, value in worse.items():
            rows = gate.evaluate({**HEALTHY, name: value}, SPEC)
            row = next(row for row in rows if row["name"] == name)
            self.assertEqual(row["status"], "FAIL", name)
            self.assertGreater(row["delta"], 0, name)
            self.assertIn(f"REGRESSION {name}", gate.format_rows(rows))

    def test_offscreen_structural_failures_count_but_throughput_is_gated_separately(self):
        report = {"renderer": {"offscreenFramesPerSecond": 25.0, "prepareAndDrawWallMs": {"p95": 3.0}},
                  "failures": ["offscreen throughput 25.00 below 30 completed images/s",
                               "advancing glyph glow was not painted during measurement"]}
        metrics = gate.offscreen_metrics(report)
        self.assertEqual(metrics["offscreenStructuralFailures"], 1)
        self.assertEqual(statuses({**HEALTHY, **metrics})["offscreenStructuralFailures"], "FAIL")
        clean = gate.offscreen_metrics({"renderer": report["renderer"], "failures": ["offscreen throughput 25.00 below 30 completed images/s"]})
        self.assertEqual(clean["offscreenStructuralFailures"], 0)
        self.assertIsNone(gate.offscreen_metrics({"renderer": report["renderer"]})["offscreenStructuralFailures"])

    def test_an_unmeasured_metric_fails_instead_of_passing(self):
        for value in (None, float("nan"), True, "0"):
            self.assertEqual(statuses({**HEALTHY, "starvedBlocksTotal": value})["starvedBlocksTotal"], "FAIL")
        without = {key: value for key, value in HEALTHY.items() if key != "songOpenMs"}
        self.assertEqual(statuses(without)["songOpenMs"], "FAIL")


class ReductionTests(unittest.TestCase):
    def test_paint_allocations_need_real_playback_to_count(self):
        windows = {"idleLibrary": {"demandedFrames": 0}, "steady": {"demandedFrames": 3},
                   "before": {"lanePlayheadPaintAllocations": 5, "mainThreadRasterizations": 1, "waveformCacheMisses": 2},
                   "after": {"lanePlayheadPaintAllocations": 5, "mainThreadRasterizations": 1, "waveformCacheMisses": 2}}
        metrics = gate.probe_metrics(windows)
        self.assertIsNone(metrics["steadyPlaybackPaintAllocations"])  # playback demanded 3 frames: proves nothing
        self.assertEqual(metrics["steadyPlaybackMainThreadRasterizations"], 0)
        windows["steady"]["demandedFrames"] = 240
        windows["after"]["lanePlayheadPaintAllocations"] = 9
        self.assertEqual(gate.probe_metrics(windows)["steadyPlaybackPaintAllocations"], 4)
        self.assertIsNone(metrics["pausedPlayerDemandedFrames"])  # a window that never ran is unmeasured, not 0

    def test_unavailable_lane_counters_leave_starved_blocks_unmeasured(self):
        report = {"complete": True, "samples": [{"phase": "pause", "cpuPercent": 2.0}, {"phase": "pause", "cpuPercent": 4.0}],
                  "metrics": {"songOpenMs": 100, "startupMs": 200, "footprintBytes": 1, "packageSizeBytes": 2,
                              "starvedBlocks": {"lanes": {"vocals": 0, "drums": None}, "reason": "no counters"}}}
        metrics = gate.harness_metrics(report)
        self.assertIsNone(metrics["starvedBlocksTotal"])
        self.assertEqual(metrics["idleCpuPercent"], 3.0)
        report["metrics"]["starvedBlocks"]["lanes"] = {"vocals": 0, "drums": 2}
        self.assertEqual(gate.harness_metrics(report)["starvedBlocksTotal"], 2)


class InjectionTests(unittest.TestCase):
    """The C-35 acceptance: a per-frame sleep injected into the ui-tests build turns the gate red."""

    def fake_legs(self):
        # Stand-in for the app: every offscreen frame costs 4 ms of work plus the injected sleep, capped at the 120 Hz cadence.
        def offscreen(*_):
            sleep = float(os.environ.get(gate.INJECT_ENV, "0"))
            frame = max(4.0 + sleep, 1000 / 120)
            return {"offscreenFramesPerSecond": 1000 / frame, "offscreenPrepareDrawP95Ms": 4.0 + sleep, "offscreenStructuralFailures": 0}
        probe = {k: v for k, v in HEALTHY.items() if k.startswith(("idle", "paused", "modal", "steady")) and k not in ("idleCpuPercent", "steadyFootprintBytes")}
        harness = {k: v for k, v in HEALTHY.items() if k not in probe and not k.startswith("offscreen")}
        return mock.patch.multiple(gate, stage_library=lambda *_: {"library": "x", "projects": ["a", "b"]},
                                   run_probe=lambda *_: dict(probe), run_harness=lambda *_: dict(harness), run_offscreen=offscreen)

    def run_gate(self, *extra):
        out = Path(tempfile.mkdtemp())
        buffer = io.StringIO()
        with self.fake_legs(), mock.patch.object(gate.platform, "system", return_value="Darwin"), \
                mock.patch.dict(os.environ, {}, clear=False), contextlib.redirect_stdout(buffer):
            os.environ.pop(gate.INJECT_ENV, None)
            status = gate.main(["--binary", "/bin/echo", "--out-dir", str(out), *extra])
        return status, buffer.getvalue(), json.loads((out / "smoke-gate.json").read_text())

    def test_clean_run_is_green(self):
        status, text, summary = self.run_gate()
        self.assertEqual(status, 0, text)
        self.assertIn("PERF SMOKE PASSED", text)
        self.assertTrue(summary["passed"])

    def test_injected_frame_sleep_turns_the_gate_red_and_prints_the_delta(self):
        status, text, summary = self.run_gate("--inject-frame-sleep-ms", "40")
        self.assertEqual(status, 1, text)
        self.assertIn("NEGATIVE CONTROL", text)
        self.assertIn("REGRESSION offscreenFramesPerSecond", text)
        self.assertIn("REGRESSION offscreenPrepareDrawP95Ms", text)
        self.assertEqual(summary["failed"], ["offscreenFramesPerSecond", "offscreenPrepareDrawP95Ms"])
        self.assertEqual(summary["injectedFrameSleepMs"], "40")

    def test_zero_means_the_control_is_off(self):
        status, text, summary = self.run_gate("--inject-frame-sleep-ms", "0")
        self.assertEqual(status, 0, text)
        self.assertNotIn("NEGATIVE CONTROL", text)
        self.assertIsNone(summary["injectedFrameSleepMs"])

    def test_a_failed_leg_is_red(self):
        def broken(*_):
            raise RuntimeError("renderer telemetry file is missing")
        with self.fake_legs(), mock.patch.object(gate, "run_offscreen", broken), \
                mock.patch.object(gate.platform, "system", return_value="Darwin"), contextlib.redirect_stdout(io.StringIO()) as buffer:
            out = Path(tempfile.mkdtemp())
            status = gate.main(["--binary", "/bin/echo", "--out-dir", str(out)])
        self.assertEqual(status, 1)
        self.assertIn("ERROR offscreen: RuntimeError: renderer telemetry file is missing", buffer.getvalue())


class WiringTests(unittest.TestCase):
    def test_the_injection_is_a_registered_ui_tests_gated_name_read_by_the_benchmark(self):
        names = json.loads((ROOT / "tests/shared/gpui-gated-env-names.json").read_text())
        self.assertIn(gate.INJECT_ENV, names)
        self.assertEqual(names, sorted(names))
        source = (ROOT / "experiments/gpui-player/src/ui_benchmark.rs").read_text()
        self.assertIn(f'gated_env!("{gate.INJECT_ENV}")', source)  # gated_env! compiles to None outside ui-tests


if __name__ == "__main__":
    unittest.main()
