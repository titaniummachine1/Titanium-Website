import { parseAlgebraic, toAlgebraic } from './gameLogic.js';
import { canonicalPositionKeyFromActions } from './canonicalState.js';

/** Current position fingerprint — canonical board state, not move history alone. */
export function positionKeyFromActions(actions) {
  return canonicalPositionKeyFromActions(actions);
}

function deepestDepthEntry(depthLog) {
  if (!depthLog?.length) return null;
  return depthLog.reduce((best, entry) => (entry.depth > (best?.depth ?? 0) ? entry : best));
}

/** Strip leading "pv" token if present in depth-log strings. */
function firstPvTokenFromString(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  if (parts[0]?.toLowerCase() === 'pv' && parts.length > 1) {
    return parts[1];
  }
  return parts[0];
}

/** Normalize wall suffix (h/v) for engine vs UI string compare. */
export function normalizeGhostKey(key) {
  const k = String(key ?? '').trim().toLowerCase();
  if (!k) return '';
  if (k.length > 2) {
    const last = k.slice(-1);
    if (last === 'h' || last === 'v') {
      return k.slice(0, -1) + last;
    }
  }
  return k;
}

function buildValidKeySet(validActions) {
  const set = new Set();
  for (const action of validActions ?? []) {
    const key = toAlgebraic(action);
    set.add(key);
    set.add(normalizeGhostKey(key));
  }
  return set;
}

function matchLegalKey(candidate, validKeySet) {
  if (!candidate) return null;
  const normalized = normalizeGhostKey(candidate);
  if (validKeySet.size === 0) {
    try {
      parseAlgebraic(normalized);
      return normalized;
    } catch {
      return null;
    }
  }
  if (validKeySet.has(normalized)) return normalized;
  if (validKeySet.has(candidate)) return candidate;
  try {
    const canon = toAlgebraic(parseAlgebraic(normalized));
    if (validKeySet.has(canon)) return canon;
    const canonNorm = normalizeGhostKey(canon);
    if (validKeySet.has(canonNorm)) return canonNorm;
  } catch {
    /* ignore */
  }
  return null;
}

function normalizeRootMoveToken(raw) {
  return normalizeGhostKey(String(raw ?? '').trim().toLowerCase());
}

function coalesceRootMoves(next, prev) {
  if (Array.isArray(next) && next.length > 0) {
    return next;
  }
  return Array.isArray(prev) ? prev : [];
}

function mergedRootMoves(liveSearch, state) {
  const seen = new Map();
  const sources = [
    ...(liveSearch?.rootMoves ?? []),
    ...(state?.activeSearchInfo?.rootMoves ?? []),
  ];
  for (const row of sources) {
    const move = normalizeRootMoveToken(row?.move);
    if (!move) continue;
    const prev = seen.get(move);
    if (!prev || (row.score ?? -Infinity) > (prev.score ?? -Infinity)) {
      seen.set(move, { ...row, move });
    }
  }
  return [...seen.values()];
}

/** Best legal root move by score (walls included — skip illegal top lines). */
function bestLegalRootMoveKey(rootMoves, validKeySet) {
  if (!rootMoves?.length) return null;
  const sorted = [...rootMoves].sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity));
  for (const row of sorted) {
    const matched = matchLegalKey(row?.move, validKeySet);
    if (matched) return matched;
  }
  return null;
}

/** Extract live best-move key from search payload (prefers legal rootMoves). */
export function pvFirstMoveFromLiveSearch(liveSearch, { validKeySet = null, rootMoves = null } = {}) {
  if (!liveSearch) return null;

  const keys =
    validKeySet ??
    (liveSearch._validKeySet instanceof Set ? liveSearch._validKeySet : new Set());

  const fromRoot = bestLegalRootMoveKey(rootMoves ?? liveSearch.rootMoves, keys);
  if (fromRoot) return fromRoot;

  const pvCandidates = [];
  if (Array.isArray(liveSearch.pv) && liveSearch.pv.length > 0) {
    const head = liveSearch.pv[0];
    pvCandidates.push(typeof head === 'string' ? firstPvTokenFromString(head) : toAlgebraic(head));
  }
  if (typeof liveSearch.pv === 'string' && liveSearch.pv.trim()) {
    pvCandidates.push(firstPvTokenFromString(liveSearch.pv));
  }
  const depthLog = liveSearch.depthLog ?? [];
  const deep = deepestDepthEntry(depthLog);
  if (typeof deep?.pv === 'string' && deep.pv.trim()) {
    pvCandidates.push(firstPvTokenFromString(deep.pv));
  }
  if (liveSearch.move && liveSearch.move !== '(none)') {
    pvCandidates.push(liveSearch.move);
  }

  for (const candidate of pvCandidates) {
    const matched = matchLegalKey(candidate, keys);
    if (matched) return matched;
  }

  return null;
}

export { coalesceRootMoves, normalizeRootMoveToken };

/**
 * Resolve highlight / play-now candidate from the active live search only.
 * Returns null when identity checks fail or move is illegal.
 */
export function resolveLiveBestMoveKey(state, { validActions = null } = {}) {
  if (!state.aiThinking || !state.liveSearch) return null;
  if (state.winner || state.isDraw) return null;

  const seat = state.thinkingSeatIndex;
  if (seat == null) return null;

  const ls = state.liveSearch;
  if (ls.seatIndex !== seat) return null;
  if (state.settings.players[seat] !== ls.playerType) return null;
  if (state.playerToMove !== seat + 1) return null;

  const posKey = positionKeyFromActions(state.actions ?? []);
  if (ls.positionKey != null && ls.positionKey !== posKey) return null;

  const gen = state.searchGeneration ?? state.activeSearchGeneration;
  if (gen != null && ls.requestSeq != null && ls.requestSeq !== gen) return null;

  const legal = validActions ?? state.validActions ?? [];
  const validKeySet = buildValidKeySet(legal);
  const rootMoves = mergedRootMoves(ls, state);
  const moveKey = pvFirstMoveFromLiveSearch(ls, { validKeySet, rootMoves });
  if (!moveKey) return null;

  try {
    parseAlgebraic(moveKey);
  } catch {
    return null;
  }

  return moveKey;
}

/** Whether Play Now can safely commit the current live PV move. */
export function canPlayNow(state) {
  return resolveLiveBestMoveKey(state) != null;
}
