import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig(() => {
  const target = process.env.SINGZ_RENDERER_TARGET
  const input: Record<string, string> = target === 'desktop'
    ? { index: resolve(import.meta.dirname, 'src/renderer/index.html') }
    : target === 'box'
      ? { box: resolve(import.meta.dirname, 'src/renderer/box.html') }
      : {
          index: resolve(import.meta.dirname, 'src/renderer/index.html'),
          box: resolve(import.meta.dirname, 'src/renderer/box.html')
        }
  return {
    ...(target === 'box' ? {} : {
      main: {
        plugins: [externalizeDepsPlugin()],
        build: {
          rollupOptions: {
            input: {
              index: resolve(import.meta.dirname, 'src/main/bootstrap.ts')
            },
            output: {
              chunkFileNames: '[name]-[hash].js'
            }
          }
        }
      },
      preload: {
        plugins: [externalizeDepsPlugin()]
      }
    }),
    renderer: {
      build: {
        ...(target === 'box' ? { outDir: resolve(import.meta.dirname, 'out/box-stage/box') } : {}),
        assetsInlineLimit: path => path.includes('/training-sounds/') ? true : undefined,
        rollupOptions: {
          input,
          output: {
            onlyExplicitManualChunks: true,
            // Keep route recovery from fetching an app-shell dependency URL again.
            hoistTransitiveImports: false,
            manualChunks: id => /\/training-(melody-generator|types)\.ts$/.test(id) ? 'melody-generator' : undefined
          }
        }
      },
      plugins: [
        {
          name: 'drive-reader-recovery-isolation',
          enforce: 'pre',
          async resolveId(source, importer) {
            const owner = importer?.match(/[?&](?:dialog-route|drop-screen-route|drive-reader-owner)=(primary|recovery)/)?.[1]
            if (!owner || !/^\.\/DriveProjects(?:Button)?(?:\?|$)/.test(source)) return null
            const [file, query] = source.split('?')
            const resolved = await this.resolve(file, importer?.split('?')[0], { skipSelf: true })
            // Both catalog routes recover independently, including their new reader dialog.
            return resolved ? `${resolved.id}?${query ? query + '&' : ''}drive-reader-owner=${owner}` : null
          }
        },
        {
          name: 'training-kit-recovery-isolation',
          enforce: 'pre',
          async resolveId(source, importer) {
            const route = importer?.match(/[?&]training-route=(primary|recovery)/)?.[1]
            if (!route) return null
            const melodyModule = source === './MelodyGrid' || source.endsWith('/training-melody') || source.endsWith('/training-types')
            const iconEntry = source === '@singz/ui/icons'
            const bannerEntry = source === '@singz/ui/banner'
            const bannerUtility = source === '../util/cx.js' && importer?.includes('/@singz/ui/dist/primitives/Banner.js')
            const iconArtwork = source === './artwork.js' && importer?.includes('/@singz/ui/dist/icons/')
            if (!melodyModule && !iconEntry && !iconArtwork && !bannerEntry && !bannerUtility) return null
            // Recovery must not refetch a failed primary UIKit URL. Keep each
            // route's small UIKit module closure independent, like the route itself.
            const resolved = await this.resolve(source, importer?.split('?')[0], { skipSelf: true })
            return resolved ? `${resolved.id}?training-route=${route}` : null
          }
        },
        react()
      ]
    }
  }
})
