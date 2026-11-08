#!/usr/bin/env python3
"""Package already-built native Windows/Linux runtimes without running them."""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import struct
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
EXECUTABLES = ('singz-gpui-player', 'singz-gpui-audio', 'singz-gpui-input', 'singz-analyze')
SAMPLES = tuple(f'{sound}-C{octave}.mp3' for sound in ('piano', 'electric', 'guitar') for octave in range(2, 7)) + ('LICENSE.md', 'loudness-calibration.json')
FONT_LICENSES = ('Bricolage-OFL.txt', 'MartianMono-OFL.txt')


class PackageError(RuntimeError):
    pass


def native_build_info(path: Path | None, executable: Path, platform: str, required: bool) -> dict | None:
    """Validate supplied CLI metadata against copied, unsigned UI bytes; never execute it.

    This binds a caller-supplied report, not an attestation of its provenance.
    Only the closed safe schema is retained in the package manifest.
    """
    if path is None:
        if required:
            raise PackageError('--require-drive-config requires --build-info-file')
        return None
    ordinary(path)
    try:
        if path.stat().st_size > 16384:
            raise ValueError('oversized')
        info = json.loads(path.read_text(encoding='utf-8'))
        expected = {'schema', 'runtime', 'nodeRuntime', 'applicationVersion', 'crateVersion', 'os', 'arch', 'executableSha256', 'drive'}
        if not isinstance(info, dict) or set(info) != expected:
            raise ValueError('schema')
        if type(info['schema']) is not int or info['schema'] != 1 or info['runtime'] != 'rust-gpui' or info['nodeRuntime'] is not False:
            raise ValueError('runtime')
        if info['os'] != platform or info['arch'] not in ('x86_64', 'aarch64'):
            raise ValueError('target')
        for field in ('applicationVersion', 'crateVersion'):
            value = info[field]
            if not isinstance(value, str) or not 0 < len(value) <= 64 or any(c not in '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.+-' for c in value):
                raise ValueError('version')
        digest = info['executableSha256']
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in '0123456789abcdef' for c in digest):
            raise ValueError('digest')
        drive = info['drive']
        if not isinstance(drive, dict) or set(drive) != {'configured', 'source', 'status'} or type(drive['configured']) is not bool:
            raise ValueError('drive')
        if drive['source'] not in ('canonical-json', 'legacy-typescript', 'none', 'unknown') or drive['status'] not in ('configured', 'missing', 'unreadable', 'malformed', 'invalid'):
            raise ValueError('labels')
        if drive['configured'] != (drive['status'] == 'configured') or (drive['configured'] and drive['source'] not in ('canonical-json', 'legacy-typescript')):
            raise ValueError('configuration')
    except (ValueError, TypeError, KeyError, UnicodeError):
        raise PackageError('Invalid safe native build-info document') from None
    if hashlib.sha256(executable.read_bytes()).hexdigest() != digest:
        raise PackageError('Native build-info executable hash does not match copied UI executable')
    if required and not drive['configured']:
        raise PackageError('Required baked Drive application configuration is unavailable')
    return info


def reject_node_runtime_path(relative: Path) -> None:
    """Reject actual runtime/addon names, not arbitrary JS documentation/DLLs."""
    parts = [part.casefold() for part in relative.parts]
    name = parts[-1] if parts else ''
    runtime_directories = {'node_modules', 'electron.app', 'electron.framework', 'electron framework.framework'}
    runtimes = {'node', 'node.exe', 'nodejs', 'nodejs.exe', 'node.dll', 'libnode.dll',
                'electron', 'electron.exe', 'electron.dll', 'electron framework',
                'electron helper', 'electron helper (gpu)', 'electron helper (renderer)',
                'electron helper (plugin)', 'libnode.so', 'libnode.dylib'}
    versioned_so = name.startswith('libnode.so.') and all(part.isdigit() for part in name[len('libnode.so.'):].split('.'))
    versioned_dylib = name.startswith('libnode.') and name.endswith('.dylib') and all(part.isdigit() for part in name[len('libnode.'):-len('.dylib')].split('.'))
    if (any(part in runtime_directories for part in parts) or name.endswith('.node')
            or name in runtimes or versioned_so or versioned_dylib):
        raise PackageError(f'Node/Electron runtime or addon is not a native-only payload: {relative}; provide a pure-native engine payload')


