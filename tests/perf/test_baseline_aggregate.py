import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

here = Path(__file__).parent
spec = importlib.util.spec_from_file_location("baseline_aggregate", here / "baseline_aggregate.py")
agg = importlib.util.module_from_spec(spec); spec.loader.exec_module(agg)
perf = agg.perf


def run(app="native", idle=0.5, play=10.0, footprint=1000, series=None, startup=1000, opened=500, commit="abc", kind="baseline", closed=None, lanes=None):
    phases = [{"name": n, "durationS": 0, "deadlineS": 1} for n in perf.PHASES]
    series = series or [footprint] * 6
    samples = [{"phase": "play", "cpuPercent": play, "footprintBytes": footprint, "elapsedS": 1}]
    samples += [{"phase": "pause", "cpuPercent": idle, "footprintBytes": footprint, "elapsedS": 2 + i} for i in range(3)]
    samples += [{"phase": "cycles", "cpuPercent": 1, "footprintBytes": value, "elapsedS": 10 + i} for i, value in enumerate(series)]
    return {"schema": perf.SCHEMA, "complete": True, "run": {"app": app, "buildProfile": "release+ui-tests", "displayMode": "hidden", "machine": "mac", "commit": commit,
            "kind": kind, "packageBuildProfile": "release", "reference": {"reference": "r", "stemCount": 6, "durationS": 300}}, "phases": phases,
            "metrics": {"processTreeCpu": {"cpuPercent": play}, "footprintBytes": footprint, "startupMs": startup, "songOpenMs": opened,
                        "starvedBlocks": {"lanes": lanes if lanes is not None else {}, "reason": "not exposed"}, "packageSizeBytes": 5,
                        "frames": {"fps": None, "frameTimeMs": None, "dropped": None, "reason": perf.HIDDEN_REASON}},
            "packageArtifact": "a.zip", "samples": samples, "actionReceipts": {"cycles": {"detail": {"closed": closed}}}, "complete": True}


def write_runs(directory, runs):
    paths = []
    for i, value in enumerate(runs):
        path = Path(directory) / f"r{i}.json"; path.write_text(json.dumps(value)); paths.append(path)
    return paths


def package(directory, size, name="p.dmg"):
    path = Path(directory) / name; path.write_bytes(b"x" * size); return path


