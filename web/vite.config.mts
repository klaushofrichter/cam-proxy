import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

// The admin UI, served by the proxy (src/proxy.ts) from dist/web.
// `npm run dev:web` proxies the API to a local cam-proxy.
export default defineConfig({
  root: resolve(__dirname),
  plugins: [svelte()],
  build: { outDir: resolve(__dirname, '../dist/web'), emptyOutDir: true },
  server: { proxy: { '/control': 'http://localhost:8480', '/api': 'http://localhost:8480' } },
});
