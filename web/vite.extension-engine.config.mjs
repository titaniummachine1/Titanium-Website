/**
 * Standalone build of the Titanium WASM worker for the Wallz Bridge Chrome
 * extension (.local/wallz-bridge/extension/engine/). Unlike the main site
 * build (`base: '/'` or the ghpages sub-path), this uses a relative base so
 * the emitted worker's `import.meta.url`-relative asset references resolve
 * correctly under `chrome-extension://<id>/...` instead of the site origin.
 *
 * Not part of the normal site build/deploy — run manually:
 *   npx vite build --config vite.extension-engine.config.mjs
 */
import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: '.',
  base: '',
  worker: {
    format: 'es',
  },
  build: {
    outDir: 'dist-extension-engine',
    emptyOutDir: true,
    target: 'es2020',
    rollupOptions: {
      input: {
        titaniumWasmWorker: path.resolve(rootDir, 'src/workers/titaniumWasmWorker.js'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
