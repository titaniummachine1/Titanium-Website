/**
 * Engine isolation — each AI seat owns a dedicated backend instance.
 * Run: node src/tests/engineIsolation.test.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_SRC = path.resolve(__dirname, '..');

function readSrc(relativePath) {
  return readFileSync(path.join(WEB_SRC, relativePath), 'utf8');
}

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('  FAIL:', message);
  }
}

console.log('\n[isolate] per-seat engine map in appController');
const controllerSrc = readSrc('game/appController.js');
assert(controllerSrc.includes('this.engines = new Map()'), 'engines map');
assert(controllerSrc.includes('engineSeatKey(seatIndex)'), 'seat key helper');
assert(
  controllerSrc.includes('return `seat-${seatIndex}`'),
  'unique seat-0 / seat-1 keys',
);
assert(
  controllerSrc.includes('createEngineClient(config, seatIndex)'),
  'factory receives seat index',
);
assert(
  controllerSrc.includes('destroyEngineForSeat(seatIndex)'),
  'per-seat teardown',
);

console.log('\n[isolate] Titanium native opt-in and static/WASM routing');
const viteSrc = readSrc('../vite.config.js');
const proxySrc = readSrc('../vite-titanium-proxy.mjs');
const buildWasmSrc = readSrc('../scripts/build-wasm.mjs');
const runtimeSrc = readSrc('lib/titaniumRuntime.js');
assert(viteSrc.includes('titaniumProxyPlugin'), 'dev server exposes native titanium proxy');
assert(
  viteSrc.includes('Cross-Origin-Opener-Policy') &&
    viteSrc.includes('Cross-Origin-Embedder-Policy'),
  'dev server sends isolation headers for threaded WASM',
);
assert(
  runtimeSrc.includes('import.meta.env.PROD'),
  'production build never enables native titanium',
);
assert(
  runtimeSrc.includes('resolveCores'),
  'titanium WASM uses configured thread count',
);
assert(
  controllerSrc.includes('hasNativeTitaniumLazySmp'),
  'native Lazy SMP routing uses shared runtime guard',
);
assert(
  runtimeSrc.includes("VITE_TITANIUM_NATIVE_PROXY === '1'"),
  'native Titanium proxy is explicit opt-in, not automatic dev routing',
);
assert(
  controllerSrc.includes('TitaniumEngineClient'),
  'appController can still use native titanium client when opted in',
);
assert(
  controllerSrc.includes('TitaniumWasmEngineClient'),
  'titanium keeps in-browser WASM fallback',
);
assert(
  controllerSrc.includes('AceRustWasmEngineClient'),
  'ACE Rust tiers use in-browser WASM client',
);
assert(
  proxySrc.includes("args.push('--threads', String(this.threads))"),
  'native Titanium session proxy passes thread count to engine',
);
const titaniumRustClient = readSrc('lib/titaniumRustClient.js');
assert(
  titaniumRustClient.includes('this.startSessionGenmove(history, searchCtx)'),
  'native Titanium uses warm session path for threaded alpha-beta search',
);
assert(
  titaniumRustClient.includes("op: 'go'") && titaniumRustClient.includes('cores: searchCtx.cores'),
  'native Titanium session go receives configured cores',
);

console.log('\n[isolate] WASM workers — dedicated Worker per engine client');
const tiWasmClient = readSrc('lib/titaniumWasmClient.js');
const tiWasmWorker = readSrc('workers/titaniumWasmWorker.js');
const workerBenchSrc = readSrc('bench/workerBench.mjs');
const benchHtmlSrc = readFileSync(path.resolve(WEB_SRC, '../bench.html'), 'utf8');
const viteConfigSrc = readFileSync(path.resolve(WEB_SRC, '../vite.config.js'), 'utf8');
const aceWasmClient = readSrc('lib/aceRustWasmClient.js');
assert(
  tiWasmClient.includes('resolveTitaniumSearchCores'),
  'titanium WASM resolves configured engine thread count',
);
assert(tiWasmClient.includes('await this.initWorkers'), 'titanium WASM awaits worker init before search');
assert(tiWasmWorker.includes('wasmUrl'), 'titanium WASM worker imports hashed wasm asset URL');
assert(tiWasmWorker.includes('ensureInit'), 'titanium WASM worker defines wasm init helper');
assert(aceWasmClient.includes('new AceRustWasmWorker()'), 'ace rust: own worker');
assert(
  tiWasmClient.includes('this.worker.postMessage({'),
  'titanium WASM client sends one search command to one worker host',
);
assert(
  tiWasmClient.includes('threads: this.threads'),
  'titanium WASM passes configured threads into Rust instead of JS fanout',
);
assert(
  tiWasmWorker.includes('go_threads_json(movetime, cap, depthCap, requestedThreads, onProgress)'),
  'titanium WASM worker calls standalone Rust API',
);
assert(
  tiWasmWorker.includes('initThreadPool') && tiWasmWorker.includes('crossOriginIsolated'),
  'titanium WASM worker initializes real wasm thread pool when exported',
);
assert(
  buildWasmSrc.includes('TITANIUM_WASM_THREADS') &&
    buildWasmSrc.includes('wasm-threads,embed-tables') &&
    buildWasmSrc.includes('build-std=panic_abort,std'),
  'build:wasm has explicit threaded WASM profile',
);
assert(
  benchHtmlSrc.includes('coi-serviceworker.js'),
  'browser benchmark page loads COOP/COEP bootstrap before WASM worker',
);
assert(
  viteConfigSrc.includes("bench: path.resolve(rootDir, 'bench.html')"),
  'production build deploys bench.html for threaded WASM verification',
);
assert(
  workerBenchSrc.includes('requireThreaded') &&
    workerBenchSrc.includes('helperStarts') &&
    workerBenchSrc.includes('helperNodes') &&
    workerBenchSrc.includes('e2 e8 a3h g6h b3v'),
  'browser benchmark can fail closed when WASM threads or real search regress',
);
assert(
  !tiWasmClient.includes('lmrBias') && !tiWasmWorker.includes('lmrBias'),
  'titanium WASM JS layer does not own helper LMR profiles',
);
assert(
  !tiWasmClient.includes('for (let workerId = 0; workerId < this.cores; workerId++)'),
  'titanium WASM JS layer does not distribute search across workers',
);

console.log('\n[isolate] Titanium WASM routes through one v16 engine path');
const engineWasm = readFileSync(
  path.resolve(WEB_SRC, '../../../engine/src/wasm.rs'),
  'utf8',
);
const engineCargo = readFileSync(
  path.resolve(WEB_SRC, '../../../engine/Cargo.toml'),
  'utf8',
);
assert(
  engineWasm.includes('grafted_v16'),
  'titanium-v16 WASM tier uses CAT LMR grafted_v16',
);
assert(
  engineCargo.includes('wasm-threads') && engineWasm.includes('think_with_threads'),
  'threaded WASM profile routes go_threads into Titanium Lazy SMP',
);
assert(
  !engineWasm.includes('titanium-v15') && !engineWasm.includes('grafted_frozen'),
  'Titanium WASM glue has no v15/frozen runtime branch',
);
assert(
  tiWasmWorker.includes('tierForEngineMode'),
  'titanium WASM worker maps engine mode to tier',
);

console.log('\n[isolate] load notation kicks AI on side to move');
assert(
  controllerSrc.includes('loadNotationString(text)'),
  'loadNotationString exists',
);
assert(
  /loadNotationString[\s\S]*?maybeRequestAiMove\(\)/.test(controllerSrc),
  'loadNotationString requests AI move after position rebuild',
);

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
if (failed > 0) process.exit(1);