def require_native_payload(directory: Path) -> None:
    for path in directory.rglob('*'):
        reject_node_runtime_path(path.relative_to(directory))


def ordinary(path: Path, directory: bool = False) -> os.stat_result:
    try:
        meta = path.lstat()
    except OSError as error:
        raise PackageError(f'Missing required payload: {path}') from error
    if not (stat.S_ISDIR(meta.st_mode) if directory else stat.S_ISREG(meta.st_mode)):
        raise PackageError(f'Payload must be an ordinary {"directory" if directory else "file"}, without links: {path}')
    return meta


def identity(meta: os.stat_result) -> dict:
    return {'device': meta.st_dev, 'inode': meta.st_ino, 'bytes': meta.st_size,
            'mtimeNs': meta.st_mtime_ns, 'ctimeNs': meta.st_ctime_ns}


def same_source_identity(path_meta: os.stat_result, opened_meta: os.stat_result, *, windows: bool | None = None) -> bool:
    # Dell/Python 3.12 exposes creation time via path lstat().st_ctime_ns but
    # change time via fstat().st_ctime_ns. Compare only common fields across
    # APIs on Windows, retaining full ctime checks within each API below.
    expected, opened = identity(path_meta), identity(opened_meta)
    is_windows = os.name == 'nt' if windows is None else windows
    if is_windows:
        return all(expected[key] == opened[key] for key in ('device', 'inode', 'bytes', 'mtimeNs'))
    return expected == opened


def binary(path: Path, platform: str, *, dll: bool = False) -> str:
    """Minimum native header/section bounds, not a dependency or loader check."""
    size = path.stat().st_size
    with path.open('rb') as stream:
        header = stream.read(64)
        if platform == 'windows':
            if len(header) != 64 or header[:2] != b'MZ':
                raise PackageError(f'Expected Windows PE executable: {path}')
            offset = struct.unpack_from('<I', header, 60)[0]
            if not 64 <= offset <= min(size - 24, 1024 * 1024):
                raise PackageError(f'Invalid PE header offset: {path}')
            stream.seek(offset)
            coff = stream.read(24)
            machine, sections = struct.unpack_from('<HH', coff, 4)
            optional_size, flags = struct.unpack_from('<HH', coff, 20)
            architectures = {0x8664: 'x86_64', 0xAA64: 'aarch64'}
            if (coff[:4] != b'PE\0\0' or machine not in architectures or not 0 < sections <= 96
                    or optional_size < 112 or not flags & 2 or bool(flags & 0x2000) != dll):
                raise PackageError(f'Unsupported PE architecture/type/header: {path}')
            if offset + 24 + optional_size + sections * 40 > size:
                raise PackageError(f'Truncated PE headers: {path}')
            optional = stream.read(optional_size)
            headers_size = struct.unpack_from('<I', optional, 60)[0]
            if (struct.unpack_from('<H', optional)[0] != 0x20B
                    or not offset + 24 + optional_size + sections * 40 <= headers_size <= size
                    or (not dll and struct.unpack_from('<I', optional, 16)[0] == 0)):
                raise PackageError(f'Invalid PE optional header: {path}')
            for _ in range(sections):
                section = stream.read(40)
                raw_size, raw_offset = struct.unpack_from('<II', section, 16)
                if raw_size and (raw_offset < headers_size or raw_offset + raw_size > size):
                    raise PackageError(f'Truncated PE section: {path}')
            return architectures[machine]
        if (len(header) != 64 or header[:7] != b'\x7fELF\x02\x01\x01'
                or header[7] not in (0, 3)
                or struct.unpack_from('<I', header, 20)[0] != 1):
            raise PackageError(f'Expected little-endian ELF64 Linux executable: {path}')
        kind, machine = struct.unpack_from('<HH', header, 16)
        entry, phoff = struct.unpack_from('<QQ', header, 24)
        ehsize, phsize, count = struct.unpack_from('<HHH', header, 52)
        architectures = {62: 'x86_64', 183: 'aarch64'}
        if (kind not in ((3,) if dll else (2, 3)) or machine not in architectures or (not dll and not entry) or ehsize != 64
                or phsize != 56 or not 0 < count <= 1024 or phoff < 64
                or phoff + phsize * count > size):
            raise PackageError(f'Unsupported/truncated ELF architecture/type/header: {path}')
        stream.seek(phoff)
        load = False
        for _ in range(count):
            program = stream.read(phsize)
            segment = struct.unpack_from('<I', program)[0]
            start = struct.unpack_from('<Q', program, 8)[0]
            length = struct.unpack_from('<Q', program, 32)[0]
            if start + length > size:
                raise PackageError(f'Truncated ELF segment: {path}')
            load |= segment == 1
        if not load:
            raise PackageError(f'ELF has no loadable segment: {path}')
        return architectures[machine]


