/**
 * Codec between the site's QuoridorBoard model and the quoridor-zero.ink REST API.
 *
 * zero.ink state schema (see memory/zeroink-api-protocol):
 * zero.ink state schema (POST /api/play `state` payload):
 *   { currentPlayer:0|1, player0Cell, player1Cell, player0Walls, player1Walls,
 *     horizontalWalls:[{x,y}], verticalWalls:[{x,y}] }
 *   cell = row0*9 + col0   (col0,row0 are 0-based, 0..8)
 *   player0 starts cell 4  (col4,row0)  == our White {e,1}  goal row8
 *   player1 starts cell 76 (col4,row8)  == our Black {e,9}  goal row0
 *   walls {x,y} on the 8x8 slot grid, x,y in 0..7
 *
 * Mapping to our model is DIRECT (no row flip): our player1/White = zero.ink player0,
 * our player2/Black = zero.ink player1, our row r (1..9) -> row0 = r-1, our column
 * 'a'..'i' -> col0 0..8. Wall anchor {column 'a'..'h', row 1..8} -> {x:col0, y:row-1}.
 */

import { WallType, parseAlgebraic } from './gameLogic.js';

const COLUMN_BASE = 97; // 'a'

/** 0-based column index for an algebraic column letter ('a' -> 0). */
function col0(column) {
  return column.charCodeAt(0) - COLUMN_BASE;
}

/** zero.ink cell index for an algebraic coordinate {column, row}. */
export function cellOf({ column, row }) {
  return (row - 1) * 9 + col0(column);
}

/** Inverse: zero.ink cell index -> algebraic coordinate {column, row}. */
export function coordinateOfCell(cell) {
  const r0 = Math.floor(cell / 9);
  const c0 = cell % 9;
  return { column: String.fromCharCode(COLUMN_BASE + c0), row: r0 + 1 };
}

/** Wall anchor {column,row} -> zero.ink slot {x,y}. */
export function wallSlotOf({ column, row }) {
  return { x: col0(column), y: row - 1 };
}

/** zero.ink slot {x,y} -> wall anchor {column,row}. */
export function coordinateOfWallSlot({ x, y }) {
  return { column: String.fromCharCode(COLUMN_BASE + x), row: y + 1 };
}

/**
 * Build a zero.ink `state` object from a QuoridorBoard (post-replay).
 * Uses only public accessors.
 */
export function boardToZeroInkState(board) {
  const horizontalWalls = [];
  const verticalWalls = [];
  for (const [wallType, coordinate] of board.getWalls()) {
    const slot = wallSlotOf(coordinate);
    if (wallType === WallType.Horizontal) {
      horizontalWalls.push(slot);
    } else {
      verticalWalls.push(slot);
    }
  }
  return {
    currentPlayer: board.playerToMove() - 1,
    player0Cell: cellOf(board.playerPosition({ playerNum: 1 })),
    player1Cell: cellOf(board.playerPosition({ playerNum: 2 })),
    player0Walls: board.wallsRemaining({ playerNum: 1 }),
    player1Walls: board.wallsRemaining({ playerNum: 2 }),
    horizontalWalls,
    verticalWalls,
  };
}

/**
 * Convert a zero.ink move object back into our algebraic notation.
 *   pawn  -> "e3"
 *   wall  -> "d2h" / "d2v"
 */
export function zeroInkMoveToAlgebraic(move) {
  if (!move || typeof move !== 'object') {
    throw new Error('zero.ink move missing');
  }
  if (move.kind === 'pawn') {
    const { column, row } = coordinateOfCell(move.target);
    return `${column}${row}`;
  }
  if (move.kind === 'wall') {
    const { column, row } = coordinateOfWallSlot({ x: move.x, y: move.y });
    // bot-move uses "h"/"v"; analysis endpoints use "horizontal"/"vertical".
    const suffix = String(move.orientation).toLowerCase().startsWith('h') ? 'h' : 'v';
    return `${column}${row}${suffix}`;
  }
  throw new Error(`Unknown zero.ink move kind: ${move.kind}`);
}

/** Convert a zero.ink move object directly into our action object. */
export function zeroInkMoveToAction(move) {
  return parseAlgebraic(zeroInkMoveToAlgebraic(move));
}
