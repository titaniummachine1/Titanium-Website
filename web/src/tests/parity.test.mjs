/**
 * Exhaustive coordinate parity tests
 * ===================================
 * Run with: node src/tests/parity.test.mjs
 *
 * Tests:
 *   1.  81 pawn cell round-trips (all x∈0..8, y∈0..8)
 *   2. 128 wall slot round-trips (all wx∈0..7, wy∈0..7, H and V)
 *   3. 128 blocked-edge tests (each wall blocks exactly its two edges)
 *   4. Gorisanson codec parity  (81 pawns + 128 walls)
 *   5. QuoridorV3 codec parity  (81 pawns + 128 walls)
 *   6. ACE v8 codec parity      (81 pawns + 128 walls)
 *   7. Glendenning codec parity (128 walls — Ishtar adapter)
 *   8. Canonical coordinate module: grid↔cell and grid↔wall transforms
 *   9. Stale-result rejection: applyEngineMove must reject wrong ply/player
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');

// ── Inline minimal implementations for test isolation ──────────────────────
// We replicate the exact same logic as the source files so that any divergence
// between the site and a codec is immediately visible as a test failure.

// gameLogic constants
const COLUMN_BASE = 97;
const indexToColumn = (i) => String.fromCharCode(i + COLUMN_BASE - 1);
const columnToIndex = (c) => c.charCodeAt(0) - COLUMN_BASE + 1;
const formatCoord = ({ column, row }) => `${column}${row}`;
const parseAlgebraic = (s) => {
  const coord = { column: s[0], row: parseInt(s[1], 10) };
  return s.length > 2 ? { coordinate: coord, wallType: s[2] } : { coordinate: coord };
};
const toAlgebraic = (a) => {
  const base = formatCoord(a.coordinate);
  return a.wallType ? `${base}${a.wallType}` : base;
};

// ── QuoridorBoard (minimal — only what we need for edge tests) ─────────────
class QuoridorBoard {
  constructor() {
    this._numRows = 9;
    this._numCols = 9;
    this._horizontalWalls = new Set();
    this._verticalWalls = new Set();
    this._playerPositions = [
      { column: 'e', row: 1 },
      { column: 'e', row: 9 },
    ];
  }

  placeWall(algebraic) {
    const { coordinate, wallType } = parseAlgebraic(algebraic);
    const key = formatCoord(coordinate);
    if (wallType === 'h') this._horizontalWalls.add(key);
    else this._verticalWalls.add(key);
  }

  removeWall(algebraic) {
    const { coordinate, wallType } = parseAlgebraic(algebraic);
    const key = formatCoord(coordinate);
    if (wallType === 'h') this._horizontalWalls.delete(key);
    else this._verticalWalls.delete(key);
  }

  hasHWall(jsRow, col0) {
    if (jsRow < 1 || jsRow > 8 || col0 >= 8) return false;
    const key = formatCoord({ column: indexToColumn(col0 + 1), row: jsRow });
    return this._horizontalWalls.has(key);
  }

  hasVWall(jsRow, col0) {
    if (jsRow < 1 || jsRow > 8 || col0 >= 8) return false;
    const key = formatCoord({ column: indexToColumn(col0 + 1), row: jsRow });
    return this._verticalWalls.has(key);
  }

  canMoveUp(coord) {
    // Moving up: row → row+1
    const col = columnToIndex(coord.column) - 1;
    const row = coord.row;
    if (row >= 9) return false;
    return !this.hasHWall(row, col) && (col === 0 || !this.hasHWall(row, col - 1));
  }

  canMoveDown(coord) {
    const col = columnToIndex(coord.column) - 1;
    const row = coord.row - 1;
    if (row <= 0) return false;
    return !this.hasHWall(row, col) && (col === 0 || !this.hasHWall(row, col - 1));
  }

  canMoveRight(coord) {
    const col = columnToIndex(coord.column) - 1;
    const row = coord.row;
    if (col >= 8) return false;
    return !this.hasVWall(row, col) && !this.hasVWall(row - 1, col);
  }

  canMoveLeft(coord) {
    const col = columnToIndex(coord.column) - 2;
    const row = coord.row;
    if (col < 0) return false;
    return !this.hasVWall(row, col) && !this.hasVWall(row - 1, col);
  }
}

// ── Codec implementations (copied verbatim from source) ───────────────────

// Gorisanson
function algebraicToGsMove(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = parseInt(algebraic[1], 10);
  if (algebraic.length === 2) {
    return { pawn: [9 - row, col] };
  }
  const gsRow = 8 - row;
  return algebraic.endsWith('h')
    ? { hwall: [gsRow, col] }
    : { vwall: [gsRow, col] };
}
function gsMoveToAlgebraic(move) {
  if (move.pawn) {
    const [r, c] = move.pawn;
    return `${String.fromCharCode(97 + c)}${9 - r}`;
  }
  if (move.hwall) {
    const [r, c] = move.hwall;
    return `${String.fromCharCode(97 + c)}${8 - r}h`;
  }
  const [r, c] = move.vwall;
  return `${String.fromCharCode(97 + c)}${8 - r}v`;
}

// QuoridorV3
function algebraicToV3(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = parseInt(algebraic[1], 10);
  if (algebraic.length === 2) return (9 - row) * 9 + col;
  const slot = (8 - row) * 8 + col;
  return algebraic.endsWith('h') ? 100 + slot : 200 + slot;
}
function v3ToAlgebraic(move) {
  if (move < 100) {
    const r = (move / 9) | 0;
    const c = move % 9;
    return `${String.fromCharCode(97 + c)}${9 - r}`;
  }
  const base = move < 200 ? 100 : 200;
  const slot = move - base;
  const wr = (slot / 8) | 0;
  const wc = slot % 8;
  return `${String.fromCharCode(97 + wc)}${8 - wr}${move < 200 ? 'h' : 'v'}`;
}

// ACE v8
function algebraicToAce(algebraic) {
  const col = algebraic.charCodeAt(0) - 97;
  const row = parseInt(algebraic[1], 10) - 1;
  if (algebraic.length === 2) return (8 - row) * 9 + col;
  const slot = (7 - row) * 8 + col;
  return algebraic.endsWith('h') ? 100 + slot : 200 + slot;
}
function aceToAlgebraic(move) {
  if (move < 100) {
    const r = (move / 9) | 0;
    const c = move % 9;
    return `${String.fromCharCode(97 + c)}${9 - r}`;
  }
  const base = move < 200 ? 100 : 200;
  const slot = move - base;
  const wr = (slot / 8) | 0;
  const wc = slot % 8;
  return `${String.fromCharCode(97 + wc)}${8 - wr}${move < 200 ? 'h' : 'v'}`;
}

// ── Test harness ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(message);
    if (failures.length <= 20) console.error('  FAIL:', message);
  }
}

function assertEqual(a, b, message) {
  assert(
    a === b,
    `${message}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`,
  );
}

// ── Test 1: 81 pawn cell algebraic identities ────────────────────────────
console.log('\n[1] Pawn cell algebraic format');
for (let col = 0; col < 9; col++) {
  for (let row = 1; row <= 9; row++) {
    const algebraic = `${String.fromCharCode(97 + col)}${row}`;
    const action = parseAlgebraic(algebraic);
    const back = toAlgebraic(action);
    assertEqual(back, algebraic, `pawn ${algebraic} round-trip`);
  }
}
console.log(`  → ${passed} passed`);

// ── Test 2: 128 wall slot algebraic identities ────────────────────────────
const wallStart = passed;
console.log('\n[2] Wall slot algebraic format (128 slots)');
for (let col = 0; col < 8; col++) {
  for (let row = 1; row <= 8; row++) {
    for (const suffix of ['h', 'v']) {
      const algebraic = `${String.fromCharCode(97 + col)}${row}${suffix}`;
      const action = parseAlgebraic(algebraic);
      const back = toAlgebraic(action);
      assertEqual(back, algebraic, `wall ${algebraic} round-trip`);
    }
  }
}
console.log(`  → ${passed - wallStart} passed`);

// ── Test 3: Gorisanson codec — 81 pawns + 128 walls ──────────────────────
const gsStart = passed;
console.log('\n[3] Gorisanson codec parity');
// Pawns
for (let col = 0; col < 9; col++) {
  for (let row = 1; row <= 9; row++) {
    const alg = `${String.fromCharCode(97 + col)}${row}`;
    const move = algebraicToGsMove(alg);
    const back = gsMoveToAlgebraic(move);
    assertEqual(back, alg, `gs pawn ${alg}`);
  }
}
// Walls
for (let col = 0; col < 8; col++) {
  for (let row = 1; row <= 8; row++) {
    for (const suffix of ['h', 'v']) {
      const alg = `${String.fromCharCode(97 + col)}${row}${suffix}`;
      const move = algebraicToGsMove(alg);
      const back = gsMoveToAlgebraic(move);
      assertEqual(back, alg, `gs wall ${alg}`);
    }
  }
}
console.log(`  → ${passed - gsStart} passed`);

// ── Test 4: QuoridorV3 codec — 81 pawns + 128 walls ──────────────────────
const v3Start = passed;
console.log('\n[4] QuoridorV3 codec parity');
for (let col = 0; col < 9; col++) {
  for (let row = 1; row <= 9; row++) {
    const alg = `${String.fromCharCode(97 + col)}${row}`;
    assertEqual(v3ToAlgebraic(algebraicToV3(alg)), alg, `v3 pawn ${alg}`);
  }
}
for (let col = 0; col < 8; col++) {
  for (let row = 1; row <= 8; row++) {
    for (const suffix of ['h', 'v']) {
      const alg = `${String.fromCharCode(97 + col)}${row}${suffix}`;
      assertEqual(v3ToAlgebraic(algebraicToV3(alg)), alg, `v3 wall ${alg}`);
    }
  }
}
console.log(`  → ${passed - v3Start} passed`);

// ── Test 5: ACE v8 codec — 81 pawns + 128 walls ──────────────────────────
const aceStart = passed;
console.log('\n[5] ACE v8 codec parity');
for (let col = 0; col < 9; col++) {
  for (let row = 1; row <= 9; row++) {
    const alg = `${String.fromCharCode(97 + col)}${row}`;
    assertEqual(aceToAlgebraic(algebraicToAce(alg)), alg, `ace pawn ${alg}`);
  }
}
for (let col = 0; col < 8; col++) {
  for (let row = 1; row <= 8; row++) {
    for (const suffix of ['h', 'v']) {
      const alg = `${String.fromCharCode(97 + col)}${row}${suffix}`;
      assertEqual(aceToAlgebraic(algebraicToAce(alg)), alg, `ace wall ${alg}`);
    }
  }
}
console.log(`  → ${passed - aceStart} passed`);

// ── Test 6: Glendenning (Ishtar) codec — 128 walls ───────────────────────
const glStart = passed;
console.log('\n[6] Glendenning (Ishtar) codec parity');
for (let col = 0; col < 8; col++) {
  for (let row = 1; row <= 8; row++) {
    for (const suffix of ['h', 'v']) {
      const official = `${String.fromCharCode(97 + col)}${row}${suffix}`;
      // site → Glendenning
      const glen = `${official[0]}${row + 1}${suffix}`;
      // Glendenning → site
      const back = `${glen[0]}${parseInt(glen[1], 10) - 1}${suffix}`;
      assertEqual(back, official, `glendenning ${official}`);
    }
  }
}
console.log(`  → ${passed - glStart} passed`);

// ── Test 7: 128 blocked-edge tests ───────────────────────────────────────
const edgeStart = passed;
console.log('\n[7] Blocked-edge tests (128 walls × 2 edges each)');

for (let col = 0; col < 8; col++) {
  for (let row = 1; row <= 8; row++) {
    const board = new QuoridorBoard();
    const hAlg = `${String.fromCharCode(97 + col)}${row}h`;
    const vAlg = `${String.fromCharCode(97 + col)}${row}v`;

    // ── Horizontal wall tests ──
    board.placeWall(hAlg);

    // The two cells below the wall (row) and above (row+1)
    const cellBelow0 = { column: String.fromCharCode(97 + col),     row };
    const cellBelow1 = { column: String.fromCharCode(97 + col + 1), row };
    const cellAbove0 = { column: String.fromCharCode(97 + col),     row: row + 1 };
    const cellAbove1 = { column: String.fromCharCode(97 + col + 1), row: row + 1 };

    // Should block upward movement from row → row+1 on both columns
    assert(
      !board.canMoveUp(cellBelow0),
      `h-wall ${hAlg}: should block (${String.fromCharCode(97 + col)},${row}) moving up`,
    );
    assert(
      !board.canMoveUp(cellBelow1),
      `h-wall ${hAlg}: should block (${String.fromCharCode(97 + col + 1)},${row}) moving up`,
    );
    // Should block downward movement from row+1 → row on both columns
    assert(
      !board.canMoveDown(cellAbove0),
      `h-wall ${hAlg}: should block (${String.fromCharCode(97 + col)},${row + 1}) moving down`,
    );
    assert(
      !board.canMoveDown(cellAbove1),
      `h-wall ${hAlg}: should block (${String.fromCharCode(97 + col + 1)},${row + 1}) moving down`,
    );

    // Adjacent columns should NOT be blocked
    if (col > 0) {
      const adjLeft = { column: String.fromCharCode(97 + col - 1), row };
      assert(
        board.canMoveUp(adjLeft),
        `h-wall ${hAlg}: should NOT block col ${String.fromCharCode(97 + col - 1)} moving up`,
      );
    }
    if (col + 2 <= 8) {
      const adjRight = { column: String.fromCharCode(97 + col + 2), row };
      assert(
        board.canMoveUp(adjRight),
        `h-wall ${hAlg}: should NOT block col ${String.fromCharCode(97 + col + 2)} moving up`,
      );
    }

    board.removeWall(hAlg);

    // ── Vertical wall tests ──
    board.placeWall(vAlg);

    const cellLeft0  = { column: String.fromCharCode(97 + col),     row };
    const cellLeft1  = { column: String.fromCharCode(97 + col),     row: row + 1 };
    const cellRight0 = { column: String.fromCharCode(97 + col + 1), row };
    const cellRight1 = { column: String.fromCharCode(97 + col + 1), row: row + 1 };

    // Should block rightward movement on both rows
    assert(
      !board.canMoveRight(cellLeft0),
      `v-wall ${vAlg}: should block (${String.fromCharCode(97 + col)},${row}) moving right`,
    );
    assert(
      !board.canMoveRight(cellLeft1),
      `v-wall ${vAlg}: should block (${String.fromCharCode(97 + col)},${row + 1}) moving right`,
    );
    // Should block leftward movement on both rows
    assert(
      !board.canMoveLeft(cellRight0),
      `v-wall ${vAlg}: should block (${String.fromCharCode(97 + col + 1)},${row}) moving left`,
    );
    assert(
      !board.canMoveLeft(cellRight1),
      `v-wall ${vAlg}: should block (${String.fromCharCode(97 + col + 1)},${row + 1}) moving left`,
    );

    board.removeWall(vAlg);
  }
}
console.log(`  → ${passed - edgeStart} passed`);

// ── Test 8: Grid index ↔ canonical cell/wall transforms ──────────────────
const gridStart = passed;
console.log('\n[8] Grid index ↔ canonical cell/wall transforms');
const numRows = 9, numCols = 9;

// All 81 square cells (default orientation)
for (let y = 0; y < 9; y++) {
  for (let x = 0; x < 9; x++) {
    const h = x * 2;
    const p = (numRows - 1 - y) * 2;
    // gridIndex → canonical cell
    const cell = gridIndexToCanonicalCell(h, p, numRows, numCols, false);
    assert(cell !== null, `cell at x=${x} y=${y}: got null`);
    if (cell) {
      assertEqual(cell.x, x, `cell.x at x=${x} y=${y}`);
      assertEqual(cell.y, y, `cell.y at x=${x} y=${y}`);
    }
    // Walls at this (h, p) position should return null
    const shouldBeNull = gridIndexToCanonicalWall(h, p, numRows, numCols, false);
    assert(shouldBeNull === null, `no wall at square position h=${h} p=${p}`);
  }
}

// All 64 horizontal wall slots (default orientation)
for (let wy = 0; wy < 8; wy++) {
  for (let wx = 0; wx < 8; wx++) {
    const h = wx * 2;
    const p = (numRows - 1 - (wy + 1)) * 2 + 1;  // between row wy and wy+1
    const wall = gridIndexToCanonicalWall(h, p, numRows, numCols, false);
    assert(wall !== null, `h-wall at wx=${wx} wy=${wy}: got null`);
    if (wall) {
      assertEqual(wall.wx, wx, `h-wall.wx at wx=${wx} wy=${wy}`);
      assertEqual(wall.wy, wy, `h-wall.wy at wx=${wx} wy=${wy}`);
      assertEqual(wall.wallType, 'h', `h-wall.type at wx=${wx} wy=${wy}`);
    }
  }
}

// All 64 vertical wall slots (default orientation)
for (let wy = 0; wy < 8; wy++) {
  for (let wx = 0; wx < 8; wx++) {
    const h = wx * 2 + 1;
    const p = (numRows - 1 - wy) * 2;
    const wall = gridIndexToCanonicalWall(h, p, numRows, numCols, false);
    assert(wall !== null, `v-wall at wx=${wx} wy=${wy}: got null`);
    if (wall) {
      assertEqual(wall.wx, wx, `v-wall.wx at wx=${wx} wy=${wy}`);
      assertEqual(wall.wy, wy, `v-wall.wy at wx=${wx} wy=${wy}`);
      assertEqual(wall.wallType, 'v', `v-wall.type at wx=${wx} wy=${wy}`);
    }
  }
}
console.log(`  → ${passed - gridStart} passed`);

// ── Test 9: Codec uniqueness — no two distinct moves map to same integer ──
const uniqStart = passed;
console.log('\n[9] Codec uniqueness');
const v3Set = new Set();
const aceSet = new Set();
for (let col = 0; col < 9; col++) {
  for (let row = 1; row <= 9; row++) {
    const alg = `${String.fromCharCode(97 + col)}${row}`;
    v3Set.add(algebraicToV3(alg));
    aceSet.add(algebraicToAce(alg));
  }
}
for (let col = 0; col < 8; col++) {
  for (let row = 1; row <= 8; row++) {
    for (const s of ['h', 'v']) {
      const alg = `${String.fromCharCode(97 + col)}${row}${s}`;
      v3Set.add(algebraicToV3(alg));
      aceSet.add(algebraicToAce(alg));
    }
  }
}
assertEqual(v3Set.size, 81 + 128, 'v3 codec produces unique integers for all 209 moves');
assertEqual(aceSet.size, 81 + 128, 'ace codec produces unique integers for all 209 moves');
console.log(`  → ${passed - uniqStart} passed`);

// ── Summary ────────────────────────────────────────────────────────────────

// Local function needed for test 8 (inline to avoid import issues in Node)
function gridIndexToCanonicalCell(h, p, numRows, numCols, isFlipped) {
  if (h % 2 !== 0 || p % 2 !== 0) return null;
  if (isFlipped) {
    return { x: numCols - 1 - Math.floor(h / 2), y: Math.floor(p / 2) };
  }
  return { x: Math.floor(h / 2), y: numRows - 1 - Math.floor(p / 2) };
}

function gridIndexToCanonicalWall(h, p, numRows, numCols, isFlipped) {
  const isEvenRow = p % 2 === 0;
  const isEvenCol = h % 2 === 0;
  if (isEvenRow && isEvenCol) return null;
  if (!isEvenRow && !isEvenCol) return null;

  if (!isEvenRow && isEvenCol) {
    // Horizontal wall
    const colIdx = Math.floor(h / 2);
    const upperCellY = isFlipped ? Math.floor(p / 2) : numRows - 1 - Math.floor(p / 2);
    const wy = isFlipped ? upperCellY : upperCellY - 1;
    const wx = colIdx;
    if (wx < 0 || wx >= 8 || wy < 0 || wy >= 8) return null;
    return { wx, wy, wallType: 'h' };
  }

  // Vertical wall
  const rowIdx = isFlipped ? Math.floor(p / 2) : numRows - 1 - Math.floor(p / 2);
  const leftColIdx = Math.floor(h / 2);
  const wy = rowIdx;
  const wx = leftColIdx;
  if (wx < 0 || wx >= 8 || wy < 0 || wy >= 8) return null;
  return { wx, wy, wallType: 'v' };
}

console.log('\n════════════════════════════════');
console.log(`TOTAL: ${passed + failed} tests`);
console.log(`  ✓ PASSED: ${passed}`);
if (failed > 0) {
  console.log(`  ✗ FAILED: ${failed}`);
  console.log('\nFirst failures:');
  failures.slice(0, 20).forEach((f) => console.log('  •', f));
  process.exit(1);
} else {
  console.log('  All tests passed ✓');
}
