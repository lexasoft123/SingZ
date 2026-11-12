import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

here = Path(__file__).parent


def load(name):
    spec = importlib.util.spec_from_file_location(name, here / f"{name}.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


win = load("frames_visible_windows")
agg = load("baseline_aggregate")
staged = load("stage_reference_copy")
helpers = load("test_baseline_aggregate")


def sampler(fps=60.0, dropped=0, samples=3600, app_gpu=12.0, dwm_gpu=3.0):
    return {"schema": "singz.perf.windows-frames.v1", "hidden": False, "expectedHz": 60,
            "frames": {"fps": fps, "frameTimeMs": {"p50": 16.6, "p99": 16.5, "max": 20.0}, "dropped": dropped, "reason": None, "presentedSamples": samples},
            "process": {"cpuPercent": 5.0}, "gpu": {"perAdapter": [{"luid": "a", "meanPercent": app_gpu}, {"luid": "b", "meanPercent": 0.5}], "error": None},
            "dwm": {"cpuPercent": 1.5, "gpuPerAdapter": [{"luid": "a", "meanPercent": dwm_gpu}]}}


class WindowsFrameTests(unittest.TestCase):
    def test_presentmon_frames_are_gated_on_presented_time_like_the_mac_runs(self):
        good = win.judge("static", 60, 60, sampler())
        self.assertEqual((good["gate"], good["failures"]), ("pass", []))
        slow = win.judge("static", 60, 60, sampler(fps=45.0, dropped=40))
        self.assertEqual(slow["gate"], "fail")
        self.assertTrue(any("dropped" in f for f in slow["failures"]))
        # idle is a presence count: any present while nothing animates fails
        self.assertEqual(win.judge("idle", 60, 60, {**sampler(), "frames": {"fps": None, "dropped": None, "presentedSamples": 7}})["gate"], "fail")

    def test_a_non_sampler_document_is_refused(self):
        with self.assertRaises(ValueError):
            win.judge("static", 60, 60, {"schema": "other"})


class WindowsAggregateTests(unittest.TestCase):
    def frames_file(self, directory, scenario, i, app_gpu, dwm_gpu, samples=3600):
        document = win.judge(scenario, 60, 60, sampler(samples=samples, app_gpu=app_gpu, dwm_gpu=dwm_gpu))
        path = Path(directory) / f"{scenario}-{app_gpu}-{i}.json"
        path.write_text(json.dumps({"schema": "singz.perf.frames-live.v1", "scenario": scenario, "seconds": 60, "panelHz": 60.0,
                                    "environment": {"displays": [{"refreshHz": 60}]}, **document, "sampler": sampler(samples=samples, app_gpu=app_gpu, dwm_gpu=dwm_gpu)}))
        return path

    def build(self, d, app, frames, size):
        runs = helpers.write_runs(d, [helpers.run(app) for _ in range(3)])
        return agg.aggregate(app, runs, helpers.package(d, size, f"{app}.exe"), frames, ["note"], {"cpu": "x"}, None, "windows")

    def test_n8_is_judged_only_on_playback_both_apps_have(self):
        with tempfile.TemporaryDirectory() as d:
            playing = lambda gpu: [self.frames_file(d, "playing", i, gpu, 3.0) for i in range(3)]
            electron_play = self.build(d, "electron", playing(20.0), 200)
            native_play = self.build(d, "native", playing(10.0), 100)
            native_hot = self.build(d, "native", playing(30.0), 100)
            native_static = self.build(d, "native", [self.frames_file(d, "static", i, 1.0, 3.0) for i in range(3)], 100)
        status = lambda native: {r["id"]: r["status"] for r in agg.gaps(native, electron_play)}["N8"]
        self.assertEqual((status(native_play), status(native_hot), status(native_static)), ("pass", "fail", "unvalidated"))  # an empty window is not playback
        self.assertNotIn("windows", native_play["deferred"])
        self.assertIn("(Windows)", agg.markdown(native_play, agg.gaps(native_play, electron_play)).splitlines()[0])

    def test_staging_gives_each_run_its_own_library_with_its_own_paths(self):
        with tempfile.TemporaryDirectory() as d:
            template = Path(d) / "template"
            for name in ("A", "B"):
                (template / "library" / name).mkdir(parents=True); (template / "library" / name / "project.json").write_text("{}")
            (template / "reference.json").write_text(json.dumps({"names": ["A", "B"], "reference": "r"}))
            one, two = staged.stage(template, Path(d) / "one"), staged.stage(template, Path(d) / "two")
            self.assertNotEqual(one["library"], two["library"])
            self.assertEqual(json.loads((Path(d) / "two/prefs/settings.json").read_text())["projectsRoot"], two["library"])
            self.assertTrue(all(Path(p).is_dir() for p in two["projects"]))
            with self.assertRaises(SystemExit):
                staged.stage(template, Path(d) / "one")  # never reuse a fresh directory


if __name__ == "__main__": unittest.main()
