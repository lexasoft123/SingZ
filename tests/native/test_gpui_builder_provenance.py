"""Native producer provenance contracts, without a compiler or audio devices."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('gpui_builder', ROOT / 'scripts/build-gpui-native.py')
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)
STAMP = 'a' * 40


class ProducerTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='gpui provenance with spaces ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.output = self.root / 'output'
        self.build_dir = self.root / 'reused-cache'
        self.build_dir.mkdir()
        (self.build_dir / 'CMakeCache.txt').write_text('SINGZ_SOURCE_HASH:STRING=' + 'b' * 40)
        assets = self.root / 'assets/pitch'
        assets.mkdir(parents=True)
        for name in ('crepe-tiny.bin', 'torchcrepe-LICENSE.txt'):
            (assets / name).write_bytes(b'fixture')
        (self.root / 'mobile/assets/training-sounds').mkdir(parents=True)
        self.locked = False
        self.commands = []
        self.replies = [STAMP, STAMP]

    @contextmanager
    def lease(self, *_args):
        self.locked = True
        try:
            yield
        finally:
            self.locked = False

    def fingerprint(self, *_args):
        self.assertTrue(self.locked)
        return self.replies.pop(0)

    def execute(self, command, **_kwargs):
        self.commands.append(command)
        if '--build' in command:
            for name in builder.HELPERS:
                (self.build_dir / name).write_bytes(b'compiled fixture')
        return SimpleNamespace(stdout=json.dumps({'version': 1, 'sourceHash': STAMP}))

    def build(self, **kwargs):
        modules = {'gpui-codec-runtime.py': SimpleNamespace(),
                   'gpui_native_build_lock.py': SimpleNamespace(native_build_lock=self.lease)}
        with patch.object(builder, 'ROOT', self.root), \
             patch.object(builder, 'native_target', return_value='linux-x64'), \
             patch.object(builder, 'cmake_path', return_value='cmake'), \
             patch.object(builder, 'load_script', side_effect=lambda _name, filename: modules[filename]), \
             patch.object(builder, 'analyze_source_hash', side_effect=self.fingerprint), \
             patch.object(builder.subprocess, 'run', side_effect=self.execute):
            return builder.build(self.output, basic_only=True, build_dir=self.build_dir, **kwargs)

    def test_reused_cache_gets_explicit_current_stamp_and_staged_probe(self):
        plan = self.build()
        self.assertIn('-DSINGZ_SOURCE_HASH=' + STAMP, self.commands[0])
        self.assertEqual(plan['sourceHash'], STAMP)
        probes = [command for command in self.commands if command[-1] == 'build-info']
        self.assertEqual(len(probes), 2)
        self.assertEqual(Path(probes[1][0]).parent, self.output)
        self.assertEqual((self.output / 'singz-analyze').read_bytes(), b'compiled fixture')
        self.assertFalse(self.locked)

    def test_changed_inputs_prevent_helper_publication(self):
        self.replies = [STAMP, 'c' * 40]
        with self.assertRaisesRegex(RuntimeError, 'inputs changed'):
            self.build()
        self.assertFalse((self.output / 'singz-analyze').exists())
        self.assertFalse((self.output / 'singz-gpui-audio').exists())

    def test_staged_mismatch_preserves_previous_analyzer(self):
        original_run = self.execute
        self.output.mkdir()
        (self.output / 'singz-analyze').write_bytes(b'previous analyzer')
        def wrong_staged(command, **kwargs):
            result = original_run(command, **kwargs)
            if command[-1] == 'build-info' and Path(command[0]).parent == self.output:
                result.stdout = json.dumps({'version': 1, 'sourceHash': None})
            return result
        self.execute = wrong_staged
        with self.assertRaisesRegex(RuntimeError, 'provenance mismatch'):
            self.build()
        self.assertEqual((self.output / 'singz-analyze').read_bytes(), b'previous analyzer')
        self.assertEqual(list(self.output.glob('.singz-analyze-*')), [])

    def test_built_mismatch_prevents_any_helper_publication(self):
        original_run = self.execute
        def wrong_built(command, **kwargs):
            result = original_run(command, **kwargs)
            if command[-1] == 'build-info':
                result.stdout = json.dumps({'version': 1, 'sourceHash': 'b' * 40})
            return result
        self.execute = wrong_built
        with self.assertRaisesRegex(RuntimeError, 'provenance mismatch'):
            self.build()
        self.assertFalse((self.output / 'singz-analyze').exists())
        self.assertFalse((self.output / 'singz-gpui-audio').exists())

    def test_plan_does_not_acquire_lease_hash_or_execute_commands(self):
        plan = self.build(print_plan=True)
        self.assertIsNone(plan['sourceHash'])
        self.assertEqual(self.commands, [])
        self.assertEqual(self.replies, [STAMP, STAMP])
        self.assertFalse(self.output.exists())


@unittest.skipUnless(shutil.which('bash') and shutil.which('git'), 'canonical hash requires Bash and Git')
class CanonicalHashTests(unittest.TestCase):
    def test_archive_matches_git_tree_and_raw_git_blob_protocol(self):
        with tempfile.TemporaryDirectory(prefix='gpui canonical with spaces ') as temporary:
            root = Path(temporary).resolve()
            for directory in ('zcore', 'zdsp', 'third_party/native', 'tools/native', 'cmake', 'scripts'):
                (root / directory).mkdir(parents=True)
            shutil.copyfile(ROOT / 'scripts/analyze-source-hash.sh', root / 'scripts/analyze-source-hash.sh')
            for name in ('CMakeLists.txt', 'scripts/vendor-analyze.sh', 'zcore/a.cpp', 'zdsp/Z.h'):
                (root / name).write_bytes(b'raw\r\nbytes without final newline')
            def blob(data):
                return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
            files = sorted(path for path in root.rglob('*') if path.is_file())
            expected = blob(''.join(f'{path.relative_to(root).as_posix()} {blob(path.read_bytes())}\n'
                                    for path in files).encode())
            archive_hash = builder.analyze_source_hash(root)
            self.assertEqual(archive_hash, expected)
            subprocess.run(['git', 'init', '--quiet', str(root)], check=True, capture_output=True)
            self.assertEqual(builder.analyze_source_hash(root), archive_hash)
            extra = root / 'tools/native/untracked.cpp'
            extra.write_bytes(b'untracked input')
            self.assertNotEqual(builder.analyze_source_hash(root), archive_hash)
            extra.unlink()
            (root / 'zcore/a.cpp').write_bytes(b'changed decoder source')
            self.assertNotEqual(builder.analyze_source_hash(root), archive_hash)
            (root / 'CMakeLists.txt').unlink()
            with self.assertRaises(subprocess.CalledProcessError):
                builder.analyze_source_hash(root)

    def test_invalid_script_output_is_rejected(self):
        with patch.object(builder.subprocess, 'run', return_value=SimpleNamespace(stdout='not a hash\n')):
            with self.assertRaisesRegex(RuntimeError, '40 lowercase hex'):
                builder.analyze_source_hash(ROOT)

    def test_windows_posix_path_priority_is_confined_to_hash_child(self):
        previous_path = os.environ.get('PATH')
        with patch.object(builder.os, 'name', 'nt'), \
             patch.object(builder.subprocess, 'run', return_value=SimpleNamespace(stdout=STAMP)) as run:
            self.assertEqual(builder.analyze_source_hash(ROOT), STAMP)
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ['bash', '-c'])
        self.assertIn('cygpath -u "$1"', command[2])
        self.assertIn('export PATH="/usr/bin:$PATH"', command[2])
        self.assertEqual(os.environ.get('PATH'), previous_path)


if __name__ == '__main__':
    unittest.main()
