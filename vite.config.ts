import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const version = JSON.parse(readFileSync('./package.json', 'utf8')).version as string;
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: 'dist', rollupOptions: { input: { main: 'index.html', projector: 'projector.html' } } },
  test: { environment: 'jsdom', globals: true },
});
