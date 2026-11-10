import type { BoxAPI } from '../../../../shared/box-contract'

export function getBoxApi(): BoxAPI | null {
  const singz = window.singz as typeof window.singz & { box?: BoxAPI }
  return singz.box ?? null
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
