import { resolveDisplayNodes } from "./searchNodes.js";

function deepestDepthEntry(depthLog) {
  if (!depthLog?.length) return null;
  return depthLog.reduce((best, entry) =>
    entry.depth > (best?.depth ?? 0) ? entry : best,
  );
}

function finiteScore(value) {
  if (value == null || !Number.isFinite(Number(value))) {
    return null;
  }
  return Number(value);
}

/**
 * True only when the snapshot contains evidence that an iterative search
 * completed at least one depth. A depth-log entry is completion evidence;
 * scalar depth fields require a finite score because bootstrap depth=0/score=0
 * ticks are emitted before the first completed iteration.
 */
export function hasCompletedSearchIteration(snap = {}) {
  if (Array.isArray(snap.depthLog) &&
      snap.depthLog.some((entry) => Number(entry?.depth) >= 1)) {
    return true;
  }
  const depth = Number(snap.searchDepth ?? snap.depth);
  if (!Number.isFinite(depth) || depth < 1) return false;
  return finiteScore(snap.rootScore) != null || finiteScore(snap.score) != null;
}

/**
 * Best centipawn score for UI. Engines often emit rootScore=0 before the first
 * depth line — never let that mask a real iterative score from depthLog.
 */
export function resolveDisplayScore({
  depthLog,
  rootScore,
  score,
  rootWinRate,
  previousScore,
  previous,
  depth,
  searchDepth,
} = {}) {
  const completed = hasCompletedSearchIteration({
    depthLog, rootScore, score, depth, searchDepth,
  });
  const deepScore = finiteScore(deepestDepthEntry(depthLog)?.score);
  const root = finiteScore(rootScore);
  const flat = finiteScore(score);
  const candidates = completed
    ? [deepScore, root, flat]
    : [deepScore, root, flat].filter((v) => v != null && v !== 0);
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  const retained = finiteScore(previousScore ?? previous);
  return retained;
}

/** Whether a think snapshot has anything worth showing on the player card / eval bar. */
export function thinkSnapHasDisplay(snap) {
  if (!snap) return false;
  if (snap.rootWinRate != null && Number.isFinite(Number(snap.rootWinRate))) {
    return true;
  }
  if (resolveDisplayNodes(snap) > 0) return true;
  const deep = deepestDepthEntry(snap.depthLog);
  if (deep?.score != null && Number.isFinite(Number(deep.score))) return true;
  if (typeof deep?.pv === "string" && deep.pv.trim()) return true;
  if (snap.rootMoves?.length) return true;
  if (hasCompletedSearchIteration(snap)) return true;
  if (finiteScore(snap.score) != null && finiteScore(snap.score) !== 0) return true;
  if (finiteScore(snap.rootScore) != null && finiteScore(snap.rootScore) !== 0) return true;
  return false;
}

/**
 * Retain an evaluation only for the same position. Different position keys
 * deliberately return null so a bootstrap tick cannot leak the old score.
 */
export function retainedEvalForPosition({
  positionKey,
  previousKey,
  previousScore,
  incoming,
} = {}) {
  if (positionKey != null && previousKey != null && positionKey !== previousKey) {
    return null;
  }
  const current = resolveDisplayScore(incoming ?? {});
  return current ?? finiteScore(previousScore);
}

/**
 * Keep the previous think telemetry visible until the incoming search reports
 * something displayable (Gorisanson MCTS progress arrives in bursts).
 */
export function mergeThinkSnapshots(previous, incoming) {
  if (!incoming) return previous ?? null;
  if (!previous) return incoming;
  const changedPosition =
    incoming.positionKey != null &&
    previous.positionKey != null &&
    incoming.positionKey !== previous.positionKey;
  if (changedPosition) return incoming;
  if (!thinkSnapHasDisplay(incoming)) return previous;
  if (!thinkSnapHasDisplay(previous)) return incoming;

  const inDeep = deepestDepthEntry(incoming.depthLog);
  const prevDeep = deepestDepthEntry(previous.depthLog);
  const incomingNodes = resolveDisplayNodes(incoming);
  const previousNodes = resolveDisplayNodes(previous);

  const mergedDepthLog = incoming.depthLog?.length
    ? incoming.depthLog
    : previous.depthLog;
  const incomingScore = resolveDisplayScore({
    ...incoming,
    depthLog: incoming.depthLog,
  });
  const previousScore = resolveDisplayScore(previous);
  const mergedScore = incomingScore ?? previousScore;
  const incomingCp = resolveDisplayScore({
    depthLog: incoming.depthLog,
    rootScore: incoming.rootScore,
    score: incoming.score,
  });
  const hasIncomingCp = incomingCp != null && incomingCp !== 0;

  return {
    ...previous,
    ...incoming,
    depthLog: mergedDepthLog,
    rootMoves: incoming.rootMoves?.length ? incoming.rootMoves : previous.rootMoves,
    rootWinRate: hasIncomingCp
      ? null
      : (incoming.rootWinRate ?? previous.rootWinRate),
    score: mergedScore,
    rootScore: mergedScore,
    depth:
      inDeep?.depth ??
      incoming.depth ??
      incoming.searchDepth ??
      previous.depth ??
      previous.searchDepth ??
      null,
    searchDepth:
      inDeep?.depth ??
      incoming.searchDepth ??
      incoming.depth ??
      previous.searchDepth ??
      previous.depth ??
      null,
    pv: inDeep?.pv || incoming.pv || previous.pv || "",
    nodes: incomingNodes > 0 ? incomingNodes : previousNodes,
    simulations:
      (incoming.simulations ?? 0) > 0
        ? incoming.simulations
        : previous.simulations,
    thinkMs: incoming.thinkMs ?? incoming.elapsedMs ?? previous.thinkMs,
    elapsedMs: incoming.elapsedMs ?? previous.elapsedMs,
    progress: incoming.progress ?? previous.progress,
    whiteDist: incoming.whiteDist ?? previous.whiteDist,
    blackDist: incoming.blackDist ?? previous.blackDist,
  };
}

/** Build a live-search shaped payload for board hints / eval merge. */
export function thinkSnapshotToSearchPayload(snap) {
  if (!snap) return null;
  const resolvedScore = resolveDisplayScore({
    depthLog: snap.depthLog,
    rootScore: snap.rootScore,
    score: snap.score,
    rootWinRate: snap.rootWinRate,
  });
  return {
    depthLog: snap.depthLog ?? [],
    rootMoves: snap.rootMoves ?? [],
    rootWinRate: snap.rootWinRate ?? null,
    rootScore: resolvedScore,
    score: resolvedScore,
    evalUnavailable: resolvedScore == null,
    searchDepth: snap.depth ?? snap.searchDepth ?? null,
    depth: snap.depth ?? snap.searchDepth ?? null,
    pv: snap.pv ?? deepestDepthEntry(snap.depthLog)?.pv ?? "",
    nodes: snap.nodes ?? snap.simulations ?? null,
    simulations: snap.simulations ?? snap.nodes ?? null,
    whiteDist: snap.whiteDist ?? null,
    blackDist: snap.blackDist ?? null,
  };
}
