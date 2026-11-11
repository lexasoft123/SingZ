"""Synthetic PE/ELF assembly tests; no build, loader or application is invoked.

Fixture headers intentionally establish only the packager's minimum-header rules.
They are not runnable programs and do not qualify native dependencies or inference.
"""
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import struct
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/package-gpui-desktop.py'
SPEC = importlib.util.spec_from_file_location('package_gpui_desktop', SCRIPT)
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


def elf(machine=62):
    data = bytearray(128)
    data[:7] = b'\x7fELF\x02\x01\x01'
    struct.pack_into('<HHIQQ', data, 16, 2, machine, 1, 0x400080, 64)
    struct.pack_into('<HHH', data, 52, 64, 56, 1)
    struct.pack_into('<IIQQQQQQ', data, 64, 1, 5, 0, 0x400000, 0x400000, len(data), len(data), 4096)
    return bytes(data)


def pe(machine=0x8664, dll=False):
    data = bytearray(544)
    data[:2] = b'MZ'
    struct.pack_into('<I', data, 60, 128)
    data[128:132] = b'PE\0\0'
    struct.pack_into('<HHIIIHH', data, 132, machine, 1, 0, 0, 0, 240, 2 | (0x2000 if dll else 0))
    struct.pack_into('<H', data, 152, 0x20B)
    struct.pack_into('<I', data, 168, 0x1000)
    struct.pack_into('<I', data, 212, 512)
    data[392:400] = b'.text\0\0\0'
    struct.pack_into('<II', data, 408, 32, 512)
    return bytes(data)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='native portable package ')
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name).resolve()
        self.runtime = self.base / 'runtime'
        self.runtime.mkdir()
        self.output = self.base / 'portable output'
        self.uikit = self.base / 'owned uikit'
        notices = self.uikit / 'gpui/assets/fonts'
        notices.mkdir(parents=True)
        for name in package.FONT_LICENSES:
            (notices / name).write_text('Exact owned OFL fixture notice: ' + name)
        for directory, names in (('pitch', ('crepe-tiny.bin', 'torchcrepe-LICENSE.txt')),
                                 ('training-sounds', package.SAMPLES)):
            target = self.runtime / directory
            target.mkdir()
            for name in names:
                (target / name).write_bytes(('Exact fixture bytes for ' + name).encode())
        self.platform = 'windows' if os.name == 'nt' else 'linux'
        self.executables(self.platform)

    def executables(self, platform):
        for name in package.EXECUTABLES:
            for suffix in ('', '.exe'):
                (self.runtime / (name + suffix)).unlink(missing_ok=True)
            (self.runtime / (name + ('.exe' if platform == 'windows' else ''))).write_bytes(pe() if platform == 'windows' else elf())

    def assemble(self, platform=None, **kwargs):
        return package.assemble(platform or self.platform, self.runtime, self.output, uikit_dir=self.uikit, **kwargs)

    def test_windows_packages_lyric_engines(self):
        self.executables('windows')
        engines = self.base / 'engines'
        engines.mkdir()
        for name in ('llama-server.exe', 'crispasr.exe'):
            (engines / name).write_bytes(pe())
        self.assemble('windows', engines=engines)
        for name in ('llama-server.exe', 'crispasr.exe'):
            self.assertTrue((self.output / 'engines' / name).is_file())

    def test_installer_inputs_and_uninstall_are_payload_scoped(self):
        self.executables('windows')
        engines = self.base / 'engines'
        engines.mkdir()
        for name in ('llama-server.exe', 'crispasr.exe'):
            (engines / name).write_bytes(pe())
        self.assemble('windows', engines=engines)
        commands = []
        def runner(args, **kwargs):
            commands.append(args)
            include = Path(next(x[10:] for x in args if x.startswith('/DINCLUDE=')))
            generated = include.read_text(encoding='utf-8')
            self.assertIn('engines\\llama-server.exe', generated)
            self.assertIn('pitch\\crepe-tiny.bin', generated)
            self.assertNotIn('$APPDATA', generated.upper())
            self.assertNotIn('RMDir /r', generated)
            Path(next(x[9:] for x in args if x.startswith('/DOUTPUT='))).write_bytes(b'installer')
            return SimpleNamespace(returncode=0)
        package.build_installer(self.output, self.base / 'setup.exe', runner=runner, env={})
        self.assertEqual(len(commands), 1)
        source = (package.ROOT / 'experiments/gpui-player/packaging/windows/singz-native.nsi').read_text()
        self.assertNotIn('RMDir /r', source)
        self.assertNotIn('$APPDATA', source.upper())
        self.assertIn('!uninstfinalize', source)
        self.assertIn('= 0', source)
        self.assertIn('MUI_LANGUAGE "PortugueseBR"', source)
        self.assertIn('MUI_LANGUAGE "Hindi"', source)
        self.assertNotIn('MUI_LANGDLL_DISPLAY', source)
        self.assertNotIn('MUI_LANGUAGE "Filipino"', source)

    def test_unsigned_warning_and_signed_hashes_with_no_secret_logged(self):
        self.executables('windows')
        with mock.patch('sys.stderr', new_callable=__import__('io').StringIO) as warnings:
            self.assemble('windows')
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(manifest['signing'], 'unsigned')
        self.assertIn('unsigned', warnings.getvalue().lower())
        shutil.rmtree(self.output)
        (self.runtime / 'codec.dll').write_bytes(pe(dll=True))
        engines = self.base / 'signed-engines'
        engines.mkdir()
        for name in ('llama-server.exe', 'crispasr.exe'):
            (engines / name).write_bytes(pe())
        password = self.base / 'password.txt'
        password.write_text('secret-password', encoding='utf-8')
        calls = []
        def runner(args, **kwargs):
            calls.append(args)
            Path(args[-1]).write_bytes(Path(args[-1]).read_bytes() + b'signed')
            return SimpleNamespace(returncode=0)
        env = {'SINGZ_SIGN_PFX': str(self.base / 'cert.pfx'), 'SINGZ_SIGN_PASSWORD_FILE': str(password), 'SINGZ_SIGN_TIMESTAMP_URL': 'https://timestamp.example'}
        with mock.patch('sys.stdout', new_callable=__import__('io').StringIO) as out, mock.patch('sys.stderr', new_callable=__import__('io').StringIO) as err:
            package.assemble('windows', self.runtime, self.output, uikit_dir=self.uikit, engines=engines, signing_env=env, runner=runner)
        self.assertNotIn('secret-password', out.getvalue() + err.getvalue())
        config = package.signing_config(env)
        def failed_runner(args, **kwargs):
            return SimpleNamespace(returncode=1, stdout='secret-password', stderr='secret-password')
        with self.assertRaises(package.PackageError) as failure:
            package.sign_file(self.runtime / 'singz-analyze.exe', config, failed_runner)
        self.assertNotIn('secret-password', str(failure.exception))
        manifest = json.loads((self.output / 'manifest.json').read_text())
        self.assertEqual(manifest['signing'], 'authenticode')
        self.assertTrue(calls[0][-1].endswith('codec.dll'))
        self.assertEqual({Path(call[-1]).name for call in calls[1:3]}, {'llama-server.exe', 'crispasr.exe'})
        self.assertTrue(calls[-1][-1].endswith('singz-gpui-player.exe'))
        for item in manifest['files']:
            self.assertEqual(item['sha256'], hashlib.sha256((self.output / item['path']).read_bytes()).hexdigest())

    def assert_clean(self):
        self.assertFalse(self.output.exists())
        self.assertEqual(list(self.base.glob('.singz-desktop-package-*')), [])

    @unittest.skipUnless(os.name == 'posix', 'Linux assembly requires POSIX executable permission bits')
    def test_linux_payload_relocates_with_identical_manifest_hashes_and_exec_bits(self):
        manifest_path = self.assemble()
        manifest = json.loads(manifest_path.read_text())
        moved = self.base / 'relocated with spaces'
        self.output.rename(moved)
        self.assertEqual(manifest['architecture'], 'x86_64')
        self.assertEqual(manifest['platform'], 'linux')
        self.assertEqual(len(manifest['binaries']), 4)
        for record in manifest['files']:
            payload = moved / record['path']
            self.assertEqual(record['bytes'], payload.stat().st_size)
            self.assertEqual(record['sha256'], hashlib.sha256(payload.read_bytes()).hexdigest())
        sources = {record['payloadPath']: record for record in manifest['sources']}
        for name in package.EXECUTABLES:
            self.assertTrue((moved / name).stat().st_mode & stat.S_IXUSR)
            self.assertEqual(sources[name]['sha256'], hashlib.sha256((self.runtime / name).read_bytes()).hexdigest())
            self.assertEqual(sources[name]['identity']['inode'], (self.runtime / name).stat().st_ino)
        self.assertTrue((moved / 'pitch/crepe-tiny.bin').is_file())
        self.assertEqual(len(list((moved / 'training-sounds').glob('*.mp3'))), 15)
        for name in package.FONT_LICENSES:
            self.assertEqual((moved / 'licenses' / name).read_bytes(), (self.uikit / 'gpui/assets/fonts' / name).read_bytes())
        self.assertIn('not a dynamic dependency', (moved / 'README.txt').read_text())
        self.assertNotIn('manifest.json', [record['path'] for record in manifest['files']])

    def test_windows_copies_only_adjacent_dlls_and_rejects_mixed_architecture(self):
        self.executables('windows')
        (self.runtime / 'onnxruntime.DLL').write_bytes(pe(dll=True))
        nested = self.runtime / 'unused'
        nested.mkdir()
        (nested / 'unselected.dll').write_bytes(b'not a native dependency')
        (self.runtime / 'unselected.log').write_text('do not package')
        manifest = json.loads(self.assemble('windows').read_text())
        self.assertEqual(len(manifest['binaries']), 5)
        self.assertTrue((self.output / 'onnxruntime.DLL').is_file())
        self.assertFalse((self.output / 'unused').exists())
        self.assertFalse((self.output / 'unselected.log').exists())
        shutil.rmtree(self.output)
        (self.runtime / 'onnxruntime.DLL').write_bytes(pe(machine=0xAA64, dll=True))
        with self.assertRaisesRegex(package.PackageError, 'architecture'):
            self.assemble('windows')
        self.assert_clean()

    def test_adjacent_node_runtime_dll_is_refused_without_output(self):
        self.executables('windows')
        for name in ('node.dll', 'libnode.dll', 'NODE.DLL'):
            with self.subTest(name=name):
                path = self.runtime / name
                path.write_bytes(pe(dll=True))
                with self.assertRaisesRegex(package.PackageError, 'provide a pure-native engine payload'):
                    self.assemble('windows')
                self.assert_clean()
                path.unlink()

    def test_missing_or_empty_required_payload_never_publishes_partial_folder(self):
        analyzer = 'singz-analyze.exe' if self.platform == 'windows' else 'singz-analyze'
        for relative in (analyzer, 'pitch/crepe-tiny.bin', 'pitch/torchcrepe-LICENSE.txt',
                         'training-sounds/piano-C2.mp3', 'training-sounds/loudness-calibration.json'):
            path = self.runtime / relative
            content = path.read_bytes()
            for replacement in (None, b''):
                with self.subTest(relative=relative, replacement=replacement):
                    path.unlink(missing_ok=True)
                    if replacement is not None:
                        path.write_bytes(replacement)
                    with self.assertRaises(package.PackageError):
                        self.assemble()
                    self.assert_clean()
            path.write_bytes(content)
        notice = self.uikit / 'gpui/assets/fonts' / package.FONT_LICENSES[0]
        notice.unlink()
        with self.assertRaises(package.PackageError):
            self.assemble()
        self.assert_clean()

    @unittest.skipUnless(os.name == 'posix', 'Linux assembly requires POSIX executable permission bits')
    def test_wrong_linux_platform_architecture_or_truncated_headers_rejected(self):
        target = self.runtime / 'singz-analyze'
        foreign_os = bytearray(elf())
        foreign_os[7] = 9  # FreeBSD OSABI is not a Linux payload.
        for content in (pe(), elf(machine=183), elf()[:40], bytes(foreign_os), b'\x7fELF' + bytes(128)):
            with self.subTest(content=content[:8]):
                target.write_bytes(content)
                with self.assertRaises(package.PackageError):
                    self.assemble()
                self.assert_clean()

    def test_wrong_windows_platform_or_truncated_headers_rejected(self):
        self.executables('windows')
        target = self.runtime / 'singz-analyze.exe'
        for content in (elf(), pe()[:200], pe(dll=True)):
            target.write_bytes(content)
            with self.assertRaises(package.PackageError):
                self.assemble('windows')
            self.assert_clean()

    @unittest.skipUnless(os.name == 'nt', 'Windows-specific cross-assembly rejection')
    def test_linux_target_on_windows_is_explicitly_refused(self):
        with self.assertRaisesRegex(package.PackageError, 'POSIX host.*executable'):
            self.assemble('linux')
        self.assert_clean()

    def test_windows_acl_api_copies_parent_dacl_to_payload_only_before_publication(self):
        # The opaque parent DACL stands for exact existing trustees, including a
        # parent-authorized limited RX SID. No ACEs are invented or broadened.
        payload = self.base / 'private staging/payload'
        (payload / 'pitch').mkdir(parents=True)
        (payload / 'pitch/model').write_bytes(b'model')
        (payload / 'player.exe').write_bytes(b'fixture')
        reads, writes, freed = [], [], []
        class Function:
            def __init__(self, implementation): self.implementation = implementation
            def __call__(self, *args): return self.implementation(*args)
        def get_security(path, kind, flags, owner, group, dacl, sacl, descriptor):
            reads.append((path, kind, flags, owner, group, sacl))
            ctypes.cast(dacl, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.c_void_p(0x1234)
            ctypes.cast(descriptor, ctypes.POINTER(ctypes.c_void_p))[0] = ctypes.c_void_p(0x5678)
            return 0
        def set_security(path, kind, flags, owner, group, dacl, sacl):
            writes.append((path, kind, flags, owner, group, dacl.value, sacl))
            return 0
        advapi = SimpleNamespace(GetNamedSecurityInfoW=Function(get_security), SetNamedSecurityInfoW=Function(set_security))
        kernel = SimpleNamespace(LocalFree=Function(lambda descriptor: freed.append(descriptor.value)))
        def library(name, **kwargs): return advapi if name == 'advapi32' else kernel
        with mock.patch.object(package.ctypes, 'WinDLL', side_effect=library, create=True):
            package._snapshot_windows_parent_dacl(payload, self.output.parent)
        self.assertEqual(reads, [(str(self.output.parent), 1, 4, None, None, None)])
        self.assertEqual({Path(record[0]) for record in writes}, {payload, payload / 'pitch', payload / 'pitch/model', payload / 'player.exe'})
        self.assertTrue(all(record[1:] == (1, 4 | 0x80000000, None, None, 0x1234, None) for record in writes))
        self.assertNotIn(payload.parent, {Path(record[0]) for record in writes})
        self.assertEqual(freed, [0x5678])

    def test_acl_failure_never_publishes_or_edits_foreign_destination(self):
        def failing_permissions(payload, destination_parent):
            self.assertTrue(payload.is_dir())
            self.assertEqual(destination_parent, self.output.parent)
            self.output.mkdir()
            (self.output / 'foreign').write_bytes(b'keep foreign payload')
            raise package.PackageError('Injected Windows DACL copy failure')
        with mock.patch.object(package, 'prepare_permissions', side_effect=failing_permissions), mock.patch.object(package, 'rename_exclusive') as publisher:
            with self.assertRaisesRegex(package.PackageError, 'DACL copy failure'):
                self.assemble(publisher=publisher)
            publisher.assert_not_called()
        self.assertEqual((self.output / 'foreign').read_bytes(), b'keep foreign payload')
        self.assertEqual(list(self.base.glob('.singz-desktop-package-*')), [])

    def synthetic_meta(self, meta, **changes):
        values = {name: getattr(meta, name) for name in ('st_dev', 'st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns')}
        return SimpleNamespace(**{**values, **changes})

    def windows_cross_stat_rule(self):
        original = package.same_source_identity
        return mock.patch.object(package, 'same_source_identity', side_effect=lambda path, opened: original(path, opened, windows=True))

    def test_windows_cross_api_ctime_difference_records_both_identities(self):
        source = self.runtime / 'pitch/crepe-tiny.bin'
        path_meta = source.lstat()
        opened = self.synthetic_meta(path_meta, st_ctime_ns=path_meta.st_ctime_ns + 10_000)
        self.assertFalse(package.same_source_identity(path_meta, opened, windows=False))
        self.assertTrue(package.same_source_identity(path_meta, opened, windows=True))
        foreign = self.synthetic_meta(opened, st_ino=path_meta.st_ino + 1)
        self.assertFalse(package.same_source_identity(path_meta, foreign, windows=True))
        target = self.base / 'copied-model'
        with self.windows_cross_stat_rule(), mock.patch.object(package.os, 'fstat', side_effect=[opened, opened]):
            record = package.copy_selected(source, target, 'synthetic Windows stat conventions')
        self.assertEqual(record['identity'], package.identity(path_meta))
        self.assertEqual(record['openedIdentity'], package.identity(opened))
        self.assertNotEqual(record['identity']['ctimeNs'], record['openedIdentity']['ctimeNs'])
        self.assertEqual(target.read_bytes(), source.read_bytes())
        self.assertEqual(record['sha256'], hashlib.sha256(target.read_bytes()).hexdigest())

    def test_handle_ctime_mutation_is_rejected_even_when_path_metadata_is_unchanged(self):
        source = self.runtime / 'pitch/crepe-tiny.bin'
        path_meta = source.lstat()
        opened = self.synthetic_meta(path_meta, st_ctime_ns=path_meta.st_ctime_ns + 10_000)
        changed_handle = self.synthetic_meta(opened, st_ctime_ns=opened.st_ctime_ns + 1)
        with self.windows_cross_stat_rule(), mock.patch.object(package.os, 'fstat', side_effect=[opened, changed_handle]), mock.patch.object(package, 'ordinary', return_value=path_meta):
            with self.assertRaisesRegex(package.PackageError, 'changed while copying'):
                package.copy_selected(source, self.base / 'rejected-copy', 'synthetic handle change')
        self.assertEqual(source.lstat().st_ino, path_meta.st_ino)
        self.assertEqual(source.lstat().st_mtime_ns, path_meta.st_mtime_ns)

    def test_path_replacement_is_rejected_while_opened_handle_stays_original(self):
        source = self.runtime / 'pitch/crepe-tiny.bin'
        path_meta = source.lstat()
        opened = self.synthetic_meta(path_meta, st_ctime_ns=path_meta.st_ctime_ns + 10_000)
        replacement = self.synthetic_meta(path_meta, st_ino=path_meta.st_ino + 1)
        with self.windows_cross_stat_rule(), mock.patch.object(package.os, 'fstat', side_effect=[opened, opened]), mock.patch.object(package, 'ordinary', side_effect=[path_meta, replacement]):
            with self.assertRaisesRegex(package.PackageError, 'changed while copying'):
                package.copy_selected(source, self.base / 'rejected-copy', 'synthetic path replacement')

    def test_existing_or_racing_foreign_output_is_preserved(self):
        self.output.mkdir()
        sentinel = self.output / 'foreign'
        sentinel.write_bytes(b'keep existing folder')
        with self.assertRaises(package.PackageError):
            self.assemble()
        self.assertEqual(sentinel.read_bytes(), b'keep existing folder')
        shutil.rmtree(self.output)
        def racing_publisher(source, destination):
            destination.mkdir()
            (destination / 'foreign').write_bytes(b'keep late folder')
            package.rename_exclusive(source, destination)
        with self.assertRaises((package.PackageError, OSError)):
            self.assemble(publisher=racing_publisher)
        self.assertEqual((self.output / 'foreign').read_bytes(), b'keep late folder')
        self.assertEqual(list(self.base.glob('.singz-desktop-package-*')), [])

    @unittest.skipIf(os.name == 'nt', 'Creating symbolic links requires machine-specific Windows privilege')
    def test_symlink_payload_is_not_followed(self):
        target = self.runtime / 'pitch/crepe-tiny.bin'
        target.unlink()
        foreign = self.base / 'foreign-model'
        foreign.write_bytes(b'foreign model')
        target.symlink_to(foreign)
        with self.assertRaises(package.PackageError):
            self.assemble()
        self.assert_clean()
        self.assertEqual(foreign.read_bytes(), b'foreign model')


if __name__ == '__main__':
    unittest.main()
