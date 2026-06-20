/**
 * Titanium WASM legality oracle — availability, false-rejection regression, position keys.
 */

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { parseAlgebraic, QuoridorBoard } from '../lib/gameLogic.js';
import {
  canonicalPositionKeyFromActions,
  canonicalPositionKeyFromBoard,
  canonicalStateFromBoard,
  legalMovesFromBoard,
  validateEngineMoveBeforeCommit,
} from '../lib/canonicalState.js';
import { TitaniumLegalityOracle } from '../lib/titaniumLegalityOracle.js';
import {
  createTitaniumLegalityRuntime,
  wasmModulePath,
} from '../lib/titaniumLegalityRuntime.node.js';
import { validateMoveLegality } from '../lib/validateMoveLegality.js';
import {
  TitaniumOracleStatus,
  unavailableTitaniumOracle,
} from '../lib/titaniumOracleResult.js';
import { assertEnumerationPreservesPosition, enumerateTitaniumLegalMoves } from '../lib/titaniumLegalityCore.js';
import { WasmEngine } from '../wasm/titanium/titanium.js';
import { readFileSync } from 'node:fs';
import { initSync } from '../wasm/titanium/titanium.js';

const wasmAvailable = existsSync(wasmModulePath());

function assertEqual(actual, expected, label) {
  assert.equal(actual, expected, label);
}

function assertIncludes(setOrArray, move, label) {
  const set = setOrArray instanceof Set ? setOrArray : new Set(setOrArray);
  assert(set.has(move), `${label}: missing ${move}`);
}

console.log('\n[positionKey] start and after e2');
const startKey = canonicalPositionKeyFromActions([]);
assertEqual(startKey, 'wp=e1|bp=e9|stm=1|ww=10|bw=10|h=|v=', 'start key');
const afterE2Key = canonicalPositionKeyFromActions([parseAlgebraic('e2')]);
assertEqual(afterE2Key, 'wp=e2|bp=e9|stm=2|ww=10|bw=10|h=|v=', 'after e2 key');
assert(startKey.length > 0, 'start key non-empty');
assert(afterE2Key.length > 0, 'after e2 key non-empty');

console.log('\n[positionKey] stm and wall count change key');
const board = new QuoridorBoard();
board.takeAction(parseAlgebraic('e2'));
const stmKey = canonicalPositionKeyFromBoard(board);
assert(stmKey.includes('stm=2'), 'stm changes key');

console.log('\n[gate] identity-only validateEngineMoveBeforeCommit');
const startBoard = new QuoridorBoard();
const startCanon = canonicalStateFromBoard(startBoard);
const startLegal = legalMovesFromBoard(startBoard);
const ok = validateEngineMoveBeforeCommit({
  move: 'e2',
  state: startCanon,
  request: { requestSeq: 2, gameGeneration: 1, positionKey: startKey, seatIndex: 0, sideToMove: 1 },
  current: { requestSeq: 2, gameGeneration: 1, positionKey: startKey, seatIndex: 0 },
  canonicalLegalMoves: startLegal,
});
assert(ok.ok, 'legal move passes identity gate');
const stale = validateEngineMoveBeforeCommit({
  move: 'e2',
  state: startCanon,
  request: { requestSeq: 1, gameGeneration: 1, positionKey: startKey, seatIndex: 0, sideToMove: 1 },
  current: { requestSeq: 2, gameGeneration: 1, positionKey: startKey, seatIndex: 0 },
  canonicalLegalMoves: startLegal,
});
assertEqual(stale.reason, 'stale-request-seq', 'stale seq rejected');

console.log('\n[legality] oracle unavailable is not titanium-illegal');
const failingOracle = {
  legalMoves: async () =>
    unavailableTitaniumOracle({
      positionKey: startKey,
      source: 'mock',
      error: new Error('init failed'),
    }),
};
const unavailable = await validateMoveLegality({
  move: 'e2',
  canonicalLegalMoves: startLegal,
  titaniumOracle: failingOracle,
  historyTokens: [],
  positionKey: startKey,
});
assertEqual(unavailable.reason, 'titanium-oracle-unavailable', 'unavailable reason');
assert(unavailable.titanium.status === TitaniumOracleStatus.UNAVAILABLE, 'unavailable status');

