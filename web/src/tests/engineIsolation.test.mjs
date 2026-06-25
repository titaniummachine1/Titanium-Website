/**
 * Engine isolation — each AI seat owns a dedicated backend instance.
 * Run: node src/tests/engineIsolation.test.mjs
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

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

console.log('\n[isolate] native dev proxy — one titanium session child per seat');
const proxySrc = readSrc('../vite-titanium-proxy.mjs');
assert(proxySrc.includes('const seatSessions = new Map()'), 'seatSessions map');
assert(proxySrc.includes('getSeatSession(seatId'), 'getSeatSession by seatId');
assert(
  proxySrc.includes('destroySeatSession(seatId)'),
  'destroySeatSession',
);
assert(
  proxySrc.includes('usesLiveNetOverride'),
  'live weights only for titanium-v15',
);
assert(
  proxySrc.includes("mode === 'titanium-v15'"),
  'ACE v13 must not get live net override',
);

console.log('\n[isolate] WASM workers — dedicated Worker per engine client');
const tiWasmClient = readSrc('lib/titaniumWasmClient.js');
const aceWasmClient = readSrc('lib/aceRustWasmClient.js');
const tiRustClient = readSrc('lib/titaniumRustClient.js');
assert(tiWasmClient.includes('new TitaniumWasmWorker()'), 'titanium: own worker');
assert(aceWasmClient.includes('new AceRustWasmWorker()'), 'ace rust: own worker');
assert(
  controllerSrc.includes('{ seatId: this.engineSeatKey(seatIndex) }'),
  'native TitaniumEngineClient gets per-seat seatId',
);

console.log('\n[isolate] ACE v13 tiers are not Titanium live NNUE in engine routing');
const engineMod = readFileSync(
  path.resolve(WEB_SRC, '../../../engine/src/titanium/mod.rs'),
  'utf8',
);
assert(
  engineMod.includes('with_ti_movegen_frozen'),
  'ace-v13 frozen weight builder exists',
);
assert(
  engineMod.includes('"ace-v13" | "ace-v13-ti"'),
  'ace-v13 tiers map to frozen path',
);
assert(
  engineMod.includes('TitaniumSearch::grafted(g, None)'),
  'titanium-v15 still uses live grafted net',
);

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
if (failed > 0) process.exit(1);
