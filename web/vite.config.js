import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titaniumProxyPlugin } from './vite-titanium-proxy.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig(({ mode }) => {
  const ghPages = mode === 'ghpages';
  return {
    root: '.',
    base: ghPages ? '/Titanium-Website/' : '/',
    plugins: ghPages ? [] : [titaniumProxyPlugin()],
    server: {
      port: 5173,
      open: true,
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
      fs: {
        allow: [rootDir, path.resolve(rootDir, '..')],
      },
    },
    preview: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      },
    },
    worker: {
      format: 'es',
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          main: path.resolve(rootDir, 'index.html'),
          bench: path.resolve(rootDir, 'bench.html'),
          smoke: path.resolve(rootDir, 'smoke.html'),
        },
      },
    },
  };
});
