import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/martian-mono'
import './styles.css'
import { createRoot } from 'react-dom/client'
import App from './App'

document.body.classList.toggle('mac', navigator.userAgent.includes('Macintosh'))

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
