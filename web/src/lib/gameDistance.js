import {
  QuoridorBoard,
  parseAlgebraic,
  shortestDistanceToGoal,
} from "./gameLogic.js";

function deepestDepthEntry(depthLog) {
  if (!depthLog?.length) return null;
  return depthLog.reduce((best, entry) =>
    entry.depth > (best?.depth ?? 0) ? entry : best,
  );
}

/** Shorter pawn race to goal — min(white, black) BFS steps at this board. */
export function conservativeDistanceToWin(board) {
  const whiteDist = shortestDistanceToGoal(board, 1);
  const blackDist = shortestDistanceToGoal(board, 2);
  const candidates = [];
  if (Number.isFinite(whiteDist)) candidates.push(whiteDist);
  if (Number.isFinite(blackDist)) candidates.push(blackDist);
  return candidates.length ? Math.min(...candidates) : null;
}

function minEngineRaceDistance(whiteDist, blackDist) {
  const candidates = [];
  const w = Number(whiteDist);
  const b = Number(blackDist);
  if (Number.isFinite(w) && w >= 0) candidates.push(w);
  if (Number.isFinite(b) && b >= 0) candidates.push(b);
  return candidates.length ? Math.min(...candidates) : null;
}

export function pvTokensFromDepthLog(depthLog) {
  const deep = deepestDepthEntry(depthLog);
  if (!deep?.pv || typeof deep.pv !== "string") return [];
  const parts = deep.pv.trim().split(/\s+/).filter(Boolean);
  if (parts[0]?.toLowerCase() === "pv") return parts.slice(1);
  return parts;
}

/** Gorisanson MCTS: mean remaining plies from rollout telemetry. */
export function remainingPliesFromDepthLog(depthLog) {
  const deep = deepestDepthEntry(depthLog);
  const direct = deep?.remainingPlies;
  if (direct != null && Number.isFinite(Number(direct))) {
    return Math.max(1, Math.round(Number(direct)));
  }
  return null;
}

function boardFromActionTokens(tokens) {
  const board = new QuoridorBoard();
  for (const token of tokens) {
    const action = parseAlgebraic(token);
    if (!board.isValid(action)) return null;
    board.takeAction(action);
  }
  return board;
}

/**
 * Min race distance at the end of the engine main line (deepest PV).
 */
export function raceDistanceAtPvLeaf(actions, depthLog) {
  const pvTokens = pvTokensFromDepthLog(depthLog);
  if (!pvTokens.length) return null;
  const history = Array.isArray(actions) ? actions : [];
  const replay = boardFromActionTokens([...history, ...pvTokens]);
  if (!replay) return null;
  return conservativeDistanceToWin(replay);
}

/**
 * Shortest plausible remaining game length along the main line:
 * PV plies + min(white, black) race at the PV leaf.
 */
export function minimumRemainingPliesFromPv(actions, depthLog) {
  const pvTokens = pvTokensFromDepthLog(depthLog);
  if (!pvTokens.length) return null;
  const leafRace = raceDistanceAtPvLeaf(actions, depthLog);
  if (leafRace == null) return null;
  return pvTokens.length + leafRace;
}

/**
 * Snapshot ponder/live search telemetry before a new think clears it.
 * Only accepts hints tied to the current position and seat.
 */
export function clockSearchHintFromState({
  positionKey,
  seatIndex,
  liveSearch = null,
  searchInfo = null,
} = {}) {
  const liveMatches =
    liveSearch?.positionKey === positionKey &&
    liveSearch?.seatIndex === seatIndex;
  if (!liveMatches) {
    return null;
  }
  const depthLog = liveSearch.depthLog?.length
    ? liveSearch.depthLog
    : searchInfo?.depthLog;
  return {
    depthLog: depthLog?.length ? depthLog : null,
    whiteDist: liveSearch.whiteDist ?? searchInfo?.whiteDist ?? null,
    blackDist: liveSearch.blackDist ?? searchInfo?.blackDist ?? null,
  };
}

/**
 * Minimum remaining plies floor for whole-game clock spreading.
 *
 * Priority:
 * 1. PV — main-line length + min race at PV leaf (game cannot end sooner)
 * 2. Engine root refresh_dist — min(whiteDist, blackDist) at current node
 * 3. Board BFS — same min race at current position
 *
 * Baseline before search: {@link WHOLE_GAME_PLAN_MOVES} own-move tail (30).
 */
export function estimateConservativeGameDistance({
  board,
  actions = [],
  depthLog = null,
  whiteDist = null,
  blackDist = null,
} = {}) {
  if (depthLog?.length) {
    const simFloor = remainingPliesFromDepthLog(depthLog);
    if (simFloor != null) return simFloor;
    const pvFloor = minimumRemainingPliesFromPv(actions, depthLog);
    if (pvFloor != null) return pvFloor;
  }

  const engineDist = minEngineRaceDistance(whiteDist, blackDist);
  if (engineDist != null) return engineDist;

  return conservativeDistanceToWin(board);
}
