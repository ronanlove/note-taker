import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  // GitHub Pages serves the app from /<repo-name>/; the deploy workflow sets this.
  base: process.env.BASE_PATH ?? '/',
  // pdf.js is one big chunk, loaded only when a note has a PDF.
  build: { chunkSizeWarningLimit: 600 },
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      workbox: {
        // The PDF viewer's worker is an .mjs file of about 1.3 MB; cache it so PDFs open offline.
        globPatterns: ['**/*.{js,mjs,css,html}'],
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
      },
      manifest: {
        name: 'Jot',
        short_name: 'Jot',
        description: 'Minimal notes and handwriting that sync to GitHub.',
        display: 'standalone',
        background_color: '#fbfbfa',
        theme_color: '#fbfbfa',
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
