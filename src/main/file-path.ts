import { resolve, win32 } from 'node:path'
import { ordinaryWindowsPath } from '../shared/windows-path'
export class FilePathError extends Error {
  constructor(public readonly code: 'path-too-long' | 'invalid-path', message: string) { super(message) }
}
/** UI/persistence/authorization identity excludes the Windows IO namespace. */
export function canonicalFilePath(path: string, platform = process.platform, cwd = process.cwd()): string {
  return platform === 'win32' ? win32.resolve(cwd, ordinaryWindowsPath(path)) : resolve(path)
}
/** Pass only these paths to native/Node IO; never persist them as project ids. */
export function nativeFilePath(path: string, platform = process.platform, cwd = process.cwd()): string {
  if (!path || path.includes('\0')) throw new FilePathError('invalid-path', 'Invalid file path')
  if (platform !== 'win32') return path
  const ordinary = ordinaryWindowsPath(path)
  if (ordinary.startsWith('\\\\.\\') || ordinary.startsWith('\\\\?\\')) throw new FilePathError('invalid-path', 'Unsupported device path')
  const full = canonicalFilePath(path, platform, cwd), namespaced = win32.toNamespacedPath(full)
  if (namespaced.length >= 32767) throw new FilePathError('path-too-long', 'File path exceeds the Windows 32767-character limit')
  if (full.split('\\').some(part => part.length > 255)) throw new FilePathError('invalid-path', 'File path component exceeds the filesystem limit')
  return namespaced
}
