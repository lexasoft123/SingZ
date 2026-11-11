#!/usr/bin/env python3
"""End-to-end native updater run on a real install, hidden and muted.

Four scenarios, each on a fresh install of version N (1.0.0), against a local
signed feed that offers N+1 (1.0.1), using a throwaway Ed25519 key:

  update      N updates itself to N+1; N+1 confirms its first launch.
  tampered    the archive differs from the signed manifest: refused, N stays.
  unsigned    the manifest is signed by another key / has no signature: refused.
  unwritable  the install folder is read-only: no download, the user is offered
              the release link instead (Electron's `available` state).
  quit-install an ordinary quit (no "Restart to update" button) installs the
              staged update.
  second-instance a second app instance owns no updater: it neither downloads
              nor installs while the first one runs.
  pending     N+2 appears while N+1 is still confirming its first launch: the
              confirmation transaction is left alone and N+1 confirms.
  broken-audio N+1's audio helper never answers: the build must not confirm; the
              watchdog restores N after the 60 s deadline.
  rollback    N+1 is forced to fail its first launch: the watchdog restores N
              and blocks 1.0.1 so it is not offered again.

Every scenario also proves user data (library, models, config files created by
the test) is byte-identical afterwards. Nothing here touches a real profile:
HOME, the config dir, library and models dir all live in a scratch folder.

macOS (ad-hoc bundles built with scripts/package-gpui-macos.py):
    python3 experiments/gpui-player/tests/test_native_updater.py macos \\
        [--binary PATH]        # a `--features test-hooks` singz-gpui-player;
                               # default: built through the native build lock

Windows (per-user NSIS install under the scratch folder). ONE command, run in
the repository root on the Windows VM / Dell, with a `--features test-hooks`
runtime directory (target\\debug) and the engines directory used for packaging:
    python experiments\\gpui-player\\tests\\test_native_updater.py windows ^
        --runtime-dir <target\\debug> --engines-dir <engines> [--uikit-dir <singz-ui>]

The Windows run builds two payloads (N, N+1), one NSIS installer for N, silently
installs it per-user with /S /D=..., and then runs the same four scenarios. It
needs `makensis` (or SINGZ_MAKENSIS). The installer writes the HKCU uninstall
key for com.lexasoft.singz.native like a real install; the script runs the
uninstaller at the end.

The packagers refuse any binary containing a gated test-hook name, by design.
This driver loads the packager modules and disables only that one check, in
memory, for its own throwaway test-hooks build. Nothing is written to the repo.
"""
from __future__ import annotations

import argparse
import hashlib
import http.server
import importlib.util
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
GPUI = HERE.parent
ROOT = GPUI.parents[1]
SIGNER = ROOT / "scripts/sign-gpui-update.py"
N, N1 = "1.0.0", "1.0.1"
STEP_DEADLINE = 120  # seconds any single wait may take
TOTAL_DEADLINE = 1500  # seconds for the whole run
LOG = []


def say(message: str) -> None:
    line = f"[{time.strftime('%H:%M:%S')}] {message}"
    LOG.append(line)
    print(line, flush=True)


def fail(message: str) -> None:
    say(f"FAIL {message}")
    raise SystemExit(1)


def wait_for(what: str, condition, timeout: float = STEP_DEADLINE, every: float = 0.25):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = condition()
        if value:
            return value
        time.sleep(every)
    fail(f"timed out after {timeout:.0f}s waiting for: {what}")


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def openssl() -> str:
    homebrew = Path("/opt/homebrew/bin/openssl")
    return str(homebrew) if homebrew.is_file() else (shutil.which("openssl") or "openssl")


def make_key(path: Path) -> str:
    subprocess.run([openssl(), "genpkey", "-algorithm", "ED25519", "-out", str(path)], check=True, capture_output=True, timeout=30)
    return subprocess.run([sys.executable, str(SIGNER), "--public-key-hex", str(path)], check=True, capture_output=True, text=True, timeout=30).stdout.strip()


