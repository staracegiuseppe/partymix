import { defineConfig } from 'vite';
export default defineConfig({
  build: { outDir: 'dist', rollupOptions: { input: { main: 'index.html', projector: 'projector.html' } } },
  test: { environment: 'jsdom', globals: true },
});
