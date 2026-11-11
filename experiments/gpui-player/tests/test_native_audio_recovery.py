#!/usr/bin/env python3
"""Owned-helper audio loss, retained drafts, safe route recovery and persistence.

Requires a ui-tests GPUI build and its native audio helper. The driver never
builds or activates an app, uses OS input, changes system devices, or touches a
real library/profile. Captures are functional candidates, not parity evidence.
"""

import argparse
import contextlib
import hashlib
import http.server
import importlib.util
import json
import math
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import tempfile
import threading
import time
import traceback
import wave

DRAFT = "Recovered draft survives owned helper loss"
WORKING_DRAFT = "Offline working lyric survives publication"
MISSING_ROUTE = "singz:ui-test-output-that-does-not-exist"
PROCESS_TIMEOUT = 150
RUST_SOURCE = Path(__file__).resolve().parents[1] / "src/ui_audio_recovery.rs"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("app", type=Path)
parser.add_argument("out", type=Path)
parser.add_argument("--publication-fault", action="store_true", help="Quarantine completed Save metadata and verify retained retry/duplicate-Save/repair")
parser.add_argument("--live-publication-fault", action="store_true", help="Keep the healthy native helper alive through real publication-read failure and measure its paused state")
args = parser.parse_args()
app = args.app.resolve()
out = args.out.resolve()
out.mkdir(parents=True, exist_ok=True)
(out / "result.json").unlink(missing_ok=True)
(out / "failure.txt").unlink(missing_ok=True)

sha = lambda path: hashlib.sha256(Path(path).read_bytes()).hexdigest()


def tone(path, hz=220, seconds=12, rate=16000):
    path.parent.mkdir(parents=True, exist_ok=True)
    frames = bytearray()
    for index in range(rate * seconds):
        sample = int(5000 * math.sin(index * math.tau * hz / rate))
        frames += struct.pack("<h", sample)
    with wave.open(str(path), "wb") as stream:
        stream.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        stream.writeframes(frames)


def foreground():
    if platform.system() != "Darwin" or not Path("/usr/bin/lsappinfo").exists():
        return None
    result = subprocess.run(
        ["/usr/bin/lsappinfo", "front"], capture_output=True, text=True, timeout=2
    )
    return {"returncode": result.returncode, "identity": result.stdout.strip()}


@contextlib.contextmanager
def lyrics_miss_server():
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            found = self.path.startswith("/api/search")
            body = b"[]" if found else b'{"message":"fixture miss"}'
            self.send_response(200 if found else 404)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/api"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


spec = importlib.util.spec_from_file_location(
    "interface_perf", Path(__file__).with_name("interface-perf.py")
)
perf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(perf)


