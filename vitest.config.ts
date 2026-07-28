import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Main-process modules import electron for call-time paths only, so unit
// tests run under plain node with a stub in its place.
export default defineConfig({
  resolve: {
    alias: { electron: resolve(__dirname, 'tests/unit/electron-stub.ts') }
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000
  }
})