def rename_exclusive(source: Path, destination: Path) -> None:
    if os.name == 'nt':
        # Windows os.rename refuses an existing destination; never os.replace.
        os.rename(source, destination)
        return
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        function = library.renamex_np
        function.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = function(os.fsencode(source), os.fsencode(destination), 4)  # RENAME_EXCL
    elif sys.platform.startswith('linux'):
        try:
            function = library.renameat2
        except AttributeError as error:
            raise PackageError('Exclusive publication requires Linux renameat2(RENAME_NOREPLACE)') from error
        function.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = function(-100, os.fsencode(source), -100, os.fsencode(destination), 1)
    else:
        raise PackageError('Exclusive publication is supported only on Windows, Linux and macOS hosts')
    if result:
        code = ctypes.get_errno()
        raise PackageError(f'Cannot exclusively publish {destination}: {os.strerror(code)}')


def prepare_permissions(payload: Path, destination_parent: Path) -> None:
    """Snapshot authorized parent rights before publication, on Windows only.

    The outer tempfile directory stays private. Protecting each payload DACL
    prevents automatic inheritance from that private staging parent; no ACL is
    edited after the exclusive publish or outside our newly created payload.
    """
    if os.name != 'nt':
        return
    _snapshot_windows_parent_dacl(payload, destination_parent)


def _snapshot_windows_parent_dacl(payload: Path, destination_parent: Path) -> None:
    from ctypes import wintypes
    advapi = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    pointer = ctypes.c_void_p
    get_security = advapi.GetNamedSecurityInfoW
    get_security.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                            ctypes.POINTER(pointer), ctypes.POINTER(pointer),
                            ctypes.POINTER(pointer), ctypes.POINTER(pointer), ctypes.POINTER(pointer)]
    get_security.restype = wintypes.DWORD
    set_security = advapi.SetNamedSecurityInfoW
    set_security.argtypes = [wintypes.LPWSTR, ctypes.c_int, wintypes.DWORD,
                            pointer, pointer, pointer, pointer]
    set_security.restype = wintypes.DWORD
    kernel.LocalFree.argtypes = [pointer]
    kernel.LocalFree.restype = pointer
    descriptor, dacl = pointer(), pointer()
    # SE_FILE_OBJECT, DACL_SECURITY_INFORMATION. Ownership/SACLs are untouched.
    code = get_security(str(destination_parent), 1, 4, None, None, ctypes.byref(dacl), None, ctypes.byref(descriptor))
    if code:
        raise PackageError(f'Cannot read destination parent DACL ({code}): {destination_parent}')
    try:
        if not dacl:
            raise PackageError('Destination parent has a NULL DACL; refusing to create unrestricted payload permissions')
        # Copy the actual parent-authorized DACL, including limited RX users.
        # DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION.
        for path in [payload, *sorted(payload.rglob('*'))]:
            ordinary(path, path.is_dir())
            code = set_security(str(path), 1, 4 | 0x80000000, None, None, dacl, None)
            if code:
                raise PackageError(f'Cannot snapshot destination parent DACL ({code}): {path}')
    finally:
        if descriptor:
            kernel.LocalFree(descriptor)


