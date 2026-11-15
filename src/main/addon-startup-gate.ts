import type { CaptureAddonFailureKind, CaptureAddonFingerprints } from './capture'

/**
 * Startup gate for a capture addon that does not match this checkout/install
 * (ADR 0015: native playback is the only desktop path, so a stale addon must
 * stop the app rather than fall back to Web Audio). Decided here; wired in
 * src/main/index.ts before any window exists.
 */
export type AddonFailureClass =
  | { action: 'block-dev'; kind: CaptureAddonFailureKind }
  | { action: 'block-corrupt-install'; kind: CaptureAddonFailureKind }
  | { action: 'continue' }

/** Pure classifier, reusable by the ADR 0015 WP3 failure panel. Only the two
 *  provenance kinds block; everything else (missing binary, ABI, platform
 *  unsupported, transient load errors) keeps today's behaviour. */
export function classifyAddonLoadFailure(
  error: unknown,
  packaged: boolean
): AddonFailureClass {
  const kind = (error as { kind?: CaptureAddonFailureKind } | null)?.kind
  if (kind !== 'provenance-mismatch' && kind !== 'metadata-missing') return { action: 'continue' }
  return packaged ? { action: 'block-corrupt-install', kind } : { action: 'block-dev', kind }
}

export interface AddonStartupGateDeps {
  /** Throws if the addon does not match; see checkCaptureAddonProvenance(). */
  check(): void
  app: { isPackaged: boolean; exit(code: number): void }
  dialog: { showErrorBox(title: string, content: string): void }
  env: Record<string, string | undefined>
  log(message: string, level: 'warn' | 'error'): void
  stderr(message: string): void
  target: string
}

export const ADDON_OPT_OUT_ENV = 'SINGZ_ALLOW_STALE_ADDON'

/** Headless runs: the E2E launch env (tests/e2e/mac/quiet-launch.cjs). */
const headless = (env: AddonStartupGateDeps['env']): boolean => Boolean(env.SINGZ_E2E_HIDDEN)

export function addonBlockMessage(
  decision: Exclude<AddonFailureClass, { action: 'continue' }>,
  reason: string,
  target: string,
  fingerprints?: CaptureAddonFingerprints
): string {
  const lines = [reason]
  if (fingerprints?.checkout || fingerprints?.addon)
    lines.push(`Checkout fingerprint: ${fingerprints.checkout ?? 'unknown'}`,
      `Addon fingerprint: ${fingerprints.addon ?? 'unknown'}`)
  lines.push(decision.action === 'block-corrupt-install'
    ? 'This SingZ install is damaged. Reinstall SingZ, then restart.'
    : `Rebuild the native audio addon: npm run capture:addon -- ${target}, then restart.`)
  return lines.join('\n')
}

/** Returns true when startup may continue. On false the process is already
 *  exiting non-zero and the caller must create no window. */
export function enforceAddonStartupGate(deps: AddonStartupGateDeps): boolean {
  try { deps.check(); return true }
  catch (error) {
    const decision = classifyAddonLoadFailure(error, deps.app.isPackaged)
    if (decision.action === 'continue') return true
    const reason = error instanceof Error ? error.message : String(error)
    if (!deps.app.isPackaged && deps.env[ADDON_OPT_OUT_ENV] === '1') {
      deps.log(`${ADDON_OPT_OUT_ENV}=1: continuing with a mismatched capture addon (${reason})`, 'warn')
      return true
    }
    const message = addonBlockMessage(decision, reason,
      deps.target, (error as { fingerprints?: CaptureAddonFingerprints }).fingerprints)
    deps.log(`startup blocked, ${decision.kind}: ${message.replace(/\n/g, ' · ')}`, 'error')
    if (headless(deps.env)) deps.stderr(`singz: startup blocked — ${message}\n`)
    else deps.dialog.showErrorBox('SingZ cannot start', message)
    deps.app.exit(1)
    return false
  }
}
