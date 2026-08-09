import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/martian-mono'
// The kit's tokens come FIRST so styles.css still wins at equal specificity —
// source order is the whole cascade story here, there are no layers.
import '@singz/ui/kit.css'
import './styles.css'
import { createRoot } from 'react-dom/client'
import App from './App'

document.body.classList.toggle('mac', navigator.userAgent.includes('Macintosh'))
document.body.classList.toggle('win', navigator.userAgent.includes('Windows'))

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
