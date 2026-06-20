import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { titaniumProxyPlugin } from './vite-titanium-proxy.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
export default defineConfig(({ mode }) => {
  const ghPages = mode === 'ghpages';
  return {
    root: '.',
    base: ghPages ? '/Titanium-Quoridor-Website/' : '/',
    plugins: ghPages ? [] : [titaniumProxyPlugin()],
    server: {
      port: 5173,
      open: true,
      fs: {
        allow: [rootDir, path.resolve(rootDir, '..')],
      },
      // quoridor-zero.ink sends no CORS headers — proxy it server-side in dev.
      proxy: {
        '/zeroink': {
          target: 'https://quoridor-zero.ink',
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/zeroink/, ''),
        },
      },
    },
    worker: {
      format: 'es',
    },
    build: {
      emptyOutDir: false,
    },
  };
});
