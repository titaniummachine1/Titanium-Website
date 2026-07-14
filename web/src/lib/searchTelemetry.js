import { resolveDisplayNodes } from "./searchNodes.js";

function deepestDepthEntry(depthLog) {
  if (!depthLog?.length) return null;
  return depthLog.reduce((best, entry) =>
    entry.depth > (best?.depth ?? 0) ? entry : best,
  );
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
  if (snap.depth != null || snap.searchDepth != null) return true;
  if (snap.score != null && Number.isFinite(Number(snap.score))) return true;
  if (snap.rootScore != null && Number.isFinite(Number(snap.rootScore))) return true;
  return false;
}

/**
 * Keep the previous think telemetry visible until the incoming search reports
 * something displayable (Gorisanson MCTS progress arrives in bursts).
 */
export function mergeThinkSnapshots(previous, incoming) {
  if (!incoming) return previous ?? null;
  if (!previous) return incoming;
  if (!thinkSnapHasDisplay(incoming)) return previous;
  if (!thinkSnapHasDisplay(previous)) return incoming;

  const inDeep = deepestDepthEntry(incoming.depthLog);
  const prevDeep = deepestDepthEntry(previous.depthLog);
  const incomingNodes = resolveDisplayNodes(incoming);
  const previousNodes = resolveDisplayNodes(previous);

  const incomingScore =
    incoming.rootScore ??
    incoming.score ??
    inDeep?.score ??
    null;
  const hasIncomingScore = Number.isFinite(Number(incomingScore));

  return {
    ...previous,
    ...incoming,
    depthLog: incoming.depthLog?.length ? incoming.depthLog : previous.depthLog,
    rootMoves: incoming.rootMoves?.length ? incoming.rootMoves : previous.rootMoves,
    rootWinRate: hasIncomingScore
      ? null
      : (incoming.rootWinRate ?? previous.rootWinRate),
    score:
      inDeep?.score ??
      incoming.score ??
      incoming.rootScore ??
      previous.score ??
      previous.rootScore ??
      null,
    rootScore:
      inDeep?.score ??
      incoming.rootScore ??
      incoming.score ??
      previous.rootScore ??
      previous.score ??
      null,
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
  return {
    depthLog: snap.depthLog ?? [],
    rootMoves: snap.rootMoves ?? [],
    rootWinRate: snap.rootWinRate ?? null,
    rootScore: snap.score ?? snap.rootScore ?? null,
    score: snap.score ?? snap.rootScore ?? null,
    searchDepth: snap.depth ?? snap.searchDepth ?? null,
    depth: snap.depth ?? snap.searchDepth ?? null,
    pv: snap.pv ?? deepestDepthEntry(snap.depthLog)?.pv ?? "",
    nodes: snap.nodes ?? snap.simulations ?? null,
    simulations: snap.simulations ?? snap.nodes ?? null,
    whiteDist: snap.whiteDist ?? null,
    blackDist: snap.blackDist ?? null,
  };
}
