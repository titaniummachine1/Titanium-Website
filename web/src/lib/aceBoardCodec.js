/**
 * ACE / Quoridor v3 move encoding — same grid as AceV13.1.html.
 * Engine row 0 = top (algebraic row 9); row 8 = bottom (algebraic row 1).
 */

import { algebraicToV3Move, v3MoveToAlgebraic } from '../game/coordinates.js';

/** View flip — involution (ACE flipMoveId). */
export function flipMoveId(move) {
  if (move < 100) {
    return (8 - ((move / 9) | 0)) * 9 + (move % 9);
  }
  const base = move < 200 ? 100 : 200;
  const slot = move % 100;
  return base + ((7 - ((slot / 8) | 0)) * 8 + (slot % 8));
}

export function viewMove(move, isFlipped) {
  return isFlipped ? flipMoveId(move) : move;
}

export function algebraicToEngineMove(algebraic) {
  return algebraicToV3Move(algebraic);
}

export function engineMoveToAlgebraic(move) {
  return v3MoveToAlgebraic(move);
}

export function pawnCellFromCoordinate(coord) {
  const col = coord.column.charCodeAt(0) - 97;
  const row = coord.row;
  return (9 - row) * 9 + col;
}

export function coordinateFromPawnCell(cell) {
  const alg = v3MoveToAlgebraic(cell);
  return { column: alg[0], row: Number.parseInt(alg[1], 10) };
}

/** Build ACE hw/vw slot arrays from QuoridorBoard wall sets. */
export function wallSlotsFromBoard(board) {
  const hw = new Uint8Array(64);
  const vw = new Uint8Array(64);
  for (const key of board._horizontalWalls) {
    hw[algebraicToV3Move(`${key}h`) - 100] = 1;
  }
  for (const key of board._verticalWalls) {
    vw[algebraicToV3Move(`${key}v`) - 200] = 1;
  }
  return { hw, vw };
}
