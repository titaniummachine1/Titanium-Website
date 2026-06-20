/**
 * Engine backend classification, canonical position keys, flip transforms.
 */

import assert from 'node:assert/strict';
import { PlayerType } from '../lib/engineConfig.js';
import {
  ENGINE_REGISTRY,
  getEngineEntry,
  getEngineEntryForPlayer,
  resolveEngineBackend,
} from '../engines/engineRegistry.js';
import {
  EngineBackendKind,
  isLocalEngineBackend,
  isRemoteEngineBackend,
  useStaticEngineBackend,
} from '../engines/engineBackend.js';
import { validateEngineResultIdentity } from '../engines/validateEngineResultIdentity.js';
import {
  canonicalPositionKey,
  canonicalPositionKeyFromActions,
  canonicalStateFromActions,
} from '../lib/canonicalState.js';
import { parseAlgebraic } from '../lib/gameLogic.js';
import {
  BOARD_SIZE,
  canonicalCellToScreen,
  screenCellToCanonical,
  canonicalCellToGridIndex,
} from '../game/coordinates.js';

function assertEqual(actual, expected, label) {
  assert.equal(actual, expected, label);
}

console.log('\n[backend] registry entries');
assert(getEngineEntry(PlayerType.Human), 'human');
assert(getEngineEntry(PlayerType.TitaniumMinimax), 'titanium live');
assert(getEngineEntry(PlayerType.KaAI), 'ka');
assertEqual(
  getEngineEntry(PlayerType.KaAI).backend,
  EngineBackendKind.REMOTE_WS,
  'ka remote',
);
assertEqual(
  getEngineEntry(PlayerType.TitaniumMinimax).backend,
  EngineBackendKind.LOCAL_WASM,
  'titanium wasm',
);
assert(isLocalEngineBackend(EngineBackendKind.LOCAL_JS));
assert(isRemoteEngineBackend(EngineBackendKind.REMOTE_WS));
assertEqual(
  resolveEngineBackend(getEngineEntry(PlayerType.GorisansonMCTS), {}),
  EngineBackendKind.LOCAL_JS,
  'gorisanson js',
);

console.log('\n[backend] local titanium is not remote');
const tiEntry = getEngineEntryForPlayer(PlayerType.TitaniumMinimax, {});
assertEqual(tiEntry.backend, EngineBackendKind.LOCAL_WASM, 'ti local wasm');
const identity = validateEngineResultIdentity({
  engineEntry: tiEntry,
  resultContext: {
    requestSeq: 1,
    gameGeneration: 0,
    positionKey: 'wp=e2|bp=e9|stm=1|ww=10|bw=10|h=|v=',
    seatIndex: 0,
    sideToMove: 1,
    engineId: PlayerType.TitaniumMinimax,
  },
  currentContext: {
    requestSeq: 1,
    gameGeneration: 0,
    positionKey: 'wp=e2|bp=e9|stm=1|ww=10|bw=10|h=|v=',
    seatIndex: 0,
    sideToMove: 1,
    engineId: PlayerType.TitaniumMinimax,
  },
});
assert(identity.ok, 'local without connectionEpoch accepted');

console.log('\n[backend] remote requires connectionEpoch');
const kaEntry = getEngineEntry(PlayerType.KaAI);
const staleConn = validateEngineResultIdentity({
  engineEntry: kaEntry,
  resultContext: {
    requestSeq: 1,
    gameGeneration: 0,
    positionKey: 'k',
    seatIndex: 1,
    sideToMove: 2,
    engineId: PlayerType.KaAI,
    connectionEpoch: 0,
  },
  currentContext: {
    requestSeq: 1,
    gameGeneration: 0,
    positionKey: 'k',
    seatIndex: 1,
    sideToMove: 2,
    engineId: PlayerType.KaAI,
    connectionEpoch: 1,
    syncState: 'SYNCED',
  },
});
assertEqual(staleConn.reason, 'stale-connection', 'epoch mismatch');

console.log('\n[positionKey] canonical after e2');
const afterE2 = canonicalPositionKeyFromActions([parseAlgebraic('e2')]);
assert(afterE2.includes('wp=e2'), 'white e2');
assert(afterE2.includes('bp=e9'), 'black e9');
assert(afterE2.includes('stm=2'), 'black to move');

console.log('\n[positionKey] transposition equality');
const a = canonicalPositionKeyFromActions([
  parseAlgebraic('e2'),
  parseAlgebraic('e8'),
]);
const b = canonicalPositionKeyFromActions([
  parseAlgebraic('e2'),
  parseAlgebraic('e8'),
]);
assertEqual(a, b, 'same line same key');

console.log('\n[flip] e2/e9 screen rows');
const e2 = { x: 4, y: 1 };
const e9 = { x: 4, y: 8 };
assertEqual(canonicalCellToScreen(e2, false).screenRow, 7, 'normal White e2 row');
assertEqual(canonicalCellToScreen(e2, true).screenRow, 1, 'flipped White e2 row');
assertEqual(canonicalCellToScreen(e9, false).screenRow, 0, 'normal Black e9 row');
assertEqual(canonicalCellToScreen(e9, true).screenRow, 8, 'flipped Black e9 row');

console.log('\n[flip] 81 cell round trips');
for (let y = 0; y < BOARD_SIZE; y += 1) {
  for (let x = 0; x < BOARD_SIZE; x += 1) {
    for (const flipped of [false, true]) {
      const screen = canonicalCellToScreen({ x, y }, flipped);
      const back = screenCellToCanonical(screen, flipped);
      assertEqual(back.x, x, `x ${x},${y} flipped=${flipped}`);
      assertEqual(back.y, y, `y ${x},${y} flipped=${flipped}`);
    }
  }
}

console.log('\n[static] production mode flag');
assert(typeof useStaticEngineBackend() === 'boolean', 'static flag');

console.log('\nengineBackend tests complete');