def copy_selected(source: Path, destination: Path, selection: str, *, executable: bool = False) -> dict:
    before = ordinary(source)
    if not before.st_size:
        raise PackageError(f'Empty required payload: {source}')
    destination.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256()
    # O_NOFOLLOW also fences replacement after the initial path inspection on
    # POSIX; the opened identity and final path are checked on every host.
    fd = os.open(source, os.O_RDONLY | getattr(os, 'O_BINARY', 0) | getattr(os, 'O_NOFOLLOW', 0))
    with os.fdopen(fd, 'rb') as reader, destination.open('xb') as writer:
        opened = os.fstat(reader.fileno())
        if not same_source_identity(before, opened):
            raise PackageError(f'Payload changed while opening: {source}')
        for chunk in iter(lambda: reader.read(1024 * 1024), b''):
            writer.write(chunk)
            digest.update(chunk)
        writer.flush()
        os.fsync(writer.fileno())
        if identity(os.fstat(reader.fileno())) != identity(opened) or identity(ordinary(source)) != identity(before):
            raise PackageError(f'Payload changed while copying: {source}')
    destination.chmod(0o755 if executable else 0o644)
    return {'selection': selection, 'path': str(source.resolve()), 'identity': identity(before), 'openedIdentity': identity(opened), 'sha256': digest.hexdigest()}


