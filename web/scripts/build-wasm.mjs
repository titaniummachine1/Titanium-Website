/**
 * Compile monorepo engine (Rust) → web/src/wasm/titanium for GitHub Pages.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const monorepoEngine = path.resolve(webDir, '..', '..', 'engine');
const siteEngine = path.resolve(webDir, '..', 'engine');
const outDir = path.join(webDir, 'src', 'wasm', 'titanium');
const publicWasmDir = path.join(webDir, 'public', 'wasm');

const engineDir = existsSync(path.join(monorepoEngine, 'Cargo.toml'))
  ? monorepoEngine
  : siteEngine;
console.log(`[build:wasm] engine dir: ${engineDir}`);

function sha256File(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function gitCommit() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: engineDir, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : 'unknown';
}

const wasmBindgen =
  process.env.WASM_BINDGEN ||
  (process.platform === 'win32'
    ? path.join(process.env.USERPROFILE ?? '', '.cargo', 'bin', 'wasm-bindgen.exe')
    : 'wasm-bindgen');

const buildTimestamp = new Date().toISOString();
const commit = gitCommit();
const { RUSTFLAGS: _dropNativeRustflags, ...hostEnv } = process.env;
const env = {
  ...hostEnv,
  WASM_BINDGEN: wasmBindgen,
  GIT_COMMIT_HASH: commit,
  WASM_BUILD_TIMESTAMP: buildTimestamp,
};

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

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const wasmPath = path.join(outDir, 'titanium_bg.wasm');
const wasmSha256 = sha256File(wasmPath);
const weightSrc = path.join(engineDir, 'src', 'titanium');
const weightsDir = path.join(webDir, 'public', 'weights');
mkdirSync(weightsDir, { recursive: true });
mkdirSync(publicWasmDir, { recursive: true });

const liveWeightsPath = path.join(weightSrc, 'net_weights.bin');
const weightsLiveSha256 = sha256File(liveWeightsPath);
const weightsFrozenSha256 = sha256File(path.join(weightSrc, 'net_weights_frozen.bin'));

const netWeightByteLen = readFileSync(liveWeightsPath).byteLength;

let weightsMediumSha256 = null;
let weightsMediumBytes = null;
const mediumSrc = path.join(weightSrc, 'net_weights_medium.bin');
if (existsSync(mediumSrc)) {
  const mediumBytes = readFileSync(mediumSrc);
  weightsMediumBytes = mediumBytes.byteLength;
  if (mediumBytes.byteLength !== netWeightByteLen) {
    console.warn(
      `[build:wasm] net_weights_medium.bin size ${mediumBytes.byteLength} != live weights ${netWeightByteLen}`,
    );
  }
  copyFileSync(mediumSrc, path.join(weightsDir, 'net_weights_medium.bin'));
  weightsMediumSha256 = sha256File(mediumSrc);
  console.log('[build:wasm] copied net_weights_medium.bin → public/weights/');
}

const buildMeta = {
  engine_version: 'titanium-v15',
  git_commit: commit,
  build_timestamp: buildTimestamp,
  wasm_sha256: wasmSha256,
  wasm_bytes: readFileSync(wasmPath).byteLength,
  weights_live_sha256: weightsLiveSha256,
  weights_frozen_sha256: weightsFrozenSha256,
  weights_medium_sha256: weightsMediumSha256,
  weights_medium_bytes: weightsMediumBytes,
  features: 'wasm,embed-tables',
  engine_dir: engineDir,
};

const metaJson = JSON.stringify(buildMeta, null, 2);
writeFileSync(path.join(outDir, 'build-meta.json'), metaJson);
writeFileSync(path.join(publicWasmDir, 'build-meta.json'), metaJson);

// Cache-bust WASM fetch in glue (dev + unbundled paths).
const gluePath = path.join(outDir, 'titanium.js');
let glue = readFileSync(gluePath, 'utf8');
const wasmBust = wasmSha256.slice(0, 16);
glue = glue.replace(
  "module_or_path = new URL('titanium_bg.wasm', import.meta.url);",
  `module_or_path = new URL('titanium_bg.wasm?v=${wasmBust}', import.meta.url);`,
);
writeFileSync(gluePath, glue);

console.log(`[build:wasm] wasm sha256: ${wasmSha256}`);
console.log(`[build:wasm] commit: ${commit}`);

process.exit(0);
