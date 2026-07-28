import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `base` is relative so the built app works from a subpath (GitHub Pages) and
// from a domain root (Netlify) without a rebuild.
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
