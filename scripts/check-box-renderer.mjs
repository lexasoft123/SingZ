import { access, readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktopHtml = resolve(root, 'out/renderer/index.html')
const boxHtml = resolve(root, 'out/renderer/box/box.html')
const [desktop, box] = await Promise.all([
  readFile(desktopHtml, 'utf8'),
  readFile(boxHtml, 'utf8')
])
if (!desktop.includes('./assets/')) throw new Error('Desktop renderer entry is missing from out/renderer/index.html.')
if (!box.includes('./assets/')) throw new Error('Box renderer entry is missing from out/renderer/box/box.html.')

const references = [...box.matchAll(/(?:src|href)="(\.\/[^\"]+)"/g)].map(match => match[1])
if (references.length === 0) throw new Error('Box renderer has no local assets.')
for (const reference of references) {
  if (reference.includes('..')) throw new Error(`Box renderer escapes its isolated asset subtree: ${reference}`)
  await access(resolve(root, 'out/renderer/box', reference))
}
console.log(`Box renderer: isolated HTML and ${references.length} packaged asset references verified.`)
