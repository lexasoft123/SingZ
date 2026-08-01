import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Main-process modules import electron for call-time paths only, so unit
// tests run under plain node with a stub in its place. The round-trip suite
// additionally runs the PHONE's modules in the same process — real desktop
// writer, real mobile reader, one fake Drive between them — which is what the
// react-native aliases are for; nothing under tests/unit imports them.
export default defineConfig({
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests/unit/electron-stub.ts'),
      'react-native-audio-api': resolve(__dirname, 'tests/shared/audio-api-stub.ts'),
      'react-native': resolve(__dirname, 'tests/shared/react-native-stub.ts')
    }
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/roundtrip/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
    // every file shares the one stubbed userData, so they take turns with
    // settings.json (which is where the projects root is switched)
    fileParallelism: false
  }
})
