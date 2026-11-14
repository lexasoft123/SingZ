import * as fs from 'node:fs'
import * as path from 'node:path'
import { PRODUCT_IDENTITIES } from '../shared/product-identity'

export interface ProfileFileSystem {
  readdirSync(directory: string): string[]
  statSync(directory: string): Pick<fs.Stats, 'dev' | 'ino' | 'isDirectory'>
  lstatSync(directory: string): Pick<fs.Stats, 'isSymbolicLink'>
  realpathSync(directory: string): string
  renameSync(from: string, to: string): void
}

/** Runs before main services or Chromium sessions can open the profile. */
export function migrateDesktopProfile(appData: string, options: {
  fs?: ProfileFileSystem
  path?: Pick<typeof path, 'join'>
  warn?: (message: string) => void
} = {}): string {
  const io = options.fs ?? fs
  const paths = options.path ?? path
  const warn = options.warn ?? console.warn
  const canonical = paths.join(appData, PRODUCT_IDENTITIES.desktop.profileDir)
  const legacy = paths.join(appData, 'singz')
  let legacyExists = false
  let canonicalExists = false
  const stat = (directory: string): ReturnType<ProfileFileSystem['statSync']> | undefined => {
    try {
      return io.statSync(directory)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  try {
    const old = stat(legacy)
    if (!old?.isDirectory()) return canonical
    legacyExists = true
    const current = stat(canonical)
    canonicalExists = Boolean(current)
    // On case-insensitive volumes both paths can open the SAME directory.
    // Neither spelling nor realpath alone proves two directories are distinct.
    if (current && (io.realpathSync(legacy) === io.realpathSync(canonical) ||
      (old.ino !== 0 && old.dev === current.dev && old.ino === current.ino))) return canonical

    const names = io.readdirSync(appData)
    if (!names.includes('singz')) return canonical
    if (current || names.includes(PRODUCT_IDENTITIES.desktop.profileDir)) {
      warn(`Both desktop profiles exist; using ${canonical}. Legacy profile left untouched: ${legacy}`)
      return canonical
    }
    // Do not move an alias to user-managed storage outside appData.
    if (io.lstatSync(legacy).isSymbolicLink()) {
      warn(`Legacy desktop profile is a symbolic link; continuing with ${legacy} without migration`)
      return legacy
    }
    io.renameSync(legacy, canonical)
    return canonical
  } catch (error) {
    let selected = canonicalExists || !legacyExists ? canonical : legacy
    // Another launch may have completed the rename before this one failed.
    // Never recreate an empty legacy profile after its data moved successfully.
    try {
      if (stat(canonical)?.isDirectory()) selected = canonical
      else if (stat(legacy)?.isDirectory()) selected = legacy
    } catch { /* Keep the last known existing path if inspection is denied. */ }
    warn(`Could not migrate desktop profile ${legacy} to ${canonical}; continuing with ${selected}: ${String(error)}`)
    return selected
  }
}
