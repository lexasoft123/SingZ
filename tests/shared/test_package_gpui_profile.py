import importlib.util
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


if __name__ == '__main__':
    unittest.main()
