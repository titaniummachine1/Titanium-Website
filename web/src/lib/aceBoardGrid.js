/**
 * AceV13.1.html 17×17 groove grid — same 1-indexed CSS placement as #board.
 * Replaces the old 0-indexed auto-flow board (which visually shifted walls/pawns
 * one cell left and one cell down relative to ACE).
 */

/** Engine cell index 0..80 from ACE grid line (gr, gc), both 1-indexed. */
export function cellIndexFromGrid(gr, gc) {
  return ((gr - 1) / 2) * 9 + ((gc - 1) / 2);
}

/** ACE pawn-square grid anchor for engine cell index. */
export function gridFromCellIndex(cell) {
  const r = (cell / 9) | 0;
  const c = cell % 9;
  return { gr: 2 * r + 1, gc: 2 * c + 1 };
}

/** ACE wallpiece grid placement (type 0 = horizontal, 1 = vertical). */
export function wallGridFromSlot(type, slot) {
  const r = (slot / 8) | 0;
  const c = slot % 8;
  if (type === 0) {
    return { gr: 2 * r + 2, gc: 2 * c + 1, rowSpan: 0, colSpan: 3 };
  }
  return { gr: 2 * r + 1, gc: 2 * c + 2, rowSpan: 3, colSpan: 0 };
}

export function applyGridPos(el, gr, gc, rowSpan = 0, colSpan = 0) {
  el.style.gridRow = gr + (rowSpan ? ` / span ${rowSpan}` : '');
  el.style.gridColumn = gc + (colSpan ? ` / span ${colSpan}` : '');
}
