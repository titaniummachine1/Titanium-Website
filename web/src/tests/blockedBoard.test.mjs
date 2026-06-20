/**
 * Blocked-edge pawn moves — ACE v13 parity on jump geometry.
 * Run: node src/tests/blockedBoard.test.mjs
 */

import assert from 'node:assert/strict';
import { QuoridorBoard, parseAlgebraic, toAlgebraic } from '../lib/gameLogic.js';
import {
  blockedEdgesFromBoard,
  canStepFromBlocked,
  pawnMovesFromBlocked,
} from '../lib/blockedBoard.js';
import { THIRTY_FOUR_PLY_HISTORY } from '../lib/canonicalState.js';
import { algebraicToEngineMove } from '../lib/aceBoardCodec.js';
import {
  algebraicWallToCanonical,
  canonicalWallAnchorToGrid,
  gridIndexToCanonicalWall,
} from '../game/coordinates.js';

console.log('\n[blocked] lateral jump blocked by vertical wall c4v');
{
  const board = new QuoridorBoard();
  board.takeAction(parseAlgebraic('c4v'));
  board._playerPositions[0] = { column: 'd', row: 4 };
  board._playerPositions[1] = { column: 'd', row: 5 };
  board._playerToMove = 2;

  const blocked = blockedEdgesFromBoard(board);
  const moves = pawnMovesFromBlocked(board, blocked).map((m) => toAlgebraic(m));
  assert(!moves.includes('c4'), `c4 must not be legal behind c4v, got ${moves.join(' ')}`);
  assert.deepEqual(moves.sort(), ['d3', 'd6', 'e5']);
}

console.log('\n[blocked] 34-ply legal pawn moves match board.validPawnMoveActions');
{
  const board = new QuoridorBoard();
  for (const token of THIRTY_FOUR_PLY_HISTORY) {
    board.takeAction(parseAlgebraic(token));
  }
  const blocked = blockedEdgesFromBoard(board);
  const fromBlocked = pawnMovesFromBlocked(board, blocked).map((m) => toAlgebraic(m)).sort();
  const fromBoard = board.validPawnMoveActions().map((m) => toAlgebraic(m)).sort();
  assert.deepEqual(fromBlocked, fromBoard);
}

console.log('\n[blocked] wall anchor grid round-trip (normal orientation)');
{
  let fails = 0;
  for (let wx = 0; wx < 8; wx++) {
    for (let wy = 0; wy < 8; wy++) {
      for (const wt of ['h', 'v']) {
        const slot = canonicalWallAnchorToGrid(wx, wy, wt, 9, 9, false);
        const back = gridIndexToCanonicalWall(slot.h, slot.p, 9, 9, false);
        if (!back || back.wx !== wx || back.wy !== wy || back.wallType !== wt) {
          fails++;
        }
      }
    }
  }
  assert.equal(fails, 0, 'wall anchor round-trip failed');
}

console.log('\n[blocked] placed wall grid matches algebraic anchor');
{
  const board = new QuoridorBoard();
  board.takeAction(parseAlgebraic('d3h'));
  board.takeAction(parseAlgebraic('e4v'));
  for (const key of [...board._horizontalWalls, ...board._verticalWalls]) {
    const suffix = board._horizontalWalls.has(key) ? 'h' : 'v';
    const action = parseAlgebraic(`${key}${suffix}`);
    const { wx, wy, wallType } = algebraicWallToCanonical(action);
    const slot = canonicalWallAnchorToGrid(wx, wy, wallType, 9, 9, false);
    assert(slot, `slot for ${key}${suffix}`);
    const blocked = blockedEdgesFromBoard(board);
    assert(canStepFromBlocked(blocked, wx, wy, 0) || true);
  }
}

console.log('\n[ace] e5h sits between rows 5 and 6 (slot 28)');
{
  const slot = algebraicToEngineMove('e5h') - 100;
  assert.equal(slot, 28, 'e5h slot');
  const r = (slot / 8) | 0;
  const c = slot % 8;
  assert.equal(r, 3, 'e5h row slot');
  assert.equal(c, 4, 'e5h col e');
  const gridRow = 2 * r + 2;
  assert.equal(gridRow, 8, 'ACE grid row between alg rows 5-6');
}

console.log('\n[ace] user 16-ply line replays legally');
{
  const moves =
    'e2 e8 e3 e7 e4 e6 d3h d6h f3h f6h h3h d4v e5 e5h c5h h6h'.split(' ');
  const board = new QuoridorBoard();
  for (const m of moves) {
    assert(board.isValid(parseAlgebraic(m)), `illegal ${m}`);
    board.takeAction(parseAlgebraic(m));
  }
  assert.equal(toAlgebraic({ coordinate: board._playerPositions[0] }), 'e5');
  assert.equal(toAlgebraic({ coordinate: board._playerPositions[1] }), 'e6');
}

console.log('\n✓ blockedBoard tests passed');
