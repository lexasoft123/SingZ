import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/martian-mono'
import '@singz/ui/kit.css'
import './styles.css'
import { createRoot } from 'react-dom/client'
import BoxApp from './App'
import { getLocale, subscribeLocale } from '../../../shared/i18n'
import { prepareBoxLocale } from './i18n'

const syncLanguage = (): void => {
  document.documentElement.lang = getLocale()
}
subscribeLocale(syncLanguage)
void window.singz.getLocale()
  .then(state => prepareBoxLocale(state.locale))
  .catch(() => prepareBoxLocale('en'))
  .finally(() => {
    syncLanguage()
    createRoot(document.getElementById('root') as HTMLElement).render(<BoxApp />)
  })
