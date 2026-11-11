import importlib.util
import json
import re
from unittest.mock import patch
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, ROOT / path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


DESKTOP = load('gpui_profile_desktop', 'scripts/package-gpui-desktop.py')
MACOS = load('gpui_profile_macos', 'scripts/package-gpui-macos.py')


class ProfileTests(unittest.TestCase):
    def test_debug_requires_explicit_allow_debug(self):
        for package in (DESKTOP, MACOS):
            with self.subTest(package=package.__name__):
                with self.assertRaises(package.PackageError):
                    package.validate_runtime_profile(Path('/tmp/target/debug'), False)
                package.validate_runtime_profile(Path('/tmp/target/debug'), True)

    def test_unknown_profile_is_refused_and_release_is_default(self):
        for package in (DESKTOP, MACOS):
            with self.subTest(package=package.__name__):
                package.validate_runtime_profile(Path('/tmp/target/release'), False)
                with self.assertRaises(package.PackageError):
                    package.validate_runtime_profile(Path('/tmp/runtime'), False)
        build_script = (ROOT / 'scripts/build-gpui-native.py').read_text()
        self.assertIn("default=ROOT / 'experiments/gpui-player/target/release'", build_script)

    def test_ui_tests_marker_is_rejected(self):
        for package in (DESKTOP, MACOS):
            with self.subTest(package=package.__name__), tempfile.NamedTemporaryFile() as binary:
                binary.write(b'header' + package.UI_TESTS_MARKER)
                binary.flush()
                with self.assertRaises(package.PackageError):
                    package.reject_ui_tests_binary(Path(binary.name))

    def test_gated_environment_name_is_rejected(self):
        for package in (DESKTOP, MACOS):
            with self.subTest(package=package.__name__), tempfile.NamedTemporaryFile() as binary:
                binary.write(b'headerSINGZ_GDRIVE_CONFIGsuffix')
                binary.flush()
                with self.assertRaises(package.PackageError):
                    package.reject_ui_tests_binary(Path(binary.name))

    def test_all_inventory_names_are_rejected_and_operator_names_remain_allowed(self):
        names = json.loads((ROOT / 'tests/shared/gpui-gated-env-names.json').read_text())
        for package in (DESKTOP, MACOS):
            with tempfile.NamedTemporaryFile() as binary:
                for name in names:
                    with self.subTest(package=package.__name__, name=name):
                        binary.seek(0)
                        binary.truncate()
                        binary.write(b'header' + name.encode('ascii') + b'suffix')
                        binary.flush()
                        with self.assertRaises(package.PackageError):
                            package.reject_ui_tests_binary(Path(binary.name))
                binary.seek(0)
                binary.truncate()
                binary.write(b'SINGZ_MUTE SINGZ_GPUI_BACKGROUND SINGZ_LANG')
                binary.flush()
                package.reject_ui_tests_binary(Path(binary.name))

    def test_invalid_inventory_is_refused(self):
        for package in (DESKTOP, MACOS):
            with self.subTest(package=package.__name__), tempfile.TemporaryDirectory() as folder:
                root = Path(folder)
                listing = root / 'tests/shared/gpui-gated-env-names.json'
                listing.parent.mkdir(parents=True)
                listing.write_text('[]')
                binary = root / 'player'
                binary.write_bytes(b'clean')
                with patch.object(package, 'ROOT', root), self.assertRaises(package.PackageError):
                    package.reject_ui_tests_binary(binary)

    def test_inventory_covers_singz_source_literals(self):
        # Conservative: all quoted names, including test-only names, must be in
        # the inventory unless they are documented operator settings or a prefix.
        operator = {'SINGZ_DEMUCS', 'SINGZ_GPUI_', 'SINGZ_GPUI_BACKGROUND',
                    'SINGZ_GPUI_CONFIG_DIR', 'SINGZ_GPUI_PROJECTS_ROOT', 'SINGZ_LANG',
                    'SINGZ_MODELS_DIR', 'SINGZ_MUTE', 'SINGZ_NO_SYNC',
                    'SINGZ_NO_SYSTEM_ENGINES', 'SINGZ_PACK_DIR'}
        names = json.loads((ROOT / 'tests/shared/gpui-gated-env-names.json').read_text())
        found = {match for path in (ROOT / 'experiments/gpui-player/src').rglob('*.rs')
                 for match in re.findall(r'"(SINGZ_[A-Z0-9_]+)"', path.read_text())}
        self.assertEqual(sorted(found - operator), names)


if __name__ == '__main__':
    unittest.main()
