/**
 * Compile monorepo engine (Rust) → web/src/wasm/titanium for GitHub Pages.
 * Uses ../../engine (canonical v15 + net_weights.bin), not stale site/engine submodule.
 * Requires: rustup target add wasm32-unknown-unknown, cargo install wasm-pack
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const monorepoEngine = path.resolve(webDir, '..', '..', 'engine');
const siteEngine = path.resolve(webDir, '..', 'engine');
const outDir = path.join(webDir, 'src', 'wasm', 'titanium');

const engineDir = existsSync(path.join(monorepoEngine, 'src', 'wasm.rs'))
  ? monorepoEngine
  : siteEngine;
console.log(`[build:wasm] engine dir: ${engineDir}`);

const wasmBindgen =
  process.env.WASM_BINDGEN ||
  (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'wasm-bindgen.exe')
    : 'wasm-bindgen');

const env = { ...process.env, WASM_BINDGEN: wasmBindgen };

const result = spawnSync(
  'wasm-pack',
  [
    'build',
    '--release',
    '--target',
    'web',
    '--out-dir',
    outDir,
    '--out-name',
    'titanium',
    '--',
    '--no-default-features',
    '--features',
    'wasm,embed-tables',
  ],
  { cwd: engineDir, stdio: 'inherit', env },
);

process.exit(result.status ?? 1);
