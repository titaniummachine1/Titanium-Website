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
const runtimeSrc = readSrc('lib/titaniumRuntime.js');
assert(viteSrc.includes('titaniumProxyPlugin'), 'dev server exposes native titanium proxy');
assert(
  runtimeSrc.includes('import.meta.env.PROD'),
  'production build never enables native titanium',
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
const aceWasmClient = readSrc('lib/aceRustWasmClient.js');
assert(
  tiWasmClient.includes('resolveTitaniumSearchCores'),
  'titanium WASM uses shared search core resolver',
);
assert(tiWasmClient.includes('await this.initWorkers'), 'titanium WASM awaits worker init before search');
assert(aceWasmClient.includes('new AceRustWasmWorker()'), 'ace rust: own worker');

console.log('\n[isolate] ACE v13 tiers are not Titanium live NNUE in engine routing');
const engineSearch = readFileSync(
  path.resolve(WEB_SRC, '../../../engine/src/titanium/search.rs'),
  'utf8',
);
const engineWasm = readFileSync(
  path.resolve(WEB_SRC, '../../../engine/src/wasm.rs'),
  'utf8',
);
assert(
  engineSearch.includes('with_ti_movegen_frozen'),
  'ace-v13 frozen weight builder exists',
);
assert(
  engineWasm.includes('"ace-v13" | "ace-v13-ti" => *TitaniumSearch::with_ti_movegen_frozen(g)'),
  'ace-v13 WASM tiers map to frozen path',
);
assert(
  engineWasm.includes('TitaniumSearch::grafted(g, None)'),
  'titanium-v15 still uses live grafted net',
);

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
if (failed > 0) process.exit(1);