console.log('\n[legality] true titanium disagreement');
const disagreeOracle = {
  legalMoves: async () => ({
    status: TitaniumOracleStatus.AVAILABLE,
    moves: new Set(['d2']),
    positionKey: startKey,
    source: 'mock',
    error: null,
  }),
};
const tiIllegal = await validateMoveLegality({
  move: 'e2',
  canonicalLegalMoves: startLegal,
  titaniumOracle: disagreeOracle,
  historyTokens: [],
  positionKey: startKey,
});
assertEqual(tiIllegal.reason, 'titanium-illegal', 'true titanium illegal');

if (wasmAvailable) {
  console.log('\n[oracle] WASM start position');
  const oracle = new TitaniumLegalityOracle({ createRuntime: createTitaniumLegalityRuntime });
  await oracle.ensureReady();
  const startResult = await oracle.legalMoves({
    historyTokens: [],
    positionKey: startKey,
  });
  assertEqual(startResult.status, TitaniumOracleStatus.AVAILABLE, 'start available');
  assertEqual(startResult.moves.size, 131, 'start move count');
  assertIncludes(startResult.moves, 'e2', 'start contains e2');
  assertIncludes(startResult.moves, 'd1', 'start contains d1');
  assertIncludes(startResult.moves, 'f1', 'start contains f1');

  console.log('\n[oracle] WASM after e2');
  const afterE2Result = await oracle.legalMoves({
    historyTokens: ['e2'],
    positionKey: afterE2Key,
  });
  assertEqual(afterE2Result.status, TitaniumOracleStatus.AVAILABLE, 'after e2 available');
  assertEqual(afterE2Result.moves.size, 131, 'after e2 move count');
  assertIncludes(afterE2Result.moves, 'e8', 'after e2 contains e8');
  assertIncludes(afterE2Result.moves, 'd9', 'after e2 contains d9');
  assertIncludes(afterE2Result.moves, 'f9', 'after e2 contains f9');

  console.log('\n[regression] Ka e2 from start would commit through oracle');
  const kaAccept = await validateMoveLegality({
    move: 'e2',
    canonicalLegalMoves: startLegal,
    titaniumOracle: oracle,
    historyTokens: [],
    positionKey: startKey,
  });
  assert(kaAccept.ok, 'Ka e2 accepted when oracle available');

  console.log('\n[play-now] dedicated validation signal after abort');
  const abortController = new AbortController();
  abortController.abort();
  const abortedResult = await oracle.legalMoves({
    historyTokens: [],
    positionKey: startKey,
    signal: abortController.signal,
  });
  assertEqual(abortedResult.status, TitaniumOracleStatus.UNAVAILABLE, 'aborted oracle unavailable');
  const freshResult = await oracle.legalMoves({
    historyTokens: [],
    positionKey: startKey,
  });
  assertEqual(freshResult.status, TitaniumOracleStatus.AVAILABLE, 'fresh signal succeeds');
  assertIncludes(freshResult.moves, 'e2', 'fresh signal contains e2');

  console.log('\n[oracle] enumeration preserves position (fresh engine per candidate)');
  initSync({ module: readFileSync(wasmModulePath()) });
  assertEnumerationPreservesPosition([]);
  assertEnumerationPreservesPosition(['e2']);
  const afterEnum = enumerateTitaniumLegalMoves(['e2']);
  assertEqual(afterEnum.length, 131, 'after enum still 131 moves');
  assertIncludes(afterEnum, 'e8', 'e8 still legal after full enum');
  assertIncludes(afterEnum, 'd9', 'd9 still legal after full enum');
  assertIncludes(afterEnum, 'f9', 'f9 still legal after full enum');
  const probe = new WasmEngine(false);
  probe.reset();
  const plies = probe.position('e2');
  assertEqual(plies, 1, 'probe replay unchanged after enumeration');
} else {
  console.log('\n[oracle] WASM binary missing — skipping live oracle tests');
  console.log(`  expected at: ${wasmModulePath()}`);
}

console.log('\n✓ titaniumLegalityOracle tests passed');
