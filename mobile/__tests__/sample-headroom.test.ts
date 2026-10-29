const { sampleGains } = require('../scripts/sample-headroom.cjs')

test('every mute/solo combination stays below -1 dBFS, including cancellation in the full mix', () => {
  const buffers = [[1, 0.1, -0.7], [-1, 0.8, 0.4], [0.2, -0.2, 0.9]]
  const gains = sampleGains(buffers)
  for (let mask = 1; mask < 1 << buffers.length; mask++) {
    for (let i = 0; i < buffers[0].length; i++) {
      const sum = buffers.reduce((mix, stem, n) => mix + (mask & (1 << n) ? Math.round(stem[i] * gains[n] * 32767) / 32767 : 0), 0)
      expect(Math.abs(sum)).toBeLessThanOrEqual(10 ** (-1 / 20))
    }
  }
  expect(gains[0] / gains[1]).toBeCloseTo(1)
  expect(gains[2] / gains[0]).toBeCloseTo(1 / 0.9)
})

test('silent stems stay finite and silent', () => {
  expect(sampleGains([[0, 0], [0, 0]])).toEqual([1, 1])
})
