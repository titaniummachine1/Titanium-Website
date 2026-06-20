/**
 * Screen iteration helpers for board flip — canonical coords never change.
 */

export function screenRowIndices(numRows, isFlipped) {
  const indices = [];
  for (let p = 0; p < numRows * 2 - 1; p++) indices.push(p);
  return isFlipped ? indices.reverse() : indices;
}

export function screenColIndices(numCols, isFlipped) {
  const indices = [];
  for (let h = 0; h < numCols * 2 - 1; h++) indices.push(h);
  return isFlipped ? indices.reverse() : indices;
}

/** Row label at screen position index (0 = top). */
export function screenRowLabel(labelIndex, numRows, isFlipped) {
  if (isFlipped) return String(labelIndex + 1);
  return String(numRows - labelIndex);
}

/** Column label at screen position index (0 = left). */
export function screenColumnLabel(labelIndex, isFlipped) {
  const col = isFlipped ? 8 - labelIndex : labelIndex;
  return String.fromCharCode(97 + col);
}
