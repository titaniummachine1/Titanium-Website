/**
 * Compile monorepo engine (Rust) → web/src/wasm/titanium for GitHub Pages.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const webDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const monorepoEngine = path.resolve(webDir, '..', '..', 'engine');
const checkoutEngine = path.resolve(webDir, '..', 'engine');
const outDir = path.join(webDir, 'src', 'wasm', 'titanium');
const publicWasmDir = path.join(webDir, 'public', 'wasm');

const engineDir = existsSync(path.join(monorepoEngine, 'Cargo.toml'))
  ? monorepoEngine
  : checkoutEngine;
if (!existsSync(path.join(engineDir, 'Cargo.toml'))) {
  throw new Error(`Canonical engine missing: ${monorepoEngine} or ${checkoutEngine}`);
}
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

const exportScript = path.join(
  engineDir,
  '..',
  'training',
  'tools',
  'opening_book',
  'export_opening_dag_bin.py',
);
const exportResult = spawnSync('python', [exportScript], {
  cwd: monorepoEngine,
  stdio: 'inherit',
});
if (exportResult.status !== 0) {
  console.warn('[build:wasm] opening book export failed — using committed .bin if present');
}

const { RUSTFLAGS: _dropNativeRustflags, ...hostEnv } = process.env;
const threadedWasm = process.env.TITANIUM_WASM_THREADS !== '0';
const wasmFeatures = threadedWasm ? 'wasm-threads,embed-tables' : 'wasm,embed-tables';
const env = {
  ...hostEnv,
  WASM_BINDGEN: wasmBindgen,
  GIT_COMMIT_HASH: commit,
  WASM_BUILD_TIMESTAMP: buildTimestamp,
  ...(threadedWasm
    ? {
        RUSTFLAGS:
          // max-memory 256MB: the threaded build holds the main thread's local TT
          // (~26MB at TT_BITS=20) AND a shared lazy-SMP TT (~36MB of per-entry
          // RwLocks) simultaneously. The old 64MB cap overflowed during the first
          // threaded search's shared-TT allocation → handle_alloc_error abort
          // (surfaced as a bare wasm `unreachable`). 256MB gives headroom for 8
          // threads. (Shared memory reserves this as virtual address space only.)
          '-C target-feature=+atomics,+bulk-memory,+simd128 -C link-arg=--shared-memory -C link-arg=--import-memory -C link-arg=--max-memory=268435456 -C link-arg=--export=__heap_base -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base',
      }
    : {}),
};

const wasmPackArgs = [
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
    wasmFeatures,
];
if (threadedWasm) {
  wasmPackArgs.push('-Z', 'build-std=panic_abort,std');
}
const wasmPackCommand = threadedWasm ? 'rustup' : 'wasm-pack';
const wasmPackCommandArgs = threadedWasm
  ? ['run', 'nightly', 'wasm-pack', ...wasmPackArgs]
  : wasmPackArgs;

if (threadedWasm) {
  console.log('[build:wasm] threaded wasm: enabled (wasm-bindgen-rayon + SharedArrayBuffer)');
}

const result = spawnSync(wasmPackCommand, wasmPackCommandArgs, {
  cwd: engineDir,
  stdio: 'inherit',
  env,
});

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

const buildMeta = {
  engine_version: 'titanium-v16',
  git_commit: commit,
  build_timestamp: buildTimestamp,
  wasm_sha256: wasmSha256,
  wasm_bytes: readFileSync(wasmPath).byteLength,
  weights_live_sha256: weightsLiveSha256,
  features: wasmFeatures,
  wasm_threads: threadedWasm,
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

if (threadedWasm) {
  const snippetRoot = path.join(outDir, 'snippets');
  const helperDirs = existsSync(snippetRoot)
    ? readdirSync(snippetRoot).filter((name) => name.startsWith('wasm-bindgen-rayon-'))
    : [];
  for (const dir of helperDirs) {
    const helperPath = path.join(snippetRoot, dir, 'src', 'workerHelpers.js');
    if (!existsSync(helperPath)) {
      continue;
    }
    let helper = readFileSync(helperPath, 'utf8');
    if (!helper.includes("typeof self !== 'undefined'")) {
      helper = helper.replace(
        "waitForMsgType(self, 'wasm_bindgen_worker_init').then(async ({ init, receiver }) => {",
        "if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {\nwaitForMsgType(self, 'wasm_bindgen_worker_init').then(async ({ init, receiver }) => {",
      );
      helper = helper.replace(
        /(  pkg\.wbg_rayon_start_worker\(receiver\);\r?\n}\);\r?\n)(\r?\n\/\/ Note: this is never used)/,
        '$1}\n$2',
      );
      writeFileSync(helperPath, helper);
    }
  }
}

console.log(`[build:wasm] wasm sha256: ${wasmSha256}`);
console.log(`[build:wasm] commit: ${commit}`);

process.exit(0);
