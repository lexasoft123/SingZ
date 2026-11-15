/** Namespace prefixes are IO syntax, never a different project identity. */
export function ordinaryWindowsPath(path: string): string {
  const prefix = path.slice(0, 8).replaceAll('/', '\\').toUpperCase()
  if (prefix === '\\\\?\\UNC\\') return '\\\\' + path.slice(8)
  if (/^\\\\\?\\[a-z]:[\\/]/i.test(path)) return path.slice(4)
  return path
}
/** UTF-16 code units, including the namespace required at the IO boundary. */
export function windowsPathTooLong(path: string): boolean {
  const plain = ordinaryWindowsPath(path)
  return plain.length + (plain.startsWith('\\\\') ? 6 : 4) >= 32767
}
