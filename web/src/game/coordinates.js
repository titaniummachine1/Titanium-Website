/**
 * Canonical Website–Engine Coordinate Contract
 * ============================================
 *
 * This module is the SINGLE SOURCE OF TRUTH for coordinate semantics.
 * No board renderer, pointer handler, engine adapter, replay component,
 * or notation dialog may implement its own coordinate arithmetic.
 *
 * ── Board cells ────────────────────────────────────────────────────────────
 *   x = 0..8   (column index, 0 = 'a', 8 = 'i')
 *   y = 0..8   (row index, 0 = White's home row, 8 = Black's home row)
 *
 *   Algebraic column: String.fromCharCode(97 + x)  ('a' through 'i')
 *   Algebraic row:    y + 1                          (1 through 9)
 *
 *   White starts at the BOTTOM (y=0, algebraic row 1) and moves toward y=8.
 *   Black starts at the TOP    (y=8, algebraic row 9) and moves toward y=0.
 *
 * ── Wall anchors ───────────────────────────────────────────────────────────
 *   wx = 0..7  (column index of left cell in the pair)
 *   wy = 0..7  (row index of bottom cell in the pair)
 *
 *   Algebraic column: String.fromCharCode(97 + wx)  ('a' through 'h')
 *   Algebraic row:    wy + 1                          (1 through 8)
 *
 *   Horizontal wall H(wx, wy):
 *     Visually spans columns wx and wx+1 (algebraic: wx_col and (wx+1)_col)
 *     Lies between rows wy and wy+1     (algebraic: wy+1 and wy+2)
 *     Blocks vertical movement across this boundary:
 *       cell(wx,   wy) ↔ cell(wx,   wy+1)
 *       cell(wx+1, wy) ↔ cell(wx+1, wy+1)
 *     Algebraic notation: `{col}{row}h`  e.g. `d3h`
 *
 *   Vertical wall V(wx, wy):
 *     Visually spans rows wy and wy+1   (algebraic: wy+1 and wy+2)
 *     Lies between columns wx and wx+1  (algebraic: wx_col and (wx+1)_col)
 *     Blocks horizontal movement across this boundary:
 *       cell(wx,   wy) ↔ cell(wx+1, wy)
 *       cell(wx,   wy+1) ↔ cell(wx+1, wy+1)
 *     Algebraic notation: `{col}{row}v`  e.g. `d3v`
 *
 * ── Board orientation ──────────────────────────────────────────────────────
 *   Default (not flipped): White at screen-bottom (low screen-y), Black at top.
 *   Flipped:               Black at screen-bottom, White at top.
 *
 *   Board flipping is PURELY VISUAL. It must NEVER mutate:
 *     - Semantic cell coordinates (x, y)
 *     - Wall anchors or orientations
 *     - Player identity or side to move
 *     - Algebraic notation
 *     - Engine position
 *
 * ── Screen coordinate conventions ──────────────────────────────────────────
 *   The board is rendered as a CSS grid:
 *     Grid column index h = 0 .. (numCols*2-2)    (even=cell, odd=wall gap)
 *     Grid row    index p = 0 .. (numRows*2-2)     (even=cell, odd=wall gap)
 *
 *   Default orientation (White at bottom, screen-y increases downward):
 *     Canonical x = Math.floor(h / 2)
 *     Canonical y = numRows - 1 - Math.floor(p / 2)   ← y=8 at top (p=0), y=0 at bottom (p=last)
 *
 *   Flipped orientation (Black at bottom):
 *     Canonical x = numCols - 1 - Math.floor(h / 2)
 *     Canonical y = Math.floor(p / 2)
 */

// ── Re-exports from gameLogic that are part of the contract ──────────────
export {
  parseAlgebraic,
  toAlgebraic,
  formatCoordinate,
  WallType,
  QuoridorBoard,
} from '../lib/gameLogic.js';

// ── Canonical constants ──────────────────────────────────────────────────

export const BOARD_SIZE = 9;          // cells per side
export const WALL_GRID_SIZE = 8;       // wall anchors per side

// ── Cell coordinate helpers ──────────────────────────────────────────────

