/** ACE v8 / Quoridor v3 HTML engines (MATE = 100_000). */
export const ACE_MATE_VALUE = 100_000;
export const ACE_MATE_THRESHOLD = ACE_MATE_VALUE - 200;

/** Titanium αβ search (MATE = 20_000). */
export const TITANIUM_MATE_VALUE = 20_000;
export const TITANIUM_MATE_THRESHOLD = TITANIUM_MATE_VALUE - 500;

/**
 * @returns {{ dist: number, sign: 1 | -1 } | null}
 */
export function mateInfo(score) {
  if (score == null || !Number.isFinite(Number(score))) {
    return null;
  }
  const n = Number(score);

  if (Math.abs(n) >= ACE_MATE_THRESHOLD) {
    const dist = n > 0 ? Math.max(0, ACE_MATE_VALUE - n) : Math.max(0, ACE_MATE_VALUE + n);
    return { dist, sign: n > 0 ? 1 : -1 };
  }

  if (Math.abs(n) >= TITANIUM_MATE_THRESHOLD) {
    const dist =
      n > 0 ? Math.max(0, TITANIUM_MATE_VALUE - n) : Math.max(0, TITANIUM_MATE_VALUE + n);
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
    return `${sign}M${mate.dist}`;
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
    if (mate.dist === 0) return mate.sign > 0 ? 'Won!' : 'Lost';
    return mate.sign > 0 ? `Win in ${mate.dist}` : `Lose in ${mate.dist}`;
  }
  const meters = n / 100;
  return `${meters > 0 ? '+' : ''}${meters.toFixed(2)}`;
}
