import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import SplitMenu from '../../src/renderer/src/components/SplitMenu'
import { withEnglish } from './i18n-source'

const render = (props: Partial<Parameters<typeof SplitMenu>[0]>): string =>
  renderToStaticMarkup(createElement(SplitMenu, {
    split: true, disabled: false, canResplit: false, canSplitBacking: false,
    onSplit: () => {}, ...props
  }))

/**
 * Backing vocals are part of every split now, so the only project that can
 * still be missing them is one split by an older build. The button is where
 * those projects are told — there is no other route to the second stage.
 */
describe('SplitMenu', () => {
  it('marks a project that was split before backing vocals existed', () => {
    const html = render({ split: true, canSplitBacking: true })
    expect(html).toContain('pill attention')
    expect(html).toContain('title="Click to split for backing vocals"')
  })

  it('leaves a fully separated project alone', () => {
    const html = render({ split: true, canSplitBacking: false, canResplit: true })
    expect(html).toContain('pill ghost')
    expect(html).not.toContain('attention')
    expect(html).not.toContain('Click to split for backing vocals')
  })

  it('does not nag an unsplit song, which will get both stages anyway', () => {
    const html = render({ split: false, canSplitBacking: false })
    expect(html).toContain('pill primary')
    expect(html).not.toContain('attention')
  })

  it('offers no way to split without backing vocals', async () => {
    // The dialog only renders once opened, and there is no DOM here to open
    // it in — so this is read at the source, which is also where a checkbox
    // would come back.
    const source = withEnglish(await readFile(
      new URL('../../src/renderer/src/components/SplitMenu.tsx', import.meta.url), 'utf8'
    ))
    expect(source).toContain("start('stems-and-vocals')")
    expect(source).not.toContain('type="checkbox"')
    // 'stems' survives only as re-split, which a separated project cannot do.
    expect(source).toContain("start('stems')")
    expect(source).toContain('Re-split instrument stems')
  })
})