/**
 * Convert canonical (x, y) to algebraic coordinate object { column, row }.
 * x = 0..8, y = 0..8
 */
export function canonicalCellToAlgebraic(x, y) {
  return {
    column: String.fromCharCode(97 + x),
    row: y + 1,
  };
}

/**
 * Convert algebraic { column, row } to canonical (x, y).
 * Returns { x, y }.
 */
export function algebraicCellToCanonical(coord) {
  return {
    x: coord.column.charCodeAt(0) - 97,
    y: coord.row - 1,
  };
}

// ── Wall coordinate helpers ──────────────────────────────────────────────

/**
 * Convert canonical wall anchor (wx, wy, orientation) to algebraic action.
 * wx = 0..7, wy = 0..7, orientation = WallType.Horizontal | WallType.Vertical
 */
export function canonicalWallToAlgebraic(wx, wy, wallType) {
  return {
    coordinate: {
      column: String.fromCharCode(97 + wx),
      row: wy + 1,
    },
    wallType,
  };
}

/**
 * Convert an algebraic wall action { coordinate, wallType } to canonical anchor.
 * Returns { wx, wy, wallType }.
 */
export function algebraicWallToCanonical(action) {
  return {
    wx: action.coordinate.column.charCodeAt(0) - 97,
    wy: action.coordinate.row - 1,
    wallType: action.wallType,
  };
}

// ── Grid cell → canonical coordinate ────────────────────────────────────

/**
 * Convert grid indices (h, p, numRows, isFlipped) to a canonical cell coordinate.
 * Only valid when h and p are both even (a pawn square).
 * Returns { x, y } or null if not a square.
 */
export function gridIndexToCanonicalCell(h, p, numRows, numCols, isFlipped = false) {
  if (h % 2 !== 0 || p % 2 !== 0) return null;
  if (isFlipped) {
    return {
      x: numCols - 1 - Math.floor(h / 2),
      y: Math.floor(p / 2),
    };
  }
  return {
    x: Math.floor(h / 2),
    y: numRows - 1 - Math.floor(p / 2),
  };
}

/**
 * Convert grid indices (h, p, numRows, numCols, isFlipped) to a canonical wall anchor.
 * Returns { wx, wy, wallType } or null if not a wall slot.
 *
 * Wall anchor convention:
 *   Horizontal wall: p odd, h even → anchor (wx=col, wy=lower_cell_y)
 *   Vertical wall:   p even, h odd → anchor (wx=left_cell_x, wy=row_y)
 */
export function gridIndexToCanonicalWall(h, p, numRows, numCols, isFlipped = false) {
  const isEvenRow = p % 2 === 0;
  const isEvenCol = h % 2 === 0;
  if (isEvenRow && isEvenCol) return null;   // square
  if (!isEvenRow && !isEvenCol) return null; // intersection

  if (!isEvenRow && isEvenCol) {
    // Horizontal wall: between two square rows
    const cellX = isFlipped
      ? numCols - 1 - Math.floor(h / 2)
      : Math.floor(h / 2);
    const upperY = isFlipped
      ? Math.floor(p / 2)                        // upper cell in flipped view
      : numRows - 1 - Math.floor(p / 2);         // upper cell in normal view
    // Anchor wy = min(upperY, upperY-1) = the lower of the two adjacent rows
    const wy = isFlipped ? upperY : upperY - 1;
    const wx = isFlipped ? numCols - 1 - cellX : cellX;
    // Clamp to valid wall anchor range
    if (wx < 0 || wx >= WALL_GRID_SIZE || wy < 0 || wy >= WALL_GRID_SIZE) return null;
    return { wx, wy, wallType: 'h' };
  }

  // Vertical wall: between two square columns
  const cellY = isFlipped
    ? Math.floor(p / 2)
    : numRows - 1 - Math.floor(p / 2);
  const leftX = isFlipped
    ? numCols - 1 - Math.floor(h / 2)
    : Math.floor(h / 2);
  const wy = cellY;
  const wx = isFlipped ? leftX - 1 : leftX;
  if (wx < 0 || wx >= WALL_GRID_SIZE || wy < 0 || wy >= WALL_GRID_SIZE) return null;
  return { wx, wy, wallType: 'v' };
}