def codec_payload(runtime: Path, platform: str) -> tuple[list[tuple[Path, Path, str, bool]], dict | None, dict]:
    """Validate the stager's immutable codec receipt, never discover SDK files."""
    directory = runtime / 'ffmpeg'
    if not os.path.lexists(directory):
        # Adjacent codec DLLs without their compliance/provenance are incomplete.
        if platform == 'windows' and any((runtime / name).exists() for name in ('avcodec-62.dll', 'avformat-62.dll', 'avutil-60.dll', 'swresample-6.dll')):
            raise PackageError('Adjacent FFmpeg DLLs require ffmpeg codec receipt and compliance')
        return [], None, {}
    ordinary(directory, True)
    receipt_path = directory / 'codec-runtime-manifest.json'
    ordinary(receipt_path)
    if not 0 < receipt_path.stat().st_size <= 1024 * 1024:
        raise PackageError('Codec runtime receipt exceeds its bounded size')
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes)
    profile = json.loads((ROOT / 'third_party/ffmpeg-codec/profile.json').read_text(encoding='utf-8'))
    targets = {'windows': ('win32-x64',), 'linux': ('linux-x64',), 'macos': ('darwin-arm64', 'darwin-x64')}
    if not isinstance(receipt, dict) or receipt.get('target') not in targets[platform] or receipt.get('source') != profile['source']:
        raise PackageError('Codec runtime target/source differs from pinned profile')
    windows = platform == 'windows'
    file_base = receipt.get('fileBase', 'codec-directory')
    if file_base != ('runtime-root' if windows else 'codec-directory'):
        raise PackageError('Codec runtime receipt has an incompatible file base')
    names = {component: (f'{component}-{major}.dll' if windows else f'lib{component}.{major}.dylib' if platform == 'macos' else f'lib{component}.so.{major}')
             for component, major in profile['abiMajors'].items()}
    libraries = receipt.get('libraries')
    if not isinstance(libraries, list) or len(libraries) != 4:
        raise PackageError('Codec runtime must describe exactly four shared libraries')
    indexed_libraries = {}
    for library in libraries:
        if not isinstance(library, dict) or library.get('component') not in names or library['component'] in indexed_libraries:
            raise PackageError('Duplicate/unknown codec library component')
        component = library['component']
        if library.get('runtimeName') != names[component]:
            raise PackageError('Codec runtime library does not match pinned ABI name')
        indexed_libraries[component] = library
    prefix = 'ffmpeg/' if windows else ''
    required = {prefix + name for name in ('configuration.txt', 'compliance/profile.json', 'compliance/NOTICE-FFMPEG.md', 'compliance/COPYING.LGPLv2.1-FFMPEG')}
    required.update(names.values())
    rows = receipt.get('files')
    if not isinstance(rows, list) or not 8 <= len(rows) <= 256:
        raise PackageError('Missing/bounded codec runtime inventory required')
    selected, expected, seen = [], {}, set()
    for row in rows:
        name = row.get('path') if isinstance(row, dict) else None
        if not isinstance(name, str) or any(part in ('', '.', '..') for part in name.split('/')) or any(char in name for char in ('\\', ':', '\0')) or PurePosixPath(name).is_absolute():
            raise PackageError('Unsafe codec runtime inventory path')
        if name.casefold() in seen:
            raise PackageError('Duplicate codec runtime inventory path')
        seen.add(name.casefold())
        library = name in names.values()
        if not library and name not in required and not name.startswith(prefix + 'compliance/'):
            raise PackageError(f'Unexpected codec runtime payload: {name}')
        source = (runtime if windows else directory) / name
        relative = Path(name) if windows else Path('ffmpeg') / name
        for parent in source.parents:
            if parent == runtime:
                break
            ordinary(parent, True)
        ordinary(source)
        limit = 256 * 1024 * 1024 if library else 2 * 1024 * 1024
        if not 0 < source.stat().st_size <= limit or row.get('bytes') != source.stat().st_size:
            raise PackageError(f'Invalid codec runtime size: {name}')
        actual = hashlib.sha256(source.read_bytes()).hexdigest()
        if row.get('sha256') != actual:
            raise PackageError(f'Codec runtime inventory bytes changed: {name}')
        expected[relative.as_posix()] = {'bytes': row['bytes'], 'sha256': actual}
        if not (windows and library):
            selected.append((source, relative, 'ffmpeg-library' if library else 'ffmpeg-compliance', library))
    if not {name.casefold() for name in required}.issubset(seen):
        raise PackageError('Missing codec runtime libraries/compliance/configuration')
    for component, library in indexed_libraries.items():
        relative = names[component] if windows else 'ffmpeg/' + names[component]
        if library.get('sha256') != expected[relative]['sha256']:
            raise PackageError('Codec library hash differs from its source receipt')
    actual_metadata = set()
    for path in directory.rglob('*'):
        ordinary(path, path.is_dir())
        if path.is_file() and path != receipt_path:
            actual_metadata.add(('ffmpeg/' if windows else '') + path.relative_to(directory).as_posix())
    expected_metadata = {row['path'] for row in rows if not windows or row['path'].startswith('ffmpeg/')}
    if actual_metadata != expected_metadata:
        raise PackageError('Codec directory differs from its receipt inventory')
    if json.loads((directory / 'compliance/profile.json').read_text(encoding='utf-8')) != profile:
        raise PackageError('Codec compliance profile differs from pinned profile')
    configuration = (directory / 'configuration.txt').read_text(encoding='utf-8')
    if any(flag in configuration for flag in ('--enable-gpl', '--enable-nonfree')) or not all(flag in configuration for flag in ('--enable-shared', '--disable-static')):
        raise PackageError('Codec configuration is not the replaceable shared LGPL profile')
    selected.append((receipt_path, Path('ffmpeg/codec-runtime-manifest.json'), 'ffmpeg-receipt', False))
    receipt_hash = hashlib.sha256(receipt_bytes).hexdigest()
    expected['ffmpeg/codec-runtime-manifest.json'] = {'bytes': len(receipt_bytes), 'sha256': receipt_hash}
    return selected, {'target': receipt['target'], 'source': profile['source'],
                      'receiptSha256': receipt_hash, 'libraryNames': list(names.values()),
                      'receiptScope': 'pre-signing staged inputs; final payload hashes are in package files inventory'}, expected


