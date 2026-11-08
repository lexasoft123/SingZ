#!/usr/bin/env python3
"""Inspect, build and stage the pinned native desktop FFmpeg codec SDK; no Node.

Builds consume an explicitly supplied, checksum-verified official source archive.
Inspection proves assembly/provenance only; real helper decode qualification is
separate and no fixture evidence is manufactured by this script.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shlex
import shutil
import stat
import struct
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
PROFILE_PATH = ROOT / 'third_party/ffmpeg-codec/profile.json'
TARGETS = ('darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64')
COMPONENTS = ('avcodec', 'avformat', 'avutil', 'swresample')
BASE_FLAGS = ('--disable-everything', '--disable-static', '--enable-shared',
              '--disable-programs', '--disable-doc', '--disable-avdevice',
              '--disable-avfilter', '--disable-swscale', '--disable-network',
              '--disable-protocols', '--disable-devices', '--disable-filters',
              '--disable-encoders', '--disable-muxers', '--disable-hwaccels',
              '--disable-autodetect', '--disable-debug', '--enable-small', '--enable-pic')
FORBIDDEN_FLAGS = ('--enable-gpl', '--enable-nonfree', '--enable-network', '--enable-static',
                   '--enable-encoder', '--enable-muxer', '--enable-program', '--enable-ffmpeg',
                   '--enable-ffprobe', '--enable-ffplay', '--enable-protocol', '--enable-device',
                   '--enable-indev', '--enable-outdev', '--enable-filter', '--enable-hwaccel',
                   '--enable-autodetect')


class CodecError(RuntimeError):
    pass


def profile() -> dict:
    return json.loads(PROFILE_PATH.read_text(encoding='utf-8'))


def digest(path: Path) -> str:
    result = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def regular(path: Path) -> None:
    if not stat.S_ISREG(path.lstat().st_mode):
        raise CodecError(f'Expected ordinary file without links: {path}')


def relative(value: str) -> Path:
    if (not isinstance(value, str) or not value or '\\' in value or ':' in value
            or any(ord(c) < 32 for c in value) or value.startswith('/')
            or any(part in ('', '.', '..') for part in value.split('/'))):
        raise CodecError(f'Unsafe manifest path: {value!r}')
    return Path(*PurePosixPath(value).parts)


def target_flags(target: str) -> list[str]:
    if target == 'darwin-arm64':
        return ['--target-os=darwin', '--arch=arm64']
    if target == 'darwin-x64':
        return ['--target-os=darwin', '--arch=x86_64']
    if target == 'linux-x64':
        return ['--target-os=linux', '--arch=x86_64']
    if target == 'win32-x64':
        return ['--target-os=win64', '--arch=x86_64', '--toolchain=msvc']
    raise CodecError(f'Unsupported native desktop codec target: {target}')


def configure_flags(target: str, prefix: Path) -> list[str]:
    pinned = profile()
    return [f'--prefix={prefix}', *BASE_FLAGS,
            *[f'--enable-{kind}={",".join(pinned[field])}' for kind, field in
              (('demuxer', 'requiredDemuxers'), ('decoder', 'requiredDecoders'), ('parser', 'requiredParsers'))],
            *target_flags(target)]


def validate_configuration(configuration: str, target: str) -> None:
    if not isinstance(configuration, str) or len(configuration) > 32768:
        raise CodecError('Missing/bounded configure evidence required')
    pinned = profile()
    for forbidden in FORBIDDEN_FLAGS:
        if forbidden in configuration:
            raise CodecError(f'Forbidden configure option: {forbidden}')
    # Legacy receipts flatten compiler arguments containing spaces. Profile
    # options themselves have no spaces and retain their exact token identity.
    tokens = set(shlex.split(configuration))
    for flag in configure_flags(target, Path('/unused'))[1:]:
        if flag not in tokens:
            raise CodecError(f'Missing pinned configure option: {flag}')


def runtime_name(component: str, target: str) -> str:
    major = profile()['abiMajors'][component]
    if target.startswith('win32-'):
        return f'{component}-{major}.dll'
    if target.startswith('darwin-'):
        return f'lib{component}.{major}.dylib'
    return f'lib{component}.so.{major}'


def inspect_binary(path: Path, target: str, component: str) -> None:
    data = path.read_bytes()
    try:
        if target.startswith('win32-'):
            if data[:2] != b'MZ':
                raise CodecError(f'Expected Windows DLL: {path}')
            offset = struct.unpack_from('<I', data, 60)[0]
            signature, machine = struct.unpack_from('<4sH', data, offset)
            flags = struct.unpack_from('<H', data, offset + 22)[0]
            if signature != b'PE\0\0' or machine != 0x8664 or not flags & 0x2000:
                raise CodecError(f'Wrong architecture/type for Windows DLL: {path}')
        elif target.startswith('darwin-'):
            magic, cpu, _, kind = struct.unpack_from('<IIII', data)
            expected = 0x100000C if target.endswith('arm64') else 0x1000007
            if magic != 0xFEEDFACF or cpu != expected or kind != 6:
                raise CodecError(f'Expected thin {target} Mach-O dylib: {path}')
            if f'@rpath/{runtime_name(component, target)}'.encode() not in data:
                raise CodecError(f'Missing relocatable Mach-O runtime identity: {path}')
        else:
            if data[:7] != b'\x7fELF\x02\x01\x01' or len(data) < 64:
                raise CodecError(f'Expected Linux ELF64 shared library: {path}')
            kind, machine = struct.unpack_from('<HH', data, 16)
            if kind != 3 or machine != 62 or data[7] not in (0, 3):
                raise CodecError(f'Wrong Linux shared-library architecture/type: {path}')
            if runtime_name(component, target).encode() + b'\0' not in data:
                raise CodecError(f'Missing pinned Linux SONAME identity: {path}')
    except struct.error as error:
        raise CodecError(f'Truncated shared-library header: {path}') from error
    for flag in FORBIDDEN_FLAGS:
        if flag.encode() in data:
            raise CodecError(f'Forbidden embedded runtime option {flag}: {path}')
    if component in ('avcodec', 'avformat'):
        pinned = profile()
        for flag in ('--disable-everything', '--disable-network',
                     f'--enable-demuxer={",".join(pinned["requiredDemuxers"])}',
                     f'--enable-decoder={",".join(pinned["requiredDecoders"])}'):
            # FFmpeg may quote comma-list arguments in its embedded receipt.
            quoted = flag.replace('=', "='") + "'" if '=' in flag else flag
            if flag.encode() not in data and quoted.encode() not in data:
                raise CodecError(f'Runtime does not bind configure profile {flag}: {path}')


def inspect_pack(pack_dir: Path, target: str) -> dict:
    target_flags(target)
    pack = Path(pack_dir).resolve(strict=True)
    regular(pack / 'manifest.json')
    manifest = json.loads((pack / 'manifest.json').read_text(encoding='utf-8'))
    pinned = profile()
    for field in ('format', 'profile', 'source', 'abiMajors', 'capabilityMask',
                  'requiredDemuxers', 'requiredDecoders', 'requiredParsers'):
        expected = 1 if field == 'format' else pinned[field]
        if manifest.get(field) != expected:
            raise CodecError(f'Codec pack {field} does not match pinned source/profile')
    if manifest.get('target') != target:
        raise CodecError(f'Codec target mismatch: expected {target}')
    validate_configuration(manifest.get('configuration'), target)
    rows = manifest.get('files')
    if not isinstance(rows, list) or not 8 <= len(rows) <= 4096:
        raise CodecError('Missing or unreasonable codec file inventory')
    seen = set()
    indexed = {}
    for row in rows:
        name = row['path']
        path = pack / relative(name)
        if name.casefold() in seen:
            raise CodecError(f'Duplicate codec inventory path: {name}')
        seen.add(name.casefold())
        indexed[name.casefold()] = row
        # Reject parent symlinks as well as leaf links in immutable packs.
        if path.resolve(strict=True) != path:
            raise CodecError(f'Linked codec inventory path: {name}')
        regular(path)
        if row.get('bytes') != path.stat().st_size or row.get('sha256') != digest(path):
            raise CodecError(f'Codec inventory bytes changed: {name}')
    actual = set()
    for path in pack.rglob('*'):
        if path.is_symlink():
            raise CodecError(f'Codec pack contains link: {path}')
        if path.is_file() and path != pack / 'manifest.json':
            actual.add(path.relative_to(pack).as_posix().casefold())
    if actual != seen:
        raise CodecError('Codec pack tree differs from its immutable inventory')
    for name in ('NOTICE-FFMPEG.md', 'COPYING.LGPLv2.1-FFMPEG', 'profile.json'):
        name = 'compliance/' + name
        if name.casefold() not in seen:
            raise CodecError(f'Missing codec notice: {name}')
        if not (pack / name).stat().st_size:
            raise CodecError(f'Empty codec notice: {name}')
    if json.loads((pack / 'compliance/profile.json').read_text(encoding='utf-8')) != pinned:
        raise CodecError('Compliance profile differs from pinned profile')
    receipt = pack / 'share/singz-ffmpeg/configuration.txt'
    if receipt.relative_to(pack).as_posix().casefold() not in seen or receipt.read_text(encoding='utf-8').strip() != manifest['configuration'].strip():
        raise CodecError('Configure receipt does not match manifest')
    mapping = manifest.get('runtimeLibraries', {})
    if set(mapping) != set(COMPONENTS):
        raise CodecError('Expected exactly four dynamic FFmpeg runtime libraries')
    libraries = []
    args = ['-DSINGZ_ENABLE_FFMPEG_CODECS=ON', f'-DSINGZ_FFMPEG_INCLUDE_DIR={pack / "include"}']
    for component in COMPONENTS:
        path = pack / relative(mapping[component])
        if mapping[component].casefold() not in seen or path.name != runtime_name(component, target):
            raise CodecError(f'Wrong pinned runtime name for {component}')
        inspect_binary(path, target, component)
        headers = [pack / f'include/lib{component}/version_major.h', pack / f'include/lib{component}/version.h']
        pattern = rf'^\s*#\s*define\s+LIB{component.upper()}_VERSION_MAJOR\s+(\d+)\b'
        majors = [int(match.group(1)) for header in headers if header.is_file()
                  for match in re.finditer(pattern, header.read_text(encoding='utf-8'), re.MULTILINE)]
        if majors != [pinned['abiMajors'][component]]:
            raise CodecError(f'Installed {component} headers do not match runtime ABI')
        header = pack / f'include/lib{component}/{component}.h'
        # swresample's main header and avutil.h follow the component names too.
        if header.relative_to(pack).as_posix().casefold() not in seen:
            raise CodecError(f'Missing installed public header: {header}')
        link = path
        if target.startswith('win32-'):
            link = next((candidate for candidate in (pack / f'lib/{component}.lib', pack / f'lib/lib{component}.lib')
                         if candidate.relative_to(pack).as_posix().casefold() in seen), None)
            if link is None:
                raise CodecError(f'Missing MSVC import library for {component}')
            if not link.stat().st_size:
                raise CodecError(f'Empty MSVC import library for {component}')
        args.append(f'-DSINGZ_FFMPEG_{component.upper()}_LIBRARY={link}')
        if target.startswith('win32-'):
            args.append(f'-DSINGZ_FFMPEG_{component.upper()}_RUNTIME={path}')
        libraries.append({'component': component, 'linkPath': str(link), 'runtimePath': str(path),
                          'runtimeName': path.name, 'sha256': indexed[mapping[component].casefold()]['sha256']})
    return {'target': target, 'packDir': str(pack), 'includeDir': str(pack / 'include'),
            'manifestSha256': digest(pack / 'manifest.json'), 'libraries': libraries, 'cmakeArgs': args,
            'qualification': 'static profile/inventory validation; helper decode qualification required',
            'fixtureEvidence': 'not validated by this inspector',
            'nativeDesktopTargetExtension': target == 'linux-x64'}


def publish(source: Path, destination: Path) -> None:
    if os.name == 'nt':
        os.rename(source, destination)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        function = libc.renamex_np
        function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = function(os.fsencode(source), os.fsencode(destination), 4)
    else:
        function = libc.renameat2
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = function(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    if result:
        raise CodecError(f'Exclusive codec publication failed: {os.strerror(ctypes.get_errno())}')


def fresh(path: Path) -> Path:
    path = Path(path).absolute()
    if os.path.lexists(path):
        raise CodecError(f'Refusing existing destination: {path}')
    if not path.parent.is_dir():
        raise CodecError(f'Destination parent must exist: {path.parent}')
    return path.parent.resolve() / path.name


def stage_runtime(pack_dir: Path, target: str, output_dir: Path) -> dict:
    info = inspect_pack(pack_dir, target)
    output = fresh(output_dir)
    pack = Path(info['packDir'])
    with tempfile.TemporaryDirectory(prefix='.gpui-codec-stage-', dir=output.parent) as temporary:
        staged = Path(temporary) / 'payload'
        staged.mkdir()
        for library in info['libraries']:
            shutil.copyfile(library['runtimePath'], staged / library['runtimeName'])
            if digest(staged / library['runtimeName']) != library['sha256']:
                raise CodecError('Codec runtime changed during staging')
        shutil.copytree(pack / 'compliance', staged / 'compliance')
        shutil.copyfile(pack / 'share/singz-ffmpeg/configuration.txt', staged / 'configuration.txt')
        files = [{'path': p.relative_to(staged).as_posix(), 'bytes': p.stat().st_size, 'sha256': digest(p)}
                 for p in sorted(staged.rglob('*')) if p.is_file()]
        receipt = {**info, 'files': files, 'source': profile()['source']}
        (staged / 'codec-runtime-manifest.json').write_text(json.dumps(receipt, indent=2) + '\n', encoding='utf-8')
        publish(staged, output)
    return receipt


def build_plan(target: str, source: Path, stage: Path, jobs: int = 1) -> dict:
    if not 1 <= jobs <= 4:
        raise CodecError('Build jobs must be between 1 and 4')
    flags = configure_flags(target, stage)
    if target.startswith('darwin-'):
        arch = 'arm64' if target.endswith('arm64') else 'x86_64'
        flags += ['--cc=clang', '--install-name-dir=@rpath',
                  f'--extra-cflags=-arch {arch} -mmacosx-version-min=11.0',
                  f'--extra-ldflags=-arch {arch} -mmacosx-version-min=11.0']
    elif target == 'win32-x64':
        flags += ['--disable-x86asm', '--cc=cl.exe', '--ld=link.exe', '--ar=lib.exe']
    else:
        flags += ['--disable-x86asm', '--cc=cc']
    return {'target': target, 'configure': ['bash', str(source / 'configure'), *flags],
            'make': ['make', f'-j{jobs}'], 'install': ['make', 'install'],
            'requirements': ['bash', 'make', 'cl.exe/link.exe/lib.exe in an x64 MSVC environment'
                             if target == 'win32-x64' else 'native C compiler'],
            'source': profile()['source'], 'network': False, 'nativeDesktopTargetExtension': target == 'linux-x64'}


def extract_source(archive: Path, destination: Path) -> None:
    regular(archive)
    if digest(archive) != profile()['source']['sha256']:
        raise CodecError('Official FFmpeg source archive SHA256 mismatch')
    with tarfile.open(archive, 'r:xz') as bundle:
        members = bundle.getmembers()
        prefix = 'ffmpeg-' + profile()['source']['version']
        for entry in members:
            parts = PurePosixPath(entry.name).parts
            if not parts or parts[0] != prefix or '..' in parts or not (entry.isdir() or entry.isfile()):
                raise CodecError(f'Unexpected source archive entry: {entry.name}')
        # Every entry is a regular file/directory under the verified single root.
        bundle.extractall(destination)


def build_pack(target: str, pack_dir: Path, source_archive: Path, work_dir: Path, jobs: int = 1) -> dict:
    # Importlib callers need not have the scripts directory on sys.path.
    import importlib.util
    spec = importlib.util.spec_from_file_location('singz_codec_build_lease', Path(__file__).with_name('gpui_native_build_lock.py'))
    lease = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lease)
    with lease.native_build_lock(ROOT, 'gpui-codec-runtime:' + target):
        return _build_pack_locked(target, pack_dir, source_archive, work_dir, jobs)


def _build_pack_locked(target: str, pack_dir: Path, source_archive: Path, work_dir: Path, jobs: int = 1) -> dict:
    output, work = fresh(pack_dir), fresh(work_dir)
    if output == work or output in work.parents or work in output.parents:
        raise CodecError('Build work and published pack must be separate destinations')
    expected_host = 'Darwin' if target.startswith('darwin-') else 'Windows' if target.startswith('win32-') else 'Linux'
    if platform.system() != expected_host or (target.endswith('x64') and platform.machine().lower() not in ('amd64', 'x86_64')):
        raise CodecError(f'{target} requires its native desktop host/toolchain')
    # Check the archive before making an owned work directory or running code.
    regular(source_archive)
    if digest(source_archive) != profile()['source']['sha256']:
        raise CodecError('Official FFmpeg source archive SHA256 mismatch')
    work.mkdir()
    (work / 'build').mkdir()
    installed = work / 'stage'
    installed.mkdir()
    extract_source(source_archive, work)
    source = work / ('ffmpeg-' + profile()['source']['version'])
    plan = build_plan(target, source, installed, jobs)
    tools = ['bash', 'make'] + (['cl.exe', 'link.exe', 'lib.exe'] if target == 'win32-x64' else ['clang'] if target.startswith('darwin-') else ['cc'])
    for tool in tools:
        if not shutil.which(tool):
            raise CodecError(f'Missing native build tool: {tool}; work retained at {work}')
    if target == 'win32-x64':
        # Native Python paths use drive letters/backslashes, whereas FFmpeg's
        # configure/Makefiles run in the existing MSYS/Git Bash environment.
        # Resolve with that environment's own cygpath, never invent a drive map.
        def shell_path(path: Path) -> str:
            result = subprocess.run(['bash', '-c', 'cygpath -u "$1"', 'gpui-codec-path', str(path)],
                                    check=True, capture_output=True, text=True)
            converted = result.stdout.strip()
            if not converted.startswith('/') or '\n' in converted:
                raise CodecError('Bash did not provide an absolute POSIX build path')
            return converted
        plan['configure'][1] = shell_path(source / 'configure')
        plan['configure'][2] = '--prefix=' + shell_path(installed)
    for command in (plan['configure'], plan['make'], plan['install']):
        subprocess.run(command, cwd=work / 'build', check=True)
    receipt = installed / 'share/singz-ffmpeg/configuration.txt'
    receipt.parent.mkdir(parents=True, exist_ok=True)
    receipt.write_text(shlex.join(plan['configure'][2:]) + '\n', encoding='utf-8')
    compliance = installed / 'compliance'
    compliance.mkdir()
    for name in ('NOTICE-FFMPEG.md', 'COPYING.LGPLv2.1-FFMPEG'):
        shutil.copyfile(ROOT / 'third_party' / name, compliance / name)
    shutil.copyfile(PROFILE_PATH, compliance / 'profile.json')
    # Keep headers/shared libs/import libs only, dereferencing make-install's
    # internal version-selector links. Never publish a link outside this stage.
    with tempfile.TemporaryDirectory(prefix='.gpui-codec-build-', dir=output.parent) as temporary:
        payload = Path(temporary) / 'payload'
        payload.mkdir()
        for directory in ('include', 'lib', 'bin', 'compliance'):
            tree = installed / directory
            if not tree.is_dir():
                continue
            for path in tree.rglob('*'):
                if path.is_dir():
                    continue
                resolved = path.resolve(strict=True)
                if not resolved.is_relative_to(installed.resolve()) or not resolved.is_file():
                    raise CodecError(f'Installed codec link leaves owned stage: {path}')
                if directory == 'lib' and (path.suffix in ('.a', '.la') or 'pkgconfig' in path.parts):
                    continue
                destination = payload / path.relative_to(installed)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(resolved, destination)
        target_receipt = payload / 'share/singz-ffmpeg/configuration.txt'
        target_receipt.parent.mkdir(parents=True)
        shutil.copyfile(receipt, target_receipt)
        pinned = profile()
        mapping = {c: ('bin/' if target.startswith('win32-') else 'lib/') + runtime_name(c, target) for c in COMPONENTS}
        manifest = {field: pinned[field] for field in ('profile', 'source', 'abiMajors', 'capabilityMask', 'requiredDemuxers', 'requiredDecoders', 'requiredParsers')}
        manifest.update(format=1, target=target, configuration=receipt.read_text(encoding='utf-8').strip(),
                        runtimeLibraries=mapping, fixtureEvidence={'fullMatrix': False},
                        builder={'name': 'gpui-codec-runtime.py', 'sourceArchiveSha256': digest(source_archive),
                                 'nativeDesktopTargetExtension': target == 'linux-x64'},
                        files=[{'path': p.relative_to(payload).as_posix(), 'bytes': p.stat().st_size, 'sha256': digest(p)}
                               for p in sorted(payload.rglob('*')) if p.is_file()])
        (payload / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        inspect_pack(payload, target)
        publish(payload, output)
    return inspect_pack(output, target)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    for name in ('inspect', 'build', 'stage'):
        command = commands.add_parser(name)
        command.add_argument('--target', choices=TARGETS, required=True)
        command.add_argument('--pack-dir', type=Path, required=True)
        if name == 'inspect':
            command.add_argument('--cmake-args', action='store_true', help='One CMake argv element per line')
        elif name == 'stage':
            command.add_argument('--output-dir', type=Path, required=True)
        else:
            command.add_argument('--source-archive', type=Path, required=True)
            command.add_argument('--work-dir', type=Path, required=True)
            command.add_argument('--jobs', type=int, default=1)
            command.add_argument('--print-plan', action='store_true', help='Print commands without reading/extracting/building the archive')
    args = parser.parse_args()
    try:
        if args.command == 'inspect':
            result = inspect_pack(args.pack_dir, args.target)
            if args.cmake_args:
                print('\n'.join(result['cmakeArgs']))
                return
        elif args.command == 'stage':
            result = stage_runtime(args.pack_dir, args.target, args.output_dir)
        elif args.print_plan:
            result = build_plan(args.target, args.work_dir.absolute() / ('ffmpeg-' + profile()['source']['version']), args.work_dir.absolute() / 'stage', args.jobs)
        else:
            result = build_pack(args.target, args.pack_dir, args.source_archive.absolute(), args.work_dir, args.jobs)
        print(json.dumps(result, indent=2))
    except (CodecError, OSError, ValueError, KeyError, TypeError, subprocess.CalledProcessError, tarfile.TarError) as error:
        parser.exit(1, f'Native codec provisioning failed: {error}\n')


if __name__ == '__main__':
    main()
