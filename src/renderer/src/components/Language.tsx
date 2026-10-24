import { lazy, Suspense } from 'react'

const LanguageControl = lazy(() => import('./LanguageControl'))

/** Load the language menu separately from the player. */
export function Language({ compact = false }: { compact?: boolean }): React.JSX.Element {
  return <Suspense fallback={null}><LanguageControl compact={compact} /></Suspense>
}
