/**
 * Compile site/engine (Rust) → web/src/wasm/titanium for GitHub Pages.
 * Requires: rustup target add wasm32-unknown-unknown, cargo install wasm-pack
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const engineDir = path.resolve(webDir, '..', 'engine');
const outDir = path.join(webDir, 'src', 'wasm', 'titanium');

const result = spawnSync(
  'wasm-pack',
  [
    'build',
    '--release',
    '--no-default-features',
    '--features',
    'wasm',
    '--out-dir',
    outDir,
    '--out-name',
    'titanium',
  ],
  { cwd: engineDir, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
