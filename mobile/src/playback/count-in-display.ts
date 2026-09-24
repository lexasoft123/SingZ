import type { PlaybackCountInStatus } from '../projects'
import { t } from '../i18n'

export interface PlaybackCountInDisplay {
  readonly accessibilityLabel: string
  readonly text: string
  readonly beatDots: boolean
}

/** Format only facts the backend actually owns; never infer a meter here. */
export function playbackCountInDisplay(
  status: PlaybackCountInStatus
): PlaybackCountInDisplay {
  if (status.kind === 'beats') {
    const text = Array.from({ length: status.total }, (_, i) =>
      i < status.done ? '●' : '○'
    ).reduce<string[]>((parts, dot, i) => {
      if (i > 0 && i % status.perBar === 0) parts.push(' ')
      parts.push(dot)
      return parts
    }, []).join('')
    return {
      accessibilityLabel: t('phone.player.countIn.beatLabel', { done: status.done, total: status.total }),
      text,
      beatDots: true
    }
  }

  const remaining = Math.max(0, status.remainingSeconds)
  const seconds = remaining >= 1
    ? String(Math.ceil(remaining))
    : Math.max(0.1, Math.ceil(remaining * 10) / 10).toFixed(1)
  return {
    accessibilityLabel: t('phone.player.countIn.secondsLabel', { seconds }),
    text: t('phone.player.countIn.secondsText', { seconds }),
    beatDots: false
  }
}