def readme(platform: str, architecture: str) -> str:
    system = ('Windows on the recorded architecture, a working graphics driver and system audio devices. '
              'Adjacent selected DLLs are included; other OS/runtime DLL prerequisites must already be installed.'
              if platform == 'windows' else
              'Linux on the recorded architecture, a working graphical desktop/graphics driver and audio stack. '
              'System shared libraries (including this build\'s graphics/audio/ONNX dependencies) must already be installed. '
              'Only explicitly staged FFmpeg shared libraries in ffmpeg/ are bundled; other system libraries are not discovered or bundled. ')
    return f'''SingZ native desktop portable preview — {platform} / {architecture}

Launch {'singz-gpui-player.exe' if platform == 'windows' else './singz-gpui-player'} from this directory. Keep all four executables,
pitch/, training-sounds/ and licenses/ together when moving the folder.
No Node/Electron runtime is used. This package does not install services, configure
the operating system, or change audio devices. Normal application preferences and
projects use the application's user configuration/data locations, not this folder.

Prerequisites: {system}
The package has not established a universal minimum OS/libc/runtime version.
Qualify this exact payload on each supported machine before distribution. Header
and architecture inspection is not a dynamic dependency, ABI or loadability check.

The adjacent CREPE tiny pitch model and its notice are included. Embedded UI fonts'
OFL notices are in licenses/. Training sounds and calibration retain their license.
When present, ffmpeg/ contains the four replaceable shared codec libraries, pinned
source/build receipt and compliance notices (Windows DLLs remain adjacent to the
executables). Its receipt describes pre-signing inputs; the final package inventory
is authoritative for delivered bytes. This is provenance, not a full codec matrix
qualification. Follow its LGPL notices and corresponding-source/replacement offer.
Optional inference/model packs and separate lyric/alignment engines are NOT included
or downloaded by this packager. Features requiring them need separately installed,
compatible native packs and their own licenses. No missing model is a successful
inference result. Native microphone/OS permissions remain the user's responsibility.

manifest.json records SHA256 of final payload files (excluding manifest.json itself)
and the selected source paths/identities. When assembled on Windows, payload DACLs
snapshot the destination parent's authorized rights before publication; they do
not track later parent ACL changes. ZIP/archive distribution does not export these
machine-specific Windows ACLs: extraction establishes permissions on that machine.
Synthetic packaging tests prove assembly,
not that these applications launched or that audio/inference worked on this OS.
'''


