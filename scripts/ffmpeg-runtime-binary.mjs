import { basename } from 'node:path'

export const ffmpegComponents = ['avcodec', 'avformat', 'avutil', 'swresample']

const bounded = (bytes, offset, length, label) => {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset + length > bytes.length)
    throw new Error(`${label} is outside the runtime binary`)
}

const unsigned = (bytes, offset, size, little, label) => {
  bounded(bytes, offset, size, label)
  if (size === 2) return little ? bytes.readUInt16LE(offset) : bytes.readUInt16BE(offset)
  if (size === 4) return little ? bytes.readUInt32LE(offset) : bytes.readUInt32BE(offset)
  if (size === 8) {
    const value = little ? bytes.readBigUInt64LE(offset) : bytes.readBigUInt64BE(offset)
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} is unreasonably large`)
    return Number(value)
  }
  throw new Error(`Unsupported integer width: ${size}`)
}

const cString = (bytes, offset, maximum, label) => {
  bounded(bytes, offset, maximum, label)
  const end = bytes.indexOf(0, offset)
  if (end < offset || end >= offset + maximum) throw new Error(`${label} is not terminated`)
  return bytes.subarray(offset, end).toString('utf8')
}

export const inspectElfRuntime = (bytes) => {
  if (bytes.length < 64 || bytes[0] !== 0x7f ||
      bytes.subarray(1, 4).toString('ascii') !== 'ELF')
    throw new Error('Runtime is not ELF')
  const elfClass = bytes[4]
  if (elfClass !== 1 && elfClass !== 2) throw new Error(`Unsupported ELF class: ${elfClass}`)
  const little = bytes[5] === 1
  if (!little && bytes[5] !== 2) throw new Error(`Unsupported ELF byte order: ${bytes[5]}`)
  const width = elfClass === 1 ? 4 : 8
  const type = unsigned(bytes, 16, 2, little, 'ELF type')
  const machine = unsigned(bytes, 18, 2, little, 'ELF machine')
  if (type !== 3) throw new Error(`ELF runtime is not ET_DYN: ${type}`)
  const phoff = unsigned(bytes, elfClass === 1 ? 28 : 32, width, little, 'ELF program-header offset')
  const phentsize = unsigned(bytes, elfClass === 1 ? 42 : 54, 2, little, 'ELF program-header size')
  const phnum = unsigned(bytes, elfClass === 1 ? 44 : 56, 2, little, 'ELF program-header count')
  const minimumPh = elfClass === 1 ? 32 : 56
  if (phentsize < minimumPh || phnum < 1 || phnum > 1024)
    throw new Error('ELF program-header table is unreasonable')
  bounded(bytes, phoff, phentsize * phnum, 'ELF program-header table')

  const segments = []
  for (let index = 0; index < phnum; index += 1) {
    const offset = phoff + index * phentsize
    const segmentType = unsigned(bytes, offset, 4, little, 'ELF segment type')
    const fileOffset = unsigned(bytes, offset + (elfClass === 1 ? 4 : 8), width, little, 'ELF segment offset')
    const virtualAddress = unsigned(bytes, offset + (elfClass === 1 ? 8 : 16), width, little, 'ELF segment address')
    const fileSize = unsigned(bytes, offset + (elfClass === 1 ? 16 : 32), width, little, 'ELF segment file size')
    const memorySize = unsigned(bytes, offset + (elfClass === 1 ? 20 : 40), width, little, 'ELF segment memory size')
    const alignment = unsigned(bytes, offset + (elfClass === 1 ? 28 : 48), width, little, 'ELF segment alignment')
    if (fileSize > 0) bounded(bytes, fileOffset, fileSize, 'ELF segment bytes')
    segments.push({ segmentType, fileOffset, virtualAddress, fileSize, memorySize, alignment })
  }
  const loads = segments.filter((row) => row.segmentType === 1)
  if (loads.length === 0) throw new Error('ELF runtime has no PT_LOAD segments')
  for (const load of loads) {
    if (load.alignment < 0x4000)
      throw new Error(`ELF PT_LOAD alignment is below 16 KiB: 0x${load.alignment.toString(16)}`)
  }

  const dynamic = segments.find((row) => row.segmentType === 2)
  if (!dynamic) throw new Error('ELF runtime has no PT_DYNAMIC segment')
  const dynamicWidth = width * 2
  const dynamicRows = []
  for (let offset = dynamic.fileOffset;
    offset + dynamicWidth <= dynamic.fileOffset + dynamic.fileSize;
    offset += dynamicWidth) {
    const tag = unsigned(bytes, offset, width, little, 'ELF dynamic tag')
    const value = unsigned(bytes, offset + width, width, little, 'ELF dynamic value')
    if (tag === 0) break
    dynamicRows.push({ tag, value })
  }
  const strtabAddress = dynamicRows.find((row) => row.tag === 5)?.value
  const strtabSize = dynamicRows.find((row) => row.tag === 10)?.value
  if (strtabAddress == null || strtabSize == null || strtabSize < 1)
    throw new Error('ELF runtime has no bounded dynamic string table')
  const stringLoad = loads.find((row) => strtabAddress >= row.virtualAddress &&
    strtabAddress + strtabSize <= row.virtualAddress + row.fileSize)
  if (!stringLoad) throw new Error('ELF dynamic string table is not file-backed')
  const strtabOffset = stringLoad.fileOffset + strtabAddress - stringLoad.virtualAddress
  const dynamicString = (index, label) => {
    if (index < 0 || index >= strtabSize) throw new Error(`${label} index is outside DT_STRTAB`)
    return cString(bytes, strtabOffset + index, strtabSize - index, label)
  }
  const needed = dynamicRows.filter((row) => row.tag === 1)
    .map((row) => dynamicString(row.value, 'DT_NEEDED'))
  const sonameRows = dynamicRows.filter((row) => row.tag === 14)
  if (sonameRows.length !== 1) throw new Error('ELF runtime must have exactly one DT_SONAME')
  const soname = dynamicString(sonameRows[0].value, 'DT_SONAME')

  let androidApi = null
  for (const note of segments.filter((row) => row.segmentType === 4)) {
    let offset = note.fileOffset
    const end = note.fileOffset + note.fileSize
    while (offset + 12 <= end) {
      const nameSize = unsigned(bytes, offset, 4, little, 'ELF note name size')
      const descriptionSize = unsigned(bytes, offset + 4, 4, little, 'ELF note description size')
      const noteType = unsigned(bytes, offset + 8, 4, little, 'ELF note type')
      offset += 12
      const paddedName = (nameSize + 3) & ~3
      const paddedDescription = (descriptionSize + 3) & ~3
      bounded(bytes, offset, paddedName + paddedDescription, 'ELF note payload')
      const owner = nameSize > 0
        ? bytes.subarray(offset, offset + nameSize).toString('utf8').replace(/\0+$/, '')
        : ''
      offset += paddedName
      if (owner === 'Android' && noteType === 1 && descriptionSize >= 4) {
        androidApi = unsigned(bytes, offset, 4, little, 'Android ELF API level')
      }
      offset += paddedDescription
    }
  }
  if (androidApi == null) throw new Error('ELF runtime has no Android ABI-ident note')
  return { kind: 'elf', elfClass, machine, loads, soname, needed, androidApi }
}

const inspectThinMach = (bytes, offset = 0, size = bytes.length - offset) => {
  bounded(bytes, offset, size, 'Mach-O slice')
  if (size < 32) throw new Error('Mach-O slice is truncated')
  const magicLe = bytes.readUInt32LE(offset)
  if (magicLe !== 0xfeedfacf) throw new Error('Mach-O slice is not 64-bit little-endian')
  const cpuType = bytes.readUInt32LE(offset + 4)
  const fileType = bytes.readUInt32LE(offset + 12)
  const commandCount = bytes.readUInt32LE(offset + 16)
  const commandBytes = bytes.readUInt32LE(offset + 20)
  if (fileType !== 6) throw new Error(`Mach-O runtime is not MH_DYLIB: ${fileType}`)
  if (commandCount > 4096) throw new Error('Mach-O load-command count is unreasonable')
  bounded(bytes, offset + 32, commandBytes, 'Mach-O load commands')
  let commandOffset = offset + 32
  let platform = null
  let installName = null
  const dependencies = []
  for (let index = 0; index < commandCount; index += 1) {
    bounded(bytes, commandOffset, 8, 'Mach-O load command')
    const command = bytes.readUInt32LE(commandOffset)
    const commandSize = bytes.readUInt32LE(commandOffset + 4)
    if (commandSize < 8) throw new Error('Mach-O load command is too small')
    bounded(bytes, commandOffset, commandSize, 'Mach-O load command')
    if (command === 0x32) {
      if (commandSize < 24) throw new Error('LC_BUILD_VERSION is truncated')
      const candidate = bytes.readUInt32LE(commandOffset + 8)
      if (platform != null && platform !== candidate)
        throw new Error('Mach-O slice has contradictory build platforms')
      platform = candidate
    }
    const baseCommand = command & 0x7fffffff
    if ([0xc, 0xd, 0x18, 0x1f, 0x23].includes(baseCommand)) {
      if (commandSize < 24) throw new Error('Mach-O dylib command is truncated')
      const nameOffset = bytes.readUInt32LE(commandOffset + 8)
      if (nameOffset < 24 || nameOffset >= commandSize)
        throw new Error('Mach-O dylib command has an invalid name')
      const name = cString(bytes, commandOffset + nameOffset,
        commandSize - nameOffset, 'Mach-O dylib name')
      if (baseCommand === 0xd) {
        if (installName != null) throw new Error('Mach-O runtime has multiple LC_ID_DYLIB commands')
        installName = name
      } else dependencies.push(name)
    }
    commandOffset += commandSize
  }
  if (platform == null) throw new Error('Mach-O runtime has no LC_BUILD_VERSION platform')
  if (installName == null) throw new Error('Mach-O runtime has no LC_ID_DYLIB')
  return { kind: 'mach', cpuType, platform, installName, dependencies }
}

export const inspectMachRuntimes = (bytes) => {
  if (bytes.length < 8) throw new Error('Mach-O runtime is truncated')
  if (bytes.readUInt32BE(0) !== 0xcafebabe) return [inspectThinMach(bytes)]
  const count = bytes.readUInt32BE(4)
  if (count < 1 || count > 32) throw new Error('Mach-O fat slice count is unreasonable')
  bounded(bytes, 8, count * 20, 'Mach-O fat architecture table')
  const result = []
  for (let index = 0; index < count; index += 1) {
    const row = 8 + index * 20
    const declaredCpu = bytes.readUInt32BE(row)
    const offset = bytes.readUInt32BE(row + 8)
    const size = bytes.readUInt32BE(row + 12)
    const slice = inspectThinMach(bytes, offset, size)
    if (slice.cpuType !== declaredCpu) throw new Error('Mach-O fat table CPU disagrees with slice')
    result.push(slice)
  }
  if (new Set(result.map((row) => row.cpuType)).size !== result.length)
    throw new Error('Mach-O fat runtime repeats an architecture')
  return result
}

export const inspectPeRuntime = (bytes) => {
  if (bytes.length < 0x40 || bytes.subarray(0, 2).toString('ascii') !== 'MZ')
    throw new Error('Runtime is not PE')
  const pe = bytes.readUInt32LE(0x3c)
  bounded(bytes, pe, 24, 'PE header')
  if (!bytes.subarray(pe, pe + 4).equals(Buffer.from('PE\0\0')))
    throw new Error('Runtime has no PE signature')
  const machine = bytes.readUInt16LE(pe + 4)
  const characteristics = bytes.readUInt16LE(pe + 22)
  if ((characteristics & 0x2000) === 0) throw new Error('PE runtime is not a DLL')
  return { kind: 'pe', machine }
}

const expectedAndroid = {
  'android-arm64-v8a': { elfClass: 2, machine: 183 },
  'android-armeabi-v7a': { elfClass: 1, machine: 40 },
  'android-x86': { elfClass: 1, machine: 3 },
  'android-x86_64': { elfClass: 2, machine: 62 },
}
const expectedNeeded = {
  avutil: ['libc.so', 'libm.so'],
  swresample: ['libavutil.so', 'libc.so', 'libm.so'],
  avcodec: ['libavutil.so', 'libc.so', 'libm.so', 'libswresample.so'],
  avformat: ['libavcodec.so', 'libavutil.so', 'libc.so', 'libm.so'],
}
const expectedMach = {
  'darwin-arm64': { cpuTypes: [0x0100000c], platform: 1 },
  'darwin-x64': { cpuTypes: [0x01000007], platform: 1 },
  'ios-arm64': { cpuTypes: [0x0100000c], platform: 2 },
  'ios-simulator-arm64': { cpuTypes: [0x0100000c], platform: 7 },
  'ios-simulator-x64': { cpuTypes: [0x01000007], platform: 7 },
}

export const ffmpegFrameworkName = (component) => {
  if (!ffmpegComponents.includes(component)) throw new Error(`Unknown FFmpeg component: ${component}`)
  return `lib${component}`
}

export const ffmpegFrameworkInstallName = (component) => {
  const name = ffmpegFrameworkName(component)
  return `@rpath/${name}.framework/${name}`
}

export const ffmpegFrameworkDependencies = {
  avutil: [],
  swresample: ['avutil'],
  avcodec: ['swresample', 'avutil'],
  avformat: ['avcodec', 'swresample', 'avutil'],
}

export const ffmpegFrameworkPackagingFormat = 'dynamic-framework-xcframework-v2'
export const ffmpegCanonicalHeaderFormat = 'canonical-namespaced-include-tree-v1'
export const ffmpegFrameworkHeaderSurface = 'runtime-marker-only-v1'

export const ffmpegFrameworkHeaderName = (component) => {
  if (!ffmpegComponents.includes(component)) throw new Error(`Unknown FFmpeg component: ${component}`)
  return `SingzFfmpeg${component[0].toUpperCase()}${component.slice(1)}Runtime.h`
}

// FFmpeg's public tree contains conventional names such as time.h. Putting
// those files directly in Framework/Headers makes Xcode's framework header
// search shadow libc headers in every dependent CocoaPods target. The product
// API headers therefore stay exclusively in the canonical, namespaced
// include/libav* tree selected into RNAudioAPI's explicit include_ffmpeg
// search path. A framework exports only this inert marker so it remains a
// valid Clang framework module without creating a second public API tree.
export const ffmpegFrameworkHeaderContents = (component) => {
  if (!ffmpegComponents.includes(component)) throw new Error(`Unknown FFmpeg component: ${component}`)
  const guard = `SINGZ_FFMPEG_${component.toUpperCase()}_RUNTIME_H`
  return `#ifndef ${guard}\n#define ${guard}\n\n#define SINGZ_FFMPEG_${component.toUpperCase()}_DYNAMIC_FRAMEWORK 1\n\n#endif\n`
}

