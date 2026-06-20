/**
 * Authoritative canonical game-state helpers — blocked edges, paths, diagnostics.
 * Single interpretation of wall anchors (see game/coordinates.js).
 */

import {
  QuoridorBoard,
  WallType,
  toAlgebraic,
  parseAlgebraic,
  formatCoordinate,
  isWallAction,
} from './gameLogic.js';
import {
  algebraicCellToCanonical,
  algebraicWallToCanonical,
  canonicalWallToAlgebraic,
  canonicalCellToAlgebraic,
  gridIndexToCanonicalWall,
  BOARD_SIZE,
  WALL_GRID_SIZE,
} from '../game/coordinates.js';
import { screenRowIndices, screenColIndices } from './screenTransform.js';

export const THIRTY_FOUR_PLY_HISTORY =
  'e2 e8 e3 e7 e4 e6 d3h c6h f3h e4v a6v d4h h3h b3v c5v b5v c1v e7 d4 d7 c7v e8v c4 d8 c8h e8 c3 e9 c2 d9 b2 c9 b7h b9'.split(
    /\s+/,
  );

export const THIRTY_FOUR_PLY_EXPECTED = {
  ply: 34,
  sideToMove: 1,
  whitePawn: 'b2',
  blackPawn: 'b9',
  whiteWallsRemaining: 1,
  blackWallsRemaining: 4,
};

export function canonicalEdgeKey(a, b) {
  const left = a.x < b.x || (a.x === b.x && a.y <= b.y) ? a : b;
  const right = left === a ? b : a;
  return `${left.x},${left.y}|${right.x},${right.y}`;
}

export function cellKey(c) {
  return `${c.x},${c.y}`;
}

export function toAlgebraicSquare({ x, y }) {
  const alg = canonicalCellToAlgebraic(x, y);
  return `${alg.column}${alg.row}`;
}

export function toAlgebraicWall({ x, y, orientation }) {
  const wallType = orientation === 'h' ? WallType.Horizontal : WallType.Vertical;
  return toAlgebraic(canonicalWallToAlgebraic(x, y, wallType));
}

function insideBoard(c) {
  return c.x >= 0 && c.x < BOARD_SIZE && c.y >= 0 && c.y < BOARD_SIZE;
}

function orthogonalNeighbors(c) {
  return [
    { x: c.x, y: c.y + 1 },
    { x: c.x, y: c.y - 1 },
    { x: c.x + 1, y: c.y },
    { x: c.x - 1, y: c.y },
  ].filter(insideBoard);
}

export function expectedBlockedEdgesForWall({ x, y, orientation }) {
  if (orientation === 'h') {
    return [
      canonicalEdgeKey({ x, y }, { x, y: y + 1 }),
      canonicalEdgeKey({ x: x + 1, y }, { x: x + 1, y: y + 1 }),
    ];
  }
  if (orientation === 'v') {
    return [
      canonicalEdgeKey({ x, y }, { x: x + 1, y }),
      canonicalEdgeKey({ x, y: y + 1 }, { x: x + 1, y: y + 1 }),
    ];
  }
  throw new Error(`Unknown wall orientation: ${orientation}`);
}

function wallKeyToAnchor(key, wallType) {
  const column = key[0];
  const row = Number.parseInt(key.slice(1), 10);
  return algebraicWallToCanonical({ coordinate: { column, row }, wallType });
}

