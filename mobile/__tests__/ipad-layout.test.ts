import { playerWorkspaceLayout } from '../src/ui/layout'

it.each([
  [393, 760, 1],
  [852, 350, 1],
  [600, 800, 1],
  [1194, 400, 1],
  [1024, 700, 1.5]
])('keeps the mixer in a sheet with insufficient room (%s × %s, text %s)', (width, height, scale) => {
  expect(playerWorkspaceLayout(width, height, scale).sideBySide).toBe(false)
})

it.each([[1024, 680], [1194, 740], [1366, 940], [1920, 1080]])(
  'fits both panes and transport within a wide window (%s × %s)', (width, height) => {
    const layout = playerWorkspaceLayout(width, height)
    expect(layout.sideBySide).toBe(true)
    expect(layout.mixerWidth).toBeGreaterThanOrEqual(360)
    expect(layout.lyricsWidth).toBeGreaterThanOrEqual(500)
    expect(layout.mixerWidth + layout.lyricsWidth + 36).toBeLessThanOrEqual(width)
    expect(layout.dockWidth).toBeLessThanOrEqual(width - 24)
    expect(layout.workspaceWidth).toBeLessThanOrEqual(1440)
  }
)
