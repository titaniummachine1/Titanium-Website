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

/** Extract first PV token from live search payload (never from completed move). */
export function pvFirstMoveFromLiveSearch(liveSearch) {
  if (!liveSearch) return null;

  if (Array.isArray(liveSearch.pv) && liveSearch.pv.length > 0) {
    try {
      const head = liveSearch.pv[0];
      if (typeof head === 'string') return firstPvTokenFromString(head);
      return toAlgebraic(head);
    } catch {
      /* fall through */
    }
  }

  if (typeof liveSearch.pv === 'string' && liveSearch.pv.trim()) {
    return firstPvTokenFromString(liveSearch.pv);
  }

  const depthLog = liveSearch.depthLog ?? [];
  const deep = deepestDepthEntry(depthLog);
  if (typeof deep?.pv === 'string' && deep.pv.trim()) {
    return firstPvTokenFromString(deep.pv);
  }

  const rootMoves = liveSearch.rootMoves ?? [];
  if (rootMoves[0]?.move) return rootMoves[0].move;

  if (liveSearch.move && liveSearch.move !== '(none)') return liveSearch.move;

  return null;
}

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

  const moveKey = pvFirstMoveFromLiveSearch(ls);
  if (!moveKey) return null;

  const legal = validActions ?? state.validActions ?? [];
  const validKeys = new Set(legal.map((action) => toAlgebraic(action)));
  if (validKeys.size > 0 && !validKeys.has(moveKey)) return null;

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
