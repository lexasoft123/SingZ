/**
 * Just enough react-native for the phone's Drive code to run under vitest, so
 * the round-trip can put the real desktop writer and the real mobile reader in
 * one process. Everything here is what mobile/src/gdrive.ts actually touches.
 */

export const NativeModules: Record<string, unknown> = {}

export const AppState = {
  currentState: 'active' as string,
  addEventListener: (_type: string, _fn: (s: string) => void) => ({ remove: () => {} })
}

export const Linking = { openURL: async (_url: string) => {} }

export const Platform = { OS: 'ios' as const, select: <T,>(o: { ios?: T; default?: T }): T | undefined => o.ios ?? o.default }

export const PixelRatio = { getFontScale: () => 1 }

export default { NativeModules, AppState, Linking, Platform, PixelRatio }
