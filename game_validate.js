'use strict';

/** Minimum plies before a finished game is stored (matches training/datagen.py). */
const MIN_PLIES = 8;

function isCompleteGame(r) {
  if (!r || r.aborted) return false;
  const plies = r.plies ?? (Array.isArray(r.moves) ? r.moves.length : 0);
  if (plies < MIN_PLIES) return false;
  if (r.draw || r.winner === 0) return false;
  return true;
}

module.exports = { MIN_PLIES, isCompleteGame };
