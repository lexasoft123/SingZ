import { syncFrameCallbackVisibility } from '../src/ui/frame-visibility'

test('hidden player suspends its frame callback and resets timing before resume', () => {
  const order: string[] = []
  const callback = { setActive: jest.fn((active: boolean) => order.push(`active:${active}`)) }
  const reset = jest.fn(() => order.push('reset'))

  syncFrameCallbackVisibility(callback, false, reset)
  expect(order).toEqual(['active:false'])
  expect(reset).not.toHaveBeenCalled()

  syncFrameCallbackVisibility(callback, true, reset)
  expect(order).toEqual(['active:false', 'reset', 'active:true'])

  syncFrameCallbackVisibility(callback, false, reset)
  expect(callback.setActive).toHaveBeenLastCalledWith(false)
  expect(reset).toHaveBeenCalledTimes(1)
})
