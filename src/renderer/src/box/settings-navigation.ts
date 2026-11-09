export type BoxRoute = 'catalog' | 'details' | 'player' | 'queue' | 'settings' | 'home' | 'account'

/** Back from song details returns where details was entered from. Re-entering
 * details while already there keeps the original origin. */
export function detailsReturnRoute(current: BoxRoute, previous: BoxRoute): BoxRoute {
  return current === 'details' ? previous : current
}

export interface BoxSettingsNavigationState {
  applyingOutput: boolean
  hasCurrent: boolean
  settingsReturn?: 'home' | 'player' | 'catalog'
}

export class BoxSettingsNavigator {
  constructor(
    private readonly readState: () => BoxSettingsNavigationState,
    private readonly navigate: (route: BoxRoute) => void
  ) {}

  canNavigate(): boolean {
    return !this.readState().applyingOutput
  }

  go(route: BoxRoute): boolean {
    if (!this.canNavigate()) return false
    this.navigate(route)
    return true
  }

  backFromSettings(): boolean {
    const state = this.readState()
    if (state.applyingOutput) return false
    this.navigate(state.settingsReturn ?? (state.hasCurrent ? 'player' : 'catalog'))
    return true
  }
}