class Feed:
    """A local HTTP feed directory."""

    def __init__(self, directory: Path):
        directory.mkdir(parents=True, exist_ok=True)
        self.directory = directory
        handler_cls = type("Quiet", (http.server.SimpleHTTPRequestHandler,), {"log_message": lambda *a: None})
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), lambda *a, **k: handler_cls(*a, directory=str(directory), **k))
        self.url = f"http://127.0.0.1:{self.server.server_port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()


class Target:
    """What differs between the macOS bundle and the Windows per-user install."""

    name: str
    update_target: str

    def prepare(self, work: Path, args) -> None: ...
    def install_n(self, dest: Path) -> None: ...
    def payload_n1(self, broken=False) -> Path: ...
    def root(self, dest: Path) -> Path: ...  # the directory the updater swaps
    def exe(self, dest: Path) -> Path: ...
    def version_dir(self, dest: Path) -> Path: ...
    def kill(self, dest: Path) -> None: ...
    def finish(self, dest: Path) -> None: ...

    def installed_version(self, dest: Path) -> str:
        return (self.version_dir(dest) / "singz-test-version.txt").read_text().strip()


def run_checked(argv, **kw):
    result = subprocess.run(argv, capture_output=True, text=True, **kw)
    if result.returncode != 0:
        fail(f"{' '.join(map(str, argv))[:200]} -> {result.returncode}\n{result.stdout[-800:]}{result.stderr[-1200:]}")
    return result


class MacTarget(Target):
    name = "macos"

    def __init__(self):
        arch = platform.machine()
        self.update_target = "macos-arm64" if arch == "arm64" else "macos-x64"

    def prepare(self, work, args):
        pkg = load_module("package_gpui_macos", ROOT / "scripts/package-gpui-macos.py")
        pkg.reject_ui_tests_binary = lambda path: None  # throwaway test-hooks build only
        binary = Path(args.binary or build_test_hooks_binary()).resolve()
        runtime = work / "runtime/debug"
        (runtime / "pitch").mkdir(parents=True)
        (runtime / "training-sounds").mkdir()
        stub = work / "stub.c"
        stub.write_text("int main(void){return 0;}\n")
        run_checked(["cc", str(stub), "-o", str(runtime / "stub")])
        shutil.copy2(binary, runtime / "singz-gpui-player")
        helper = Path(args.audio_helper or build_audio_helper(work)).resolve()
        for name in pkg.EXECUTABLES[1:]:  # player and audio helper are real; the rest are inert stand-ins
            shutil.copy2(helper if name == "singz-gpui-audio" else runtime / "stub", runtime / name)
        for name in ("crepe-tiny.bin", "torchcrepe-LICENSE.txt"):
            (runtime / "pitch" / name).write_text("x")
        for name in pkg.SAMPLES:
            (runtime / "training-sounds" / name).write_text("x")
        engines = work / "engines"
        engines.mkdir()
        for name in ("llama-server", "crispasr"):
            shutil.copy2(runtime / "stub", engines / name)
        fonts = work / "fonts"
        fonts.mkdir()
        for name in pkg.FONT_LICENSES:
            (fonts / name).write_text("OFL")
        broken = work / "runtime-broken/debug"
        shutil.copytree(runtime, broken, symlinks=True)
        shutil.copy2(runtime / "stub", broken / "singz-gpui-audio")  # a helper that never answers the inventory
        self.bundles = {}
        for version, variant, source in ((N, "", runtime), (N1, "", runtime), (N1, "-broken", broken)):
            output = work / f"bundles-{version}{variant}" / "SingZ Preview.app"
            output.parent.mkdir()
            pkg.assemble(source, output, version=version, engines=engines, font_license_dir=fonts, ad_hoc_sign=True)
            (output / "Contents/Resources/singz-test-version.txt").write_text(version)
            run_checked(["codesign", "--force", "--deep", "--sign", "-", str(output)])
            run_checked(["codesign", "--verify", "--deep", "--strict", str(output)])
            self.bundles[version + variant] = output
        say(f"packaged ad-hoc bundles {N} and {N1} from {binary.name}")

    def install_n(self, dest):
        dest.mkdir(parents=True)
        run_checked(["ditto", str(self.bundles[N]), str(self.root(dest))])

    def payload_n1(self, broken=False):
        return self.bundles[N1 + ("-broken" if broken else "")]

    def root(self, dest):
        return dest / "SingZ Preview.app"

    def exe(self, dest):
        return self.root(dest) / "Contents/MacOS/singz-gpui-player"

    def version_dir(self, dest):
        return self.root(dest) / "Contents/Resources"

    def kill(self, dest):
        subprocess.run(["pkill", "-f", str(dest)], capture_output=True, timeout=30)
        time.sleep(0.5)

    def finish(self, dest):
        pass


