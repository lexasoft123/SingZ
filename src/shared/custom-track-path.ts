/** Project metadata uses portable paths, including older Windows saves. */
export function customTrackPath(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const file = value.replace(/\\/g, '/')
  // One ordinary filename in stems/. Never normalize away traversal segments
  // or accept absolute paths, nested folders, NULs, or Windows stream names.
  const match = /^stems\/([^/:\0]+)$/.exec(file)
  if (!match || match[1] === '.' || match[1] === '..') return null
  return file
}
