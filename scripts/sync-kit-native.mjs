/*
 * Vendor the mobile-safe @singz/ui build artifacts for Metro.
 *
 * SingZ installs the UI kit from a GitHub tag at the repository root, while
 * the React Native app has an independent dependency graph. Keeping the
 * compiled native entry here makes feature branches and CI reproducible
 * before a new kit tag is published. The kit repository remains the source
 * of truth; never edit mobile/src/ui/uikit by hand.
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const KIT_ROOT = resolve(process.env.SINGZ_UI_DIR ?? join(ROOT, '..', 'singz-ui'))
const SOURCE = join(KIT_ROOT, 'dist')
const TARGET = join(ROOT, 'mobile', 'src', 'ui', 'uikit')
const FILES = [
  'native/components.d.ts',
  'native/components.js',
  'native/index.d.ts',
  'native/index.js',
  'native/theme.d.ts',
  'native/theme.js',
  'tokens/stems.d.ts',
  'tokens/stems.js',
  'tokens/tokens.d.ts',
  'tokens/tokens.js'
]

const packageJson = JSON.parse(await readFile(join(KIT_ROOT, 'package.json'), 'utf8'))
await rm(TARGET, { recursive: true, force: true })
for (const relative of FILES) {
  const destination = join(TARGET, relative)
  await mkdir(dirname(destination), { recursive: true })
  await cp(join(SOURCE, relative), destination)
}
await writeFile(join(TARGET, 'README.md'), `# Vendored @singz/ui native entry\n\nGenerated from @singz/ui ${packageJson.version}. Do not edit these artifacts by hand.\n\nRegenerate after building the kit:\n\n\`\`\`bash\nSINGZ_UI_DIR=/path/to/singz-ui node scripts/sync-kit-native.mjs\n\`\`\`\n`)
console.log(`vendored @singz/ui ${packageJson.version} native entry from ${KIT_ROOT}`)
