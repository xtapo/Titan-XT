import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

// PWA-ready Vite config for the Titan-XT web viewer.
// - serviceWorker is registered in dev too so installability can be tested
//   without a full build/deploy cycle.
// - We don't precache the entry HTML so a stale shell can't outlive a deploy.
export default defineConfig({
  server: {
    port: 5180,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    outDir: 'dist',
  },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      manifest: {
        name: 'Titan-XT Viewer',
        short_name: 'Titan-XT',
        description: 'Điều khiển máy tính từ điện thoại qua trình duyệt',
        theme_color: '#0a0a0f',
        background_color: '#0a0a0f',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        // SVG icon scales to any size and serves as both standard + maskable.
        // Replace with PNGs (192/512) once we have a finalized brand mark — we
        // skip PNGs here to keep the repo free of binary placeholders.
        icons: [
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api/],
        runtimeCaching: [
          {
            urlPattern: /\.(?:js|css|woff2)$/,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'titan-xt-assets' },
          },
        ],
      },
    }),
  ],
});
