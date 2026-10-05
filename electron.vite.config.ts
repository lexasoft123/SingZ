import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    build: { assetsInlineLimit: path => path.includes('/training-sounds/') ? true : undefined },
    plugins: [
      {
        name: 'training-icon-recovery-isolation',
        enforce: 'pre',
        async resolveId(source, importer) {
          const route = importer?.match(/[?&]training-route=(primary|recovery)/)?.[1]
          if (!route) return null
          const iconEntry = source === '@singz/ui/icons'
          const iconArtwork = source === './artwork.js' && importer?.includes('/@singz/ui/dist/icons/')
          if (!iconEntry && !iconArtwork) return null
          // Recovery must not refetch a failed primary icon URL. Keep each
          // route's small icon module closure independent, like the route itself.
          const resolved = await this.resolve(source, importer?.split('?')[0], { skipSelf: true })
          return resolved ? `${resolved.id}?training-route=${route}` : null
        }
      },
      react()
    ]
  }
})
