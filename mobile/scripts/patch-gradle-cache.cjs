#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')

const upstreamPrebuiltTask = String.raw`task downloadPrebuiltBinaries(type: Exec) {
  def isWindows = Os.isFamily(Os.FAMILY_WINDOWS)
  if (isWindows) {
    commandLine 'C:\\Program Files\\Git\\usr\\bin\\bash.exe', '../scripts/download-prebuilt-binaries.sh', 'android', isFFmpegDisabled() ? 'skipffmpeg' : ''
  } else {
    commandLine 'chmod', '+x', '../scripts/download-prebuilt-binaries.sh'
    commandLine 'bash', '../scripts/download-prebuilt-binaries.sh', 'android', isFFmpegDisabled() ? 'skipffmpeg' : ''
  }
  environment 'DISABLE_AUDIOAPI_STATIC_EXTERNAL_LIBS', isStaticExternalLibsDisabled() ? '1' : '0'
}`
const cachedPrebuiltTask = `task downloadPrebuiltBinaries(type: Exec) {
  // SingZ: use the same validated Android-only ZIP cache as bootstrap and CI.
  // Keep the dependency edge and runtime checks; never fetch unrelated macOS libraries.
  commandLine('node', rootProject.file('../../scripts/restore-audio-api-prebuilts.cjs').absolutePath, 'android', isFFmpegDisabled() ? 'skipffmpeg' : '')
  environment 'DISABLE_AUDIOAPI_STATIC_EXTERNAL_LIBS', isStaticExternalLibsDisabled() ? '1' : '0'
}`

// Configuration-time Groovy.execute() bypasses Gradle's configuration-cache
// input tracking. Replace only the pinned upstream shapes with providers.exec,
// whose outputs/exit status are checked again before a cached graph is reused.
const edits = [
  {
    file: 'node_modules/@shopify/react-native-skia/android/build.gradle',
    replacements: [
      ['static def resolveNodePackage(packageName, baseDir) {', '// SingZ: providers.exec needs the project provider factory.\ndef resolveNodePackage(packageName, baseDir) {'],
      [
        '  def proc = ["node", "-e", script].execute(null, baseDir)\n  proc.waitFor()\n  if (proc.exitValue() != 0) {',
        '  // SingZ: tracked configuration input, not an untracked Groovy process.\n  def proc = providers.exec {\n    workingDir(baseDir)\n    commandLine("node", "-e", script)\n    ignoreExitValue = true\n  }\n  if (proc.result.get().exitValue != 0) {',
      ],
      ['+ proc.err.text', '+ proc.standardError.asText.get()'],
      ['  return proc.text.trim()', '  return proc.standardOutput.asText.get().trim()'],
    ],
  },
  {
    file: 'node_modules/react-native-audio-api/android/build.gradle',
    replacements: [
      [upstreamPrebuiltTask, cachedPrebuiltTask],
      [
        '  def reactNativePackage = file(["node", "--print", "require.resolve(\'react-native/package.json\')"].execute(null, rootDir).text.trim())',
        '  // SingZ: resolve through Gradle so configuration-cache inputs are tracked.\n  def reactNativeResolver = providers.exec {\n    workingDir(rootDir)\n    commandLine("node", "--print", "require.resolve(\'react-native/package.json\')")\n  }\n  def reactNativePackage = file(reactNativeResolver.standardOutput.asText.get().trim())',
      ],
      [
        '    def process = ["node", validationScript.absolutePath].execute()\n    process.waitForProcessOutput(System.out, System.err)\n    def exitCode = process.exitValue()',
        '    // SingZ: preserve validation output and nonzero handling while tracking the process.\n    def validation = providers.exec {\n      workingDir(rootDir)\n      commandLine("node", validationScript.absolutePath)\n      ignoreExitValue = true\n    }\n    def exitCode = validation.result.get().exitValue\n    def validationOutput = validation.standardOutput.asText.get()\n    def validationErrors = validation.standardError.asText.get()\n    if (validationOutput) System.out.print(validationOutput)\n    if (validationErrors) System.err.print(validationErrors)',
      ],
    ],
  },
]

function applyReplacement(source, before, after, file) {
  const beforeCount = source.split(before).length - 1
  const afterCount = source.split(after).length - 1
  if (beforeCount === 0 && afterCount === 1) return source
  if (beforeCount !== 1 || afterCount !== 0)
    throw new Error(`Gradle cache patch: upstream changed ${file}; expected one known original or patched shape. Re-check configuration-cache compatibility before updating the patch.`)
  return source.replace(before, after)
}

function patchGradleCaches(mobileRoot) {
  // Validate every target first so upstream drift never leaves a half-applied
  // dependency set. Re-running does not rewrite already-patched Gradle files.
  const plans = edits.map(({ file, replacements }) => {
    const filename = path.join(mobileRoot, file)
    const original = fs.readFileSync(filename, 'utf8')
    let patched = original.replace(/\r\n/g, '\n')
    for (const [before, after] of replacements)
      patched = applyReplacement(patched, before, after, file)
    return { filename, original, patched }
  })
  let changed = 0
  for (const plan of plans) {
    if (plan.original === plan.patched) continue
    fs.writeFileSync(plan.filename, plan.patched)
    ++changed
  }
  return changed
}

module.exports = { patchGradleCaches }

if (require.main === module) {
  try {
    const changed = patchGradleCaches(path.resolve(__dirname, '..'))
    console.log(`Gradle cache patches: ${changed ? `updated ${changed} dependency file(s)` : 'already applied'}`)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
