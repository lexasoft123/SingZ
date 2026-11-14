"""Pure assembly tests with synthetic headers and injected inspection/signing.

These tests do not establish that fixture bytes are valid loadable Mach-O, that
codesign worked, or that a packaged application ran. Native qualification is
separate. Only the Darwin-specific publication test uses the real rename API.
"""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import plistlib
import shutil
import stat
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[2] / 'scripts/package-gpui-macos.py'
SPEC = importlib.util.spec_from_file_location('package_gpui_macos', SCRIPT)
package = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(package)


def test_publish(source, destination):
    if os.path.lexists(destination):
        raise package.PackageError('Test destination exists')
    source.rename(destination)


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='gpui package test ')
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name).resolve()
        self.runtime = self.base / 'runtime with spaces'
        self.runtime.mkdir()
        for name in package.EXECUTABLES:
            path = self.runtime / name
            path.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic non-runnable test header')
            path.chmod(0o755)
        for directory, names in (('pitch', ('crepe-tiny.bin', 'torchcrepe-LICENSE.txt')),
                                 ('training-sounds', package.SAMPLES)):
            target = self.runtime / directory
            target.mkdir()
            for name in names:
                (target / name).write_bytes(b'nonempty test asset')
        self.output = self.base / 'SingZ Preview.app'
        self.font_licenses = self.base / 'font notices'
        self.font_licenses.mkdir()
        for name in package.FONT_LICENSES:
            (self.font_licenses / name).write_bytes(('Exact fixture notice: ' + name + '\n').encode())
        self.commands = []

    def assemble(self, **kwargs):
        options = dict(version='0.1.2', inspector=lambda _: (['/usr/lib/libSystem.B.dylib'], []),
                       run=lambda args: self.commands.append(args) or '', publisher=test_publish,
                       font_license_dir=self.font_licenses)
        options.update(kwargs)
        inspect = options['inspector']
        # Deliberately synthetic deployment metadata; no native inspection claim.
        def with_metadata(path):
            result = inspect(path)
            dependencies, rpaths = result[:2]
            metadata = result[2] if len(result) == 3 else {'architectures': ['fixture'], 'minimumMacOS': '14.0'}
            metadata = {'filetype': 'DYLIB' if path.suffix == '.dylib' else 'EXECUTE', **metadata}
            metadata.setdefault('slices', {architecture: {'dependencies': dependencies, 'rpaths': rpaths,
                'filetype': metadata['filetype'], 'minimumMacOS': metadata['minimumMacOS']}
                for architecture in metadata['architectures']})
            return dependencies, rpaths, metadata
        options['inspector'] = with_metadata
        return package.assemble(self.runtime, self.output, **options)

    def assert_clean(self):
        self.assertFalse(self.output.exists())
        self.assertFalse(self.output.with_name(self.output.name + '.manifest.json').exists())
        self.assertFalse(list(self.base.glob('.singz-package-*')))

    def test_default_font_notices_are_packaged_from_repo(self):
        self.assemble(font_license_dir=None)
        for name in package.FONT_LICENSES:
            self.assertEqual((self.output / 'Contents/Resources/licenses' / name).read_bytes(),
                             (package.ROOT / 'experiments/gpui-player/assets' / name).read_bytes())

    def test_plist_manifest_and_exact_payload_paths(self):
        manifest_path = self.assemble()
        with (self.output / 'Contents/Info.plist').open('rb') as stream:
            info = plistlib.load(stream)
        self.assertEqual(info['CFBundleExecutable'], 'singz-gpui-player')
        self.assertEqual(info['CFBundleIdentifier'], package.BUNDLE_ID)
        self.assertEqual(info['CFBundleVersion'], '0.1.2')
        self.assertEqual(info['LSMinimumSystemVersion'], '14.0')
        self.assertTrue(info['NSHighResolutionCapable'])
        self.assertIn('microphone', info['NSMicrophoneUsageDescription'])
        manifest = json.loads(manifest_path.read_text())
        self.assertFalse(manifest['adHocSigned'])
        self.assertEqual(len(manifest['machoDependencies']), 4)
        for record in manifest['files']:
            payload = self.output / record['path']
            self.assertEqual(record['sha256'], hashlib.sha256(payload.read_bytes()).hexdigest())
        for name in package.EXECUTABLES:
            self.assertTrue((self.output / 'Contents/MacOS' / name).stat().st_mode & 0o111)
        self.assertTrue((self.output / 'Contents/Resources/pitch/crepe-tiny.bin').is_file())
        self.assertTrue((self.output / 'Contents/Resources/training-sounds/guitar-C6.mp3').is_file())
        self.assertFalse((self.output / 'Contents/MacOS/pitch').exists())
        self.assertFalse((self.output / 'Contents/MacOS/training-sounds').exists())
        for name in package.FONT_LICENSES:
            self.assertEqual((self.output / 'Contents/Resources/licenses' / name).read_bytes(), (self.font_licenses / name).read_bytes())
        self.assertEqual(self.commands, [])

    def test_mismatched_engine_architecture_is_refused(self):
        engines = self.base / 'engines'
        engines.mkdir()
        for name in ('llama-server', 'crispasr'):
            path = engines / name
            path.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic executable')
            path.chmod(0o755)
        def inspect(path):
            arch = 'x86_64' if path.name == 'crispasr' else 'arm64'
            return (['/usr/lib/libSystem.B.dylib'], [], {'architectures': [arch], 'minimumMacOS': '14.0'})
        with self.assertRaisesRegex(package.PackageError, 'architecture'):
            self.assemble(engines=engines, inspector=inspect)
        self.assert_clean()

    def test_missing_or_empty_embedded_font_notices_refused(self):
        for name in package.FONT_LICENSES:
            with self.subTest(name=name):
                path = self.font_licenses / name
                content = path.read_bytes()
                path.unlink()
                with self.assertRaisesRegex(package.PackageError, 'font-license-dir'):
                    self.assemble()
                self.assert_clean()
                path.write_bytes(b'')
                with self.assertRaisesRegex(package.PackageError, 'font-license-dir'):
                    self.assemble()
                path.write_bytes(content)

    def test_missing_or_empty_required_assets(self):
        for relative in ('singz-analyze', 'pitch/crepe-tiny.bin', 'pitch/torchcrepe-LICENSE.txt',
                         'training-sounds/piano-C2.mp3', 'training-sounds/loudness-calibration.json'):
            with self.subTest(relative=relative):
                path = self.runtime / relative
                content, mode = path.read_bytes(), path.stat().st_mode
                path.unlink()
                with self.assertRaises(package.PackageError):
                    self.assemble()
                self.assert_clean()
                path.write_bytes(b'')
                with self.assertRaises(package.PackageError):
                    self.assemble()
                path.write_bytes(content)
                path.chmod(mode)

    def test_linked_or_special_payload_refused(self):
        path = self.runtime / 'training-sounds/piano-C2.mp3'
        path.unlink()
        outside = self.base / 'foreign.mp3'
        outside.write_bytes(b'foreign')
        path.symlink_to(outside)
        with self.assertRaises(package.PackageError):
            self.assemble()
        self.assert_clean()
        path.unlink()
        os.mkfifo(path)
        with self.assertRaises(package.PackageError):
            self.assemble()
        self.assert_clean()

    def test_no_overwrite_existing_bundle_or_dangling_manifest(self):
        self.output.mkdir()
        marker = self.output / 'keep'
        marker.write_text('original')
        with self.assertRaises(package.PackageError):
            self.assemble()
        self.assertEqual(marker.read_text(), 'original')
        shutil.rmtree(self.output)
        manifest = self.output.with_name(self.output.name + '.manifest.json')
        manifest.symlink_to(self.base / 'missing')
        with self.assertRaises(package.PackageError):
            self.assemble()
        self.assertTrue(manifest.is_symlink())

    def test_dependency_rejection_cleans_private_staging(self):
        for dependency in ('/opt/homebrew/lib/libforeign.dylib', '/usr/lib/../../opt/homebrew/x.dylib',
                           '/System/Library/../../opt/homebrew/x.dylib', '@rpath/missing.dylib', '@loader_path/../../../foreign.dylib'):
            with self.subTest(dependency=dependency):
                with self.assertRaisesRegex(package.PackageError, 'dependency'):
                    self.assemble(inspector=lambda _: ([dependency], []))
                self.assert_clean()

    def test_explicit_engine_payload_internal_dependency_and_icon(self):
        engines = self.base / 'engines'
        engines.mkdir()
        engine = engines / 'llama-server'
        engine.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic engine')
        engine.chmod(0o755)
        library = engines / 'libengine.dylib'
        library.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic dylib')
        icon = self.base / 'existing.icns'
        icon.write_bytes(b'icns\0\0\0\x08')
        def inspect(path):
            return (['@executable_path/libengine.dylib'], []) if path.name == 'llama-server' else ([], [])
        self.assemble(engines=engines, icon=icon, inspector=inspect)
        with (self.output / 'Contents/Info.plist').open('rb') as stream:
            self.assertEqual(plistlib.load(stream)['CFBundleIconFile'], 'SingZ.icns')
        self.assertEqual((self.output / 'Contents/Resources/SingZ.icns').read_bytes(), icon.read_bytes())

    def test_native_engine_payload_rejects_node_addon_before_publication(self):
        engines = self.base / 'mixed engines'
        engines.mkdir()
        (engines / 'capture.node').write_bytes(bytes.fromhex('cffaedfe') + b'synthetic addon')
        with self.assertRaisesRegex(package.PackageError, 'provide a pure-native engine payload'):
            self.assemble(engines=engines)
        self.assert_clean()
        self.assertEqual(self.commands, [])

    def test_native_engine_payload_rejects_node_modules_directory(self):
        engines = self.base / 'mixed engines'
        (engines / 'node_modules').mkdir(parents=True)
        (engines / 'node_modules/package.json').write_text('{}')
        with self.assertRaisesRegex(package.PackageError, 'Node/Electron'):
            self.assemble(engines=engines)
        self.assert_clean()

    def test_pure_native_two_cli_engine_payload_and_js_documentation_are_allowed(self):
        engines = self.base / 'native engines'
        engines.mkdir()
        for name in ('llama-server', 'crispasr'):
            path = engines / name
            path.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic native executable')
            path.chmod(0o755)
        (engines / 'runtime-notes.js').write_text('// documentation, not a Node runtime')
        manifest = json.loads(self.assemble(engines=engines).read_text())
        paths = {record['path'] for record in manifest['files']}
        self.assertTrue({'Contents/Resources/engines/llama-server', 'Contents/Resources/engines/crispasr',
                         'Contents/Resources/engines/runtime-notes.js'}.issubset(paths))
        self.assertEqual(self.commands, [])

    @unittest.skipUnless(sys.platform == 'darwin' and all(hasattr(os, name) for name in ('setxattr', 'getxattr', 'listxattr')),
                         'Actual macOS extended attributes required')
    def test_assembly_copies_bytes_and_mode_without_source_download_xattrs(self):
        engines = self.base / 'downloaded native engines'
        engines.mkdir()
        engine = engines / 'llama-server'
        engine.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic native CLI')
        engine.chmod(0o755)
        ui = self.runtime / 'singz-gpui-player'
        asset_directory = self.runtime / 'pitch'
        asset = asset_directory / 'crepe-tiny.bin'
        sources = [engines, engine, ui, asset_directory, asset]
        quarantine = b'0083;00000000;SyntheticPackagingTest;'
        provenance = b'packager synthetic metadata, not a source byte'
        for source in sources:
            os.setxattr(source, 'com.apple.quarantine', quarantine)
            os.setxattr(source, 'com.singz.packaging.fixture', provenance)
        manifest = json.loads(self.assemble(engines=engines).read_text())
        targets = [self.output / 'Contents/Resources/engines',
                   self.output / 'Contents/Resources/engines/llama-server',
                   self.output / 'Contents/MacOS/singz-gpui-player',
                   self.output / 'Contents/Resources/pitch',
                   self.output / 'Contents/Resources/pitch/crepe-tiny.bin']
        for source, target in zip(sources, targets):
            self.assertEqual(os.getxattr(source, 'com.apple.quarantine'), quarantine)
            self.assertEqual(os.getxattr(source, 'com.singz.packaging.fixture'), provenance)
            self.assertNotIn('com.apple.quarantine', os.listxattr(target))
            self.assertNotIn('com.singz.packaging.fixture', os.listxattr(target))
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), stat.S_IMODE(source.stat().st_mode) & 0o777)
            if source.is_file():
                self.assertEqual(target.read_bytes(), source.read_bytes())
        indexed = {record['path']: record for record in manifest['files']}
        for target in targets:
            if target.is_file():
                self.assertEqual(indexed[target.relative_to(self.output).as_posix()]['sha256'], hashlib.sha256(target.read_bytes()).hexdigest())

    def test_engine_symlink_refused(self):
        engines = self.base / 'engines'
        engines.mkdir()
        (engines / 'escape').symlink_to(self.runtime / 'singz-analyze')
        with self.assertRaises(package.PackageError):
            self.assemble(engines=engines)
        self.assert_clean()

    def test_staging_inside_copied_payload_is_refused_before_copy(self):
        original = self.output
        engines = self.base / 'explicit engines'
        engines.mkdir()
        (engines / 'payload.txt').write_text('fixture payload')
        for source in (self.runtime / 'pitch', self.runtime / 'training-sounds', engines):
            with self.subTest(source=source):
                nested = source / 'nested output'
                nested.mkdir()
                self.output = nested / 'Preview.app'
                with self.assertRaisesRegex(package.PackageError, 'recursively copied payload'):
                    self.assemble(engines=engines)
                self.assertFalse(self.output.exists())
                self.assertFalse(list(nested.glob('.singz-package-*')))
        self.output = original

    def test_output_beside_helpers_is_allowed(self):
        self.output = self.runtime / 'Preview.app'
        self.assemble()
        self.assertTrue(self.output.is_dir())

    def test_signing_order_and_failure_cleanup(self):
        self.assemble(ad_hoc_sign=True)
        signs = [args for args in self.commands if '--sign' in args]
        self.assertEqual(len(signs), 4)
        self.assertTrue(signs[-1][-1].endswith('.app'))
        self.assertTrue(all('/Contents/MacOS/' in args[-1] for args in signs[:-1]))
        self.assertFalse(any(args[-1].endswith('/singz-gpui-player') for args in signs))
        self.assertIn('--verify', self.commands[-1])
        shutil.rmtree(self.output)
        self.output.with_name(self.output.name + '.manifest.json').unlink()
        def fail(_):
            raise package.PackageError('injected signing failure')
        with self.assertRaises(package.PackageError):
            self.assemble(ad_hoc_sign=True, run=fail)
        self.assert_clean()

    def test_release_signing_order_entitlements_and_adhoc_fallback(self):
        paths = ['Contents/MacOS/singz-gpui-player', 'Contents/MacOS/singz-gpui-input',
                 'Contents/MacOS/singz-gpui-audio', 'Contents/MacOS/singz-analyze',
                 'Contents/MacOS/ffmpeg/libav.dylib', 'Contents/Resources/engines/libengine.dylib',
                 'Contents/Resources/engines/llama-server']
        package.sign_bundle(self.output, [{'path': p} for p in paths], '-', run=lambda a: self.commands.append(a) or '')
        signs = [c for c in self.commands if '--sign' in c]
        self.assertEqual([Path(c[-1]).name for c in signs], ['libav.dylib', 'libengine.dylib', 'llama-server', 'singz-analyze', 'singz-gpui-audio', 'singz-gpui-input', self.output.name])
        # Ad-hoc: no hardened runtime, whose library validation would refuse the
        # app's own ad-hoc FFmpeg and engine dylibs (no Team ID).
        self.assertFalse(any('--options' in c for c in signs))
        self.assertEqual([Path(c[-1]).name for c in signs if '--entitlements' in c], ['singz-gpui-input', self.output.name])
        self.commands.clear()
        package.sign_bundle(self.output, [{'path': p} for p in paths], 'A' * 40, run=lambda a: self.commands.append(a) or '')
        signed = [c for c in self.commands if '--sign' in c]
        self.assertTrue(signed and all('--options' in c and c[c.index('--options') + 1] == 'runtime'
                                       and '--timestamp' in c for c in signed))
        self.assertEqual(package.signing_configuration({}, run=lambda a: ''), ('-', None))
        env = {'SINGZ_SIGNING_KEYCHAIN_PATH': '/keychain', 'SINGZ_ASC_KEY_PATH': '/key.p8',
               'APP_STORE_CONNECT_API_KEY_ID': 'key-id', 'APP_STORE_CONNECT_API_ISSUER_ID': 'issuer'}
        fingerprint = 'A' * 40
        identity, credentials = package.signing_configuration(env, run=lambda args: f'  1) {fingerprint} "Developer ID Application: Example"')
        self.assertEqual(identity, fingerprint)
        self.assertEqual(credentials['keychain'], '/keychain')
        self.assertEqual(package.signing_configuration(env, run=lambda args: '0 valid identities found'), ('-', None))
        with package.ENTITLEMENTS.open('rb') as stream:
            self.assertEqual(plistlib.load(stream), {'com.apple.security.device.audio-input': True})

    P12_ENV = {'SINGZ_SIGNING_KEYCHAIN_PATH': '/wrapper.keychain', 'SINGZ_ASC_KEY_PATH': '/key.p8',
               'APP_STORE_CONNECT_API_KEY_ID': 'key-id', 'APP_STORE_CONNECT_API_ISSUER_ID': 'issuer',
               'SINGZ_MAC_P12': '/secret/dev-id.p12', 'SINGZ_MAC_P12_PASSWORD': 'p12-secret-pw'}

    def p12_runner(self, calls, fail_on=None):
        fingerprint = 'B' * 40
        def run(argv):
            calls.append(list(argv))
            verb = argv[1]
            if fail_on and verb == fail_on:
                raise package.PackageError('security failed; sensitive command details suppressed')
            if verb == 'find-identity':
                if argv[-1] == '/wrapper.keychain':
                    return f'  1) {"C" * 40} "Apple Distribution: Example"'
                return f'  1) {fingerprint} "Developer ID Application: Example (TEAM)"'
            if verb == 'list-keychains' and '-s' not in argv:
                return '    "/Users/x/Library/Keychains/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n'
            return ''
        return run

    def test_p12_import_into_temporary_keychain_then_cleanup(self):
        import contextlib
        calls = []
        with contextlib.ExitStack() as stack:
            identity, credentials = package.signing_configuration(self.P12_ENV, self.p12_runner(calls), stack)
            self.assertEqual(identity, 'B' * 40)
            temporary = credentials['keychain']
            self.assertNotEqual(temporary, '/wrapper.keychain')
            self.assertTrue(Path(temporary).parent.is_dir())
            self.assertEqual(stat.S_IMODE(Path(temporary).parent.stat().st_mode), 0o700)
            verbs = [c[1] for c in calls]
            for step in ('create-keychain', 'unlock-keychain', 'import', 'set-key-partition-list'):
                self.assertIn(step, verbs)
            self.assertLess(verbs.index('import'), verbs.index('set-key-partition-list'))
            imported = next(c for c in calls if c[1] == 'import')
            self.assertEqual(imported[2], '/secret/dev-id.p12')
            self.assertEqual(imported[imported.index('-k') + 1], temporary)
            self.assertNotIn('/wrapper.keychain', imported)
            self.assertFalse(any(c[1] in ('create-keychain', 'import', 'delete-keychain') and '/wrapper.keychain' in c for c in calls))
            # Search list gained the temporary keychain in front of the originals.
            added = next(c for c in calls if c[1:4] == ['list-keychains', '-d', 'user'] and '-s' in c and temporary in c)
            self.assertEqual(added[added.index('-s') + 1], temporary)
        # Context closed: search list restored without the temporary keychain, keychain deleted, directory gone.
        restore = [c for c in calls if c[1] == 'list-keychains' and '-s' in c][-1]
        self.assertNotIn(temporary, restore)
        self.assertEqual(restore[restore.index('-s') + 1:], ['/Users/x/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain'])
        self.assertEqual([c for c in calls if c[1] == 'delete-keychain'], [['/usr/bin/security', 'delete-keychain', temporary]])
        self.assertFalse(Path(temporary).parent.exists())

    def test_p12_path_not_used_when_wrapper_keychain_has_developer_id(self):
        import contextlib
        calls = []
        def run(argv):
            calls.append(argv)
            return f'  1) {"D" * 40} "Developer ID Application: Example"'
        with contextlib.ExitStack() as stack:
            identity, credentials = package.signing_configuration(self.P12_ENV, run, stack)
        self.assertEqual((identity, credentials['keychain']), ('D' * 40, '/wrapper.keychain'))
        self.assertEqual([c[1] for c in calls], ['find-identity'])

    def test_p12_requires_password_and_stack(self):
        import contextlib
        calls = []
        env = dict(self.P12_ENV)
        with contextlib.ExitStack() as stack:
            self.assertEqual(package.signing_configuration(env, self.p12_runner(calls)), ('-', None))
            del env['SINGZ_MAC_P12_PASSWORD']
            self.assertEqual(package.signing_configuration(env, self.p12_runner(calls), stack), ('-', None))
        self.assertFalse(any(c[1] in ('create-keychain', 'import') for c in calls))

    def test_p12_cleanup_runs_when_import_or_later_signing_fails(self):
        import contextlib
        for fail_on in ('import', 'set-key-partition-list'):
            calls = []
            before = set(Path(tempfile.gettempdir()).glob('singz-signing-*'))
            with self.assertRaises(package.PackageError):
                with contextlib.ExitStack() as stack:
                    package.signing_configuration(self.P12_ENV, self.p12_runner(calls, fail_on), stack)
            self.assertEqual(len([c for c in calls if c[1] == 'delete-keychain']), 1, fail_on)
            self.assertEqual(set(Path(tempfile.gettempdir()).glob('singz-signing-*')), before)
        # A failure after a successful import (e.g. signing) also cleans up.
        calls = []
        with self.assertRaises(RuntimeError):
            with contextlib.ExitStack() as stack:
                package.signing_configuration(self.P12_ENV, self.p12_runner(calls), stack)
                raise RuntimeError('signing blew up')
        self.assertEqual(len([c for c in calls if c[1] == 'delete-keychain']), 1)
        self.assertTrue([c for c in calls if c[1] == 'list-keychains' and '-s' in c][-1][-2:] == ['/Users/x/Library/Keychains/login.keychain-db', '/Library/Keychains/System.keychain'])

    def test_p12_cleanup_failure_does_not_mask_error_or_skip_steps(self):
        import contextlib
        calls = []
        base = self.p12_runner(calls)
        def run(argv):
            if argv[1] == 'delete-keychain' or (argv[1] == 'list-keychains' and '-s' in argv and 'singz-signing' not in ' '.join(argv)):
                calls.append(list(argv))
                raise package.PackageError('security failed')
            return base(argv)
        with self.assertRaises(ValueError):
            with contextlib.ExitStack() as stack:
                package.signing_configuration(self.P12_ENV, run, stack)
                raise ValueError('original')
        self.assertTrue(any(c[1] == 'delete-keychain' for c in calls))

    def test_p12_redaction(self):
        import contextlib, io
        from unittest.mock import patch
        import subprocess
        # Real `command` with a failing security: nothing sensitive in the error.
        with patch.object(package.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, [], stderr='p12-secret-pw Developer ID Application: Example')):
            with self.assertRaises(package.PackageError) as error:
                with contextlib.ExitStack() as stack:
                    package.signing_configuration(self.P12_ENV, package.command, stack)
        for text in ('p12-secret-pw', 'Developer ID', '/secret/dev-id.p12'):
            self.assertNotIn(text, str(error.exception))
        # Non-PackageError runner failures are replaced by a generic message.
        def exploding(argv):
            if argv[1] == 'import':
                raise OSError('p12-secret-pw leaked')
            return self.p12_runner([])(argv)
        with self.assertRaises(package.PackageError) as error:
            with contextlib.ExitStack() as stack:
                package.signing_configuration(self.P12_ENV, exploding, stack)
        self.assertNotIn('p12-secret-pw', str(error.exception))
        # Identity names and passwords never reach stdout/stderr.
        out, err = io.StringIO(), io.StringIO()
        with patch('sys.stdout', out), patch('sys.stderr', err):
            with contextlib.ExitStack() as stack:
                package.signing_configuration(self.P12_ENV, self.p12_runner([]), stack)
        self.assertNotIn('p12-secret-pw', out.getvalue() + err.getvalue())
        self.assertNotIn('Developer ID', out.getvalue() + err.getvalue())

    def test_p12_refuses_unreadable_search_list(self):
        import contextlib
        calls = []
        def run(argv):
            calls.append(list(argv))
            return ''
        with self.assertRaises(package.PackageError):
            with contextlib.ExitStack() as stack:
                package.signing_configuration(self.P12_ENV, run, stack)
        self.assertFalse(any(c[1] in ('create-keychain', 'delete-keychain') or (c[1] == 'list-keychains' and '-s' in c) for c in calls))

    def test_release_notary_and_dmg_commands_and_redaction(self):
        credentials = {'key': '/secret/key.p8', 'key_id': 'secret-key-id', 'issuer': 'secret-issuer', 'keychain': '/secret/keychain'}
        package.release_artifacts(self.output, self.base / 'out.dmg', 'Developer ID', credentials, run=lambda a: self.commands.append(a) or ('{"status":"Accepted"}' if 'submit' in a else ''))
        commands = self.commands
        self.assertEqual(sum('submit' in c for c in commands), 2)
        self.assertTrue(any('create' in c and '-srcfolder' in c for c in commands))
        self.assertEqual(sum('staple' in c for c in commands), 2)
        self.assertTrue(any('--timestamp' in c and str(self.base / 'out.dmg') in c for c in commands))
        from unittest.mock import patch
        import subprocess
        with patch.object(package.subprocess, 'run', side_effect=subprocess.CalledProcessError(1, [], stderr='secret-key-id secret-issuer /secret/key.p8')):
            with self.assertRaises(package.PackageError) as error:
                package.command(['/usr/bin/xcrun', 'notarytool', 'submit', '--key', '/secret/key.p8', '--key-id', 'secret-key-id', '--issuer', 'secret-issuer'])
        self.assertNotIn('secret-', str(error.exception))
        self.assertNotIn('/secret/', str(error.exception))

    def test_input_plist_identifier_matches_signature(self):
        with (package.ROOT / 'tools/native/gpui-input-info.plist').open('rb') as stream:
            self.assertEqual(plistlib.load(stream)['CFBundleIdentifier'], package.BUNDLE_ID + '.input')

    def test_rejected_notarization_stops_before_stapling(self):
        credentials = {'key': 'key', 'key_id': 'id', 'issuer': 'issuer', 'keychain': 'chain'}
        def runner(args):
            self.commands.append(args)
            return '{"status":"Invalid"}' if 'submit' in args else ''
        with self.assertRaisesRegex(package.PackageError, 'notarization'):
            package.release_artifacts(self.output, self.base / 'out.dmg', 'identity', credentials, run=runner)
        self.assertFalse(any('staple' in command for command in self.commands))

    def test_publication_race_preserves_winners_bundle(self):
        def raced_publish(source, destination):
            if destination == self.output:
                destination.mkdir()
                (destination / 'winner').write_text('other process')
                raise package.PackageError('injected exclusive publish collision')
            test_publish(source, destination)
        with self.assertRaises(package.PackageError):
            self.assemble(publisher=raced_publish)
        self.assertEqual((self.output / 'winner').read_text(), 'other process')
        self.assertFalse(self.output.with_name(self.output.name + '.manifest.json').exists())
        self.assertFalse(list(self.base.glob('.singz-package-*')))

    def test_manifest_replacement_or_disappearance_does_not_mask_publish_error(self):
        manifest = self.output.with_name(self.output.name + '.manifest.json')
        for replace in (True, False):
            with self.subTest(replace=replace):
                def publish(source, destination):
                    if destination == self.output:
                        if replace:
                            foreign = self.base / 'foreign-manifest'
                            foreign.write_text('foreign replacement')
                            foreign.replace(manifest)
                        else:
                            manifest.unlink()
                        raise package.PackageError('original bundle collision')
                    test_publish(source, destination)
                with self.assertRaisesRegex(package.PackageError, 'original bundle collision'):
                    self.assemble(publisher=publish)
                if replace:
                    self.assertEqual(manifest.read_text(), 'foreign replacement')
                    manifest.unlink()
                else:
                    self.assertFalse(manifest.exists())
                self.assertFalse(self.output.exists())

    def test_minimum_os_is_maximum_of_actual_inspection_results(self):
        def inspect(path):
            return [], [], {'architectures': ['fixture'], 'minimumMacOS': '15.2' if path.name == 'singz-gpui-input' else '14.5'}
        self.assemble(inspector=inspect)
        with (self.output / 'Contents/Info.plist').open('rb') as stream:
            self.assertEqual(plistlib.load(stream)['LSMinimumSystemVersion'], '15.2')

    def test_incompatible_helper_architecture_refused(self):
        def inspect(path):
            return [], [], {'architectures': ['x86_64'] if path.name == 'singz-gpui-input' else ['arm64'], 'minimumMacOS': '14.0'}
        with self.assertRaisesRegex(package.PackageError, 'architectures'):
            self.assemble(inspector=inspect)
        self.assert_clean()

    def test_otool_parser_records_target_rpaths_and_excludes_dylib_id(self):
        calls = []
        def run(args):
            calls.append(args)
            flag = args[3] if args[0].endswith('/otool') else args[1]
            return {
                '-D': 'fixture:\n@rpath/libfixture.dylib\n',
                '-L': 'fixture:\n\t@rpath/libfixture.dylib (compatibility version 1.0.0, current version 1.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n',
                '-l': 'cmd LC_BUILD_VERSION\ncmdsize 32\nplatform 1\nminos 13.5\nsdk 15.0\ncmd LC_RPATH\ncmdsize 32\npath @loader_path (offset 12)\n',
                '-archs': 'arm64 x86_64\n',
                '-hv': 'fixture:\n magic cputype cpusubtype caps filetype ncmds sizeofcmds flags\n MH_MAGIC_64 ARM64 ALL 0x00 DYLIB 12 1024 NOUNDEFS\n',
            }[flag]
        dependencies, rpaths, metadata = package.inspect_dependencies(Path('fixture'), run)
        self.assertEqual(dependencies, ['/usr/lib/libSystem.B.dylib'])
        self.assertEqual(rpaths, ['@loader_path'])
        self.assertEqual(metadata['architectures'], ['arm64', 'x86_64'])
        self.assertEqual(metadata['minimumMacOS'], '13.5')
        self.assertEqual(metadata['filetype'], 'DYLIB')
        self.assertEqual(set(metadata['slices']), {'arm64', 'x86_64'})
        for arch in ('arm64', 'x86_64'):
            for flag in ('-D', '-L', '-l', '-hv'):
                self.assertIn(['/usr/bin/otool', '-arch', arch, flag, 'fixture'], calls)

    def test_normalized_system_dependency_preserves_raw_and_resolved_paths(self):
        manifest = json.loads(self.assemble(inspector=lambda _: (['/usr/lib/../lib/libSystem.B.dylib'], [])).read_text())
        for record in manifest['machoDependencies']:
            self.assertEqual(record['contexts'][0]['resolvedDependencies'],
                [{'load': '/usr/lib/../lib/libSystem.B.dylib', 'resolved': '/usr/lib/libSystem.B.dylib'}])

    def test_universal_slice_cannot_borrow_another_architectures_rpath(self):
        engines = self.base / 'engines'
        engines.mkdir()
        for name in ('engine', 'libEngine.dylib'):
            path = engines / name
            path.write_bytes(bytes.fromhex('cafebabe') + b'synthetic universal metadata seam')
            path.chmod(0o755)
        def inspect(path):
            architectures = ['arm64', 'x86_64']
            kind = 'DYLIB' if path.suffix == '.dylib' else 'EXECUTE'
            slices = {arch: {'dependencies': [], 'rpaths': [], 'filetype': kind, 'minimumMacOS': '14.0'} for arch in architectures}
            if path.name == 'engine':
                slices['arm64']['dependencies'] = ['@rpath/libEngine.dylib']
                slices['x86_64']['dependencies'] = ['@rpath/libEngine.dylib']
                slices['x86_64']['rpaths'] = ['@loader_path']
            return ['@rpath/libEngine.dylib'] if path.name == 'engine' else [], ['@loader_path'] if path.name == 'engine' else [], {
                'architectures': architectures, 'filetype': kind, 'minimumMacOS': '14.0', 'slices': slices}
        with self.assertRaisesRegex(package.PackageError, 'Unresolved'):
            self.assemble(engines=engines, inspector=inspect)
        self.assert_clean()

    def test_dependency_target_must_supply_referencing_slice(self):
        engines = self.base / 'engines'
        engines.mkdir()
        for name in ('engine', 'libEngine.dylib'):
            path = engines / name
            path.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic architecture seam')
            path.chmod(0o755)
        def inspect(path):
            return (['@loader_path/libEngine.dylib'] if path.name == 'engine' else [], [], {
                'architectures': ['x86_64'] if path.suffix == '.dylib' else ['arm64'],
                'minimumMacOS': '14.0', 'filetype': 'DYLIB' if path.suffix == '.dylib' else 'EXECUTE'})
        with self.assertRaisesRegex(package.PackageError, 'Referencing architecture arm64'):
            self.assemble(engines=engines, inspector=inspect)
        self.assert_clean()

    def test_engine_executable_cannot_resolve_dependency_from_main_app_directory(self):
        engines = self.base / 'engines'
        engines.mkdir()
        engine = engines / 'llama-server'
        engine.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic engine')
        engine.chmod(0o755)
        # This target exists beside the app, but not beside the standalone engine.
        def inspect(path):
            return (['@executable_path/singz-analyze'], []) if path.name == 'llama-server' else ([], [])
        with self.assertRaisesRegex(package.PackageError, 'Unresolved'):
            self.assemble(engines=engines, inspector=inspect)
        self.assert_clean()

    def test_engine_loader_chain_inherits_rpaths_and_keeps_executable_context(self):
        engines = self.base / 'engines'
        engines.mkdir()
        for name in ('llama-server', 'libA.dylib', 'libB.dylib'):
            path = engines / name
            path.write_bytes(bytes.fromhex('cffaedfe') + b'synthetic dependency graph')
            path.chmod(0o755)
        def inspect(path):
            if path.name == 'llama-server':
                return ['@rpath/libA.dylib'], ['@loader_path']
            if path.name == 'libA.dylib':
                return ['@rpath/libB.dylib'], []
            if path.name == 'libB.dylib':
                return ['@executable_path/libA.dylib'], []  # bounded cycle
            return [], []
        manifest = json.loads(self.assemble(engines=engines, inspector=inspect).read_text())
        records = {record['path']: record for record in manifest['machoDependencies']}
        for name in ('libA.dylib', 'libB.dylib'):
            context = records['Contents/Resources/engines/' + name]['contexts'][0]
            self.assertEqual(context['executable'], 'Contents/Resources/engines/llama-server')
            self.assertEqual(context['rpathSearch'], ['Contents/Resources/engines'])
        self.assertEqual(records['Contents/Resources/engines/libA.dylib']['contexts'][0]['resolvedDependencies'],
                         [{'load': '@rpath/libB.dylib', 'resolved': 'Contents/Resources/engines/libB.dylib'}])

    def test_required_binary_must_be_execute_and_dylib_context_is_not_guessed(self):
        def wrong_kind(path):
            return [], [], {'architectures': ['fixture'], 'minimumMacOS': '14.0', 'filetype': 'DYLIB' if path.name == 'singz-analyze' else 'EXECUTE'}
        with self.assertRaisesRegex(package.PackageError, 'MH_EXECUTE'):
            self.assemble(inspector=wrong_kind)
        self.assert_clean()
        engines = self.base / 'engines'
        engines.mkdir()
        (engines / 'libengine.dylib').write_bytes(bytes.fromhex('cffaedfe') + b'synthetic dylib')
        def ambiguous(path):
            return (['@executable_path/singz-analyze'], []) if path.suffix == '.dylib' else ([], [])
        with self.assertRaisesRegex(package.PackageError, 'Ambiguous @executable_path'):
            self.assemble(engines=engines, inspector=ambiguous)
        self.assert_clean()

    @unittest.skipUnless(sys.platform == 'darwin', 'Real exclusive macOS publication')
    def test_actual_exclusive_publisher_refuses_existing_names(self):
        source, destination = self.base / 'source', self.base / 'destination'
        source.mkdir()
        destination.mkdir()
        with self.assertRaises(package.PackageError):
            package.rename_exclusive(source, destination)
        self.assertTrue(source.is_dir())
        destination.rmdir()
        package.rename_exclusive(source, destination)
        self.assertFalse(source.exists())
        self.assertTrue(destination.is_dir())


if __name__ == '__main__':
    unittest.main()
