import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/martian-mono'
// The kit's tokens come FIRST so styles.css still wins at equal specificity —
// source order is the whole cascade story here, there are no layers.
import '@singz/ui/kit.css'
import './styles.css'
import { applyPlatformClasses } from '@singz/ui'
import { createRoot } from 'react-dom/client'
import App from './App'
import { loadLocale, setLocale, subscribeLocale, getLocale } from '../../shared/i18n'

// Before the first render, deliberately: App reads these classes DURING
// render to decide whether to mount the window buttons.
applyPlatformClasses()

// Windows starts solid and turns to glass only when main vouches for the GPU
// it composites on (src/main/glass.ts): a weak one never flickers, a strong
// one gets its blur a moment after the window appears — and loses it again
// if Chromium later falls to software compositing.
if (document.body.classList.contains('win')) {
  const apply = (v: { glass: boolean }): void => {
    document.body.classList.toggle('glass', v.glass)
  }
  window.singz.onGlassVerdict(apply)
  void window.singz.glassVerdict().then(apply, () => undefined)
}

// The language comes from main (settings.json + the machine's languages)
// before the first render, so the window never flashes English first.
const syncLang = (): void => {
  document.documentElement.lang = getLocale()
}
subscribeLocale(syncLang)
void window.singz
  .getLocale()
  .then(async (s) => {
    await loadLocale(s.locale)
    setLocale(s.locale)
  })
  .catch(() => {})
  .finally(() => {
    syncLang()
    createRoot(document.getElementById('root') as HTMLElement).render(<App />)
  })
