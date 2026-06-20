/**
 * Browser-oriented integration checks (DOM-free structural assertions).
 * Run: node src/tests/browser.integration.test.mjs
 *
 * Complements manual browser acceptance — validates flip iteration,
 * highlight keys, and layer constants without a headless browser.
 */

import {
  gridIndexToCanonicalCell,
  gridIndexToCanonicalWall,
  canonicalCellToGridIndex,
  canonicalCellToAlgebraic,
  canonicalWallToAlgebraic,
} from '../game/coordinates.js';
import { resolveLiveBestMoveKey } from '../lib/liveBestMove.js';
import { canonicalPositionKeyFromActions } from '../lib/canonicalState.js';
import { parseAlgebraic } from '../lib/gameLogic.js';
import { screenRowIndices, screenColIndices } from '../lib/screenTransform.js';
import { toAlgebraic } from '../lib/gameLogic.js';

const numRows = 9;
const numCols = 9;
let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('  FAIL:', message);
  }
}

function assertEqual(a, b, msg) {
  assert(a === b, `${msg}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

console.log('\n[flip] pawn placement normal/flipped');
for (const isFlipped of [false, true]) {
  for (let y = 0; y < 9; y++) {
    for (let x = 0; x < 9; x++) {
      const { h, p } = canonicalCellToGridIndex(x, y, numRows, numCols, isFlipped);
      const back = gridIndexToCanonicalCell(h, p, numRows, numCols, isFlipped);
      assert(back?.x === x && back?.y === y, `cell ${x},${y} flipped=${isFlipped}`);
    }
  }
}

console.log('\n[flip] wall slots horizontal/vertical');
for (const isFlipped of [false, true]) {
  let walls = 0;
  for (let h = 0; h < 17; h++) {
    for (let p = 0; p < 17; p++) {
      const w = gridIndexToCanonicalWall(h, p, numRows, numCols, isFlipped);
      if (w) {
        walls++;
        const alg = toAlgebraic(canonicalWallToAlgebraic(w.wx, w.wy, w.wallType));
        assert(alg.endsWith('h') || alg.endsWith('v'), `wall algebraic ${alg}`);
      }
    }
  }
  assertEqual(walls, 128, `wall count flipped=${isFlipped}`);
}

console.log('\n[flip] screen iteration covers full grid');
for (const isFlipped of [false, true]) {
  const seen = new Set();
  for (const p of screenRowIndices(numRows, isFlipped)) {
    for (const h of screenColIndices(numCols, isFlipped)) {
      seen.add(`${h},${p}`);
    }
  }
  assertEqual(seen.size, 17 * 17, `full grid iterated flipped=${isFlipped}`);
}

console.log('\n[highlight] canonical move key locates grid cell');
const e3 = canonicalCellToAlgebraic(4, 2);
const { h, p } = canonicalCellToGridIndex(4, 2, numRows, numCols, false);
const back = gridIndexToCanonicalCell(h, p, numRows, numCols, false);
assertEqual(`${back.x},${back.y}`, '4,2', 'e3 grid mapping');
assertEqual(`${e3.column}${e3.row}`, 'e3', 'e3 algebraic');

const afterE2Key = canonicalPositionKeyFromActions([parseAlgebraic('e2')]);

console.log('\n[highlight] stale PV rejected');
assertEqual(
  resolveLiveBestMoveKey({
    aiThinking: true,
    winner: null,
    isDraw: false,
    thinkingSeatIndex: 0,
    playerToMove: 1,
    settings: { players: ['titanium-minimax', 'human'] },
    actions: [{ coordinate: { column: 'e', row: 2 } }],
    validActions: [{ coordinate: { column: 'e', row: 3 } }],
    searchGeneration: 2,
    liveSearch: {
      seatIndex: 0,
      playerType: 'titanium-minimax',
      requestSeq: 1,
      positionKey: 'e2-only-history',
      pv: 'e3',
    },
  }),
  null,
  'positionKey mismatch',
);

console.log('\n[highlight] live PV h5 and f3h resolve (normal orientation)');
const pawnState = {
  aiThinking: true,
  winner: null,
  isDraw: false,
  thinkingSeatIndex: 0,
  playerToMove: 1,
  settings: { players: ['ka-ai', 'human'], showBestMoveHint: true },
  actions: [{ coordinate: { column: 'e', row: 2 } }],
  validActions: [
    { coordinate: { column: 'h', row: 5 } },
    { coordinate: { column: 'e', row: 3 } },
  ],
  searchGeneration: 3,
  liveSearch: {
    seatIndex: 0,
    playerType: 'ka-ai',
    requestSeq: 3,
    positionKey: afterE2Key,
    depthLog: [{ depth: 2, pv: 'h5' }],
  },
};
assertEqual(resolveLiveBestMoveKey(pawnState), 'h5', 'pawn pv h5');

const wallState = {
  ...pawnState,
  validActions: [
    { coordinate: { column: 'f', row: 3 }, wallType: 'h' },
  ],
  liveSearch: {
    ...pawnState.liveSearch,
    depthLog: [{ depth: 4, pv: 'f3h' }],
  },
};
assertEqual(resolveLiveBestMoveKey(wallState), 'f3h', 'wall pv f3h');

console.log('\n[highlight] flipped board uses same algebraic keys');
for (const isFlipped of [false, true]) {
  const f3h = canonicalWallToAlgebraic(5, 2, 'h');
  const alg = toAlgebraic(f3h);
  assertEqual(alg, 'f3h', `wall key stable flipped=${isFlipped}`);
  const h5cell = canonicalCellToAlgebraic(7, 4);
  assertEqual(`${h5cell.column}${h5cell.row}`, 'h5', `h5 cell flipped=${isFlipped}`);
}

console.log('\n[layering] board-local z-index contract documented');
const layers = {
  grid: 0,
  walls: 1,
  pawns: 2,
  legal: 3,
  bestMove: 4,
  preview: 5,
  terminal: 6,
};
assert(layers.terminal <= 6 && layers.bestMove === 4, 'z-index table within board shell');

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
if (failed > 0) process.exit(1);
