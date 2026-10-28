import type { Locale } from '../i18n'

/**
 * The flags the language switcher wears, drawn here rather than by the kit:
 * which flag stands for a language is this app's call, and an emoji flag
 * renders as two letters on Windows. `.lang-flag` is the kit's slot — it sets
 * the size and the hairline hem.
 */
const UK = (): React.JSX.Element => (
  <svg className="lang-flag" viewBox="0 0 30 21" aria-hidden>
    <rect width="30" height="21" fill="#012169" />
    <path d="M0 0l30 21M30 0L0 21" stroke="#fff" strokeWidth="4" />
    <path d="M0 0l30 21M30 0L0 21" stroke="#C8102E" strokeWidth="1.6" />
    <path d="M15 0v21M0 10.5h30" stroke="#fff" strokeWidth="6" />
    <path d="M15 0v21M0 10.5h30" stroke="#C8102E" strokeWidth="3.4" />
  </svg>
)

const RU = (): React.JSX.Element => (
  <svg className="lang-flag" viewBox="0 0 30 21" aria-hidden>
    <rect width="30" height="7" fill="#fff" />
    <rect y="7" width="30" height="7" fill="#0039A6" />
    <rect y="14" width="30" height="7" fill="#D52B1E" />
  </svg>
)

const CN = (): React.JSX.Element => (
  <svg className="lang-flag" viewBox="0 0 30 21" aria-hidden>
    <rect width="30" height="21" fill="#EE1C25" />
    <polygon points="5,3.5 5.94,6.21 8.8,6.26 6.52,7.99 7.35,10.74 5,9.1 2.65,10.74 3.48,7.99 1.2,6.26 4.06,6.21" fill="#FFDE00" />
    <circle cx="11" cy="3.2" r="0.95" fill="#FFDE00" />
    <circle cx="13.2" cy="5.4" r="0.95" fill="#FFDE00" />
    <circle cx="13.2" cy="8.4" r="0.95" fill="#FFDE00" />
    <circle cx="11" cy="10.6" r="0.95" fill="#FFDE00" />
  </svg>
)

// Language codes remain legible on every platform; these badges avoid relying on
// emoji flags, which Windows renders as two regional-indicator letters.
const LanguageMark = ({ code }: { code: string }): React.JSX.Element => (
  <svg className="lang-flag" viewBox="0 0 30 21" aria-hidden>
    <rect width="30" height="21" rx="2" fill="#26221c" />
    <text x="15" y="14" textAnchor="middle" fill="#ffa028" fontFamily="system-ui, sans-serif" fontSize="10" fontWeight="700">{code}</text>
  </svg>
)

export const FLAGS: Record<Locale, React.JSX.Element> = {
  tr: <LanguageMark code="TR" />,
  en: <UK />, ru: <RU />, 'zh-CN': <CN />,
  hi: <LanguageMark code="HI" />, ja: <LanguageMark code="JA" />,
  ko: <LanguageMark code="KO" />, th: <LanguageMark code="TH" />,
  id: <LanguageMark code="ID" />, vi: <LanguageMark code="VI" />,
  fil: <LanguageMark code="FIL" />, ms: <LanguageMark code="MS" />,
  'zh-TW': <LanguageMark code="繁" />
}