// ── Canonical cell → grid index ──────────────────────────────────────────

/**
 * Convert canonical cell (x, y) to grid (h, p) indices.
 */
export function canonicalCellToGridIndex(x, y, numRows, numCols, isFlipped = false) {
  if (isFlipped) {
    return {
      h: (numCols - 1 - x) * 2,
      p: y * 2,
    };
  }
  return {
    h: x * 2,
    p: (numRows - 1 - y) * 2,
  };
}

// ── Screen transform for flipped board ───────────────────────────────────

/** Map canonical cell to screen row/column (0 = top/left). */
export function canonicalCellToScreen({ x, y }, isFlipped) {
  if (isFlipped) {
    return { screenRow: y, screenColumn: BOARD_SIZE - 1 - x };
  }
  return { screenRow: BOARD_SIZE - 1 - y, screenColumn: x };
}

export function screenCellToCanonical({ screenRow, screenColumn }, isFlipped) {
  if (isFlipped) {
    return { x: BOARD_SIZE - 1 - screenColumn, y: screenRow };
  }
  return { x: screenColumn, y: BOARD_SIZE - 1 - screenRow };
}

/**
 * @deprecated use canonicalCellToScreen
 */
export function flipScreenTransform(x, y, numRows, numCols, isFlipped) {
  const { screenRow, screenColumn } = canonicalCellToScreen({ x, y }, isFlipped);
  return { screenX: screenColumn, screenY: screenRow };
}

// ── Move encoding ────────────────────────────────────────────────────────

/**
 * Encode a pawn action { coordinate } to algebraic string.
 * Equivalent to toAlgebraic but explicit.
 */
export function encodeMove(action) {
  const base = `${action.coordinate.column}${action.coordinate.row}`;
  if (action.wallType) {
    return `${base}${action.wallType}`;
  }
  return base;
}

/**
 * Decode an algebraic string to an action { coordinate, [wallType] }.
 */
export function decodeMove(algebraic) {
  const coordinate = {
    column: algebraic[0],
    row: Number.parseInt(algebraic[1], 10),
  };
  if (algebraic.length > 2) {
    return { coordinate, wallType: algebraic[2] };
  }
  return { coordinate };
}

/**
 * Map canonical wall anchor to board-grid groove indices (h, p).
 * Inverse of gridIndexToCanonicalWall — used to paint placed walls directly.
 */
export function canonicalWallAnchorToGrid(
  wx,
  wy,
  wallType,
  numRows = BOARD_SIZE,
  numCols = BOARD_SIZE,
  isFlipped = false,
) {
  if (wx < 0 || wx >= WALL_GRID_SIZE || wy < 0 || wy >= WALL_GRID_SIZE) {
    return null;
  }
  const isHorizontal = wallType === 'h' || wallType === 'horizontal';
  if (!isFlipped) {
    if (isHorizontal) {
      return { h: wx * 2, p: (numRows - 1 - (wy + 1)) * 2 + 1, orientation: 'h' };
    }
    return { h: wx * 2 + 1, p: (numRows - 1 - wy) * 2, orientation: 'v' };
  }
  if (isHorizontal) {
    const cellX = numCols - 1 - wx;
    return { h: cellX * 2, p: wy * 2 + 1, orientation: 'h' };
  }
  const leftX = wx + 1;
  const cellX = numCols - 1 - leftX;
  return { h: cellX * 2 + 1, p: wy * 2, orientation: 'v' };
}

// ── Blocked-edge query helper ────────────────────────────────────────────

/**
 * Given a QuoridorBoard and a canonical wall anchor (wx, wy, wallType),
 * return the two cell pairs blocked by this wall.
 *
 * Each pair is [cellA, cellB] where cellA/B are { column, row }.
 */
export function wallBlockedEdges(wx, wy, wallType) {
  const col0 = String.fromCharCode(97 + wx);
  const col1 = String.fromCharCode(97 + wx + 1);
  const row0 = wy + 1;
  const row1 = wy + 2;

  if (wallType === 'h') {
    // Horizontal: blocks vertical movement
    return [
      [{ column: col0, row: row0 }, { column: col0, row: row1 }],
      [{ column: col1, row: row0 }, { column: col1, row: row1 }],
    ];
  }
  // Vertical: blocks horizontal movement
  return [
    [{ column: col0, row: row0 }, { column: col1, row: row0 }],
    [{ column: col0, row: row1 }, { column: col1, row: row1 }],
  ];
}

