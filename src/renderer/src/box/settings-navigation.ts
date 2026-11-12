export type BoxRoute = 'catalog' | 'details' | 'player' | 'queue' | 'settings' | 'home' | 'account'

/** Back from song details returns where details was entered from. Re-entering
 * details while already there keeps the original origin. */
export function detailsReturnRoute(current: BoxRoute, previous: BoxRoute): BoxRoute {
  return current === 'details' ? previous : current
}

/** Settings (the hub) and Account return to the screen they were opened from, not
 * to the catalog. Opening one from the other keeps the original origin. */
export function overlayReturnRoute(current: BoxRoute, previous: BoxRoute, opening: 'home' | 'account'): BoxRoute {
  return current === 'home' || current === 'settings' || current === opening ? previous : current
}

/** Next/Sing from the player keeps the player on screen while the song opens (details would flash
 * "← Catalog" focus); every other origin shows the details screen it opens from. */
export function routeWhileOpening(current: BoxRoute): BoxRoute {
  return current === 'player' ? 'player' : 'details'
}

/** A failed open from the player lands on details, where the error is shown. */
export function routeAfterFailedOpen(current: BoxRoute): BoxRoute {
  return current === 'player' ? 'details' : current
}

/** Account opened from the Settings hub returns to the hub, unless the hub itself was
 * opened from Account: then Account keeps its own origin, so Back cannot cycle. */
export function accountReturnFromHub(hubReturn: BoxRoute, accountReturn: BoxRoute): BoxRoute {
  return hubReturn === 'account' ? accountReturn : 'home'
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
