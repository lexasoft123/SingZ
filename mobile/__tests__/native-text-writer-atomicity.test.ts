import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(__dirname, '..')
const read = (relative: string): string => readFileSync(join(root, relative), 'utf8')

describe('native atomic text writers', () => {
  test('Android deletes only its failed temporary file', () => {
    const source = read('android/app/src/main/java/com/singzplayer/FolderAccessModule.kt')
    const start = source.indexOf('fun writeText(project: String, file: String, text: String, promise: Promise)')
    const end = source.indexOf('/**\n   * Move a file', start)
    const writer = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(writer).toContain('val part = File(out.path + ".part")')
    expect(writer).toContain('if (!part.renameTo(out)) throw Exception("Cannot write $file")')
    expect(writer).toMatch(/catch \(e: Exception\) \{\s*tmp\?\.delete\(\)\s*promise\.reject/)
    expect(writer).not.toMatch(/catch \(e: Exception\)[\s\S]*out\.delete\(\)/)
  })

  test('iOS deletes only its failed temporary file', () => {
    const source = read('ios/FolderAccess/FolderAccess.swift')
    const start = source.indexOf('@objc func writeText(')
    const end = source.indexOf('@objc func moveIntoProject(', start)
    const writer = source.slice(start, end)

    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(writer).toContain('let tmp = URL(fileURLWithPath: out.path + ".part")')
    expect(writer).toContain('try self.install(tmp, at: out)')
    expect(writer).toMatch(/catch \{\s*try\? self\.fm\.removeItem\(at: tmp\)\s*reject\("write"/)
    expect(writer).not.toMatch(/catch \{[\s\S]*removeItem\(at: out\)/)
  })
})
