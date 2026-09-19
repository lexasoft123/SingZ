import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SetupWizard from '../../src/renderer/src/components/SetupWizard'
import type { ModelInfo } from '../../src/shared/types'
import { vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { setupWizardCloseAction } from '../../src/renderer/src/components/SetupWizard'

describe('setup wizard routing ownership', () => {
  it('keeps an automatic model download alive when the persistent wizard closes', () => {
    expect(setupWizardCloseAction('auto', true)).toBe('leave-running')
    expect(setupWizardCloseAction('auto', false)).toBe('cancel')
    expect(setupWizardCloseAction('manual', true)).toBe('cancel')
  })

  it('stays eager instead of entering generic dialog chunk recovery', async () => {
    const source = await readFile(
      new URL('../../src/renderer/src/App.tsx', import.meta.url),
      'utf8'
    )
    expect(source).toContain("import SetupWizard from './components/SetupWizard'")
    expect(source).toContain('<SetupWizard models={wizard.models}')
    expect(source).not.toContain('RecoverableSetupWizard')
    expect(source).not.toContain("import('./components/SetupWizard")

    const wizardSource = await readFile(
      new URL('../../src/renderer/src/components/SetupWizard.tsx', import.meta.url),
      'utf8'
    )
    expect(wizardSource).toContain('<Modal onClose={onClose} cardClassName="wizard" persistent>')
    expect(wizardSource).toContain("setupWizardCloseAction(origin, busy) === 'cancel'")
  })
})


const missingModels: ModelInfo[] = [
  { id: 'gpu-splitter', label: 'Stem splitter', description: 'Runtime', present: false, optional: false, required: false, sizeMb: 272 },
  { id: 'whisper', label: 'Lyrics model', description: 'Transcription', present: false, optional: true, required: false, sizeMb: 1624 }
]
describe('requested model downloads', () => {
  // The vocal model used to be a second download that only worked once the
  // splitter pack was there, so a Get button had to pull both and price
  // both. It rides inside the pack now: every row is its own download again,
  // and its own size.
  it('gives missing models a download button priced at their own size', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } })
    try {
      const html = renderToStaticMarkup(createElement(SetupWizard, { models: missingModels, origin: 'manual', focusModel: 'gpu-splitter', onClose: () => {} }))
      expect(html).toContain('Get · 272 MB')
      expect(html).toContain('Get · 1624 MB')
      expect(html).toContain('data-model-id="gpu-splitter"')
      expect(html).not.toContain('backing-vocals')
    } finally { vi.unstubAllGlobals() }
  })
})
