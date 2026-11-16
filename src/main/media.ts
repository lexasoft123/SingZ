import { app } from 'electron'
import { join, sep } from 'node:path'
import { canonicalFilePath } from './file-path'
// Only files the renderer explicitly registered (dropped/picked songs) or files
// under the stems cache can be read through the media:read IPC channel.
const allowedFiles = new Set<string>()
const allowedRoots: string[] = []

export function stemsRoot(): string {
  return join(app.getPath('userData'), 'stems')
}

export function allowFile(path: string): void {
  allowedFiles.add(canonicalFilePath(path))
}

export function allowRoot(dir: string): void {
  const full = canonicalFilePath(dir)
  // every project open registers its folder, so re-opening must not grow the list
  if (!allowedRoots.includes(full)) allowedRoots.push(full)
}

export function isAllowed(path: string): boolean {
  const full = canonicalFilePath(path)
  if (allowedFiles.has(full)) return true
  return allowedRoots.some((root) => full === root || full.startsWith(root.endsWith(sep) ? root : root + sep))
}
