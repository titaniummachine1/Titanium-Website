/**
 * Site logic tests — live best move, play-now guards, flip labels.
 * Run: node src/tests/siteLogic.test.mjs
 */

import { resolveLiveBestMoveKey, canPlayNow, pvFirstMoveFromLiveSearch } from '../lib/liveBestMove.js';
import {
  screenRowLabel,
  screenColumnLabel,
  screenRowIndices,
  screenColIndices,
} from '../lib/screenTransform.js';
import { PlayerType } from '../lib/engineConfig.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) passed++;
  else {
    failed++;
    console.error('  FAIL:', message);
  }
}

function assertEqual(a, b, message) {
  assert(a === b, `${message}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
}

console.log('\n[liveBestMove] PV extraction');
assertEqual(
  pvFirstMoveFromLiveSearch({ pv: 'e3 e4 d3', depthLog: [] }),
  'e3',
  'string pv first token',
);
assertEqual(
  pvFirstMoveFromLiveSearch({ depthLog: [{ depth: 4, pv: 'g3 g4' }] }),
  'g3',
  'depthLog pv first token',
);
assertEqual(
  pvFirstMoveFromLiveSearch({ rootMoves: [{ move: 'f5' }] }),
  'f5',
  'rootMoves fallback',
);

assertEqual(
  pvFirstMoveFromLiveSearch({ depthLog: [{ depth: 4, pv: 'pv f3h e2' }] }),
  'f3h',
  'depthLog strips pv prefix',
);

console.log('\n[liveBestMove] identity checks');
const baseState = {
  aiThinking: true,
  winner: null,
  isDraw: false,
  thinkingSeatIndex: 0,
  playerToMove: 1,
  settings: { players: [PlayerType.TitaniumMinimax, PlayerType.Human] },
  actions: [],
  validActions: [{ coordinate: { column: 'e', row: 3 } }],
  searchGeneration: 7,
  liveSearch: {
    seatIndex: 0,
    playerType: PlayerType.TitaniumMinimax,
    requestSeq: 7,
    positionKey: '',
    pv: 'e3',
  },
};

assertEqual(resolveLiveBestMoveKey(baseState), 'e3', 'valid live pv');
assertEqual(
  resolveLiveBestMoveKey({ ...baseState, liveSearch: { ...baseState.liveSearch, requestSeq: 6 } }),
  null,
  'stale generation rejected',
);
assertEqual(
  resolveLiveBestMoveKey({ ...baseState, liveSearch: { ...baseState.liveSearch, pv: 'z9' } }),
  null,
  'illegal pv rejected',
);
assert(canPlayNow(baseState), 'canPlayNow when live pv legal');

console.log('\n[liveBestMove] last committed move not highlighted');
assertEqual(
  resolveLiveBestMoveKey({
    ...baseState,
    actions: [{ coordinate: { column: 'e', row: 2 } }],
    liveSearch: null,
  }),
  null,
  'no highlight without live search',
);

console.log('\n[screenTransform] flip label order');
assertEqual(screenRowLabel(0, 9, false), '9', 'normal top row label');
assertEqual(screenRowLabel(0, 9, true), '1', 'flipped top row label');
assertEqual(screenColumnLabel(0, false), 'a', 'normal left col');
assertEqual(screenColumnLabel(0, true), 'i', 'flipped left col');

const normalRows = screenRowIndices(9, false);
const flippedRows = screenRowIndices(9, true);
assertEqual(normalRows[0], 0, 'normal starts at p=0');
assertEqual(flippedRows[0], 16, 'flipped starts at bottom screen row');
assertEqual(screenColIndices(9, true)[0], 16, 'flipped reverses columns');

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} tests — passed ${passed}, failed ${failed}`);
if (failed > 0) process.exit(1);
