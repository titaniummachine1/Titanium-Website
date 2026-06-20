/**
 * Site logic tests — live best move, play-now guards, flip labels.
 * Run: node src/tests/siteLogic.test.mjs
 */

import { resolveLiveBestMoveKey, canPlayNow, pvFirstMoveFromLiveSearch } from '../lib/liveBestMove.js';
import {
  formatScoreForCard,
  TITANIUM_MATE_VALUE,
  quoridorMovesFromMatePlies,
} from '../lib/engineScore.js';
import { canonicalPositionKeyFromActions } from '../lib/canonicalState.js';
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
    positionKey: canonicalPositionKeyFromActions([]),
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

console.log('\n[mate] Quoridor moves from engine plies (AceV13 parity)');
assertEqual(quoridorMovesFromMatePlies(1), 1, 'mate in 1 ply = 1 move');
assertEqual(quoridorMovesFromMatePlies(2), 1, 'mate in 2 plies = 1 move');
assertEqual(quoridorMovesFromMatePlies(4), 2, 'mate in 4 plies = 2 moves');
assertEqual(
  formatScoreForCard(TITANIUM_MATE_VALUE - 4),
  'Win in 2',
  'titanium mate score uses half-plies as moves',
);
assertEqual(
  formatScoreForCard(TITANIUM_MATE_VALUE - 1),
  'Win in 1',
  'mate in 1 ply displays Win in 1',
);

console.log('\n[legality] user midgame line replays legally');
import { QuoridorBoard, parseAlgebraic } from '../lib/gameLogic.js';
import { GameSession } from '../game/gameSession.js';
const userLine =
  'e2 e8 e3 e7 e4 e6 d3h e6h f3h c6h h3h e4v b3h d6 a4v a6h c5v g6h e5 d5 e6 d4 f6 h5v a2h c4 f5 b4 g5 b5 c2h b6 h5 g4h g5 a6 f5 a5 f4 a4 g4 a3 h4'.split(
    /\s+/,
  );
const midBoard = new QuoridorBoard();
for (const token of userLine) {
  const action = parseAlgebraic(token);
  assert(midBoard.isValid(action), `user line legal at ${token}`);
  midBoard.takeAction(action);
}
assertEqual(midBoard.validActions().length, 78, 'user midgame legal move count');

console.log('\n[legality] 62-ply line ends with Black win on g1');
const winLine =
  'e2 e8 e3 e7 e4 e6 d3h e6h f3h c6h h3h e4v b3h d6 a4v a6h c5v g6h e5 d5 e6 d4 f6 h5v a2h c4 f5 b4 g4h h7h f4 b5 g4 f7h h4 b6 i4 a6 i5 a5 i6 a4 i7 a3 h7 b3 c2h c3 g7 d3 e2h e3 f7 d7h e7 f3 d7 g3 c7 g2 c8 g1'.split(
    /\s+/,
  );
const winSession = new GameSession();
for (const token of winLine) {
  assert(winSession.applyAction(parseAlgebraic(token)), `62-ply applies ${token}`);
}
assertEqual(winSession.winner, 2, 'Black wins on g1');
assertEqual(winSession.getSnapshot().validActions.length, 0, 'no legal moves after win');

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
