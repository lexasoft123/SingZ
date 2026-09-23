import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TrainPopover } from '../../src/renderer/src/components/Transport'
import {
  customTrackId,
  TRACK_META,
  TRAIN_DEFAULTS,
  trackLabel,
  type TrainingConfig
} from '../../src/renderer/src/model'

type Popover = Parameters<typeof TrainPopover>[0]
type Lane = Popover['lanes'][number]

/**
 * The lanes of a split song with both kinds of added lane, built the way App
 * builds them: stems are named by TRACK_META, the backing-vocals lane a
 * lead/backing split leaves behind is `custom-backing-vocals`, and a file the
 * singer adds ("my take.wav" arrives as "my take") gets a slug id and a name.
 */
function songLanes(): Lane[] {
  const stems: Lane[] = ['vocals', 'drums', 'bass'].map((id) => ({ id, label: TRACK_META[id].label }))
  const taken = new Set(stems.map((l) => l.id))
  const backing = { id: customTrackId('Backing vocals', taken), label: 'Backing vocals' }
  taken.add(backing.id)
  const mine = { id: customTrackId('my take', taken), label: trackLabel('my take') }
  return [...stems, backing, mine]
}

const props = (over: Partial<Popover> = {}): Popover => ({
  training: false,
  cfg: TRAIN_DEFAULTS,
  linesReady: false,
  lanes: songLanes(),
  onToggle: () => {},
  onCfg: () => {},
  onClose: () => {},
  ...over
})

const render = (over: Partial<Popover> = {}): string =>
  renderToStaticMarkup(createElement(TrainPopover, props(over)))

/** The stem chips, in order, as `[class, text]` pairs. */
function chips(html: string): [string, string][] {
  const stems = html.slice(html.indexOf('class="tp-stems"'))
  return [...stems.matchAll(/<button type="button" class="(chip stem[^"]*)">([^<]*)<\/button>/g)].map(
    (m) => [m[1], m[2]]
  )
}

/**
 * Render once and keep the element tree the popover returned, so a chip can
 * be pressed with no DOM (unit tests run under plain node): its onClick is a
 * prop like any other.
 */
function pressChip(over: Partial<Popover>, text: string): void {
  let tree: ReactNode = null
  const Capture = (): ReactElement => {
    const out = TrainPopover(props(over))
    tree = out
    return out
  }
  renderToStaticMarkup(createElement(Capture))
  const find = (node: ReactNode): ReactElement<{ onClick?: () => void }> | null => {
    if (Array.isArray(node)) {
      for (const child of node) {
        const hit = find(child)
        if (hit) return hit
      }
      return null
    }
    if (!isValidElement<{ className?: string; children?: ReactNode }>(node)) return null
    const { className, children } = node.props
    if (node.type === 'button' && className?.startsWith('chip stem') && children === text) {
      return node as ReactElement<{ onClick?: () => void }>
    }
    return find(children)
  }
  const chip = find(tree)
  if (!chip) throw new Error(`no stem chip reads "${text}"`)
  chip.props.onClick?.()
}

/**
 * "Muted while you sing:" printed `TRACK_META[id]?.label ?? id`, and
 * TRACK_META knows only the six stems — so the backing-vocals lane read
 * "custom-backing-vocals" and a singer's own track its file slug, while the
 * lane itself said "Backing vocals" or whatever the singer had renamed it to.
 */
describe('Carry the line: muted while you sing', () => {
  it('names every lane the way the lane itself does, never by its id', () => {
    const html = render()
    expect(chips(html).map(([, text]) => text)).toEqual([
      'Vocals',
      'Drums',
      'Bass',
      'Backing vocals',
      'My take'
    ])
    expect(html).not.toContain('custom-')
  })

  it('follows a rename, which changes the label and nothing else', () => {
    // App's renameTrack: `{ ...t, label }` — same id, same file, new name.
    const lanes = songLanes().map((l) =>
      l.id === 'custom-my-take' ? { ...l, label: 'Harmony, take 2' } : l
    )
    const texts = chips(render({ lanes })).map(([, text]) => text)
    expect(texts).toContain('Harmony, take 2')
    expect(texts).not.toContain('My take')
    expect(texts.some((t) => t.startsWith('custom-'))).toBe(false)
  })

  it('keeps the training config keyed by id, whatever the lane is called', () => {
    const lanes = songLanes().map((l) =>
      l.id === 'custom-my-take' ? { ...l, label: 'Harmony, take 2' } : l
    )
    const cfg: TrainingConfig = { ...TRAIN_DEFAULTS, stems: ['vocals', 'custom-my-take'] }
    expect(chips(render({ lanes, cfg }))).toEqual([
      ['chip stem active', 'Vocals'],
      ['chip stem', 'Drums'],
      ['chip stem', 'Bass'],
      ['chip stem', 'Backing vocals'],
      ['chip stem active', 'Harmony, take 2']
    ])

    // Pressing a chip by its NAME hands back the lane's ID — a saved config,
    // a project.json and the ducking all speak ids.
    const onCfg = vi.fn<(next: TrainingConfig) => void>()
    pressChip({ lanes, cfg, onCfg }, 'Backing vocals')
    expect(onCfg).toHaveBeenLastCalledWith({
      ...cfg,
      stems: ['vocals', 'custom-my-take', 'custom-backing-vocals']
    })
    pressChip({ lanes, cfg, onCfg }, 'Harmony, take 2')
    expect(onCfg).toHaveBeenLastCalledWith({ ...cfg, stems: ['vocals'] })
  })
})
