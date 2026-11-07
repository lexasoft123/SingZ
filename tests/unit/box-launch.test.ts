import { describe, expect, it } from 'vitest'
import { boxKioskRequested, desktopUpdaterEnabled, developmentRendererUrl, requestedRendererSurface } from '../../src/main/launch-surface'

describe('Box launch selection', () => {
  it('keeps Desktop as the default and requires an explicit Box selector', () => {
    expect(requestedRendererSurface(['electron', '.'], {})).toBe('desktop')
    expect(requestedRendererSurface(['electron', '.'], { SINGZ_SURFACE: 'desktop' })).toBe('desktop')
    expect(requestedRendererSurface(['electron', '.'], { SINGZ_SURFACE: 'Box' })).toBe('desktop')
    expect(requestedRendererSurface(['electron', '.', '--box'], {})).toBe('box')
    expect(requestedRendererSurface(['electron', '.'], { SINGZ_SURFACE: 'box' })).toBe('box')
  })

  it('selects separate production and development renderer targets', () => {
    expect(developmentRendererUrl('http://localhost:5173/', 'desktop')).toBe('http://localhost:5173/')
    expect(developmentRendererUrl('http://localhost:5173/', 'box')).toBe('http://localhost:5173/box.html')
    expect(developmentRendererUrl('http://localhost:5173/dev', 'box')).toBe('http://localhost:5173/dev/box.html')
  })
})


describe('Box chrome and updater ownership', () => {
  it('keeps Desktop updater behavior and skips it for Box', () => {
    expect(desktopUpdaterEnabled('desktop')).toBe(true)
    expect(desktopUpdaterEnabled('box')).toBe(false)
  })

  it('uses production kiosk only for Box, with dev and hidden-test exceptions', () => {
    expect(boxKioskRequested('desktop')).toBe(false)
    expect(boxKioskRequested('box')).toBe(true)
    expect(boxKioskRequested('box', { developmentUrl: 'http://localhost:5173/' })).toBe(false)
    expect(boxKioskRequested('box', { hiddenTest: true })).toBe(false)
    expect(boxKioskRequested('box', { windowed: true })).toBe(false)
  })
})
