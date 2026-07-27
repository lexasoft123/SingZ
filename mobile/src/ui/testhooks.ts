/** Dev-only driver hooks (the mobile analog of desktop's window.__engine). */
export const TEST: Record<string, unknown> | null = __DEV__
  ? (((globalThis as Record<string, unknown>).__test ??= {}) as Record<string, unknown>)
  : null
