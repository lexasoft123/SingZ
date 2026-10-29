import { NativeModules, Platform } from 'react-native'
import { StackActions, type NavigationState, type PartialState } from '@react-navigation/native'

// A native presentation must finish dismissing before its tab loses focus.
// Switching tabs underneath a full-screen modal leaves iPadOS showing black.
const modalNames = new Set(['AddSong', 'Settings', 'Log', 'Diagnostics', 'WhatsNew', 'Mixer', 'Song', 'Practice'])
type State = NavigationState | PartialState<NavigationState>
type Navigation = {
  getRootState(): State | undefined
  dispatch(action: ReturnType<typeof StackActions.pop> & { target?: string }): void
}
const transitions = new Map<string, { closing: boolean; finish: () => void }>()

export const tabModalListeners = {
  transitionEnd(event: { target?: string; data: { closing: boolean } }): void {
    const pending = event.target ? transitions.get(event.target) : undefined
    if (pending?.closing === event.data.closing) pending?.finish()
  }
}

function presented(state: State | undefined): { stack: string; route: string; revealed: string } | null {
  if (!state) return null
  const route = state.routes[state.index ?? 0]
  if (!route) return null
  if (state.type === 'stack' && state.key && modalNames.has(route.name)) {
    const revealed = state.routes[(state.index ?? 0) - 1]?.key
    if (!revealed || !route.key) return null
    return { stack: state.key, route: route.key, revealed }
  }
  return route.state ? presented(route.state) : null
}

function presentedCount(state: State | undefined): number {
  if (!state) return 0
  if (state.type === 'tab') return presentedCount(state.routes[state.index ?? 0]?.state)
  return state.routes.slice(0, (state.index ?? 0) + 1).reduce((count, route, index) =>
    count + (index > 0 && modalNames.has(route.name) ? 1 : 0) + presentedCount(route.state), 0)
}

const pendingDismissals = new WeakMap<Navigation, Promise<boolean>>()

export function dismissTabModals(navigation: Navigation): Promise<boolean> {
  const existing = pendingDismissals.get(navigation)
  if (existing) return existing
  const pending = dismissPresented(navigation).finally(() => pendingDismissals.delete(navigation))
  pendingDismissals.set(navigation, pending)
  return pending
}

async function dismissPresented(navigation: Navigation): Promise<boolean> {
  for (let modal = presented(navigation.getRootState()); modal; modal = presented(navigation.getRootState())) {
    const { stack, route, revealed } = modal
    const remaining = presentedCount(navigation.getRootState()) - 1
    const dismissed = await new Promise<boolean>(resolve => {
      let finished = false
      const finish = (ok: boolean) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        transitions.delete(route)
        transitions.delete(revealed)
        resolve(ok)
      }
      // If iOS does not acknowledge dismissal, retain the current tab safely.
      const timer = setTimeout(() => finish(false), 5000)
      transitions.set(route, { closing: true, finish: () => finish(true) })
      // Removed routes can lose their JS listener before onDisappear. The
      // revealed controller's viewDidAppear acknowledges the same dismissal.
      transitions.set(revealed, { closing: false, finish: () => finish(true) })
      navigation.dispatch({ ...StackActions.pop(1), target: stack })
      if (Platform.OS === 'ios' && NativeModules.FolderAccess?.waitForNavigationModals) {
        // Fabric can remove a sheet's event emitter before onDisappear. Ask
        // UIKit to confirm its presentation count and transitions instead.
        void NativeModules.FolderAccess.waitForNavigationModals(remaining).then(
          (ready: boolean) => finish(ready), () => finish(false)
        )
      }
    })
    if (!dismissed) return false
  }
  return true
}
