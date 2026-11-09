import { useEffect, useReducer, useRef } from 'react'

export interface Resource<T> {
  value: T | null
  loading: boolean
  error: string | null
  generation: number
}

export type ResourceAction<T> =
  | { type: 'started'; generation: number; background?: boolean }
  | { type: 'succeeded'; generation: number; value: T }
  | { type: 'failed'; generation: number; error: string }

export function initialResource<T>(): Resource<T> {
  return { value: null, loading: false, error: null, generation: 0 }
}

export function resourceReducer<T>(state: Resource<T>, action: ResourceAction<T>): Resource<T> {
  switch (action.type) {
    case 'started':
      if (action.generation <= state.generation) return state
      return {
        value: state.value,
        // A background poll never changes `loading`: pages disable controls on
        // it (Refresh, Retry, language…), and disabling the focused control makes
        // the remote's focus jump back to the page's primary action every poll —
        // with data on screen or after a failed first load alike.
        loading: action.background === true ? state.loading : true,
        error: null,
        generation: action.generation
      }
    case 'succeeded':
      if (action.generation !== state.generation) return state
      return { value: action.value, loading: false, error: null, generation: state.generation }
    case 'failed':
      if (action.generation !== state.generation) return state
      return {
        value: state.value,
        loading: false,
        error: action.error,
        generation: state.generation
      }
  }
}

export function useJourneyResource<T>() {
  const [state, dispatch] = useReducer(resourceReducer<T>, undefined, initialResource<T>)
  const generation = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])

  return {
    state,
    begin(options: { background?: boolean } = {}): number {
      const next = ++generation.current
      dispatch({ type: 'started', generation: next, background: options.background })
      return next
    },
    current(token: number): boolean {
      return mounted.current && token === generation.current
    },
    succeed(token: number, value: T): void {
      if (mounted.current && token === generation.current) {
        dispatch({ type: 'succeeded', generation: token, value })
      }
    },
    fail(token: number, error: string): void {
      if (mounted.current && token === generation.current) {
        dispatch({ type: 'failed', generation: token, error })
      }
    },
    invalidate(): void {
      generation.current++
    }
  }
}