def run_process(phase, env, foreground_before):
    folder = out / phase
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "result.json").unlink(missing_ok=True)
    (folder / "failure.txt").unlink(missing_ok=True)
    samples = []
    stop = threading.Event()
    started = time.monotonic()
    child = None
    try:
        with (folder / "audio-recovery.log").open("w") as log:
            child = subprocess.Popen(
                [str(app)], env=env, stdout=log, stderr=subprocess.STDOUT
            )

            def sample():
                previous = None
                while not stop.wait(0.4):
                    if platform.system() != "Darwin":
                        if not samples:
                            samples.append(
                                {
                                    "available": False,
                                    "reason": "macOS process resource counters unavailable",
                                }
                            )
                        return
                    try:
                        cpu, memory = perf.process_usage(child.pid)
                        now = time.monotonic()
                        if previous:
                            samples.append(
                                {
                                    "elapsedSeconds": now - started,
                                    "processCpuPercent": (cpu - previous[0])
                                    / ((now - previous[1]) * 1e9)
                                    * 100,
                                    "processFootprintBytes": memory,
                                    "gpuSystem": perf.gpu_usage(),
                                }
                            )
                        previous = cpu, now
                    except (OSError, RuntimeError):
                        return

            sampling = threading.Thread(target=sample, daemon=True)
            sampling.start()
            try:
                child.wait(timeout=PROCESS_TIMEOUT)
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
                stop.set()
                sampling.join(timeout=5)
        cpu_values = [
            row["processCpuPercent"]
            for row in samples
            if "processCpuPercent" in row
        ]
        memory_values = [
            row["processFootprintBytes"]
            for row in samples
            if "processFootprintBytes" in row
        ]
        performance = {
            "scope": "main GPUI process CPU/footprint; native helpers excluded; GPU system-wide",
            "pid": child.pid,
            "wallSeconds": time.monotonic() - started,
            "samples": samples,
            "summary": {
                "processCpuPercent": perf.summarize(cpu_values),
                "processFootprintBytes": perf.summarize(memory_values),
            },
            "liveFps": {
                "available": False,
                "reason": "hidden functional renders do not measure live display cadence",
            },
        }
        (folder / "performance.json").write_text(json.dumps(performance, indent=2))
        if child.returncode != 0 or not (folder / "result.json").is_file():
            failure = folder / "failure.txt"
            detail = failure.read_text() if failure.exists() else ""
            raise AssertionError(
                f"{phase} failed with return code {child.returncode}:\n"
                + (folder / "audio-recovery.log").read_text()
                + "\n"
                + detail
            )
        if platform.system() == "Darwin":
            assert cpu_values and memory_values, f"{phase} recorded no process resource samples"
            assert all(
                math.isfinite(value) and value >= 0 for value in memory_values
            ), f"{phase} recorded invalid memory samples"
        assert foreground() == foreground_before, (
            f"{phase} changed foreground application",
            foreground_before,
            foreground(),
        )
        return (
            json.loads((folder / "result.json").read_text()),
            {
                "pid": child.pid,
                "samples": len(samples),
                "cpu": performance["summary"]["processCpuPercent"],
                "memory": performance["summary"]["processFootprintBytes"],
                "report": str(folder / "performance.json"),
            },
        )
    finally:
        stop.set()
        if child is not None and child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def validate_captures(phase, result, fixture_hash, binary_hash, helper_hash):
    folder = out / phase
    expected_sizes = {tuple(size) for size in result["sizes"]}
    sidecars = sorted(folder.glob("*.state.json"))
    assert sidecars, f"{phase} produced no capture sidecars"
    for sidecar in sidecars:
        state = json.loads(sidecar.read_text())
        case = sidecar.name[: -len(".state.json")]
        png = sidecar.with_name(case + ".png")
        assert state["caseId"] == case
        assert png.is_file(), f"Missing capture for {sidecar}"
        data = png.read_bytes()
        assert data[:8] == b"\x89PNG\r\n\x1a\n", f"Invalid PNG: {png}"
        width, height = struct.unpack(">II", data[16:24])
        assert [width, height] == state["imagePixels"], (png, state["imagePixels"])
        assert hashlib.sha256(data).hexdigest() == state["screenshotSha256"]
        assert tuple(state["viewport"]) in expected_sizes, (case, state["viewport"])
        scale = state["scale"]
        assert scale > 0
        assert abs(width - state["viewport"][0] * scale) <= 2
        assert abs(height - state["viewport"][1] * scale) <= 2
        assert state["hidden"] and state["hiddenConfigured"]
        assert not state["windowPresented"] and not state["windowActive"]
        assert state["mutedConfigured"]
        assert "sourceState" in state and "working" in state["sourceState"]
        assert state["fixtureSha256"] == fixture_hash
        assert state["binarySha256"] == binary_hash
        assert state["testSourceSha256"] == sha(RUST_SOURCE)
        assert state["productionParity"].startswith("not evaluated")
        assert "unmeasured" in state["liveFps"]
        assert "not hardware hotplug qualification" in state["faultScope"]
    assert helper_hash
    return len(sidecars)


def require_flags(result, names):
    for name in names:
        assert result.get(name) is True, (name, result)