class WindowsTarget(Target):
    name = "windows"
    update_target = "windows-x64"

    def prepare(self, work, args):
        pkg = load_module("package_gpui_desktop", ROOT / "scripts/package-gpui-desktop.py")
        pkg.reject_ui_tests_binary = lambda path: None  # throwaway test-hooks build only
        self.work = work
        self.payloads = {}
        for version in (N, N1):
            output = work / f"payload-{version}"
            pkg.assemble("windows", args.runtime_dir, output, uikit_dir=args.uikit_dir, engines=args.engines_dir)
            # The installer lays down only what manifest.json lists, so every
            # file the test adds after assembly is listed there too.
            added = ["singz-test-version.txt"]
            (output / "singz-test-version.txt").write_text(version)
            if version == N1:
                # N+1 adds a nested file N's original inventory never knew (R4).
                extra = output / "added-in-n1" / "nested" / "extra.txt"
                extra.parent.mkdir(parents=True)
                extra.write_text("new in 1.0.1")
                added.append("added-in-n1/nested/extra.txt")
            manifest = json.loads((output / "manifest.json").read_text(encoding="utf-8"))
            for relative in added:
                path = output / relative
                manifest["files"].append({"path": relative, "bytes": path.stat().st_size,
                                          "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "mode": 0o644})
            (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
            self.payloads[version] = output
        self.setup = work / f"SingZ-Native-{N}-setup.exe"
        pkg.build_installer(self.payloads[N], self.setup)
        say(f"built payloads {N} / {N1} and installer {self.setup.name}")

    def install_n(self, dest):
        dest.parent.mkdir(parents=True, exist_ok=True)
        # NSIS: /S silent, /D must be last and unquoted. Per-user, no elevation.
        subprocess.run(f'"{self.setup}" /S /D={dest}', shell=True, check=True, timeout=180)
        wait_for("installer to finish", lambda: self.exe(dest).is_file(), 60)

    def payload_n1(self, broken=False):
        return self.payloads[N1]  # Windows: the broken-audio scenario is macOS-only

    def root(self, dest):
        return dest

    def exe(self, dest):
        return dest / "singz-gpui-player.exe"

    def version_dir(self, dest):
        return dest

    def kill(self, dest):
        script = f"Get-CimInstance Win32_Process | Where-Object {{ $_.ExecutablePath -like '{dest}*' }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}"
        subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, timeout=30)
        time.sleep(1)

    def finish(self, dest):
        uninstaller = dest / "Uninstall.exe"
        if uninstaller.is_file():
            subprocess.run([str(uninstaller), "/S", f"_?={dest}"], capture_output=True, timeout=120)


def build_audio_helper(work: Path) -> Path:
    out = work / "singz-gpui-audio"
    say("building the real audio helper (self-locking producer)")
    deadline = time.monotonic() + 3000
    while True:
        result = subprocess.run(["bash", str(ROOT / "scripts/build-gpui-audio.sh"), str(out)], cwd=ROOT, capture_output=True, text=True,
                                timeout=max(1.0, deadline - time.monotonic()))
        if result.returncode == 0 and out.is_file():
            return out
        if time.monotonic() < deadline and "lock" in (result.stdout + result.stderr).lower():
            time.sleep(5)
            continue
        fail("audio helper build failed:\n" + (result.stdout + result.stderr)[-2000:])


def build_test_hooks_binary() -> Path:
    say("building the test-hooks player through the native build lock")
    while True:
        result = subprocess.run(
            ["node", str(ROOT / "scripts/with-native-build-lock.mjs"), "--owner", "c33", "--", "cargo", "build", "--offline", "--locked",
             "--features", "test-hooks", "--bin", "singz-gpui-player"],
            cwd=GPUI, capture_output=True, text=True, timeout=TOTAL_DEADLINE)
        if result.returncode == 0:
            return GPUI / "target/debug/singz-gpui-player"
        if "singz-native-build.lock" in result.stderr and "owns" in result.stderr:
            time.sleep(5)  # another worker holds the lock: retry, as the build rules say
            continue
        fail("cargo build failed:\n" + (result.stdout + result.stderr)[-2000:])


class Scenario:
    def __init__(self, target: Target, work: Path, key: Path, public: str):
        self.target, self.work, self.key, self.public = target, work, key, public
        self.processes: list[subprocess.Popen] = []

    # -- environment ------------------------------------------------------
    def sandbox(self, name: str):
        base = self.work / name
        home, config, library, models = (base / d for d in ("home", "config", "library", "models"))
        for d in (home, config, library, models):
            d.mkdir(parents=True)
        user_data = {
            library / "song" / "project.json": b'{"user":"library"}',
            models / "model.bin": b"model-bytes",
            config / "settings-sentinel.json": b'{"keep":true}',
            home / "Documents" / "notes.txt": "never touched – ünïcode".encode(),
        }
        for path, data in user_data.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
        return base, home, config, library, models, user_data

    def env(self, home, config, library, models, feed, extra=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith("SINGZ_")}
        env.update(
            HOME=str(home), USERPROFILE=str(home), APPDATA=str(home / "AppData"), LOCALAPPDATA=str(home / "Local"),
            SINGZ_GPUI_BACKGROUND="1", SINGZ_MUTE="1", SINGZ_NO_SYNC="1", SINGZ_LANG="en",
            SINGZ_GPUI_CONFIG_DIR=str(config), SINGZ_GPUI_PROJECTS_ROOT=str(library), SINGZ_MODELS_DIR=str(models),
            SINGZ_UPDATE_FEED=feed.url, SINGZ_UPDATE_TEST_PUBLIC_KEY=self.public,
            SINGZ_UPDATE_FIRST_CHECK_MS="300", SINGZ_UPDATE_CONFIRM_MS="1500", SINGZ_UPDATE_AUTO_INSTALL="1",
        )
        if self.target.name == "windows":
            # Windows paints no frame for a hidden window, and "main window
            # presented" is part of the first-launch health gate (D-04): the
            # app runs visible (still muted) in the logged-in desktop session.
            env.pop("SINGZ_GPUI_BACKGROUND", None)
        for key, value in (extra or {}).items():
            if value is None:
                env.pop(key, None)
            else:
                env[key] = value
        return env

    def updates_dir(self, config: Path) -> Path | None:
        """The install's coordination directory (`.singz-update-<id>` beside
        the install, shared by every profile), or, for an install that cannot
        update itself, the per-profile log directory (`updates/<id>/`)."""
        dest = getattr(self, "ctx", {}).get("dest")
        if dest is not None:
            beside = sorted(self.target.root(dest).parent.glob(".singz-update-*"))
            if beside:
                return beside[0]
        root = config / "updates"
        found = [d for d in root.glob("*") if d.is_dir() and d.name != "applier"] if root.is_dir() else []
        return found[0] if found else None

    def state(self, config: Path) -> dict:
        directory = self.updates_dir(config)
        try:
            state = json.loads((directory / "state.json").read_text())
            blocked = directory / "blocked.json"
            state["blocked"] = json.loads(blocked.read_text()) if blocked.exists() else []
            return state
        except (OSError, ValueError, AttributeError, TypeError):
            return {}

    def log(self, config: Path) -> str:
        directory = self.updates_dir(config)
        try:
            return (directory / "applier.log").read_text()
        except (OSError, AttributeError, TypeError):
            return ""

    def snapshot(self, user_data) -> dict:
        return {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in user_data}

    # -- one scenario -------------------------------------------------------
    def run(self, name: str, feed_builder, extra_env=None, expect=None, lock_install=False):
        say(f"--- scenario: {name}")
        base, home, config, library, models, user_data = self.sandbox(name)
        feed = Feed(base / "feed")
        feed_builder(feed.directory)
        dest = base / "install"
        self.target.install_n(dest)
        proc = None
        try:
            say(f"installed N={self.target.installed_version(dest)} at {self.target.root(dest)}")
            before = self.snapshot(user_data)
            if lock_install:
                os.chmod(dest, 0o555)  # the app cannot create its staging siblings here
            env = self.env(home, config, library, models, feed, extra_env)
            proc = subprocess.Popen([str(self.target.exe(dest))], env=env, stdout=(base / "app.log").open("wb"), stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            self.processes.append(proc)
            self.ctx = dict(env=env, base=base, dest=dest, feed=feed, config=config)
            expect(self, dest, config, proc)
            after = self.snapshot(user_data)
            if before != after:
                fail(f"user data changed during {name}: {before} != {after}")
            say(f"PASS {name}: user data (library, models, config, documents) byte-identical")
        finally:
            # Always undo the install, even when the scenario failed early.
            if lock_install:
                os.chmod(dest, 0o755)
            self.target.kill(dest)
            feed.close()
            if proc is not None:
                try:
                    proc.terminate()
                except OSError:
                    pass
            self.target.finish(dest)


def signed_feed(target: Target, key: Path, tamper=False, wrong_key: Path | None = None, drop_sig=False, broken=False):
    def build(directory: Path):
        used = wrong_key or key
        run_checked([sys.executable, str(SIGNER), "--payload", str(target.payload_n1(broken)), "--version", N1, "--target", target.update_target,
                     "--out-dir", str(directory), "--key", str(used), "--rollback-floor", N])
        if tamper:
            archive = directory / f"singz-native-{target.update_target}.zip"
            data = bytearray(archive.read_bytes())
            data[len(data) // 2] ^= 0xFF  # same length, different bytes
            archive.write_bytes(bytes(data))
        if drop_sig:
            (directory / f"singz-native-{target.update_target}.update.json.sig").unlink()
    return build


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="platform")
    mac = sub.add_parser("macos")
    mac.add_argument("--binary", help="a --features test-hooks singz-gpui-player (default: build one)")
    mac.add_argument("--audio-helper", help="a real singz-gpui-audio (default: build one)")
    win = sub.add_parser("windows")
    win.add_argument("--runtime-dir", type=Path, required=True)
    win.add_argument("--engines-dir", type=Path, required=True)
    win.add_argument("--uikit-dir", type=Path)
    for p in (mac, win):
        p.add_argument("--keep", action="store_true", help="keep the scratch folder")
        p.add_argument("--work-dir", type=Path, help="parent folder for the scratch folder (default: system temp)")
        p.add_argument("--only", choices=("update", "tampered", "unsigned", "unwritable", "quit-install", "second-instance", "two-profiles", "pending", "broken-audio", "rollback"), action="append")
    args = parser.parse_args()
    if not args.platform:
        args.platform = "macos" if sys.platform == "darwin" else "windows"
        args.binary = None
        args.audio_helper = None
        args.keep = False
        args.only = None
        args.work_dir = None
    if hasattr(signal, "SIGALRM"):
        signal.signal(signal.SIGALRM, lambda *_: fail(f"total deadline of {TOTAL_DEADLINE}s exceeded"))
        signal.alarm(TOTAL_DEADLINE)
    target: Target = MacTarget() if args.platform == "macos" else WindowsTarget()
    if args.work_dir:
        args.work_dir.mkdir(parents=True, exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix="singz-updater-e2e-", dir=args.work_dir))
    say(f"scratch folder {work}")
    try:
        key, other = work / "update-key.pem", work / "other-key.pem"
        public = make_key(key)
        make_key(other)
        target.prepare(work, args)
        s = Scenario(target, work, key, public)
        chosen = set(args.only or ("update", "tampered", "unsigned", "unwritable", "quit-install", "second-instance", "two-profiles", "pending", "broken-audio", "rollback"))

        def expect_update(sc, dest, config, proc):
            wait_for("N+1 to confirm its first launch", lambda: sc.state(config).get("phase") == "confirmed" and sc.state(config).get("version") == N1)
            wait_for("the installed payload to report N+1", lambda: sc.target.installed_version(dest) == N1)
            state = sc.state(config)
            if state.get("previousVersion") != N or state.get("blocked"):
                fail(f"unexpected journal after update: {state}")
            if not list(sc.target.root(dest).parent.glob(".singz-previous-*")):
                fail("the previous payload was not retained for rollback")
            say(f"updated {N} -> {N1}; journal: {json.dumps(state)}")
            say("applier log:\n  " + sc.log(config).strip().replace("\n", "\n  "))
            if sys.platform == "win32":
                # R4: uninstalling the updated install removes N+1's files too.
                if not (dest / "added-in-n1/nested/extra.txt").is_file():
                    fail("the N+1 payload did not carry its added nested file")
                sc.target.kill(dest)
                subprocess.run([str(dest / "Uninstall.exe"), "/S"], check=True, timeout=120)
                wait_for("the uninstaller to remove the updated install", lambda: not dest.exists(), 120)
                key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\com.lexasoft.singz.native"
                if subprocess.run(["reg", "query", key], capture_output=True, timeout=30).returncode == 0:
                    fail("the uninstall registry key survived")
                say("uninstall after the update removed every payload file, including N+1's nested addition")

        def expect_refused(needle, allowed_phases):
            def check(sc, dest, config, proc):
                wait_for(f"the refusal ({needle!r}) to be logged", lambda: needle in sc.log(config))
                time.sleep(2)  # an auto-install, had one started, would have swapped by now
                if sc.target.installed_version(dest) != N:
                    fail("the install changed although the update must be refused")
                phase = sc.state(config).get("phase", "idle")
                if phase not in allowed_phases:
                    fail(f"journal phase {phase!r} after a refused update, expected one of {allowed_phases}")
                say(f"refused as expected; log: {sc.log(config).strip().splitlines()[-1]}")
            return check

        def expect_rollback(sc, dest, config, proc):
            wait_for("the watchdog to roll back", lambda: sc.state(config).get("phase") == "rolled-back")
            if sc.state(config).get("blocked") != [N1]:
                fail(f"1.0.1 was not blocked: {sc.state(config)}")
            wait_for("N to be restored", lambda: sc.target.installed_version(dest) == N)
            log = sc.log(config)
            if "rolling back" not in log or "previous version restored" not in log:
                fail("applier log lacks the rollback trail:\n" + log)
            say("applier log:\n  " + log.strip().replace("\n", "\n  "))

            def relaunched():
                if sys.platform == "darwin":
                    return subprocess.run(["pgrep", "-f", str(sc.target.exe(dest))], capture_output=True, timeout=30).returncode == 0
                return True
            wait_for("the old version to be running again", relaunched, 30)
            time.sleep(4)  # several 300 ms checks later it must not re-offer the blocked version
            if sc.state(config).get("phase") != "rolled-back" or sc.target.installed_version(dest) != N:
                fail("the blocked version was offered again")
            say("rolled back to N, 1.0.1 blocked and not re-offered")
            # Damage the journal: the app must fail closed and the blocked ledger must survive.
            sc.target.kill(dest)
            directory = sc.updates_dir(config)
            (directory / "state.json").write_bytes(b'{"phase":"pending-conf')
            again = subprocess.Popen([str(sc.target.exe(dest))], env=sc.ctx["env"], stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
            time.sleep(6)
            if sc.target.installed_version(dest) != N or (directory / "update.zip").exists():
                fail("an unreadable journal must disable updating")
            if (directory / "state.json").read_bytes() != b'{"phase":"pending-conf':
                fail("the damaged journal was overwritten instead of preserved")
            if json.loads((directory / "blocked.json").read_text()) != [N1]:
                fail("the blocked ledger was lost")
            again.terminate()
            say("a damaged journal disabled updating; the blocked ledger survived")

        if "update" in chosen:
            s.run("update", signed_feed(target, key), expect=expect_update)
        if "tampered" in chosen:
            s.run("tampered", signed_feed(target, key, tamper=True), expect=expect_refused("SHA-256", {"aborted"}))
        if "unsigned" in chosen:
            s.run("unsigned-wrong-key", signed_feed(target, key, wrong_key=other), expect=expect_refused("signature is invalid", {"idle"}))
            s.run("unsigned-missing-signature", signed_feed(target, key, drop_sig=True), expect=expect_refused("update check failed", {"idle"}))
        if "unwritable" in chosen and os.name == "posix":
            def expect_manual(sc, dest, config, proc):
                wait_for("the fallback to the download link", lambda: "cannot update itself" in sc.log(config))
                time.sleep(2)
                state = sc.state(config)
                if state.get("phase", "idle") != "idle" or state.get("staged"):
                    fail(f"an unwritable install must not download or stage anything: {state}")
                if sc.target.installed_version(dest) != N or any(dest.glob(".singz-*")):
                    fail("an unwritable install was touched")
                say("fell back to the download link: " + sc.log(config).strip().splitlines()[-1])
            s.run("unwritable", signed_feed(target, key), expect=expect_manual, lock_install=True)
        if "quit-install" in chosen:
            s.run("quit-install", signed_feed(target, key), extra_env={"SINGZ_UPDATE_AUTO_INSTALL": None, "SINGZ_UPDATE_QUIT_WHEN_READY": "1"}, expect=expect_update)

        if "second-instance" in chosen:
            def expect_second_instance(sc, dest, config, proc):
                # Instance A (the one already running) owns the install and never checks.
                wait_for("instance A to own the install", lambda: sc.updates_dir(config) is not None and (sc.updates_dir(config) / "instance.lock").exists(), 30)
                # Instance B offers an update and would install it automatically, if it were the owner.
                b_env = dict(sc.ctx["env"], SINGZ_UPDATE_FIRST_CHECK_MS="300", SINGZ_UPDATE_AUTO_INSTALL="1")
                b = subprocess.Popen([str(sc.target.exe(dest))], env=b_env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
                time.sleep(8)  # many 300 ms checks
                directory = sc.updates_dir(config)
                if sc.target.installed_version(dest) != N or (directory / "update.zip").exists() or "found" in sc.log(config):
                    fail("a second instance acted as the updater while the first one owns the install")
                if sc.state(config).get("phase", "idle") != "idle":
                    fail(f"a second instance touched the journal: {sc.state(config)}")
                b.terminate()
                say("second instance stayed out of the updater and the journal")
            s.run("second-instance", signed_feed(target, key), extra_env={"SINGZ_UPDATE_FIRST_CHECK_MS": "600000", "SINGZ_UPDATE_AUTO_INSTALL": None}, expect=expect_second_instance)

        if "two-profiles" in chosen:
            def expect_two_profiles(sc, dest, config, proc):
                # R1: profile A owns the install. Profile B (another config root)
                # would download and install at once, if it were admitted.
                wait_for("profile A to own the install", lambda: sc.updates_dir(config) is not None and (sc.updates_dir(config) / "instance.lock").exists(), 30)
                b_config = sc.ctx["base"] / "config-b"
                b_config.mkdir()
                b_env = dict(sc.ctx["env"], SINGZ_GPUI_CONFIG_DIR=str(b_config), SINGZ_UPDATE_FIRST_CHECK_MS="300", SINGZ_UPDATE_AUTO_INSTALL="1")
                b = subprocess.Popen([str(sc.target.exe(dest))], env=b_env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
                try:
                    code = b.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    b.kill()
                    fail("profile B kept running beside profile A on one install")
                time.sleep(3)
                directory = sc.updates_dir(config)
                if sc.target.installed_version(dest) != N or (directory / "update.zip").exists() or "found" in sc.log(config):
                    fail("profile B acted as an updater while profile A owns the install")
                if any((b_config / "updates").glob("*/state.json")) if (b_config / "updates").exists() else False:
                    fail("profile B kept its own journal for a shared install")
                say(f"profile B exited at once (code {code}) while profile A owned the install")
                # Once A is gone, B is the owner, and it uses the same journal.
                sc.target.kill(dest)
                b2 = subprocess.Popen([str(sc.target.exe(dest))], env=b_env, stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL)
                sc.processes.append(b2)
                wait_for("profile B to update the shared install", lambda: sc.state(config).get("phase") == "confirmed" and sc.target.installed_version(dest) == N1)
                say("profile B updated the install through the one shared coordination directory")
            s.run("two-profiles", signed_feed(target, key), extra_env={"SINGZ_UPDATE_FIRST_CHECK_MS": "600000", "SINGZ_UPDATE_AUTO_INSTALL": None}, expect=expect_two_profiles)

        if "pending" in chosen:
            def expect_pending(sc, dest, config, proc):
                feed_dir = sc.ctx["feed"].directory
                manifest = feed_dir / f"singz-native-{sc.target.update_target}.update.json"

                def offer_n2():
                    # The handoff has happened (planned) or any later step of the swap.
                    if sc.state(config).get("phase") not in ("planned", "staged", "swapping", "swapped", "pending-confirm"):
                        return False
                    document = json.loads(manifest.read_text())
                    document["version"] = "1.0.2"  # N+2 appears while N+1 is about to confirm
                    manifest.write_text(json.dumps(document, separators=(",", ":")))
                    run_checked([sys.executable, str(SIGNER), str(manifest), "--key", str(sc.key)])
                    return True
                wait_for("the swap to start", offer_n2, 60, every=0.02)
                wait_for("N+1 to confirm although N+2 is on offer", lambda: sc.state(config).get("phase") == "confirmed" and sc.state(config).get("version") == N1, 90)
                state = sc.state(config)
                if state.get("blocked") or "found" in sc.log(config).split("watching")[-1].split("confirmed")[0]:
                    fail(f"N+1's confirmation transaction was disturbed: {state}")
                say("N+1 confirmed with N+2 on offer; the transaction was left alone")
            s.run("pending", signed_feed(target, key), extra_env={"SINGZ_UPDATE_CONFIRM_MS": "4000"}, expect=expect_pending)

        if "broken-audio" in chosen and sys.platform == "darwin":
            def expect_broken_audio(sc, dest, config, proc):
                wait_for("the watchdog deadline to roll the build back", lambda: sc.state(config).get("phase") == "rolled-back", 150)
                log = sc.log(config)
                if "no confirmation within the deadline" not in log or sc.state(config).get("blocked") != [N1]:
                    fail("a build whose audio helper never answered must not confirm:\n" + log)
                wait_for("N to be restored", lambda: sc.target.installed_version(dest) == N)
                say("a build with a dead audio helper never confirmed and was rolled back")
            s.run("broken-audio", signed_feed(target, key, broken=True), extra_env={"SINGZ_UPDATE_CONFIRM_MS": "1500"}, expect=expect_broken_audio)

        if "rollback" in chosen:
            s.run("rollback", signed_feed(target, key), extra_env={"SINGZ_UPDATE_FAIL_FIRST_LAUNCH": "1"}, expect=expect_rollback)
        say("ALL SCENARIOS PASSED")
        return 0
    finally:
        if args.keep:
            say(f"kept {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