export const ffmpegFrameworkModuleMap = (component) => {
  const name = ffmpegFrameworkName(component)
  return `framework module ${name} {\n  umbrella header "${ffmpegFrameworkHeaderName(component)}"\n  export *\n}\n`
}

// The source slice packs deliberately retain FFmpeg's conventional
// @rpath/libav*.N.dylib identities. CocoaPods cannot embed those raw dynamic
// library XCFrameworks into SingZ's otherwise-static Pods graph, so the iOS
// composer wraps each slice in a real framework and rewrites this complete
// inter-component closure. Validate that transformed shape separately rather
// than weakening the source-pack policy above.
export const validateFfmpegFrameworkBytes = ({
  bytes, target, component, profile: _profile, path = '',
}) => {
  if (!ffmpegComponents.includes(component)) throw new Error(`Unknown FFmpeg component: ${component}`)
  const mach = expectedMach[target]
  const slices = inspectMachRuntimes(bytes)
  if (mach) {
    const cpuTypes = slices.map((row) => row.cpuType).sort((a, b) => a - b)
    if (JSON.stringify(cpuTypes) !== JSON.stringify([...mach.cpuTypes].sort((a, b) => a - b)) ||
        slices.some((row) => row.platform !== mach.platform))
      throw new Error(`${target} ${component} framework has the wrong Mach-O architecture/platform`)
  } else if (target === 'ios-simulator-universal') {
    const cpuTypes = slices.map((row) => row.cpuType).sort((a, b) => a - b)
    if (JSON.stringify(cpuTypes) !== JSON.stringify([0x01000007, 0x0100000c]) ||
        slices.some((row) => row.platform !== 7))
      throw new Error(`${component} universal simulator framework has the wrong slices/platform`)
  } else {
    throw new Error(`No iOS framework binary policy for FFmpeg target: ${target}`)
  }

  const installName = ffmpegFrameworkInstallName(component)
  if (slices.some((row) => row.installName !== installName))
    throw new Error(`${target} ${component} framework has the wrong Mach-O install name${path ? `: ${path}` : ''}`)
  const expectedDependencies = ffmpegFrameworkDependencies[component]
    .map(ffmpegFrameworkInstallName)
    .sort()
  for (const slice of slices) {
    const actualDependencies = slice.dependencies
      .filter((dependency) => dependency.startsWith('@rpath/'))
      .sort()
    if (JSON.stringify(actualDependencies) !== JSON.stringify(expectedDependencies)) {
      throw new Error(
        `${target} ${component} framework has forbidden or missing @rpath dependencies: ` +
        actualDependencies.join(', '),
      )
    }
  }
  return slices
}

