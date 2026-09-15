import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SetupWizard from '../../src/renderer/src/components/SetupWizard'
import type { ModelInfo } from '../../src/shared/types'
import { vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { modelDownloadTargets, setupWizardCloseAction } from '../../src/renderer/src/components/SetupWizard'

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
  { id: 'backing-vocals', label: 'Lead and backing vocals', description: 'Vocal model', present: false, optional: true, required: false, sizeMb: 26 }
]
describe('requested model downloads', () => {
  it('includes the missing splitter runtime even if system demucs made it optional for ordinary splitting', () => {
    expect(modelDownloadTargets('backing-vocals', missingModels)).toEqual(['gpu-splitter', 'backing-vocals'])
    expect(modelDownloadTargets('backing-vocals', missingModels.map(m => ({ ...m, present: m.id === 'gpu-splitter' })))).toEqual(['backing-vocals'])
    expect(modelDownloadTargets('whisper', missingModels)).toEqual(['whisper'])
  })
  it('gives missing non-optional models a download button in the manually opened dialog and includes dependency size', () => {
    vi.stubGlobal('document', { body: { classList: { contains: () => false } } })
    try {
      const html = renderToStaticMarkup(createElement(SetupWizard, { models: missingModels, origin: 'manual', focusModel: 'backing-vocals', onClose: () => {} }))
      expect(html).toContain('Get · 272 MB')
      expect(html).toContain('Get · 298 MB')
      expect(html).toContain('data-model-id="backing-vocals"')
    } finally { vi.unstubAllGlobals() }
  })
})
