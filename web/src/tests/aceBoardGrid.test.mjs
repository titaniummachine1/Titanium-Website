/**
 * ACE v13 board grid parity — same cell/wall placement as AceV13.1.html.
 * Run: node src/tests/aceBoardGrid.test.mjs
 */

import assert from 'node:assert/strict';
import { QuoridorBoard, parseAlgebraic, toAlgebraic } from '../lib/gameLogic.js';
import {
  pawnCellFromCoordinate,
  algebraicToEngineMove,
  wallSlotsFromBoard,
} from '../lib/aceBoardCodec.js';
import {
  cellIndexFromGrid,
  gridFromCellIndex,
  wallGridFromSlot,
} from '../lib/aceBoardGrid.js';

console.log('\n[aceGrid] cell index round-trip (81 squares)');
{
  for (let gr = 1; gr <= 17; gr += 2) {
    for (let gc = 1; gc <= 17; gc += 2) {
      const cell = cellIndexFromGrid(gr, gc);
      const back = gridFromCellIndex(cell);
      assert.equal(back.gr, gr, `gr for cell ${cell}`);
      assert.equal(back.gc, gc, `gc for cell ${cell}`);
    }
  }
}

console.log('\n[aceGrid] start position pawns match ACE defaults');
{
  assert.equal(pawnCellFromCoordinate({ column: 'e', row: 1 }), 76);
  assert.equal(pawnCellFromCoordinate({ column: 'e', row: 9 }), 4);
  assert.deepEqual(gridFromCellIndex(76), { gr: 17, gc: 9 });
  assert.deepEqual(gridFromCellIndex(4), { gr: 1, gc: 9 });
}

console.log('\n[aceGrid] e5h wall between rows 5–6 (not above e5)');
{
  const slot = algebraicToEngineMove('e5h') - 100;
  assert.equal(slot, 28);
  const grid = wallGridFromSlot(0, slot);
  assert.equal(grid.gr, 8, 'horizontal wall CSS row');
  assert.equal(grid.gc, 9, 'horizontal wall CSS col at e');
}

console.log('\n[aceGrid] 16-ply fixture pawn and wall cells');
{
  const moves =
    'e2 e8 e3 e7 e4 e6 d3h d6h f3h f6h h3h d4v e5 e5h c5h h6h'.split(' ');
  const board = new QuoridorBoard();
  for (const m of moves) {
    board.takeAction(parseAlgebraic(m));
  }
  const whiteCell = pawnCellFromCoordinate(board._playerPositions[0]);
  const blackCell = pawnCellFromCoordinate(board._playerPositions[1]);
  assert.equal(toAlgebraic({ coordinate: board._playerPositions[0] }), 'e5');
  assert.equal(toAlgebraic({ coordinate: board._playerPositions[1] }), 'e6');
  assert.equal(whiteCell, 40);
  assert.equal(blackCell, 31);
  assert.deepEqual(gridFromCellIndex(whiteCell), { gr: 9, gc: 9 });
  assert.deepEqual(gridFromCellIndex(blackCell), { gr: 7, gc: 9 });

  const { hw } = wallSlotsFromBoard(board);
  const e5hSlot = algebraicToEngineMove('e5h') - 100;
  assert.equal(hw[e5hSlot], 1, 'e5h placed in engine slot');
  assert.equal(wallGridFromSlot(0, e5hSlot).gr, 8);
}

console.log('\n✓ aceBoardGrid tests passed');
