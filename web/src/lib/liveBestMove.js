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

function committedRootFromDepthLog(depthLog, validKeySet) {
  const deep = deepestDepthEntry(depthLog);
  if (!deep?.pv || typeof deep.pv !== 'string') return null;
  const parts = deep.pv.trim().split(/\s+/).filter(Boolean);
  const single =
    parts.length === 1 || (parts.length === 2 && parts[0]?.toLowerCase() === 'pv');
  if (!single) return null;
  return matchLegalKey(firstPvTokenFromString(deep.pv), validKeySet);
}

/** Extract live best-move key from search payload (prefers legal rootMoves). */
export function pvFirstMoveFromLiveSearch(liveSearch, { validKeySet = null, rootMoves = null } = {}) {
  if (!liveSearch) return null;

  const keys =
    validKeySet ??
    (liveSearch._validKeySet instanceof Set ? liveSearch._validKeySet : new Set());

  const fromRootMoveField = matchLegalKey(liveSearch.rootMove, keys);
  if (fromRootMoveField) return fromRootMoveField;

  const fromCommittedDepth = committedRootFromDepthLog(liveSearch.depthLog ?? [], keys);
  if (fromCommittedDepth) return fromCommittedDepth;

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
  if (!state.aiThinking) return null;
  if (state.winner || state.isDraw) return null;

  const seat = state.thinkingSeatIndex;
  if (seat == null) return null;

  const ls = {
    ...(state.activeSearchInfo ?? {}),
    ...(state.liveSearch ?? {}),
    seatIndex: state.liveSearch?.seatIndex ?? seat,
    playerType: state.liveSearch?.playerType ?? state.settings.players[seat],
    requestSeq: state.liveSearch?.requestSeq ?? state.searchGeneration,
    positionKey: state.liveSearch?.positionKey ?? positionKeyFromActions(state.actions ?? []),
  };
  if (!state.liveSearch && !state.activeSearchInfo) return null;
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

/**
 * Aggressive Play-now resolver: commit any legal best the engine currently
 * reports for the thinking seat. Unlike resolveLiveBestMoveKey, does not
 * require requestSeq / positionKey / playerType identity matches when the
 * payload clearly belongs to that seat (seatIndex match or unset).
 *
 * Source order: rootMove → best legal rootMoves → depthLog PV head → pv →
 * searchInfoBySeat / activeSearchInfo → lastCompletedThinkBySeat (same pos).
 */
export function resolvePlayNowMoveKey(state, { validActions = null } = {}) {
  if (!state.aiThinking) return null;
  if (state.winner || state.isDraw) return null;

  const seat = state.thinkingSeatIndex;
  if (seat == null) return null;

  const legal = validActions ?? state.validActions ?? [];
  const validKeySet = buildValidKeySet(legal);
  const posKey = positionKeyFromActions(state.actions ?? []);

  const belongsToSeat = (payload) => {
    if (!payload) return false;
    return payload.seatIndex == null || payload.seatIndex === seat;
  };

  const tryPayload = (payload) => {
    if (!belongsToSeat(payload)) return null;

    const fromRootMove = matchLegalKey(payload.rootMove, validKeySet);
    if (fromRootMove) return fromRootMove;

    const rootMoves = mergedRootMoves(payload, state);
    const fromRoot = bestLegalRootMoveKey(
      rootMoves.length ? rootMoves : payload.rootMoves,
      validKeySet,
    );
    if (fromRoot) return fromRoot;

    const deep = deepestDepthEntry(payload.depthLog ?? []);
    if (typeof deep?.pv === 'string' && deep.pv.trim()) {
      const fromDepth = matchLegalKey(firstPvTokenFromString(deep.pv), validKeySet);
      if (fromDepth) return fromDepth;
    }

    if (Array.isArray(payload.pv) && payload.pv.length > 0) {
      const head = payload.pv[0];
      const tok =
        typeof head === 'string' ? firstPvTokenFromString(head) : toAlgebraic(head);
      const matched = matchLegalKey(tok, validKeySet);
      if (matched) return matched;
    }
    if (typeof payload.pv === 'string' && payload.pv.trim()) {
      const matched = matchLegalKey(firstPvTokenFromString(payload.pv), validKeySet);
      if (matched) return matched;
    }

    if (payload.move && payload.move !== '(none)') {
      const matched = matchLegalKey(payload.move, validKeySet);
      if (matched) return matched;
    }

    return null;
  };

  const finalize = (key) => {
    if (!key) return null;
    try {
      parseAlgebraic(key);
      return key;
    } catch {
      return null;
    }
  };

  const live = state.liveSearch;
  const active = state.activeSearchInfo;
  const seatInfo = state.searchInfoBySeat?.[seat];

  // Prefer a merged live view (live overlays active/seat info).
  if (live || active || seatInfo) {
    const merged = {
      ...(seatInfo ?? {}),
      ...(active ?? {}),
      ...(live ?? {}),
      seatIndex: live?.seatIndex ?? active?.seatIndex ?? seat,
    };
    const key = finalize(tryPayload(merged));
    if (key) return key;
  }

  for (const payload of [live, active, seatInfo]) {
    const key = finalize(tryPayload(payload));
    if (key) return key;
  }

  const completed = state.lastCompletedThinkBySeat?.[seat];
  if (completed) {
    const completedPos = completed.positionKey;
    if (completedPos == null || completedPos === posKey) {
      const key = finalize(tryPayload(completed));
      if (key) return key;
    }
  }

  return null;
}