class AggregateTests(unittest.TestCase):
    def build(self, directory, app, runs, size=100, frames=()):
        return agg.aggregate(app, write_runs(directory, runs), package(directory, size, f"{app}.dmg"), list(frames), ["note"])

    def test_three_runs_give_median_and_worst(self):
        with tempfile.TemporaryDirectory() as d:
            doc = self.build(d, "native", [run(play=p) for p in (10.0, 30.0, 20.0)])
        cell = doc["cells"]["playingCpuPercent"]
        self.assertEqual((cell["median"], cell["worst"], cell["runs"]), (20.0, 30.0, [10.0, 30.0, 20.0]))
        self.assertEqual(doc["shippedPackage"]["bytes"], 100)

    def test_only_three_complete_baseline_runs_of_one_build_are_accepted(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaisesRegex(ValueError, "three"):
                agg.aggregate("native", write_runs(d, [run(), run()]), None, [], [])
            with self.assertRaisesRegex(ValueError, "baseline"):
                self.build(d, "native", [run(), run(), run(kind="smoke")])
            with self.assertRaisesRegex(ValueError, "commit"):
                self.build(d, "native", [run(), run(), run(commit="other")])
            with self.assertRaisesRegex(ValueError, "expected electron"):
                self.build(d, "electron", [run(), run(), run()])

    def test_growth_is_judged_against_its_own_noise(self):
        flat = agg.growth(run(footprint=1_000_000, series=[1_000_000, 1_000_300, 999_800, 1_000_200, 1_000_000, 999_900]))
        rising = agg.growth(run(footprint=1_000_000, series=[1_000_000, 1_100_000, 1_200_000, 1_300_000, 1_400_000, 1_500_000]))
        self.assertFalse(flat["growing"]); self.assertTrue(rising["growing"])
        self.assertGreater(rising["growthBytes"], 400_000)
        self.assertIsNone(agg.growth(run(series=[1, 2]))["growing"])

    def frames_file(self, directory, scenario, i, samples, source="handler-callback-time"):
        path = Path(directory) / f"{scenario}{i}.json"
        path.write_text(json.dumps({"schema": "singz.perf.frames-live.v1", "scenario": scenario, "seconds": 60, "panelHz": 60.0, "gate": "unvalidated", "failures": [],
            "environment": {"displays": [], "startedQuiet": True}, "frames": {"fps": 60.0, "frameTimeMs": {"p50": 16.6, "p99": 17.0, "max": 20}, "dropped": 0, "presentedSamples": samples, "timeSource": source}}))
        return path

    def test_gaps_state_pass_fail_unvalidated_and_deferred(self):
        with tempfile.TemporaryDirectory() as d:
            electron = self.build(d, "electron", [run("electron", idle=3.0, play=40.0, footprint=2000, startup=2000, opened=1000) for _ in range(3)], size=200)
            frames = [self.frames_file(d, "idle", i, 0) for i in range(3)] + [self.frames_file(d, "static", i, 3600) for i in range(3)]
            native = self.build(d, "native", [run(idle=0.5, play=50.0, footprint=1500, startup=900, opened=400) for _ in range(3)], size=100, frames=frames)
        rows = {r["id"]: r["status"] for r in agg.gaps(native, electron)}
        self.assertEqual(rows["N6"], "pass"); self.assertEqual(rows["N7"], "fail")          # 50 > 40
        self.assertEqual(rows["N9"], "pass"); self.assertEqual(rows["N12"], "pass"); self.assertEqual(rows["N13"], "pass")
        self.assertEqual(rows["N14"], "pass"); self.assertEqual(rows["N5"], "pass")
        self.assertEqual(rows["N8"], "deferred"); self.assertEqual(rows["N11"], "unvalidated")
        self.assertEqual([rows[n] for n in ("N1", "N2", "N3", "N4", "N10")], ["unvalidated"] * 5)  # never pass on handler-callback time or open/open cycles
        self.assertEqual(len(rows), 14)

    def test_idle_presents_fail_n5_and_a_bigger_package_fails_n14(self):
        with tempfile.TemporaryDirectory() as d:
            electron = self.build(d, "electron", [run("electron") for _ in range(3)], size=100)
            native = self.build(d, "native", [run() for _ in range(3)], size=300, frames=[self.frames_file(d, "idle", i, 5) for i in range(3)])
        rows = {r["id"]: r["status"] for r in agg.gaps(native, electron)}
        self.assertEqual((rows["N5"], rows["N14"]), ("fail", "fail"))

    def test_starved_blocks_pass_only_after_the_full_60_second_burst(self):
        lanes = {"vocals": 0, "drums": 0}
        with tempfile.TemporaryDirectory() as d:
            electron = self.build(d, "electron", [run("electron") for _ in range(3)])
            short = self.build(d, "native", [run(lanes=lanes) for _ in range(3)])
            full_runs = [run(lanes=lanes) for _ in range(3)]
            for r in full_runs: r["phases"][3].update(durationS=60, deadlineS=200)
            full = self.build(d, "native", full_runs)
            bad_runs = [run(lanes={"vocals": 2}) for _ in range(3)]
            for r in bad_runs: r["phases"][3].update(durationS=60, deadlineS=200)
            bad = self.build(d, "native", bad_runs)
        status = lambda doc: {r["id"]: r["status"] for r in agg.gaps(doc, electron)}["N11"]
        self.assertEqual((status(short), status(full), status(bad)), ("unvalidated", "pass", "fail"))

    def test_markdown_lists_every_budget_and_the_windows_steps(self):
        with tempfile.TemporaryDirectory() as d:
            electron = self.build(d, "electron", [run("electron") for _ in range(3)])
            native = self.build(d, "native", [run() for _ in range(3)])
        text = agg.markdown(native, agg.gaps(native, electron))
        for n in range(1, 15):
            self.assertIn(f"| N{n} |", text)
        self.assertIn("Windows legs", text)


if __name__ == "__main__": unittest.main()
