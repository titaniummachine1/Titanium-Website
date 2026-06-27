/** ACE v8 / Quoridor v3 HTML engines and Titanium WASM (MATE = 100_000). */
export const ACE_MATE_VALUE = 100_000;
export const ACE_MATE_THRESHOLD = ACE_MATE_VALUE - 200;

/** Titanium race-proof forced-win scores (RACE_MATE = 32_000, within 1000 of peak). */
export const RACE_MATE_VALUE = 32_000;
export const RACE_MATE_THRESHOLD = RACE_MATE_VALUE - 1_000;

/**
 * Convert engine mate plies to Quoridor "moves" for display (ceil(plies / 2)).
 * @param {number} plies
 */
export function quoridorMovesFromMatePlies(plies) {
  if (plies <= 0) {
    return 0;
  }
  return Math.ceil(plies / 2);
}

/**
 * @returns {{ dist: number, sign: 1 | -1 } | null}
 */
export function mateInfo(score) {
  if (score == null || !Number.isFinite(Number(score))) {
    return null;
  }
  const n = Number(score);
  const abs = Math.abs(n);

  // True mate (pawn reaches goal row) — engine returns MATE - ply (100_000 range).
  if (abs >= ACE_MATE_THRESHOLD) {
    const dist = n > 0 ? Math.max(0, ACE_MATE_VALUE - n) : Math.max(0, ACE_MATE_VALUE + n);
    return { dist, sign: n > 0 ? 1 : -1 };
  }

  // Race-proof forced win — engine returns RACE_MATE - ply (32_000 range).
  if (abs >= RACE_MATE_THRESHOLD && abs <= RACE_MATE_VALUE + 100) {
    const dist = n > 0 ? Math.max(0, RACE_MATE_VALUE - n) : Math.max(0, RACE_MATE_VALUE + n);
    return { dist, sign: n > 0 ? 1 : -1 };
  }

  return null;
}

export function isMateScore(score) {
  return mateInfo(score) != null;
}

export function formatEngineScore(score) {
  if (score == null || !Number.isFinite(Number(score))) {
    return '?';
  }
  const n = Number(score);
  const mate = mateInfo(n);
  if (mate) {
    const sign = mate.sign > 0 ? '+' : '-';
    if (mate.dist === 0) {
      return `${sign}#`;
    }
    return `${sign}M${quoridorMovesFromMatePlies(mate.dist)}`;
  }
  const meters = n / 100;
  return `${meters > 0 ? '+' : ''}${meters.toFixed(2)}`;
}

/** Human-friendly score for the player card. */
export function formatScoreForCard(score) {
  if (score == null || !Number.isFinite(Number(score))) {
    return null;
  }
  const n = Number(score);
  const mate = mateInfo(n);
  if (mate) {
    if (mate.dist === 0) {
      return mate.sign > 0 ? 'Won!' : 'Lost';
    }
    const moves = quoridorMovesFromMatePlies(mate.dist);
    return mate.sign > 0 ? `Win in ${moves}` : `Lose in ${moves}`;
  }
  const meters = n / 100;
  return `${meters > 0 ? '+' : ''}${meters.toFixed(2)}`;
}
