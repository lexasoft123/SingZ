"""Every native driver carries a deadline and is registered in the e2e-verifier lane list.

Run: python3 -m unittest tests.shared.test_native_lane_deadlines

A driver is experiments/gpui-player/tests/test_native_*.py. It must

  1. set an explicit overall timeout (a timeout/deadline/budget name, a `--timeout` or
     `--deadline` option, a `timeout=` argument), or hand the whole run to
     native_ui_observer.run, which itself has a `timeout` default; and
  2. pass a timeout to every subprocess wait: subprocess.run/call/check_call/check_output
     and Popen .wait()/.communicate().

`.claude/agents/e2e-verifier.md` must name every driver (and every tests/perf driver)
between its native-mac heading and the simulators heading, so a new driver cannot be
added without being registered.

"""
from __future__ import annotations

import ast
import re
import tempfile
import unittest
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DRIVERS = ROOT / "experiments" / "gpui-player" / "tests"
PERF = ROOT / "tests" / "perf"
LANE_DOC = ROOT / ".claude" / "agents" / "e2e-verifier.md"
LANE_START = "## Platform: native-mac"
LANE_END = "## Platform: simulators"

NAME = re.compile(r"timeout|deadline|budget", re.I)
SUBPROCESS_CALLS = {"run", "call", "check_call", "check_output"}

def _helper_run_has_timeout_default() -> bool:
    tree = ast.parse((DRIVERS / "native_ui_observer.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "run":
            names = [a.arg for a in node.args.kwonlyargs] + [a.arg for a in node.args.args]
            return "timeout" in names
    return False


def check_driver(path: Path) -> tuple[bool, Counter]:
    """Return (has overall deadline, Counter of unbounded subprocess waits by call kind)."""
    tree = ast.parse(path.read_text())
    subprocess_names: set[str] = set()
    delegates_to_observer = False
    overall = False
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.module == "subprocess":
                subprocess_names.update(a.asname or a.name for a in node.names)
            if node.module == "native_ui_observer" and any(a.name == "run" for a in node.names):
                delegates_to_observer = True
        if isinstance(node, ast.Name) and NAME.search(node.id):
            overall = True
        elif isinstance(node, ast.arg) and NAME.search(node.arg):
            overall = True
        elif isinstance(node, ast.keyword) and node.arg and NAME.search(node.arg):
            overall = True
        elif isinstance(node, ast.Constant) and isinstance(node.value, str) \
                and node.value.startswith("--") and NAME.search(node.value):
            overall = True
    if delegates_to_observer and _helper_run_has_timeout_default():
        overall = True
    unbounded: Counter = Counter()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func, kind = node.func, None
        if isinstance(func, ast.Attribute):
            if isinstance(func.value, ast.Name) and func.value.id == "subprocess" and func.attr in SUBPROCESS_CALLS:
                kind = func.attr
            elif func.attr in ("wait", "communicate"):
                kind = func.attr
        elif isinstance(func, ast.Name) and func.id in subprocess_names and func.id in SUBPROCESS_CALLS:
            kind = func.id
        if kind is None:
            continue
        bounded = any(k.arg == "timeout" for k in node.keywords) \
            or any(k.arg is None for k in node.keywords) \
            or (kind in ("wait", "communicate") and bool(node.args))
        if not bounded:
            unbounded[kind] += 1
    return overall, unbounded


def drivers(directory: Path = DRIVERS) -> list[Path]:
    return sorted(directory.glob("test_native_*.py"))


def lane_text() -> str:
    text = LANE_DOC.read_text()
    start, end = text.index(LANE_START), text.index(LANE_END)
    return text[start:end]


def perf_drivers() -> list[str]:
    return sorted(f"tests/perf/{p.name}" for p in PERF.iterdir() if p.suffix in (".py", ".cjs") and not p.name.startswith("test_"))


class NativeDriverDeadlines(unittest.TestCase):
    def test_every_driver_has_an_overall_deadline(self):
        missing = [p.name for p in drivers() if not check_driver(p)[0]]
        self.assertEqual(missing, [], "native drivers without an explicit overall timeout")

    def test_subprocess_waits_have_timeouts(self):
        found = {p.name: dict(check_driver(p)[1]) for p in drivers() if check_driver(p)[1]}
        self.assertEqual(found, {}, "subprocess waits without a timeout (file -> call kind -> count)")

    def test_planted_driver_without_a_deadline_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            planted = Path(tmp) / "test_native_planted.py"
            planted.write_text(
                "import subprocess\n"
                "child = subprocess.Popen(['sleep', '1'])\n"
                "child.wait()\n"
                "subprocess.run(['true'])\n"
            )
            overall, unbounded = check_driver(planted)
            self.assertFalse(overall)
            self.assertEqual(unbounded, Counter({"wait": 1, "run": 1}))
            bounded = Path(tmp) / "test_native_bounded.py"
            bounded.write_text(
                "import subprocess\nTIMEOUT = 30\n"
                "child = subprocess.Popen(['sleep', '1'])\n"
                "child.wait(timeout=TIMEOUT)\nsubprocess.run(['true'], timeout=TIMEOUT)\n"
            )
            self.assertEqual(check_driver(bounded), (True, Counter()))

    def test_lane_list_names_every_driver(self):
        lane = lane_text()
        missing = [p.name for p in drivers() if f"`{p.name}`" not in lane]
        missing += [name for name in perf_drivers() if f"`{name}`" not in lane]
        self.assertEqual(missing, [], "drivers not named in the native lane of .claude/agents/e2e-verifier.md")


if __name__ == "__main__":
    unittest.main()
