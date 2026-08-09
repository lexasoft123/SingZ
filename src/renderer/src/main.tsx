import '@fontsource-variable/bricolage-grotesque'
import '@fontsource-variable/martian-mono'
// The kit's tokens come FIRST so styles.css still wins at equal specificity —
// source order is the whole cascade story here, there are no layers.
import '@singz/ui/kit.css'
import './styles.css'
import { applyPlatformClasses } from '@singz/ui'
import { createRoot } from 'react-dom/client'
import App from './App'

// Before the first render, deliberately: App reads these classes DURING
// render to decide whether to mount the window buttons.
applyPlatformClasses()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
