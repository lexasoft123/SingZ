import { Component, type ReactNode } from 'react'

/** The Voice host is a lazy chunk: if it fails to load or render, the song screen stays. */
export default class VoiceBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(error: unknown): void {
    console.error('Voice strip failed to load:', error)
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
