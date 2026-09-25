import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Main-process modules import electron for call-time paths only, so unit
// tests run under plain node with a stub in its place. The round-trip suite
// additionally runs the PHONE's modules in the same process — real desktop
// writer, real mobile reader, one fake Drive between them — which is what the
// react-native aliases are for; nothing under tests/unit imports them.
export default defineConfig({
  // The round-trip suite transforms files from BOTH roots, and
  // mobile/tsconfig.json extends @react-native/typescript-config — a package
  // that exists only once mobile's deps are installed. CI installs the desktop
  // root alone, so the lookup threw TSConfckParseError and the two suites that
  // reach into mobile/src failed there while passing on a dev machine. A
  // STRING tsconfigRaw is the one form Vite reads as "do not look for a
  // tsconfig at all" (an object still triggers the lookup, then merges); the
  // values below are what every tsconfig in this repo already agrees on, so
  // the transform is unchanged.
  // "jsx" is part of that agreement and was missing: without it esbuild falls
  // back to the classic transform, so a component under test compiled to
  // React.createElement and threw "React is not defined" unless it happened
  // to import React by name. The app builds with the automatic runtime.
  esbuild: { tsconfigRaw: '{"compilerOptions":{"target":"ES2022","useDefineForClassFields":true,"jsx":"react-jsx"}}' },
  resolve: {
    alias: {
      electron: resolve(__dirname, 'tests/unit/electron-stub.ts'),
      'react-native-audio-api': resolve(__dirname, 'tests/shared/audio-api-stub.ts'),
      'react-native': resolve(__dirname, 'tests/shared/react-native-stub.ts')
    }
  },
  test: {
    // {ts,tsx} because .ts alone silently collects nothing for a component
    // suite someone writes as .tsx: it passes when named on the command line
    // and never runs under `npm test`, which is the quietest way to lose a
    // test. No .tsx suite exists today — this is the guard, not a fix.
    include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/roundtrip/**/*.test.{ts,tsx}'],
    environment: 'node',
    testTimeout: 30000,
    // A fresh stubbed userData for each run (see the file), never one per
    // machine: a fixed one under tmpdir() let two runs at once — two
    // worktrees, two sessions — fail each other.
    globalSetup: ['tests/unit/global-setup.ts'],
    // every file in a run shares that one userData, so they take turns with
    // settings.json (which is where the projects root is switched)
    fileParallelism: false
  }
})
