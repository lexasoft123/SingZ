import { describe, expect, it } from 'vitest'
import { friendlyError } from '../../src/main/separation'

// Real stderr tails from field logs. The 2026-08-12 5800H+RTX 3060 log only
// classified because "DmlExecutionProvider" happened to appear in a C++
// source path — these pin the intended matches so ordering stays deliberate.
describe('friendlyError', () => {
  it('names the hung-and-reset GPU (TDR), not device-removed', () => {
    // 887A0006 with the DXGI message mojibake'd by the Russian locale, and
    // DmlExecutionProvider present only as a file path further up the tail.
    const tail = [
      "Status Message: E:\\_work\\1\\s\\onnxruntime\\core\\providers\\dml\\DmlExecutionProvider\\src\\DmlGraphFusionHelper.cpp(1078)",
      'Exception(2) tid(1df4) 887A0006 \uFFFD\uFFFD\uFFFD\uFFFD\uFFFD\uFFFD',
      "UnicodeDecodeError: 'utf-8' codec can't decode byte 0xc3 in position 360: invalid continuation byte"
    ].join('\n')
    expect(friendlyError(tail)).toContain('stopped responding')
  })

  it('keeps device-removed for 887A0005', () => {
    expect(friendlyError('Exception 887A0005 device removed')).toContain('GPU device removed')
  })

  it('keeps GPU out-of-memory for 8007000E', () => {
    expect(friendlyError('Exception 8007000E Not enough memory resources')).toContain(
      'ran out of memory'
    )
  })
})
