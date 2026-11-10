import { beforeEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { StartupOverlay } from '../../src/renderer/src/box/StartupOverlay'
import { prepareBoxLocale } from '../../src/renderer/src/box/i18n'

const root = resolve(__dirname, '../..')
function zIndex(file: string, selector: string): number {
  const css = readFileSync(resolve(root, file), 'utf8')
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const rule = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))?.[1]
  const value = rule?.match(/z-index:\s*(\d+)/)?.[1]
  if (value === undefined) throw new Error(`No z-index for ${selector} in ${file}`)
  return Number(value)
}

describe('Box startup overlay', () => {
  beforeEach(() => { prepareBoxLocale('en') })

  it('covers the Box only while hydration is pending without a failure', () => {
    expect(renderToStaticMarkup(createElement(StartupOverlay, { hydrated: false, failed: false })))
      .toContain('data-surface="startup"')
    expect(renderToStaticMarkup(createElement(StartupOverlay, { hydrated: true, failed: false }))).toBe('')
  })

  it('unmounts on a startup failure so the policy-startup Retry is not hidden', () => {
    expect(renderToStaticMarkup(createElement(StartupOverlay, { hydrated: false, failed: true }))).toBe('')
  })

  it('stacks above the policy status but below the retained-playback dialog', () => {
    const startup = zIndex('src/renderer/src/box/collection/collection.css', '.box-startup')
    const policy = zIndex('src/renderer/src/box/settings.css', '.box-policy-startup')
    const retainedScrim = zIndex('node_modules/@singz/ui/dist/kit.css', '.modal-scrim')
    expect(startup).toBeGreaterThan(policy)
    expect(startup).toBeLessThan(retainedScrim)
  })
})
