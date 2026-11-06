import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('attaches renderer failure logging before either development or packaged navigation', () => {
  const source = readFileSync(resolve('src/main/index.ts'), 'utf8')
  const create = source.indexOf('const win = new BrowserWindow(')
  const attach = source.indexOf('attachRendererLogs(win.webContents)', create)
  expect(create).toBeGreaterThan(-1)
  expect(attach).toBeGreaterThan(create)
  for (const navigation of ['win.loadURL(', 'win.loadFile(']) {
    const load = source.indexOf(navigation, create)
    expect(load).toBeGreaterThan(attach)
  }
  // The production callback must use the formatter covered against real hit
  // and miss batches, rather than retaining the ambiguous inline log label.
  expect(source).toContain("onBatch: batch => log('dsp', describeLaneMeasureBatch(batch))")
  expect(source).not.toContain('lanes measured · cache')
})
