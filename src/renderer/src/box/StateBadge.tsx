import { t } from './i18n'
import { STATE_GLYPH, STATE_LABEL_KEY, STATE_SHORT_KEY, type CatalogStateKind } from './catalog-state'

/** Glyph + short word, coloured per state; the long sentence is the accessible name. */
export function StateBadge({ kind }: { kind: CatalogStateKind }): React.JSX.Element {
  return <span className="state-badge" data-state={kind} role="img" aria-label={t(STATE_LABEL_KEY[kind])}>
    <span aria-hidden="true" className="state-glyph">{STATE_GLYPH[kind]}</span>
    <span aria-hidden="true">{t(STATE_SHORT_KEY[kind])}</span>
  </span>
}
