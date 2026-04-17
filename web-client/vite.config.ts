import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vuetify from 'vite-plugin-vuetify'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'

export default defineConfig({
  plugins: [
    vue(),
    vuetify({ autoImport: false }),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // Disabled during development
      devOptions: {
        enabled: false, // PWA disabled in dev mode
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Don't cache API responses — always fetch fresh data
        runtimeCaching: [
          {
            urlPattern: /^https?.*\/api\/files\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'files-cache',
              expiration: { maxEntries: 500, maxAgeSeconds: 30 * 24 * 60 * 60 },
            },
          },
        ],
      },
      manifest: {
        name: 'Fast Chat',
        short_name: 'FastChat',
        description: 'Real-time messenger with E2E encryption',
        theme_color: '#1976D2',
        background_color: '#121212',
        display: 'standalone',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    https: false,
    host: true,
    proxy: {
      '/api': {
        target: 'https://localhost:8080',
        changeOrigin: true,
        secure: false,
      },
      '/sse': {
        target: 'https://localhost:8080',
        changeOrigin: true,
        secure: false,
        ws: true,
      },
    },
    headers: {
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
    },
  },
})
