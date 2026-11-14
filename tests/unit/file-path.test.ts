import { describe, expect, it } from 'vitest'
import { win32 } from 'node:path'
import { canonicalFilePath, nativeFilePath } from '../../src/main/file-path'
import { ordinaryWindowsPath, windowsPathTooLong } from '../../src/shared/windows-path'
describe('Windows file IO and stable project identities', () => {
  it.each(['C:\\Users\\Singer\\OneDrive\\Projects\\Song\\stems\\vocals.wav','\\\\server\\share\\Song\\stems\\vocals.flac'])('round-trips ordinary and namespaced %s', path => {
    const io=nativeFilePath(path,'win32','C:\\base')
    expect(io).toBe(win32.toNamespacedPath(path))
    expect(canonicalFilePath(io,'win32','C:\\base')).toBe(canonicalFilePath(path,'win32','C:\\base'))
    expect(ordinaryWindowsPath(io)).toBe(path)
    expect(nativeFilePath(io,'win32','C:\\base')).toBe(io)
    expect(win32.basename(io)).toBe(win32.basename(path))
  })
  it('accepts a 300-character directory rejected by the historical MAX_PATH rule', () => {
    const dir=win32.join('C:\\','p'.repeat(100),'q'.repeat(100),'r'.repeat(100)), path=win32.join(dir,'vocals.wav')
    expect(dir.length).toBeGreaterThan(300)
    expect(windowsPathTooLong(path)).toBe(false)
    expect(nativeFilePath(path,'win32','C:\\')).toBe('\\\\?\\'+path)
    const oldNarrowOpen=(p:string):boolean=>p.length<260
    expect(oldNarrowOpen(path)).toBe(false)
  })
  it('uses UTF-16 units instead of a 32-KiB UTF-8 budget, with typed errors only for the extended limit', () => {
    const path='C:\\'+('歌'.repeat(200)+'\\').repeat(100)+'vocals.wav'
    expect(Buffer.byteLength(path)).toBeGreaterThan(32768)
    expect(nativeFilePath(path,'win32','C:\\').length).toBeLessThan(32767)
    expect(()=>nativeFilePath('C:\\'+('p'.repeat(200)+'\\').repeat(164),'win32','C:\\')).toThrowError(expect.objectContaining({code:'path-too-long'}))
    expect(()=>nativeFilePath('C:\\'+'p'.repeat(256),'win32','C:\\')).toThrowError(expect.objectContaining({code:'invalid-path'}))
  })
})