export const validateFfmpegRuntimeBytes = ({ bytes, target, component, profile, path = '' }) => {
  if (!ffmpegComponents.includes(component)) throw new Error(`Unknown FFmpeg component: ${component}`)
  const android = expectedAndroid[target]
  if (android) {
    const inspected = inspectElfRuntime(bytes)
    if (inspected.elfClass !== android.elfClass || inspected.machine !== android.machine)
      throw new Error(`${target} ${component} has the wrong ELF class/machine`)
    if (inspected.androidApi !== 21)
      throw new Error(`${target} ${component} has Android API ${inspected.androidApi}, expected 21`)
    const expectedSoname = `lib${component}.so`
    if (inspected.soname !== expectedSoname)
      throw new Error(`${target} ${component} SONAME is ${inspected.soname}, expected ${expectedSoname}`)
    const actualNeeded = [...inspected.needed].sort()
    if (JSON.stringify(actualNeeded) !== JSON.stringify(expectedNeeded[component]))
      throw new Error(`${target} ${component} has forbidden or missing DT_NEEDED entries: ${actualNeeded.join(', ')}`)
    return inspected
  }
  const mach = expectedMach[target]
  if (mach) {
    const slices = inspectMachRuntimes(bytes)
    const cpuTypes = slices.map((row) => row.cpuType).sort((a, b) => a - b)
    if (JSON.stringify(cpuTypes) !== JSON.stringify([...mach.cpuTypes].sort((a, b) => a - b)) ||
        slices.some((row) => row.platform !== mach.platform))
      throw new Error(`${target} ${component} has the wrong Mach-O architecture/platform`)
    const installName = `@rpath/lib${component}.${profile.abiMajors[component]}.dylib`
    if (slices.some((row) => row.installName !== installName))
      throw new Error(`${target} ${component} has the wrong Mach-O install name`)
    return slices
  }
  if (target === 'ios-simulator-universal') {
    const slices = inspectMachRuntimes(bytes)
    const cpuTypes = slices.map((row) => row.cpuType).sort((a, b) => a - b)
    if (JSON.stringify(cpuTypes) !== JSON.stringify([0x01000007, 0x0100000c]) ||
        slices.some((row) => row.platform !== 7))
      throw new Error(`${component} universal simulator runtime has the wrong slices/platform`)
    const installName = `@rpath/lib${component}.${profile.abiMajors[component]}.dylib`
    if (slices.some((row) => row.installName !== installName))
      throw new Error(`${component} universal simulator runtime has the wrong install name`)
    return slices
  }
  if (target === 'win32-x64') {
    const inspected = inspectPeRuntime(bytes)
    if (inspected.machine !== 0x8664)
      throw new Error(`win32-x64 ${component} PE machine is not AMD64`)
    const expectedName = `${component}-${profile.abiMajors[component]}.dll`
    if (path && basename(path).toLowerCase() !== expectedName)
      throw new Error(`win32-x64 ${component} runtime name is not ${expectedName}`)
    return inspected
  }
  throw new Error(`No binary policy for FFmpeg target: ${target}`)
}