def assert_native_advance(result):
    advance = result["nativeAdvance"]
    assert advance["to"] > advance["from"] + 0.04, advance


def main():
    assert app.is_file(), f"Missing GPUI app: {app}"
    helper = app.with_name("singz-gpui-audio.exe" if os.name == "nt" else "singz-gpui-audio")
    assert helper.is_file(), f"Missing native audio helper: {helper}"
    binary_hash = sha(app)
    helper_hash = sha(helper)
    rust_hash = sha(RUST_SOURCE)
    foreground_before = foreground()

    with tempfile.TemporaryDirectory(prefix="singz-audio-recovery-") as temporary, lyrics_miss_server() as lyrics_url:
        root = Path(temporary).resolve()
        library = root / "library"
        saved = library / "Retained recovery fixture"
        (saved / "stems").mkdir(parents=True)
        tone(saved / "stems/vocals.wav")
        raw = root / "Raw recovery fixture.wav"
        shutil.copyfile(saved / "stems/vocals.wav", raw)
        notes = "Retained project documents must survive transport recovery.\n"
        (saved / "notes.txt").write_text(notes)
        settings = {
            "tempo": 1,
            "transpose": 0,
            "masterVolume": 1,
            "loop": False,
            "selection": {"s": 1, "e": 10},
            "view": {"s": 0, "e": 12},
            "tracks": {"vocals": {"volume": 1, "muted": False, "solo": False}},
            "metronome": {
                "click": False,
                "countInBars": 0,
                "volume": 0.7,
                "accent": True,
                "grid": False,
            },
            "melody": {
                "detVersion": 4,
                "hopSec": 0.025,
                "f0": " ".join(["2400"] * 480),
            },
            "foreignSetting": {"keep": "saved-fixture"},
        }
        project = {
            "version": 2,
            "name": saved.name,
            "settings": settings,
            "foreignProject": {"keep": "retained-fixture"},
        }
        (saved / "project.json").write_text(json.dumps(project, indent=2))
        lyric_document = {
            "source": "edited",
            "credit": "fixture-credit",
            "foreignLyrics": {"keep": "retained-lyrics"},
            "lines": [
                {
                    "start": 1,
                    "end": 3,
                    "text": "Original fixture line",
                    "words": [
                        {"w": "Original", "s": 1, "e": 1.7},
                        {"w": "fixture", "s": 1.8, "e": 2.3},
                        {"w": "line", "s": 2.4, "e": 3},
                    ],
                },
                {
                    "start": 4,
                    "end": 6,
                    "text": "Second fixture line",
                    "words": [
                        {"w": "Second", "s": 4, "e": 4.6},
                        {"w": "fixture", "s": 4.7, "e": 5.3},
                        {"w": "line", "s": 5.4, "e": 6},
                    ],
                },
                {
                    "start": 8,
                    "end": 10,
                    "text": "Third fixture line",
                    "words": [
                        {"w": "Third", "s": 8, "e": 8.6},
                        {"w": "fixture", "s": 8.7, "e": 9.3},
                        {"w": "line", "s": 9.4, "e": 10},
                    ],
                },
            ],
        }
        (saved / "lyrics.json").write_text(json.dumps(lyric_document, indent=2))
        invalid = root / "Invalid new project"
        invalid.mkdir()
        (invalid / "project.json").write_text(
            json.dumps({"version": 3, "name": "Must be rejected", "settings": {}}, indent=2)
        )
        invalid_hash = sha(invalid / "project.json")
        config = root / "preferences"
        config.mkdir()
        (config / "audio.json").write_text(
            json.dumps({"outputUid": "", "karaoke": True, "future": "preserve-audio-preferences"}, indent=2)
        )
        initial_project_hash = sha(saved / "project.json")
        initial_media_hash = sha(saved / "stems/vocals.wav")
        raw_hash = sha(raw)
        fixture = {
            "schema": 1,
            "savedProject": str(saved),
            "rawSource": str(raw),
            "invalidProject": str(invalid),
            "initialProjectSha256": initial_project_hash,
            "initialLyricsSha256": sha(saved / "lyrics.json"),
            "initialMediaSha256": initial_media_hash,
            "rawSourceSha256": raw_hash,
            "audioPreferencesSha256": sha(config / "audio.json"),
            "seconds": 12,
            "sampleRate": 16000,
            "localLyricsLookupOnly": True,
            "realUserLibrary": False,
        }
        fixture_path = root / "fixture.json"
        fixture_path.write_text(json.dumps(fixture, indent=2))
        fixture_hash = sha(fixture_path)
        base = {
            key: value
            for key, value in os.environ.items()
            if not key.startswith("SINGZ_GPUI_")
            and key
            not in {
                "SINGZ_PACK_DIR",
                "SINGZ_MODELS_DIR",
                "SINGZ_DEMUCS",
                "SINGZ_MUTE",
                "SINGZ_NO_SYNC",
                "SINGZ_NO_SYSTEM_ENGINES",
            }
        }
        base.update(
            SINGZ_MUTE="1",
            SINGZ_NO_SYNC="1",
            SINGZ_NO_SYSTEM_ENGINES="1",
            SINGZ_GPUI_BACKGROUND="1",
            SINGZ_GPUI_TEST_NO_CAPTURE="1",
            SINGZ_GPUI_CONFIG_DIR=str(config),
            SINGZ_GPUI_PROJECTS_ROOT=str(library),
            SINGZ_GPUI_AUDIO_HELPER=str(helper),
            SINGZ_GPUI_ANALYZER=str(root / "missing-analyzer"),
            SINGZ_GPUI_LRCLIB_URL=lyrics_url,
            SINGZ_GPUI_AUDIO_RECOVERY_FIXTURE=str(fixture_path),
            SINGZ_GPUI_AUDIO_RECOVERY_PROJECT=str(saved),
            SINGZ_GPUI_AUDIO_RECOVERY_RAW=str(raw),
            SINGZ_GPUI_AUDIO_RECOVERY_INVALID=str(invalid),
            SINGZ_PACK_DIR=str(root / "missing-pack"),
            SINGZ_MODELS_DIR=str(root / "missing-models"),
            SINGZ_DEMUCS=str(root / "missing-demucs"),
        )
        performance = {}
        captures = {}
        process_ids = []

        def launch(phase):
            env = dict(base)
            env.update(
                SINGZ_GPUI_AUDIO_RECOVERY=str(out / phase),
                SINGZ_GPUI_AUDIO_RECOVERY_PHASE=phase,
            )
            if args.publication_fault or args.live_publication_fault:
                env["SINGZ_GPUI_AUDIO_RECOVERY_PUBLICATION_FAULT"]="1"
            result, metrics = run_process(phase, env, foreground_before)
            performance[phase] = metrics
            process_ids.append(metrics["pid"])
            captures[phase] = validate_captures(
                phase, result, fixture_hash, binary_hash, helper_hash
            )
            return result

        if args.live_publication_fault:
            working = launch("working-live")
            require_flags(working, ["livePublicationFault", "healthyLiveHelperPublicationFailure", "nativePausedMeasuredBeforeHostAdmission"])
            assert working["ownedHelperKilled"] is False
            assert working["monitorTrainingHandoffQualified"] is False
            published = Path(working["publishedDir"])
            assert published.parent == library and published != Path(working["workingDir"])
            assert working["originalHelperPid"] != working["recoveredHelperPid"]
            assert working["lyricArcBefore"] == working["lyricArcAfter"]
            probes = json.loads((out/"working-live/live-native-probes.json").read_text())
            assert len(probes) == 13, probes
            for probe in probes:
                assert probe["epoch"] == working["sameEpoch"]
                assert probe["monitorLeased"] is False and probe["activeTraining"] is None
                assert probe["trainingOnly"] is False and probe["cueActive"] is False
                assert probe["outputUid"] == working["selectedUid"]
                assert abs(probe["rate"]-.9) < .0001 and probe["transpose"] == -2
                assert probe["loop"] == [0., 12.]
                assert probe["sampleAgeSeconds"] < 1
                assert probe["method"] == "fresh backend-owned helper status command before host admission"
            playing = [p for p in probes if p["stage"] == "before-save-playing"]
            paused = [p for p in probes if p["stage"] == "failed-publication-paused"]
            resumed = [p for p in probes if p["stage"] == "repaired-playing"]
            assert len(playing) == 2 and len(paused) == 7 and len(resumed) == 2
            assert all(p["playing"] and p["audibleCurrent"] and p["helperPid"] == working["originalHelperPid"] for p in playing)
            assert playing[1]["position"] > playing[0]["position"] + .04
            assert all(not p["playing"] and p["helperPid"] == working["originalHelperPid"] for p in paused)
            assert max(p["position"] for p in paused) - min(p["position"] for p in paused) < .0001
            assert working["pausedObservationSeconds"] >= .7
            assert all(p["playing"] and p["audibleCurrent"] and p["helperPid"] == working["recoveredHelperPid"] for p in resumed)
            assert resumed[1]["position"] > resumed[0]["position"] + .04
            assert_native_advance(working)
            assert sha(published/"project.json") == working["publishedMetadataSha256"]
            assert sha(published/"lyrics.json") == working["publishedLyricsSha256"]
            project = json.loads((published/"project.json").read_text())
            assert sha(published/project["songFile"]) == raw_hash == working["rawSourceSha256"]
            assert project["settings"]["tempo"] == .9 and project["settings"]["transpose"] == -2
            assert project["settings"]["masterVolume"] == .62 and project["settings"]["loop"] is True
            assert working["selectionBefore"] is None and working["selectionAfter"] == [0., 12.]
            assert working["nativeLoopBefore"] == working["nativeLoopAfter"] == [0., 12.]
            assert project["settings"]["selection"] == {"s":0., "e":12.}
            assert json.loads((published/"lyrics.json").read_text())["lines"][0]["text"] == WORKING_DRAFT
            assert not list(published.glob("*.ui-test-held"))
            failed = json.loads((out/"working-live/live-publication-failed-paused-owner-1060.state.json").read_text())
            repaired = json.loads((out/"working-live/live-publication-repaired-paused-1060.state.json").read_text())
            assert failed["sourceState"]["working"] and failed["sourceState"]["publicationPending"] and failed["tracksAudioFailed"] and not failed["playing"]
            assert repaired["sourceState"]["working"] is False and repaired["sourceState"]["publicationPending"] is False and repaired["tracksAudioFailed"] is False
            assert failed["epoch"] == repaired["epoch"] == working["sameEpoch"]
            assert failed["lyricArc"] == repaired["lyricArc"] and failed["lyricLines"] == repaired["lyricLines"]
            assert failed["sidebar"]["showsLyrics"] and repaired["sidebar"]["showsLyrics"]
            assert repaired["native"] and not repaired["native"]["playing"]
            assert len(process_ids) == 1 and foreground() == foreground_before
            persisted = out/"persisted/working-project"
            shutil.copytree(published, persisted, dirs_exist_ok=True)
            summary = {"passed":True,"livePublicationFault":True,"ownedHelperKilled":False,
                "appLaunches":1,"independentProcessIds":process_ids,"captures":captures,"performance":performance,
                "uiBinarySha256":binary_hash,"helperSha256":helper_hash,"testSourceSha256":rust_hash,"fixtureSha256":fixture_hash,
                "nativeProbes":13,"samePausedHelperSamples":7,"monitorTrainingHandoffQualified":False,
                "persistedMetadataSha256":sha(persisted/"project.json"),"persistedLyricsSha256":sha(persisted/"lyrics.json"),
                "rawSourceSha256":raw_hash,"foregroundBefore":foreground_before,"foregroundAfter":foreground(),
                "noNode":True,"hidden":True,"muted":True,"hardwareHotplugQualified":False,
                "productionParity":"not evaluated; functional captures only","liveFps":"unmeasured in hidden windows"}
            (out/"result.json").write_text(json.dumps(summary,indent=2)+'\n')
            print("PASS: healthy live-helper publication fault retains paused native owner; exact repair replaces paused then real Play advances")
            return

        retained = launch("retained")
        require_flags(
            retained,
            [
                "documentDraftMixRetained",
                "stoppedClockRetained",
                "invalidRecoveryPreferencesUnchanged",
                "validRecoveryNativePaused",
                "nativePlaybackAfterRecovery",
                "independentEditorSaveDistinctFromProjectSave",
                "settingsSelectorClicked",
                "settingsRetryClicked",
            ],
        )
        assert_native_advance(retained)
        assert retained["selectedUid"] and retained["selectedUid"] != MISSING_ROUTE
        assert retained["afterEditorProjectSha256"] == initial_project_hash
        assert retained["finalProjectSha256"] != initial_project_hash
        assert retained["finalLyricsSha256"] == retained["afterEditorLyricsSha256"]
        assert retained["finalProjectSha256"] == sha(saved / "project.json")
        assert retained["finalLyricsSha256"] == sha(saved / "lyrics.json")
        final_project = json.loads((saved / "project.json").read_text())
        final_settings = final_project["settings"]
        assert final_project["foreignProject"] == {"keep": "retained-fixture"}
        assert final_settings["foreignSetting"] == {"keep": "saved-fixture"}
        assert final_settings["tempo"] == 0.8
        assert final_settings["transpose"] == 2
        assert final_settings["loop"] is True
        assert final_settings["selection"] == {"s": 1, "e": 10}
        assert final_settings["masterVolume"] == 0.63
        assert final_settings["tracks"]["vocals"]["volume"] == 0.47
        assert final_settings["tracks"]["vocals"]["muted"] is True
        final_lyrics = json.loads((saved / "lyrics.json").read_text())
        assert final_lyrics["lines"][0]["text"] == DRAFT
        assert final_lyrics["lines"][1]["text"] == "Second fixture line"
        assert final_lyrics["source"] == "edited"
        assert final_lyrics["credit"] == "fixture-credit"
        assert final_lyrics["foreignLyrics"] == {"keep": "retained-lyrics"}
        assert sha(saved / "stems/vocals.wav") == initial_media_hash
        assert (saved / "notes.txt").read_text() == notes
        preferences = json.loads((config / "audio.json").read_text())
        assert preferences["outputUid"] == retained["selectedUid"]
        assert preferences["future"] == "preserve-audio-preferences"
        retained_project_hash = sha(saved / "project.json")
        retained_lyrics_hash = sha(saved / "lyrics.json")

        restarted = launch("restart")
        require_flags(restarted, ["savedMixAndLyricsAdopted", "independentLaunch"])
        assert restarted["savedProjectSha256"] == retained_project_hash
        assert restarted["selectedUid"] == retained["selectedUid"]
        assert_native_advance(restarted)
        invalid_result = restarted["invalidNewOpen"]
        assert invalid_result["projectCleared"] is True
        assert invalid_result["oldProjectBytesUnchanged"] is True
        assert "Unsupported project version" in invalid_result["notice"]
        assert sha(saved / "project.json") == retained_project_hash
        assert sha(saved / "lyrics.json") == retained_lyrics_hash
        assert sha(invalid / "project.json") == invalid_hash
        assert json.loads((invalid / "project.json").read_text())["version"] == 3

        if args.publication_fault:
            assert retained["noticeKeyboardBarrierAndEditorFocusReturn"] is True
            guarded=json.loads((out/"retained/retained-draft-audio-failed-1280.state.json").read_text())
            restored=json.loads((out/"retained/retained-notice-dismissed-editor-focused-1280.state.json").read_text())
            assert guarded["notice"] and not guarded["editor"]["textInputFocused"]
            assert restored["notice"] is None and restored["editorOpen"] and restored["editor"]["textInputFocused"]
            assert restored["editor"]["rows"][0]["text"]==DRAFT
        working = launch("working")
        require_flags(
            working,
            [
                "offlineSaveWithoutAudio",
                "adoptionWithoutOpenedReset",
                "renderedSidebarRetainedAfterPublication",
                "audioFailedUntilExplicitRouteRetry",
                "settingsRetryClicked",
            ],
        )
        assert working["selectedUid"] == retained["selectedUid"]
        working_dir = Path(working["workingDir"])
        published = Path(working["publishedDir"])
        assert working_dir.is_relative_to(config / "source-work")
        assert published.parent == library
        assert published.name == "Raw recovery fixture"
        assert published != working_dir
        publication_capture = "working-adopted-after-publication-repair-1060" if args.publication_fault else "working-adopted-offline-1060"
        published_state = json.loads((out / "working" / (publication_capture+".state.json")).read_text())
        assert working["publicationReadFault"] is args.publication_fault
        if args.publication_fault:
            coverage=working["publicationFaultCoverage"]
            assert all(coverage.values()) and len(coverage)==10
            receipt=json.loads((out/"working/publication-fault-receipt.json").read_text())
            original=(out/"working/publication-original-metadata.json").read_bytes()
            assert hashlib.sha256(original).hexdigest()==receipt["metadataSha256"]==working["publishedMetadataSha256"]
            refused=json.loads((out/"working/publication-foreign-metadata-refused-1060.state.json").read_text())
            assert refused["sourceState"]["publicationPending"] and refused["sourceState"]["working"]
            assert refused["native"] is None and refused["tracksAudioFailed"]
            assert not refused["settings"]["routeBusy"] and "Saved project changed" in refused["notice"]
            for name in ["publication-extra-escape-retains-receipt-1060","publication-settings-escape-retains-receipt-1060"]:
                state=json.loads((out/"working"/(name+".state.json")).read_text())
                assert state["notice"] is None and state["screen"]=="player"
                assert state["sourceState"]["publicationPending"] and state["sourceState"]["working"]
            overlap=json.loads((out/"working/publication-notice-over-save-progress-1060.state.json").read_text())
            assert overlap["rendererHeldSaveProgress"] and overlap["noticeRootFocused"] and overlap["notice"]
            assert not overlap["headerSaveEnabled"]
            disabled=json.loads((out/"working/publication-duplicate-save-blocked-1060.state.json").read_text())
            assert not disabled["headerSaveEnabled"]
            assert not list(published.glob("*.ui-test-held"))

        assert published_state["sidebar"]["showsLyrics"] is True
        assert published_state["sidebar"]["status"] == "ready"
        assert published_state["sidebar"]["songkey"] == str(published)
        assert published_state["lyricLines"][0]["text"] == WORKING_DRAFT
        assert working["epochBeforePublication"] == working["epochAfterPublication"]
        assert working["editorGenerationBeforePublication"] == working["editorGenerationAfterPublication"]
        assert working["lyricArcBeforePublication"] == working["lyricArcAfterPublication"]
        assert working["publishedMetadataSha256"] == sha(published / "project.json")
        assert working["publishedLyricsSha256"] == working["offlineLyricsSha256"]
        assert working["publishedLyricsSha256"] == sha(published / "lyrics.json")
        published_project = json.loads((published / "project.json").read_text())
        assert published_project["name"] == "Raw recovery fixture"
        assert published_project["sourceFileName"] == raw.name
        assert published_project["settings"]["tempo"] == 0.9
        assert published_project["settings"]["transpose"] == -2
        assert published_project["settings"]["loop"] is True
        assert published_project["settings"]["masterVolume"] == 0.62
        published_lyrics = json.loads((published / "lyrics.json").read_text())
        assert published_lyrics["source"] == "edited"
        assert published_lyrics["lines"][0]["text"] == WORKING_DRAFT
        published_media = published / published_project["songFile"]
        assert Path(working["publishedMedia"]) == published_media
        assert working["rawSourceSha256"] == raw_hash
        assert sha(published_media) == raw_hash
        assert sha(raw) == raw_hash
        assert_native_advance(working)
        assert preferences["future"] == "preserve-audio-preferences"
        assert json.loads((config / "audio.json").read_text())["future"] == "preserve-audio-preferences"
        assert len(set(process_ids)) == 3, process_ids
        assert foreground() == foreground_before

        persisted = out / "persisted"
        shutil.copytree(saved, persisted / "retained-project", dirs_exist_ok=True)
        shutil.copytree(published, persisted / "working-project", dirs_exist_ok=True)
        shutil.copy2(invalid / "project.json", persisted / "invalid-project.json")
        foreground_after = foreground()
        assert foreground_after == foreground_before
        summary = {
            "schema": 1,
            "coverage": {
                "ownedHelperDeathRetainsDocumentDraftAndStoppedClock": True,
                "invalidRecoveryRetainsPreferencesDocumentDraftAndMix": True,
                "validRecoveryRestoresActualNativePausedTransportThenAdvances": True,
                "independentEditorSaveAndProjectSaveRemainDistinct": True,
                "savedProjectSurvivesIndependentRestartAndNativePlayback": True,
                "rawWorkingOfflineSavePublishesAndAdoptsWithoutOpenedReset": True,
                "publishedMetadataLyricsAndMediaIdentityVerified": True,
                "renderedLyricsSidebarRetainedAcrossPublication": True,
                "audioRemainsFailedUntilExplicitSettingsRetry": True,
                "invalidNewOpenReportsErrorAndClearsDocument": True,
                "settingsSelectorAndRetryControlsClicked": True,
                "logicalViewports": [[1280, 800], [1060, 640]],
            },
            "publicationFault": args.publication_fault,
            "publicationFaultCoverage": working["publicationFaultCoverage"],
            "threeIndependentLaunches": True,
            "independentProcessIds": process_ids,
            "uiBinarySha256": binary_hash,
            "helperSha256": helper_hash,
            "testSourceSha256": rust_hash,
            "fixtureSha256": fixture_hash,
            "initialMediaSha256": initial_media_hash,
            "rawSourceSha256": raw_hash,
            "captures": captures,
            "performance": performance,
            "persistedEvidence": {
                "retainedProject": "persisted/retained-project/project.json",
                "retainedLyrics": "persisted/retained-project/lyrics.json",
                "workingProject": "persisted/working-project/project.json",
                "workingLyrics": "persisted/working-project/lyrics.json",
                "workingMedia": "persisted/working-project/song.wav",
                "invalidProject": "persisted/invalid-project.json",
            },
            "noNode": True,
            "hidden": True,
            "muted": True,
            "isolatedEnvironment": {
                "config": "temporary SINGZ_GPUI_CONFIG_DIR",
                "library": "temporary SINGZ_GPUI_PROJECTS_ROOT",
                "lyricsLookup": "loopback fixture server only",
                "realUserProfiles": False,
            },
            "foregroundBefore": foreground_before,
            "foregroundAfter": foreground_after,
            "fault": "simulated death of the app's owned native audio child",
            "hardwareHotplugQualified": False,
            "productionParity": "not evaluated; functional captures only",
            "unmatchedPngComparison": "not performed",
            "liveFps": "unmeasured in hidden windows",
            "platform": platform.platform(),
            "architecture": platform.machine(),
        }
        (out / "result.json").write_text(json.dumps(summary, indent=2) + "\n")
        print(
            "PASS: owned-helper loss retains drafts/documents; native route recovery, "
            "independent restart, offline working publication, persisted identity and invalid Open"
        )


try:
    main()
except Exception:
    (out / "failure.txt").write_text(traceback.format_exc())
    raise
