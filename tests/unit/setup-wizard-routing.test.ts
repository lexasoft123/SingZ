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