def assemble(platform: str, runtime: Path, output: Path, *, uikit_dir: Path | None = None,
             publisher=rename_exclusive, require_drive_config: bool = False,
             build_info_file: Path | None = None) -> Path:
    if platform not in ('windows', 'linux'):
        raise PackageError('Platform must be windows or linux')
    if platform == 'linux' and os.name != 'posix':
        raise PackageError('Linux packaging requires a POSIX host to preserve executable permission bits')
    runtime, output = Path(runtime).absolute(), Path(output).absolute()
    ordinary(runtime, True)
    ordinary(output.parent, True)
    output = output.parent.resolve() / output.name
    if os.path.lexists(output):
        raise PackageError(f'Output already exists: {output}')
    uikit = Path(uikit_dir).absolute() if uikit_dir is not None else ROOT.parent / 'singz-ui'
    ordinary(uikit, True)
    gpui = uikit / 'gpui' if (uikit / 'gpui').exists() else uikit
    for directory in (gpui, gpui / 'assets', gpui / 'assets/fonts'):
        ordinary(directory, True)
    notices = gpui / 'assets/fonts'
    selected = []
    suffix = '.exe' if platform == 'windows' else ''
    for executable in EXECUTABLES:
        name = executable + suffix
        selected.append((runtime / name, Path(name), 'native-executable', True))
    for directory, names in (('pitch', ('crepe-tiny.bin', 'torchcrepe-LICENSE.txt')), ('training-sounds', SAMPLES)):
        ordinary(runtime / directory, True)
        for name in names:
            selected.append((runtime / directory / name, Path(directory) / name, 'runtime-asset', False))
    for name in FONT_LICENSES:
        selected.append((notices / name, Path('licenses') / name, 'embedded-font-notice', False))
    if platform == 'windows':
        for path in sorted(runtime.iterdir()):
            if path.suffix.lower() == '.dll':
                stem = path.name.split('.', 1)[0].upper()
                reserved = {'CON', 'PRN', 'AUX', 'NUL'} | {f'{prefix}{number}' for prefix in ('COM', 'LPT') for number in range(1, 10)}
                if stem in reserved or any(ord(char) < 32 or char in '<>:"/\\|?*' for char in path.name):
                    raise PackageError(f'Invalid Windows DLL filename: {path.name}')
                selected.append((path, Path(path.name), 'adjacent-dll', False))
    codec_selected, codec_runtime, codec_expected = codec_payload(runtime, platform)
    selected.extend(codec_selected)
    # Avoid case-folded collisions on Windows even when assembly runs on Linux.
    for _, relative, _, _ in selected:
        reject_node_runtime_path(relative)
    targets = [relative.as_posix().casefold() for _, relative, _, _ in selected]
    if len(set(targets)) != len(targets):
        raise PackageError('Payload contains case-insensitive path collisions')
    with tempfile.TemporaryDirectory(prefix='.singz-desktop-package-', dir=output.parent) as temporary:
        payload = Path(temporary) / 'payload'
        payload.mkdir()
        sources, binaries = [], []
        architecture = None
        for source, relative, selection, executable in selected:
            record = copy_selected(source, payload / relative, selection, executable=executable and platform == 'linux')
            sources.append({'payloadPath': relative.as_posix(), **record})
            expected = codec_expected.get(relative.as_posix())
            if expected is not None and (record['sha256'] != expected['sha256'] or record['identity']['bytes'] != expected['bytes']):
                raise PackageError(f'Codec input changed after selection: {relative}')
            if executable or selection in ('adjacent-dll', 'ffmpeg-library'):
                found = binary(payload / relative, platform, dll=selection in ('adjacent-dll', 'ffmpeg-library'))
                if architecture is not None and architecture != found:
                    raise PackageError(f'Inconsistent binary architecture: {relative} is {found}, expected {architecture}')
                architecture = found
                binaries.append({'path': relative.as_posix(), 'architecture': found, 'kind': 'dll' if selection == 'adjacent-dll' else 'shared-library' if selection == 'ffmpeg-library' else 'executable'})
        require_native_payload(payload)
        build_info = native_build_info(build_info_file, payload / (EXECUTABLES[0] + suffix), platform, require_drive_config)
        if build_info is not None and build_info['arch'] != architecture:
            raise PackageError('Native build-info architecture does not match payload')
        (payload / 'README.txt').write_text(readme(platform, architecture), encoding='utf-8')
        files = [{'path': path.relative_to(payload).as_posix(), 'bytes': path.stat().st_size,
                  'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'mode': stat.S_IMODE(path.stat().st_mode)}
                 for path in sorted(payload.rglob('*')) if path.is_file()]
        manifest = {'schema': 1, 'nativeBuildInfo': build_info, 'driveConfigRequired': require_drive_config, 'platform': platform, 'architecture': architecture,
                    'runtimeSelection': str(runtime.resolve()), 'uikitSelection': str(uikit.resolve()),
                    'binaries': binaries, 'sources': sources, 'files': files, 'codecRuntime': codec_runtime,
                    'inventoryExcludes': ['manifest.json'],
                    'windowsAclPolicy': 'destination-parent-DACL-snapshot-before-publication' if os.name == 'nt' else 'not-applicable-on-assembly-host',
                    'archiveAclPolicy': 'machine-specific Windows ACLs are not exported by ZIP distribution',
                    'qualification': 'assembly-only; not launched or dependency-qualified'}
        (payload / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
        prepare_permissions(payload, output.parent)
        # Rename is the only publication operation. A racing foreign destination
        # remains untouched; TemporaryDirectory cleans only our private staging.
        publisher(payload, output)
    return output / 'manifest.json'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--platform', choices=('windows', 'linux'), required=True)
    parser.add_argument('--runtime-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True, help='Fresh, nonexistent portable-folder destination')
    parser.add_argument('--uikit-dir', type=Path, help='Existing singz-ui repository or gpui crate root; fonts are already embedded')
    parser.add_argument('--require-drive-config', action='store_true', help='Require configured baked Drive metadata bound to the unsigned source UI hash')
    parser.add_argument('--build-info-file', type=Path, help='Safe JSON previously emitted by the source UI --native-build-info; assembler never runs it')
    args = parser.parse_args()
    try:
        manifest = assemble(args.platform, args.runtime_dir, args.output_dir, uikit_dir=args.uikit_dir, require_drive_config=args.require_drive_config, build_info_file=args.build_info_file)
    except (PackageError, OSError, ValueError) as error:
        parser.exit(1, f'Packaging failed: {error}\n')
    print(manifest)


if __name__ == '__main__':
    main()
