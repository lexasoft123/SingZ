/**
 * A song identity that survives restarts (the per-launch load token does not):
 * the project's full directory path for a project, else the source path, hashed
 * to a slug that is safe as a directory name. Projects carry no id of their own
 * (project.json has none), so renaming or moving a project folder starts it with
 * no takes; two folders with the same name in different parents stay distinct.
 */
export function stableVoiceSongId(src: { path: string; projectDir: string | null }): string {
  // Windows paths (drive letter or UNC) are case-insensitive: lowercase them
  // whole. POSIX paths keep their case.
  const norm = (p: string): string => {
    const win = /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p)
    const flat = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/(.)\/+$/, '$1')
    return win ? flat.toLowerCase() : flat
  }
  const key = src.projectDir ? `project:${norm(src.projectDir)}` : `file:${norm(src.path)}`
  // FNV-1a, two 32-bit lanes with different multipliers: 64 bits, no crypto needed.
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0
  }
  return `song-${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`
}
