import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
// A Windows checkout can be CRLF; the multi-line toContain assertions embed
// bare \n, so normalize every read.
const read = (path: string): string =>
  readFileSync(resolve(root, path), 'utf8').replaceAll('\r\n', '\n')

describe('Windows Electron capture addon build', () => {
  it('delay-loads node.exe and resolves imports from the actual host process', () => {
    const cmake = read('CMakeLists.txt')
    const hook = read('native/electron/win_delay_load_hook.cc')

    expect(cmake).toContain('target_sources(singz_capture PRIVATE\n      native/electron/win_delay_load_hook.cc)')
    expect(cmake).toContain('target_link_options(singz_capture PRIVATE "/DELAYLOAD:node.exe")')
    expect(cmake).toContain('delayimp')
    expect(hook).toContain('GetModuleHandleW(nullptr)')
    expect(hook).toContain('__pfnDliNotifyHook2 = loadHostBinary')
  })

  it('retires capture on renderer crash and main-document navigation', () => {
    const main = read('src/main/index.ts')
    expect(main).toContain("e.sender.on('render-process-gone', gone)")
    expect(main).toContain("e.sender.on('did-start-navigation'")
    expect(main).toContain('if (isMainFrame) gone()')
  })

  it('keeps only the latest scalar window instead of a deep TSFN FIFO', () => {
    const addon = read('native/electron/capture_addon.cpp')
    expect(addon).toContain('std::atomic<AnalysisWindow*> latest')
    expect(addon).toContain('name, 1, 1,')
    expect(addon).toContain('overwrittenWindows')
    expect(addon).not.toContain('name, 64, 1,')
  })
})
