import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const safeRelative = (path) =>
  typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
  !path.includes('\\') && !path.split('/').includes('..')

const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

export const walkRegularFiles = (root) => {
  const rootEntry = lstatSync(root)
  if (!rootEntry.isDirectory() || rootEntry.isSymbolicLink())
    throw new Error('Pack root must be a real directory, not a symlink or special entry')
  const files = []
  const walk = (directory, prefix = '') => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path, relative)
      else if (entry.isFile()) files.push(relative)
      else throw new Error(`Pack contains unsupported filesystem entry: ${relative}`)
    }
  }
  walk(root)
  return files.sort((left, right) => left.localeCompare(right))
}

export const assertExactManifestTree = ({
  root,
  rows,
  allowedRootFiles = [],
  label = 'Pack',
}) => {
  if (!Array.isArray(rows)) throw new Error(`${label} manifest file rows are missing`)
  const declared = new Set()
  for (const row of rows) {
    if (!safeRelative(row?.path) || declared.has(row.path) ||
        !Number.isSafeInteger(row.bytes) || row.bytes < 0 ||
        typeof row.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(row.sha256))
      throw new Error(`${label} has a malformed or duplicate file row`)
    if (allowedRootFiles.includes(row.path))
      throw new Error(`${label} manifest must not declare its allowed root metadata file: ${row.path}`)
    declared.add(row.path)
    const path = join(root, row.path)
    if (!existsSync(path) || !statSync(path).isFile() ||
        statSync(path).size !== row.bytes || sha256(path) !== row.sha256)
      throw new Error(`${label} file changed after publication: ${row.path}`)
  }
  const expected = [...declared, ...allowedRootFiles].sort((left, right) => left.localeCompare(right))
  const actual = walkRegularFiles(root)
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    const expectedSet = new Set(expected)
    const actualSet = new Set(actual)
    const extras = actual.filter((path) => !expectedSet.has(path))
    const missing = expected.filter((path) => !actualSet.has(path))
    throw new Error(
      `${label} actual file set differs from its manifest` +
      `${extras.length > 0 ? `; undeclared: ${extras.join(', ')}` : ''}` +
      `${missing.length > 0 ? `; missing: ${missing.join(', ')}` : ''}`,
    )
  }
}

export const assertExactSelectionTree = ({ root, rows, destinationPrefix, label }) => {
  if (!Array.isArray(rows) || rows.length === 0)
    throw new Error(`${label} selection rows are missing`)
  const prefix = `${destinationPrefix}/`
  const projected = rows.map((row) => {
    if (typeof row?.destination !== 'string' || !row.destination.startsWith(prefix))
      throw new Error(`${label} selection escapes its staged destination`)
    return { ...row, path: row.destination.slice(prefix.length) }
  })
  assertExactManifestTree({ root, rows: projected, label })
}
