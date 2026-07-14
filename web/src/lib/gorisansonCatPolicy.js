import { QuoridorBoard, parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { catSquareIndex, indexCatWalls } from './catHeatmap.js';
import {
  GORISANSON_NET_MEDIUM,
  migrateGorisansonNet,
} from './timeControl.js';

export function isGorisansonCatPolicy(gorisansonNet) {
  return migrateGorisansonNet(gorisansonNet) === GORISANSON_NET_MEDIUM;
}

/**
 * CAT corridor snapshot → per-algebraic-move rollout/selection weights.
 * Uses wall heat from CAT and pawn-destination square heat.
 */
export function buildCatMoveWeights(algebraicMoves, catSnapshot) {
  if (!catSnapshot?.squares?.length) {
    return null;
  }
  const wallByAlg = indexCatWalls(catSnapshot.walls);
  const squares = catSnapshot.squares;
  const board = new QuoridorBoard();
  for (const token of algebraicMoves ?? []) {
    board.takeAction(parseAlgebraic(token));
  }

  const weights = {};
  const pawnFloor = 1;
  const wallFloor = 8;

  for (const action of board.validPawnMoveActions()) {
    const alg = toAlgebraic(action);
    const y = action.coordinate.row - 1;
    const x = action.coordinate.column.charCodeAt(0) - 97;
    const idx = catSquareIndex(8 - y, x);
    const heat = Number(squares[idx] ?? 0);
    weights[alg] = pawnFloor + Math.max(0, heat);
  }

  for (const action of board.validWallActions()) {
    const alg = toAlgebraic(action);
    const entry = wallByAlg.get(alg);
    if (!entry || entry.skip) {
      weights[alg] = wallFloor;
      continue;
    }
    const heat = Number(entry.heat ?? entry.directHeat ?? 0);
    weights[alg] = wallFloor + Math.max(0, heat);
  }

  return Object.keys(weights).length ? weights : null;
}
