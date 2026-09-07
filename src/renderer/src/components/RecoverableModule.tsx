import { Component, type ComponentType, type ReactNode } from 'react'

export type ModuleLoader<Props> = () => Promise<{ default: ComponentType<Props> }>
export type ModuleAttempts<Props> = readonly [ModuleLoader<Props>, ModuleLoader<Props>]

export interface RecoverableModuleState<Props> {
  readonly phase: 'loading' | 'loaded' | 'failed'
  readonly attempt: 0 | 1
  readonly Component: ComponentType<Props> | null
}

interface RecoverableModuleProps<Props> {
  readonly attempts: ModuleAttempts<Props>
  readonly initialAttempt: 0 | 1
  readonly onAttemptFailed: (attempt: 0 | 1) => void
  readonly renderLoading: () => ReactNode
  readonly renderFailure: (retry: (() => void) | null) => ReactNode
  readonly renderLoaded: (Loaded: ComponentType<Props>) => ReactNode
}

/**
 * Loads one of two statically emitted module URLs without becoming an error
 * boundary. Only an import rejection reaches renderFailure; exceptions from
 * the loaded component continue to its caller's purpose-built runtime policy.
 */
export class RecoverableModule<Props> extends Component<
  RecoverableModuleProps<Props>,
  RecoverableModuleState<Props>
> {
  state: RecoverableModuleState<Props>
  private mounted = false
  private generation = 0

  constructor(props: RecoverableModuleProps<Props>) {
    super(props)
    this.state = {
      phase: 'loading',
      attempt: props.initialAttempt,
      Component: null
    }
  }

  componentDidMount(): void {
    this.mounted = true
    this.load(this.state.attempt)
  }

  componentWillUnmount(): void {
    this.mounted = false
  }

  private load(attempt: 0 | 1): void {
    const generation = ++this.generation
    this.setState({ phase: 'loading', attempt, Component: null })
    void this.props.attempts[attempt]().then(({ default: Loaded }) => {
      if (!this.mounted || generation !== this.generation) return
      this.setState({ phase: 'loaded', attempt, Component: Loaded })
    }).catch(() => {
      // Chromium remembers a failed module URL even if its view disappeared
      // before the request settled. Record that provenance for the next
      // route mount, but never update the unmounted instance's state. A
      // superseded generation must not poison the currently selected URL.
      if (generation !== this.generation) return
      this.props.onAttemptFailed(attempt)
      if (!this.mounted) return
      this.setState({ phase: 'failed', attempt, Component: null })
    })
  }

  private readonly retry = (): void => {
    if (this.state.phase !== 'failed' || this.state.attempt !== 0) return
    this.load(1)
  }

  render(): ReactNode {
    if (this.state.phase === 'loaded' && this.state.Component) {
      return this.props.renderLoaded(this.state.Component)
    }
    if (this.state.phase === 'failed') {
      return this.props.renderFailure(this.state.attempt === 0 ? this.retry : null)
    }
    return this.props.renderLoading()
  }
}