// ── Codec round-trip helpers (for tests and adapters) ───────────────────

/**
 * Gorisanson MCTS worker codec:
 *   algebraic → gorisanson tuple → algebraic
 */
export function algebraicToGorisansonPawn(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = Number.parseInt(algebraic[1], 10);
  const gsRow = 9 - row;       // y-axis flip: row1→8, row9→0
  return [gsRow, col];
}

export function gorisansonPawnToAlgebraic(gsRow, col) {
  const row = 9 - gsRow;
  return `${String.fromCharCode(97 + col)}${row}`;
}

export function algebraicToGorisansonHWall(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = Number.parseInt(algebraic[1], 10);
  const gsRow = 8 - row;       // y-axis flip: row1→7, row8→0
  return [gsRow, col];
}

export function gorisansonHWallToAlgebraic(gsRow, col) {
  const row = 8 - gsRow;
  return `${String.fromCharCode(97 + col)}${row}h`;
}

export function algebraicToGorisansonVWall(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = Number.parseInt(algebraic[1], 10);
  const gsRow = 8 - row;
  return [gsRow, col];
}

export function gorisansonVWallToAlgebraic(gsRow, col) {
  const row = 8 - gsRow;
  return `${String.fromCharCode(97 + col)}${row}v`;
}

/**
 * Quoridor v3 codec:
 *   algebraic → integer move → algebraic
 */
export function algebraicToV3Move(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = Number.parseInt(algebraic[1], 10);
  if (algebraic.length === 2) {
    return (9 - row) * 9 + col;
  }
  const wallRow = 8 - row;
  const slot = wallRow * 8 + col;
  return algebraic.endsWith('h') ? 100 + slot : 200 + slot;
}

export function v3MoveToAlgebraic(move) {
  if (move < 100) {
    const r = (move / 9) | 0;
    const c = move % 9;
    return `${String.fromCharCode(97 + c)}${9 - r}`;
  }
  const base = move < 200 ? 100 : 200;
  const slot = move - base;
  const wr = (slot / 8) | 0;
  const wc = slot % 8;
  const suffix = move < 200 ? 'h' : 'v';
  return `${String.fromCharCode(97 + wc)}${8 - wr}${suffix}`;
}

/**
 * ACE v8 codec:
 *   algebraic → integer move → algebraic
 */
export function algebraicToAceMove(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = Number.parseInt(algebraic[1], 10) - 1;
  if (algebraic.length === 2) {
    return (8 - row) * 9 + col;
  }
  const slot = (7 - row) * 8 + col;
  return algebraic.endsWith('h') ? 100 + slot : 200 + slot;
}

export function aceMoveToAlgebraic(move) {
  if (move < 100) {
    const r = (move / 9) | 0;
    const c = move % 9;
    return `${String.fromCharCode(97 + c)}${9 - r}`;
  }
  const base = move < 200 ? 100 : 200;
  const slot = move - base;
  const wr = (slot / 8) | 0;
  const wc = slot % 8;
  const suffix = move < 200 ? 'h' : 'v';
  return `${String.fromCharCode(97 + wc)}${8 - wr}${suffix}`;
}

/**
 * Ishtar (Glendenning) notation:
 *   In Glendenning, wall row = Official row + 1
 *   Ka (Official) uses same notation as site.
 */
export function algebraicToGlendenningWall(algebraic) {
  // Increment row by 1
  const col = algebraic[0];
  const row = Number.parseInt(algebraic[1], 10) + 1;
  const suffix = algebraic.slice(2);
  return `${col}${row}${suffix}`;
}

export function glendenningToAlgebraicWall(glendenning) {
  const col = glendenning[0];
  const row = Number.parseInt(glendenning[1], 10) - 1;
  const suffix = glendenning.slice(2);
  return `${col}${row}${suffix}`;
}
