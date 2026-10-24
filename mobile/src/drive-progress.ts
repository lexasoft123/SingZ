import type { FileProgress } from './file-download'
import { t } from './i18n'

const amount = (bytes: number): string => bytes >= 1_000_000
  ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(Math.max(0, bytes) / 1000)} KB`
export function describeFileProgress(p: FileProgress, label: string, index: number, count: number): string {
  if (p.phase === 'checking') return t('phone.library.downloadChecking', { label, index, count })
  if (p.phase === 'retrying') return t('phone.library.downloadRetrying', { label, attempt: p.attempt, attempts: p.attempts })
  if (p.phase === 'verifying') return t('phone.library.downloadVerifying', { label, index, count })
  const bytes = p.total > 0 ? `${amount(Math.min(p.got, p.total))} / ${amount(p.total)}` : amount(p.got)
  const speed = p.bytesPerSecond > 0 ? ` · ${amount(p.bytesPerSecond)}/s` : ''
  return t('phone.library.downloadTrack', { label, index, count }) + `\n${bytes}${speed}`
}
export function fileProgressFraction(p: FileProgress): number {
  return p.total > 0 ? Math.max(0, Math.min(1, p.got / p.total)) : 0
}
