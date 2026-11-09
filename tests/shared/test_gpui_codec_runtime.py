"""Synthetic native codec assembly contracts; no decoder/build/network executes."""
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('gpui_codecs', Path(__file__).resolve().parents[2] / 'scripts/gpui-codec-runtime.py')
codec = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(codec)


class CodecTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='gpui codecs with spaces ')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.pack = self.root / 'pack'
        self.pack.mkdir()

    def fixture(self, target='linux-x64'):
        pinned = codec.profile()
        configuration = ' '.join(codec.configure_flags(target, Path('/stage'))[1:])
        for component in codec.COMPONENTS:
            directory = self.pack / f'include/lib{component}'
            directory.mkdir(parents=True)
            (directory / f'{component}.h').write_text('/* synthetic SDK header */')
            (directory / 'version.h').write_text(f'#define LIB{component.upper()}_VERSION_MAJOR {pinned["abiMajors"][component]}\n')
        compliance = self.pack / 'compliance'
        compliance.mkdir()
        (compliance / 'profile.json').write_text(json.dumps(pinned))
        for name in ('NOTICE-FFMPEG.md', 'COPYING.LGPLv2.1-FFMPEG'):
            (compliance / name).write_text('synthetic notice ' + name)
        receipt = self.pack / 'share/singz-ffmpeg/configuration.txt'
        receipt.parent.mkdir(parents=True)
        receipt.write_text(configuration + '\n')
        mapping = {}
        for component in codec.COMPONENTS:
            if target.startswith('win32-'):
                data = bytearray(128)
                data[:2] = b'MZ'
                struct.pack_into('<I', data, 60, 64)
                data[64:68] = b'PE\0\0'
                struct.pack_into('<H', data, 68, 0x8664)
                struct.pack_into('<H', data, 86, 0x2002)
                directory = 'bin'
                link = self.pack / f'lib/{component}.lib'
                link.parent.mkdir(exist_ok=True)
                link.write_bytes(b'synthetic MSVC import lib')
            elif target.startswith('darwin-'):
                data = bytearray(64)
                struct.pack_into('<IIII', data, 0, 0xFEEDFACF, 0x100000C if target.endswith('arm64') else 0x1000007, 0, 6)
                data += ('@rpath/' + codec.runtime_name(component, target)).encode() + b'\0'
                directory = 'lib'
            else:
                data = bytearray(64)
                data[:7] = b'\x7fELF\x02\x01\x01'
                struct.pack_into('<HH', data, 16, 3, 62)
                data += codec.runtime_name(component, target).encode() + b'\0'
                directory = 'lib'
            data += configuration.encode() + b'\0'
            relative = f'{directory}/{codec.runtime_name(component, target)}'
            path = self.pack / relative
            path.parent.mkdir(exist_ok=True)
            path.write_bytes(data)
            mapping[component] = relative
        manifest = {field: pinned[field] for field in ('profile', 'source', 'abiMajors', 'capabilityMask', 'requiredDemuxers', 'requiredDecoders', 'requiredParsers')}
        manifest.update(format=1, target=target, configuration=configuration, runtimeLibraries=mapping,
                        fixtureEvidence={'fullMatrix': False})
        self.inventory(manifest)
        return manifest

    def inventory(self, manifest):
        manifest['files'] = [{'path': p.relative_to(self.pack).as_posix(), 'bytes': p.stat().st_size,
                              'sha256': codec.digest(p)} for p in sorted(self.pack.rglob('*'))
                             if p.is_file() and p != self.pack / 'manifest.json']
        self.save(manifest)

    def save(self, manifest):
        (self.pack / 'manifest.json').write_text(json.dumps(manifest))

    def test_linux_inspect_and_stage_exact_runtime_without_headers_or_fixture_claim(self):
        self.fixture()
        result = codec.inspect_pack(self.pack, 'linux-x64')
        self.assertEqual(len(result['libraries']), 4)
        self.assertIn('-DSINGZ_ENABLE_FFMPEG_CODECS=ON', result['cmakeArgs'])
        self.assertTrue(result['nativeDesktopTargetExtension'])
        output = self.root / 'portable codec files'
        receipt = codec.stage_runtime(self.pack, 'linux-x64', output)
        self.assertFalse((output / 'include').exists())
        self.assertIn('not validated', receipt['fixtureEvidence'])
        for row in receipt['files']:
            self.assertEqual(codec.digest(output / row['path']), row['sha256'])
        for library in result['libraries']:
            self.assertEqual(codec.digest(output / library['runtimeName']), library['sha256'])

    def test_windows_import_libraries_and_runtime_cmake_paths(self):
        self.fixture('win32-x64')
        result = codec.inspect_pack(self.pack, 'win32-x64')
        self.assertTrue(all(row['linkPath'].endswith('.lib') and row['runtimePath'].endswith('.dll') for row in result['libraries']))
        self.assertEqual(len([arg for arg in result['cmakeArgs'] if '_RUNTIME=' in arg]), 4)
        (self.pack / 'lib/avcodec.lib').unlink()
        with self.assertRaises((codec.CodecError, OSError)):
            codec.inspect_pack(self.pack, 'win32-x64')

    def test_windows_upstream_bin_import_libraries_inspect_and_stage(self):
        manifest = self.fixture('win32-x64')
        # FFmpeg's MSVC make install puts import libraries beside its DLLs.
        for component in codec.COMPONENTS:
            (self.pack / f'lib/{component}.lib').rename(self.pack / f'bin/{component}.lib')
        self.inventory(manifest)

        result = codec.inspect_pack(self.pack, 'win32-x64')
        for library in result['libraries']:
            component = library['component']
            link = self.pack / f'bin/{component}.lib'
            runtime = self.pack / f'bin/{codec.runtime_name(component, "win32-x64")}'
            self.assertEqual(library['linkPath'], str(link))
            self.assertEqual(library['runtimePath'], str(runtime))
            self.assertIn(f'-DSINGZ_FFMPEG_{component.upper()}_LIBRARY={link}', result['cmakeArgs'])
            self.assertIn(f'-DSINGZ_FFMPEG_{component.upper()}_RUNTIME={runtime}', result['cmakeArgs'])

        output = self.root / 'windows runtime only'
        receipt = codec.stage_runtime(self.pack, 'win32-x64', output)
        self.assertFalse(list(output.rglob('*.lib')))
        self.assertFalse((output / 'include').exists())
        self.assertIn('not validated', receipt['fixtureEvidence'])
        self.assertEqual({path.name for path in output.glob('*.dll')},
                         {library['runtimeName'] for library in result['libraries']})
        for row in receipt['files']:
            self.assertEqual(codec.digest(output / row['path']), row['sha256'])

        missing = self.pack / 'bin/avcodec.lib'
        missing.unlink()
        self.inventory(manifest)
        with self.assertRaisesRegex(codec.CodecError, 'Missing MSVC import library for avcodec'):
            codec.inspect_pack(self.pack, 'win32-x64')

    def test_macos_header_target_and_install_identity(self):
        self.fixture('darwin-arm64')
        codec.inspect_pack(self.pack, 'darwin-arm64')
        with self.assertRaises(codec.CodecError):
            codec.inspect_pack(self.pack, 'darwin-x64')

    def test_tampered_bytes_foreign_tree_and_source_provenance_refused(self):
        manifest = self.fixture()
        library = self.pack / manifest['runtimeLibraries']['avcodec']
        before = library.read_bytes()
        library.write_bytes(before + b'changed')
        with self.assertRaises(codec.CodecError):
            codec.inspect_pack(self.pack, 'linux-x64')
        library.write_bytes(before)
        foreign = self.pack / 'foreign'
        foreign.write_text('not selected')
        with self.assertRaises(codec.CodecError):
            codec.inspect_pack(self.pack, 'linux-x64')
        foreign.unlink()
        manifest['source'] = {**manifest['source'], 'sha256': '0' * 64}
        self.save(manifest)
        with self.assertRaises(codec.CodecError):
            codec.inspect_pack(self.pack, 'linux-x64')

    def test_wrong_abi_arch_or_gpl_refused_even_with_updated_inventory(self):
        manifest = self.fixture()
        header = self.pack / 'include/libavcodec/version.h'
        header.write_text('#define LIBAVCODEC_VERSION_MAJOR 61\n')
        self.inventory(manifest)
        with self.assertRaisesRegex(codec.CodecError, 'ABI'):
            codec.inspect_pack(self.pack, 'linux-x64')
        header.write_text('#define LIBAVCODEC_VERSION_MAJOR 62\n')
        library = self.pack / manifest['runtimeLibraries']['avcodec']
        data = bytearray(library.read_bytes())
        struct.pack_into('<H', data, 18, 183)
        library.write_bytes(data)
        self.inventory(manifest)
        with self.assertRaisesRegex(codec.CodecError, 'architecture'):
            codec.inspect_pack(self.pack, 'linux-x64')
        struct.pack_into('<H', data, 18, 62)
        library.write_bytes(data + b'--enable-gpl')
        self.inventory(manifest)
        with self.assertRaisesRegex(codec.CodecError, 'Forbidden'):
            codec.inspect_pack(self.pack, 'linux-x64')

    def test_configuration_cannot_hide_enabled_network_or_missing_profile(self):
        manifest = self.fixture()
        for text in (manifest['configuration'] + ' --enable-network', manifest['configuration'].replace('--disable-autodetect', '')):
            with self.assertRaises(codec.CodecError):
                codec.validate_configuration(text, 'linux-x64')

    def test_existing_output_and_bad_archive_are_never_replaced_or_executed(self):
        self.fixture()
        output = self.root / 'foreign'
        output.mkdir()
        sentinel = output / 'keep'
        sentinel.write_text('foreign bytes')
        with self.assertRaises(codec.CodecError):
            codec.stage_runtime(self.pack, 'linux-x64', output)
        self.assertEqual(sentinel.read_text(), 'foreign bytes')
        archive = self.root / 'ffmpeg.tar.xz'
        archive.write_bytes(b'unverified source')
        with patch.object(codec.subprocess, 'run', side_effect=AssertionError('must not execute')):
            with self.assertRaisesRegex(codec.CodecError, 'SHA256'):
                codec.extract_source(archive, self.root)

    def test_build_plans_are_offline_pinned_decode_only(self):
        for target in codec.TARGETS:
            plan = codec.build_plan(target, self.root / 'source', self.root / 'stage')
            codec.validate_configuration(' '.join(plan['configure'][2:]), target)
            self.assertEqual(plan['source']['version'], '8.0.1')
            self.assertFalse(plan['network'])
            self.assertEqual(plan['make'], ['make', '-j1'])
            self.assertNotIn('node', plan['configure'])
        with self.assertRaises(codec.CodecError):
            codec.build_plan('linux-x64', self.root, self.root, jobs=32)


if __name__ == '__main__':
    unittest.main()
