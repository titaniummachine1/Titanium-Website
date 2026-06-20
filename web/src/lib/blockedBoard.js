/**
 * Blocked-edge board model — same geometry as ACE v13 / coordinates.js.
 * Single source for pawn step legality on the playable board.
 */

/** Canonical dirs: 0=Up (+y), 1=Down (-y), 2=Left (-x), 3=Right (+x). */
const DIRBIT = [1, 2, 4, 8];
const DELTA_X = [0, 0, -1, 1];
const DELTA_Y = [1, -1, 0, 0];

const BORDER = new Uint8Array(81);
for (let idx = 0; idx < 81; idx++) {
  const x = idx % 9;
  const y = (idx / 9) | 0;
  BORDER[idx] =
    (y === 8 ? DIRBIT[0] : 0) |
    (y === 0 ? DIRBIT[1] : 0) |
    (x === 0 ? DIRBIT[2] : 0) |
    (x === 8 ? DIRBIT[3] : 0);
}

function cellIndex(x, y) {
  return y * 9 + x;
}

function parseWallKey(key) {
  return {
    wx: key.charCodeAt(0) - 97,
    wy: Number.parseInt(key.slice(1), 10) - 1,
  };
}

function setHorizontalWallBits(blocked, wx, wy, on) {
  const pairs = [
    [wx, wy, DIRBIT[0]],
    [wx, wy + 1, DIRBIT[1]],
    [wx + 1, wy, DIRBIT[0]],
    [wx + 1, wy + 1, DIRBIT[1]],
  ];
  for (const [x, y, bit] of pairs) {
    if (x < 0 || x > 8 || y < 0 || y > 8) {
      continue;
    }
    const idx = cellIndex(x, y);
    if (on) {
      blocked[idx] |= bit;
    } else {
      blocked[idx] &= ~bit;
    }
  }
}

function setVerticalWallBits(blocked, wx, wy, on) {
  const pairs = [
    [wx, wy, DIRBIT[3]],
    [wx + 1, wy, DIRBIT[2]],
    [wx, wy + 1, DIRBIT[3]],
    [wx + 1, wy + 1, DIRBIT[2]],
  ];
  for (const [x, y, bit] of pairs) {
    if (x < 0 || x > 8 || y < 0 || y > 8) {
      continue;
    }
    const idx = cellIndex(x, y);
    if (on) {
      blocked[idx] |= bit;
    } else {
      blocked[idx] &= ~bit;
    }
  }
}

/** Rebuild ACE-style blocked edge bits from QuoridorBoard wall sets. */
export function blockedEdgesFromBoard(board) {
  const blocked = new Uint8Array(81);
  for (const key of board._horizontalWalls) {
    const { wx, wy } = parseWallKey(key);
    setHorizontalWallBits(blocked, wx, wy, true);
  }
  for (const key of board._verticalWalls) {
    const { wx, wy } = parseWallKey(key);
    setVerticalWallBits(blocked, wx, wy, true);
  }
  return blocked;
}

export function canStepFromBlocked(blocked, x, y, dir) {
  const idx = cellIndex(x, y);
  return ((blocked[idx] | BORDER[idx]) & DIRBIT[dir]) === 0;
}

function coordFromXY(x, y) {
  return { column: String.fromCharCode(97 + x), row: y + 1 };
}

function xyFromCoord(coord) {
  return {
    x: coord.column.charCodeAt(0) - 97,
    y: coord.row - 1,
  };
}

/** ACE v13 genPawnMoves on blocked[] — site canonical (x,y). */
export function pawnMovesFromBlocked(board, blocked) {
  const me = board.playerToMove() - 1;
  const from = board.playerPosition({ playerNum: me + 1 });
  const opp = board.playerPosition({ playerNum: 2 - me });
  const { x: fx, y: fy } = xyFromCoord(from);
  const { x: ox, y: oy } = xyFromCoord(opp);
  const fromIdx = cellIndex(fx, fy);
  const oppIdx = cellIndex(ox, oy);

  const moves = [];
  for (let dir = 0; dir < 4; dir++) {
    if (!canStepFromBlocked(blocked, fx, fy, dir)) {
      continue;
    }
    const tx = fx + DELTA_X[dir];
    const ty = fy + DELTA_Y[dir];
    const targetIdx = cellIndex(tx, ty);

    if (targetIdx !== oppIdx) {
      moves.push({ coordinate: coordFromXY(tx, ty) });
      continue;
    }

    if (canStepFromBlocked(blocked, ox, oy, dir)) {
      const jx = ox + DELTA_X[dir];
      const jy = oy + DELTA_Y[dir];
      moves.push({ coordinate: coordFromXY(jx, jy) });
      continue;
    }

    const perpA = dir < 2 ? 2 : 0;
    const perpB = dir < 2 ? 3 : 1;
    if (canStepFromBlocked(blocked, ox, oy, perpA)) {
      const lx = ox + DELTA_X[perpA];
      const ly = oy + DELTA_Y[perpA];
      if (cellIndex(lx, ly) !== fromIdx) {
        moves.push({ coordinate: coordFromXY(lx, ly) });
      }
    }
    if (canStepFromBlocked(blocked, ox, oy, perpB)) {
      const rx = ox + DELTA_X[perpB];
      const ry = oy + DELTA_Y[perpB];
      if (cellIndex(rx, ry) !== fromIdx) {
        moves.push({ coordinate: coordFromXY(rx, ry) });
      }
    }
  }

  return moves;
}

export function pawnCanMoveFromBlocked(blocked, fromCoord, direction) {
  const dirs = {
    up: 0,
    down: 1,
    left: 2,
    right: 3,
  };
  const dir = dirs[direction];
  if (dir == null) {
    return false;
  }
  const { x, y } = xyFromCoord(fromCoord);
  return canStepFromBlocked(blocked, x, y, dir);
}
