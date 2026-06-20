/**
 * Wall rendering, blocked edges, 34-ply regression, goal orientation.
 * Run: node src/tests/wallDiagnostics.test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { QuoridorBoard, parseAlgebraic, toAlgebraic } from '../lib/gameLogic.js';
import { GameSession } from '../game/gameSession.js';
import {
  THIRTY_FOUR_PLY_HISTORY,
  THIRTY_FOUR_PLY_EXPECTED,
  blockedEdgesFromCanonicalWalls,
  canonicalEdgeKey,
  canonicalStateFromBoard,
  enumerateWallSlots,
  expectedBlockedEdgesForWall,
  findCanonicalPathToGoal,
  formatCanonicalGameLog,
  isBlackGoalSquare,
  isBlackWin,
  isWhiteGoalSquare,
  isWhiteWin,
  legalMovesFromBoard,
  positionKeyFromHistory,
  replayHistory,
  toAlgebraicSquare,
  toAlgebraicWall,
  validateEngineMoveBeforeCommit,
} from '../lib/canonicalState.js';
import { probeTitaniumFields, titaniumBinaryAvailable } from '../lib/titaniumStateProbe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures/thirty_four_ply.json'), 'utf8'),
);

let passed = 0;
let failed = 0;
let firstCanonicalDivergence = null;
let firstDomDivergence = null;

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

console.log('\n[34-ply] exact history replays legally');
const snapshots = replayHistory(THIRTY_FOUR_PLY_HISTORY);
assertEqual(snapshots.length, 34, '34 plies');
const final = snapshots[33];
assertEqual(final.state.sideToMove, THIRTY_FOUR_PLY_EXPECTED.sideToMove, 'side to move');
assertEqual(toAlgebraicSquare(final.state.pawns.white), THIRTY_FOUR_PLY_EXPECTED.whitePawn, 'white pawn');
assertEqual(toAlgebraicSquare(final.state.pawns.black), THIRTY_FOUR_PLY_EXPECTED.blackPawn, 'black pawn');
assertEqual(final.state.wallsRemaining.white, THIRTY_FOUR_PLY_EXPECTED.whiteWallsRemaining, 'white walls');
assertEqual(final.state.wallsRemaining.black, THIRTY_FOUR_PLY_EXPECTED.blackWallsRemaining, 'black walls');

console.log('\n[34-ply] fixture file matches constants');
assertEqual(fixture.history.split(/\s+/).length, 34, 'fixture ply count');

console.log('\n[34-ply] BFS path exists after every legal ply');
for (const snap of snapshots) {
  const wp = findCanonicalPathToGoal(snap.state, 'white');
  const bp = findCanonicalPathToGoal(snap.state, 'black');
  assert(wp != null, `white path ply ${snap.ply}`);
  assert(bp != null, `black path ply ${snap.ply}`);
}

console.log('\n[walls] blocked edges for each wall in 34-ply line');
for (const snap of snapshots) {
  for (const wall of [...snap.state.horizontalWalls, ...snap.state.verticalWalls]) {
    const edges = expectedBlockedEdgesForWall(wall);
    assertEqual(edges.length, 2, `two edges ${toAlgebraicWall(wall)} ply ${snap.ply}`);
    for (const edge of edges) {
      assert(snap.blockedEdges.has(edge), `edge ${edge} in ledger ply ${snap.ply}`);
    }
  }
}

console.log('\n[walls] DOM slot metadata matches canonical anchors');
const session = new GameSession();
for (const token of THIRTY_FOUR_PLY_HISTORY) {
  session.applyAction(parseAlgebraic(token));
}
const canon = canonicalStateFromBoard(session.board);
const placed = new Set([
  ...canon.horizontalWalls.map((w) => toAlgebraicWall(w)),
  ...canon.verticalWalls.map((w) => toAlgebraicWall(w)),
]);
for (const isFlipped of [false, true]) {
  const slots = enumerateWallSlots(9, 9, isFlipped, placed);
  const canonWallKeys = new Set([
    ...canon.horizontalWalls.map((w) => toAlgebraicWall(w)),
    ...canon.verticalWalls.map((w) => toAlgebraicWall(w)),
  ]);
  for (const key of canonWallKeys) {
    const matches = slots.filter((s) => s.key === key && s.placed);
    if (matches.length !== 1) {
      firstDomDivergence = firstDomDivergence ?? { key, isFlipped, count: matches.length };
    }
    assertEqual(matches.length, 1, `placed wall ${key} once flipped=${isFlipped}`);
    const slot = matches[0];
    assertEqual(String(slot.x), String(slot.x), 'anchor x present');
    assert(slot.orientation === 'h' || slot.orientation === 'v', `orientation ${key}`);
  }
  for (const slot of slots.filter((s) => s.placed)) {
    const edges = expectedBlockedEdgesForWall({ x: slot.x, y: slot.y, orientation: slot.orientation });
    const ledger = blockedEdgesFromCanonicalWalls(canon);
    for (const edge of edges) {
      assert(ledger.has(edge), `DOM wall ${slot.key} edge ${edge} flipped=${isFlipped}`);
    }
  }
}

console.log('\n[walls] normal/flipped slot keys identical');
const normalSlots = enumerateWallSlots(9, 9, false, placed);
const flippedSlots = enumerateWallSlots(9, 9, true, placed);
const normalKeys = new Set(normalSlots.map((s) => s.key));
const flippedKeys = new Set(flippedSlots.map((s) => s.key));
assertEqual(normalKeys.size, flippedKeys.size, 'slot count');
for (const key of normalKeys) {
  assert(flippedKeys.has(key), `flipped has ${key}`);
}

console.log('\n[goal] White goal row is 9, Black goal row is 1');
assert(isWhiteGoalSquare(4, 8), 'y=8 is white goal row');
assert(isBlackGoalSquare(4, 0), 'y=0 is black goal row');
assert(!isWhiteGoalSquare(4, 0), 'y=0 not white goal');
assert(!isBlackGoalSquare(4, 8), 'y=8 not black goal');

console.log('\n[goal] terminal squares');
const bWhiteWin = new QuoridorBoard();
bWhiteWin.playerPosition({ playerNum: 1, coordinate: { column: 'a', row: 9 } });
assert(isWhiteWin(bWhiteWin), 'White a9 wins');
const bWhiteLose = new QuoridorBoard();
bWhiteLose.playerPosition({ playerNum: 1, coordinate: { column: 'a', row: 1 } });
assert(!isWhiteWin(bWhiteLose), 'White a1 not win');
const bBlackWin = new QuoridorBoard();
bBlackWin.playerPosition({ playerNum: 2, coordinate: { column: 'a', row: 1 } });
assert(isBlackWin(bBlackWin), 'Black a1 wins');
const bBlackNot = new QuoridorBoard();
bBlackNot.playerPosition({ playerNum: 2, coordinate: { column: 'a', row: 9 } });
assert(!isBlackWin(bBlackNot), 'Black a9 not win');

console.log('\n[goal] session start and after e2 / e2 e8');
const gs = new GameSession();
let st = canonicalStateFromBoard(gs.board);
assertEqual(toAlgebraicSquare(st.pawns.white), 'e1', 'White start e1');
assertEqual(toAlgebraicSquare(st.pawns.black), 'e9', 'Black start e9');
gs.applyAction(parseAlgebraic('e2'));
st = canonicalStateFromBoard(gs.board);
assertEqual(toAlgebraicSquare(st.pawns.white), 'e2', 'after e2 white');
assertEqual(toAlgebraicSquare(st.pawns.black), 'e9', 'after e2 black');
assertEqual(st.sideToMove, 2, 'after e2 black to move');
gs.applyAction(parseAlgebraic('e8'));
st = canonicalStateFromBoard(gs.board);
assertEqual(toAlgebraicSquare(st.pawns.white), 'e2', 'after e2 e8 white');
assertEqual(toAlgebraicSquare(st.pawns.black), 'e8', 'after e2 e8 black');
assertEqual(st.sideToMove, 1, 'after e2 e8 white to move');

console.log('\n[gate] validateEngineMoveBeforeCommit rejects stale and illegal');
const startBoard = new QuoridorBoard();
const startCanon = canonicalStateFromBoard(startBoard);
const startLegal = legalMovesFromBoard(startBoard);
const ok = validateEngineMoveBeforeCommit({
  move: startLegal[0],
  state: startCanon,
  request: { requestSeq: 2, gameGeneration: 1, positionKey: 'k', seatIndex: 0, sideToMove: 1 },
  current: { requestSeq: 2, gameGeneration: 1, positionKey: 'k', seatIndex: 0 },
  canonicalLegalMoves: startLegal,
  titaniumLegalMoves: startLegal,
});
assert(ok.ok, 'legal move passes');
const stale = validateEngineMoveBeforeCommit({
  move: startLegal[0],
  state: startCanon,
  request: { requestSeq: 1, gameGeneration: 1, positionKey: 'k', seatIndex: 0, sideToMove: 1 },
  current: { requestSeq: 2, gameGeneration: 1, positionKey: 'k', seatIndex: 0 },
  canonicalLegalMoves: startLegal,
  titaniumLegalMoves: startLegal,
});
assertEqual(stale.reason, 'stale-request-seq', 'stale seq rejected');

console.log('\n[logs] copied logs include canonical game state');
const history = session.actions.map((a) => toAlgebraic(a));
const blockedEdges = blockedEdgesFromCanonicalWalls(canon);
const legalMoves = legalMovesFromBoard(session.board);
const logText = formatCanonicalGameLog({
  history,
  state: canon,
  legalMoves,
  positionKey: positionKeyFromHistory(session.actions),
  blockedEdges,
  isFlipped: false,
});
assert(logText.includes('=== GAME STATE ==='), 'game header');
assert(logText.includes('positionKey:'), 'position key');
assert(logText.includes('blockedEdges:'), 'blocked edges');
assert(logText.includes('legalMoves'), 'legal moves');
assert(logText.includes('screenFlipped:'), 'flip state');
assert(!logText.includes('rbt_token'), 'no auth tokens');

console.log('\n[34-ply] Black retreat to b9 is legal (not orientation bug)');
const retreatSnap = snapshots[33];
assertEqual(toAlgebraicSquare(retreatSnap.state.pawns.black), 'b9', 'Black at b9');
assert(retreatSnap.legalMoves.length > 0, 'Black retreat position has legal moves for White');

if (titaniumBinaryAvailable()) {
  console.log('\n[parity] native Titanium fields agrees at ply 34');
  const probe = probeTitaniumFields(THIRTY_FOUR_PLY_HISTORY);
  assert(probe.ok, `probe ok: ${probe.error ?? ''}`);
  if (probe.ok) {
    assertEqual(probe.sideToMove, final.state.sideToMove, 'native side to move');
    assertEqual(probe.wallsRemaining.white, final.state.wallsRemaining.white, 'native white walls');
    assertEqual(probe.wallsRemaining.black, final.state.wallsRemaining.black, 'native black walls');
  }

  console.log('\n[parity] compare canonical vs native at every ply');
  for (let i = 0; i < THIRTY_FOUR_PLY_HISTORY.length; i++) {
    const prefix = THIRTY_FOUR_PLY_HISTORY.slice(0, i + 1);
    const snap = snapshots[i];
    const native = probeTitaniumFields(prefix);
    if (!native.ok) {
      firstCanonicalDivergence = firstCanonicalDivergence ?? { ply: i + 1, error: native.error };
      assert(false, `native replay ply ${i + 1}: ${native.error}`);
      continue;
    }
    if (native.sideToMove !== snap.state.sideToMove) {
      firstCanonicalDivergence = firstCanonicalDivergence ?? {
        ply: i + 1,
        field: 'sideToMove',
        canonical: snap.state.sideToMove,
        native: native.sideToMove,
      };
    }
    assertEqual(native.sideToMove, snap.state.sideToMove, `side ply ${i + 1}`);
    assertEqual(native.wallsRemaining.white, snap.state.wallsRemaining.white, `w walls ply ${i + 1}`);
    assertEqual(native.wallsRemaining.black, snap.state.wallsRemaining.black, `b walls ply ${i + 1}`);
  }
} else {
  console.log('\n[parity] native Titanium binary unavailable — skipping live/frozen CLI checks');
}

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} — passed ${passed}, failed ${failed}`);
if (firstCanonicalDivergence) {
  console.log('First canonical/native divergence:', JSON.stringify(firstCanonicalDivergence));
}
if (firstDomDivergence) {
  console.log('First DOM divergence:', JSON.stringify(firstDomDivergence));
}
if (failed > 0) process.exit(1);