export function horizontalWallsFromBoard(board) {
  const out = [];
  for (const key of board._horizontalWalls) {
    const { wx, wy } = wallKeyToAnchor(key, WallType.Horizontal);
    out.push({ x: wx, y: wy, orientation: 'h' });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function verticalWallsFromBoard(board) {
  const out = [];
  for (const key of board._verticalWalls) {
    const { wx, wy } = wallKeyToAnchor(key, WallType.Vertical);
    out.push({ x: wx, y: wy, orientation: 'v' });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

export function blockedEdgesFromCanonicalWalls(state) {
  const blocked = new Set();
  for (const wall of state.horizontalWalls) {
    for (const edge of expectedBlockedEdgesForWall(wall)) {
      blocked.add(edge);
    }
  }
  for (const wall of state.verticalWalls) {
    for (const edge of expectedBlockedEdgesForWall(wall)) {
      blocked.add(edge);
    }
  }
  return blocked;
}

export function canonicalStateFromBoard(board) {
  const whiteCoord = board._playerPositions[0];
  const blackCoord = board._playerPositions[1];
  return {
    sideToMove: board.playerToMove(),
    pawns: {
      white: algebraicCellToCanonical(whiteCoord),
      black: algebraicCellToCanonical(blackCoord),
    },
    wallsRemaining: {
      white: board._wallsRemaining[0],
      black: board._wallsRemaining[1],
    },
    horizontalWalls: horizontalWallsFromBoard(board),
    verticalWalls: verticalWallsFromBoard(board),
    terminal: board.terminal(),
  };
}

export function canonicalStateFromActions(actions) {
  const board = new QuoridorBoard();
  for (const action of actions) {
    if (!board.isValid(action)) {
      throw new Error(`illegal move ${toAlgebraic(action)} at ply ${board.actions?.length ?? actions.indexOf(action) + 1}`);
    }
    board.takeAction(action);
  }
  return canonicalStateFromBoard(board);
}

export function positionKeyFromHistory(actions) {
  return actions.map((action) => toAlgebraic(action)).join('|');
}

export function legalMovesFromBoard(board) {
  return board.validActions().map((action) => toAlgebraic(action)).sort();
}

export function findCanonicalPathToGoal(state, player) {
  const start = state.pawns[player];
  const goalY = player === 'white' ? BOARD_SIZE - 1 : 0;
  const blocked = blockedEdgesFromCanonicalWalls(state);

  const queue = [start];
  const parent = new Map();
  const visited = new Set([cellKey(start)]);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.y === goalY) {
      const path = [];
      let cursor = current;
      while (cursor) {
        path.push({ ...cursor });
        cursor = parent.get(cellKey(cursor)) ?? null;
      }
      path.reverse();
      return path;
    }

    for (const next of orthogonalNeighbors(current)) {
      if (blocked.has(canonicalEdgeKey(current, next))) {
        continue;
      }
      const key = cellKey(next);
      if (visited.has(key)) {
        continue;
      }
      visited.add(key);
      parent.set(key, current);
      queue.push(next);
    }
  }

  return null;
}

export function formatCanonicalGameLog({
  history,
  state,
  legalMoves,
  positionKey,
  blockedEdges,
  isFlipped,
  titaniumLegalMoves = null,
}) {
  const whitePawn = toAlgebraicSquare(state.pawns.white);
  const blackPawn = toAlgebraicSquare(state.pawns.black);

  const horizontalWalls = state.horizontalWalls
    .map((w) => toAlgebraicWall(w))
    .sort();

  const verticalWalls = state.verticalWalls
    .map((w) => toAlgebraicWall(w))
    .sort();

  const formatEdge = (edgeKey) => {
    const [a, b] = edgeKey.split('|');
    const [ax, ay] = a.split(',').map(Number);
    const [bx, by] = b.split(',').map(Number);
    return `${toAlgebraicSquare({ x: ax, y: ay })}<->${toAlgebraicSquare({ x: bx, y: by })}`;
  };

  const sideLabel = state.sideToMove === 1 ? 'White' : 'Black';
  const lines = [
    '=== GAME STATE ===',
    `moves (${history.length}): ${history.join(' ')}`,
    `positionKey: ${positionKey}`,
    `sideToMove: ${sideLabel} (${state.sideToMove})`,
    `whitePawn: ${whitePawn}`,
    `blackPawn: ${blackPawn}`,
    `whiteWallsRemaining: ${state.wallsRemaining.white}`,
    `blackWallsRemaining: ${state.wallsRemaining.black}`,
    `horizontalWalls: ${horizontalWalls.join(' ') || '(none)'}`,
    `verticalWalls: ${verticalWalls.join(' ') || '(none)'}`,
    `blockedEdges: ${[...blockedEdges].map(formatEdge).sort().join(' ') || '(none)'}`,
    `legalMoves (${legalMoves.length}): ${legalMoves.join(' ')}`,
  ];

  if (titaniumLegalMoves) {
    lines.push(
      `titaniumLegalMoves (${titaniumLegalMoves.length}): ${titaniumLegalMoves.join(' ')}`,
    );
  }

  lines.push(`screenFlipped: ${Boolean(isFlipped)}`, '');
  return lines.join('\n');
}

export function buildDiagnosticContext({
  session,
  settings = {},
  request = {},
  move = null,
  rawResponse = null,
  decodedMove = null,
  reason = null,
  titaniumLegalMoves = null,
}) {
  const snapshot = session.getSnapshot();
  const history = snapshot.actions.map((a) => toAlgebraic(a));
  const board = session.board;
  const state = canonicalStateFromBoard(board);
  const blockedEdges = blockedEdgesFromCanonicalWalls(state);
  const legalMoves = legalMovesFromBoard(board);
  const positionKey = positionKeyFromHistory(snapshot.actions);

  const gameSection = formatCanonicalGameLog({
    history,
    state,
    legalMoves,
    positionKey,
    blockedEdges,
    isFlipped: settings.rotateBoard ?? false,
    titaniumLegalMoves,
  });

  const meta = [
    '=== ENGINE DIAGNOSTIC ===',
    reason ? `reason: ${reason}` : null,
    `historyLength: ${history.length}`,
    `controllerSeat: ${request.seatIndex ?? '?'}`,
    `sideToMove: ${state.sideToMove}`,
    `requestSeq: ${request.requestSeq ?? '?'}`,
    `gameGeneration: ${request.gameGeneration ?? '?'}`,
    `connectionEpoch: ${request.connectionEpoch ?? 'n/a'}`,
    rawResponse != null ? `rawResponse: ${String(rawResponse)}` : null,
    decodedMove != null ? `decodedMove: ${decodedMove}` : null,
    move != null ? `move: ${move}` : null,
    '',
    gameSection,
  ].filter((line) => line != null);

  return meta.join('\n');
}

export function validateEngineMoveBeforeCommit({
  move,
  state,
  request,
  current,
  canonicalLegalMoves,
  titaniumLegalMoves,
}) {
  const canonSet = new Set(canonicalLegalMoves);
  const tiSet = new Set(titaniumLegalMoves ?? canonicalLegalMoves);

  if (request.requestSeq !== current.requestSeq) {
    return { ok: false, reason: 'stale-request-seq' };
  }
  if (request.gameGeneration !== current.gameGeneration) {
    return { ok: false, reason: 'stale-game-generation' };
  }
  if (request.positionKey !== current.positionKey) {
    return { ok: false, reason: 'stale-position' };
  }
  if (request.seatIndex !== current.seatIndex) {
    return { ok: false, reason: 'wrong-seat' };
  }
  if (request.sideToMove !== state.sideToMove) {
    return { ok: false, reason: 'wrong-side' };
  }
  if (!canonSet.has(move)) {
    return { ok: false, reason: 'canonical-illegal' };
  }
  if (!tiSet.has(move)) {
    return { ok: false, reason: 'titanium-illegal' };
  }
  return { ok: true };
}

export function assertPostWallInvariants(state) {
  const whitePath = findCanonicalPathToGoal(state, 'white');
  const blackPath = findCanonicalPathToGoal(state, 'black');
  if (!whitePath || !blackPath) {
    return { ok: false, reason: 'path-cut-after-wall' };
  }
  if (state.wallsRemaining.white < 0 || state.wallsRemaining.black < 0) {
    return { ok: false, reason: 'negative-wall-count' };
  }
  for (const wall of [...state.horizontalWalls, ...state.verticalWalls]) {
    if (wall.x < 0 || wall.x >= WALL_GRID_SIZE || wall.y < 0 || wall.y >= WALL_GRID_SIZE) {
      return { ok: false, reason: 'wall-anchor-out-of-range' };
    }
  }
  return { ok: true };
}

/** Pure enumeration of wall slot metadata (mirrors board grid walk). */
export function enumerateWallSlots(numRows, numCols, isFlipped, placedWallKeys = new Set()) {
  const slots = [];
  for (const p of screenRowIndices(numRows, isFlipped)) {
    for (const h of screenColIndices(numCols, isFlipped)) {
      const anchor = gridIndexToCanonicalWall(h, p, numRows, numCols, isFlipped);
      if (!anchor) {
        continue;
      }
      const wallType = anchor.wallType === 'h' ? WallType.Horizontal : WallType.Vertical;
      const action = canonicalWallToAlgebraic(anchor.wx, anchor.wy, anchor.wallType);
      const key = toAlgebraic({ coordinate: action.coordinate, wallType });
      slots.push({
        key,
        x: anchor.wx,
        y: anchor.wy,
        orientation: anchor.wallType,
        h,
        p,
        placed: placedWallKeys.has(key),
      });
    }
  }
  return slots;
}

export function isWhiteGoalSquare(x, y, numRows = BOARD_SIZE) {
  return y === numRows - 1;
}

export function isBlackGoalSquare(x, y) {
  return y === 0;
}

export function isWhiteWin(board) {
  const pos = board._playerPositions[0];
  return board.isCoordinateGoal(1, pos);
}

export function isBlackWin(board) {
  const pos = board._playerPositions[1];
  return board.isCoordinateGoal(2, pos);
}

export async function filterTitaniumLegalMoves(historyTokens, candidates) {
  const { validateMovesWithRust } = await import('./rustMoveValidate.js');
  const legal = [];
  for (const move of candidates) {
    const trial = [...historyTokens, move];
    const result = await validateMovesWithRust(trial);
    if (result.ok) {
      legal.push(move);
    }
  }
  return legal;
}

export function replayHistory(tokens) {
  const actions = tokens.map((t) => parseAlgebraic(t));
  const snapshots = [];
  const partial = [];
  for (const action of actions) {
    partial.push(action);
    const board = new QuoridorBoard();
    for (const a of partial) {
      board.takeAction(a);
    }
    const state = canonicalStateFromBoard(board);
    snapshots.push({
      ply: partial.length,
      state,
      legalMoves: legalMovesFromBoard(board),
      blockedEdges: blockedEdgesFromCanonicalWalls(state),
      positionKey: positionKeyFromHistory(partial),
      whitePath: findCanonicalPathToGoal(state, 'white'),
      blackPath: findCanonicalPathToGoal(state, 'black'),
    });
  }
  return snapshots;
}
