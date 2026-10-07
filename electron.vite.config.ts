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
        name: 'training-kit-recovery-isolation',
        enforce: 'pre',
        async resolveId(source, importer) {
          const route = importer?.match(/[?&]training-route=(primary|recovery)/)?.[1]
          if (!route) return null
          const iconEntry = source === '@singz/ui/icons'
          const bannerEntry = source === '@singz/ui/banner'
          const bannerUtility = source === '../util/cx.js' && importer?.includes('/@singz/ui/dist/primitives/Banner.js')
          const iconArtwork = source === './artwork.js' && importer?.includes('/@singz/ui/dist/icons/')
          if (!iconEntry && !iconArtwork && !bannerEntry && !bannerUtility) return null
          // Recovery must not refetch a failed primary UIKit URL. Keep each
          // route's small UIKit module closure independent, like the route itself.
          const resolved = await this.resolve(source, importer?.split('?')[0], { skipSelf: true })
          return resolved ? `${resolved.id}?training-route=${route}` : null
        }
      },
      react()
    ]
  }
})
