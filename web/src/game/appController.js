import { GameSession } from "./gameSession.js";
import {
  naiveDistanceEval,
  parseAlgebraic,
  isWallAction,
  QuoridorBoard,
} from "../lib/gameLogic.js";
import {
  clockSearchHintFromState,
  estimateConservativeGameDistance,
  pvTokensFromDepthLog,
  remainingPliesFromDepthLog,
} from "../lib/gameDistance.js";
import {
  decodeReplayCode,
  encodeReplayFromActions,
  tokenizeAlgebraicNotation,
} from "../lib/replayCode.js";
import {
  AnalysisEngineSession,
  analysisResultToEvalState,
} from "./analysisEngineSession.js";
import {
  ReviewAnalysisSession,
  classifyReviewMoves,
} from "./reviewAnalysisSession.js";
import {
  LMR_AGGRESSION_DEFAULT,
  fetchCatSnapshot,
  indexCatWalls,
  prewarmCatSnapshot,
  applyVisionTuning,
  getVisionTuning,
} from "../lib/catHeatmap.js";
import { buildLmrViz, fetchLmrSnapshot } from "../lib/lmrHeatmap.js";
import { toAlgebraic } from "../lib/gameLogic.js";
import { EngineClient } from "../lib/engineClient.js";
import { GorisansonEngineClient } from "../lib/localMctsEngine.js";
import { TitaniumEngineClient } from "../lib/titaniumRustClient.js";
import { TitaniumWasmEngineClient } from "../lib/titaniumWasmClient.js";
import { resolveOnBestMoveResult } from "../lib/onBestMoveResult.js";
import {
  positionKeyFromActions,
  resolveLiveBestMoveKey,
  pvFirstMoveFromLiveSearch,
  coalesceRootMoves,
} from "../lib/liveBestMove.js";
import {
  positionKeyFromHistory as historyPositionKey,
  SyncState,
} from "../lib/remoteSync.js";
import {
  buildDiagnosticContext,
  validateEngineMoveBeforeCommit,
  canonicalStateFromBoard,
  canonicalPositionKeyFromBoard,
  assertPostWallInvariants,
} from "../lib/canonicalState.js";
import { TitaniumLegalityOracle } from "../lib/titaniumLegalityOracle.js";
import { createTitaniumLegalityRuntime } from "../lib/titaniumLegalityRuntime.js";
import { validateMoveLegality } from "../lib/validateMoveLegality.js";
import { isAbortError } from "../lib/engineAbort.js";
import { formatEngineFailureMessage, engineFailureBackoffMs } from "../lib/engineFailureReport.js";
import { TITANIUM_MATE_VALUE } from "../lib/engineScore.js";
import { resolveDisplayNodes } from "../lib/searchNodes.js";
import {
  mergeThinkSnapshots,
  thinkSnapshotToSearchPayload,
  resolveDisplayScore,
} from "../lib/searchTelemetry.js";
import { getEngineEntryForPlayer } from "../engines/engineRegistry.js";
import { requestEngineMove } from "../engines/requestEngineMove.js";
import { validateEngineResultIdentity } from "../engines/validateEngineResultIdentity.js";
import { logAiRequestEvent } from "../engines/aiRequestLog.js";
import { EngineBackendKind } from "../engines/engineBackend.js";
import {
  finishedGamePayload,
  finishedGameSignature,
  submitFinishedGame,
} from "../lib/trainingSubmit.js";
import { AceV10JsEngineClient } from "../lib/aceV10JsEngine.js";
import { AceV13JsEngineClient } from "../lib/aceV13JsEngine.js";
import { AceRustWasmEngineClient } from "../lib/aceRustWasmClient.js";
import {
  resolveAceTier,
  aceDisplayName,
  clampAceV10Tier,
  migrateAceV10Strength,
  defaultAceCompareAiSettings,
  aceGenerationFromPlayerType,
} from "../lib/aceTier.js";
import { QuoridorV3EngineClient } from "../lib/quoridorV3Engine.js";
import { ZeroInkEngineClient } from "../lib/zeroInkEngine.js";
import { PlayerType, StrengthLevel, TimeToMove } from "../lib/engineConfig.js";
import {
  STRENGTH_LEVEL_PRESETS,
  TIME_TO_MOVE_PRESETS,
  getAllEngineConfigs,
  getPlayerOptionGroups,
  flattenPlayerOptions,
  describeTimeBudget,
  describeActiveSearchInfo,
} from "../lib/playerRegistry.js";

const DEFAULT_CAT_VISION_SETTINGS = Object.freeze({
  showSquares: true,
  showWalls: true,
  squareOpacity: 1,
  wallOpacity: 1,
});

function mergeDepthLogs(existing, incoming) {
  const byDepth = new Map(
    (existing ?? []).map((entry) => [entry.depth, entry]),
  );
  for (const entry of incoming ?? []) {
    byDepth.set(entry.depth, entry);
  }
  return [...byDepth.values()].sort((a, b) => a.depth - b.depth);
}

function deepestDepthEntry(depthLog) {
  if (!depthLog?.length) {
    return null;
  }
  return depthLog.reduce((best, entry) =>
    entry.depth > (best?.depth ?? 0) ? entry : best,
  );
}

function scoreFromDepthLog(depthLog, rootScore, rootWinRate) {
  return resolveDisplayScore({ depthLog, rootScore, rootWinRate });
}

function sanitizeSearchPayloadForEngine(payload, playerType, engineConfigs) {
  if (!payload) {
    return payload;
  }
  if (isTitaniumEngine(playerType, engineConfigs) || isAceFamily(playerType, engineConfigs)) {
    return { ...payload, rootWinRate: null, evalKind: "score" };
  }
  if (isGorisansonEngine(playerType, engineConfigs)) {
    return {
      ...payload,
      rootScore: null,
      score: null,
      evalKind: "winrate",
    };
  }
  return payload;
}

function finalizeSearchInfo(info) {
  const depthLog = info?.depthLog ? [...info.depthLog] : [];
  const deep = deepestDepthEntry(depthLog);
  const nodes = resolveDisplayNodes(info);
  return {
    ...info,
    depthLog,
    nodes,
    simulations: Number(info?.simulations) || nodes,
    searchDepth: info?.searchDepth ?? deep?.depth ?? null,
    rootScore: scoreFromDepthLog(depthLog, info?.rootScore, info?.rootWinRate),
    pv: deep?.pv ?? info?.pv ?? "",
  };
}

function resolveThinkMs(info, thinkStartedAt) {
  if (info?.elapsedMs != null && Number.isFinite(Number(info.elapsedMs))) {
    return Math.round(Number(info.elapsedMs));
  }
  if (info?.time != null && Number.isFinite(Number(info.time))) {
    return Math.round(Number(info.time));
  }
  if (thinkStartedAt != null) {
    return Math.round(performance.now() - thinkStartedAt);
  }
  return null;
}

function buildThinkSeatSnapshot({
  engine,
  live = false,
  move = null,
  ply = null,
  depthLog,
  searchDepth,
  whiteDist,
  blackDist,
  rootScore,
  nodes,
  simulations,
  selectedWorkerNodes,
  totalNodes,
  totalNodesAcrossWorkers,
  mainThreadNodes,
  helperNodes,
  nodeSource,
  estimatedTotalNodes,
  rootWinRate,
  stoppedBy,
  rootMoves,
  lmrProfile,
  lmrReSearches,
  helperStarts,
  helperStartsTotal,
  requestedThreads,
  effectiveThreads,
  threaded,
  fallbackReason,
  thinkMs,
}) {
  const deep = deepestDepthEntry(depthLog);
  const resolvedNodes = resolveDisplayNodes({ nodes, simulations, depthLog });
  return {
    live,
    engine,
    move,
    ply,
    whiteDist,
    blackDist,
    score: deep?.score ?? rootScore ?? null,
    depth: deep?.depth ?? searchDepth ?? null,
    pv: deep?.pv ?? "",
    nodes: resolvedNodes,
    simulations: simulations ?? resolvedNodes,
    selectedWorkerNodes: selectedWorkerNodes ?? null,
    totalNodes: totalNodes ?? null,
    totalNodesAcrossWorkers: totalNodesAcrossWorkers ?? null,
    mainThreadNodes: mainThreadNodes ?? null,
    helperNodes: helperNodes ? [...helperNodes] : null,
    nodeSource: nodeSource ?? null,
    estimatedTotalNodes: estimatedTotalNodes ?? null,
    rootWinRate,
    stoppedBy: stoppedBy ?? (live ? "searching" : "?"),
    rootMoves: rootMoves ? [...rootMoves] : [],
    lmrProfile: lmrProfile ?? null,
    lmrReSearches: lmrReSearches ?? null,
    helperStarts: helperStarts ?? null,
    helperStartsTotal: helperStartsTotal ?? null,
    requestedThreads: requestedThreads ?? null,
    effectiveThreads: effectiveThreads ?? null,
    threaded: threaded ?? null,
    fallbackReason: fallbackReason ?? null,
    depthLog: depthLog ? [...depthLog] : [],
    thinkMs: thinkMs ?? null,
  };
}

function pvArrayFromPayload(payload) {
  if (Array.isArray(payload?.pv)) {
    return payload.pv.filter(Boolean).map(String);
  }
  if (typeof payload?.pv === "string") {
    return payload.pv.trim().split(/\s+/).filter(Boolean);
  }
  const deep = deepestDepthEntry(payload?.depthLog);
  if (typeof deep?.pv === "string") {
    return deep.pv.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function terminalEvalState(snapshot) {
  if (snapshot.isDraw) {
    return {
      p1: 0.5,
      margin: 0,
      rootScore: 0,
      evalKind: "score",
      playerToMove: snapshot.playerToMove,
      pv: [],
      rootMoves: [],
      source: "terminal",
    };
  }
  if (snapshot.winner === 1) {
    return {
      p1: 0.99,
      margin: 99,
      rootScore: TITANIUM_MATE_VALUE,
      evalKind: "score",
      playerToMove: snapshot.playerToMove,
      pv: [],
      rootMoves: [],
      source: "terminal",
    };
  }
  if (snapshot.winner === 2) {
    return {
      p1: 0.01,
      margin: -99,
      rootScore: -TITANIUM_MATE_VALUE,
      evalKind: "score",
      playerToMove: snapshot.playerToMove,
      pv: [],
      rootMoves: [],
      source: "terminal",
    };
  }
  return null;
}

function distanceEvalState(snapshot, distanceEval) {
  let rootScore = null;
  if (distanceEval.whiteDist === 0) {
    rootScore = TITANIUM_MATE_VALUE;
  } else if (distanceEval.blackDist === 0) {
    rootScore = -TITANIUM_MATE_VALUE;
  }
  return {
    p1: distanceEval.p1,
    margin: distanceEval.margin,
    whiteDist: distanceEval.whiteDist,
    blackDist: distanceEval.blackDist,
    rootScore,
    evalKind: rootScore != null ? "score" : "distance",
    playerToMove: snapshot.playerToMove,
    pv: [],
    rootMoves: [],
    source: "distance",
  };
}

function searchPayloadToEvalState(payload, playerToMove) {
  if (!payload) {
    return null;
  }
  const hasDist =
    Number.isFinite(payload.whiteDist) && Number.isFinite(payload.blackDist);
  const margin = hasDist ? payload.blackDist - payload.whiteDist : 0;
  const deep = deepestDepthEntry(payload.depthLog);
  const scoreCandidate = resolveDisplayScore({
    depthLog: payload.depthLog,
    rootScore: payload.rootScore,
    score: payload.score,
    rootWinRate: payload.rootWinRate,
  });
  const hasScore =
    payload.evalKind === "score" ||
    (payload.evalKind !== "winrate" && scoreCandidate != null);
  const hasWinRate =
    !hasScore &&
    (payload.evalKind === "winrate" ||
      Number.isFinite(Number(payload.rootWinRate)));

  let p1;
  let whiteScore = null;
  if (hasScore) {
    const sideScore = Number(scoreCandidate);
    whiteScore = playerToMove === 2 ? -sideScore : sideScore;
    p1 = 1 / (1 + Math.exp(-whiteScore / 350));
  } else if (Number.isFinite(Number(payload.rootWinRate))) {
    const sideWinRate = Math.max(0, Math.min(1, Number(payload.rootWinRate)));
    p1 = playerToMove === 2 ? 1 - sideWinRate : sideWinRate;
  } else if (hasDist) {
    p1 = 0.5 + margin * 0.07;
  } else {
    return null;
  }
  p1 = Math.max(0.05, Math.min(0.95, p1));

  return {
    p1,
    margin,
    whiteDist: payload.whiteDist,
    blackDist: payload.blackDist,
    rootScore: whiteScore,
    playerToMove,
    depth: payload.depth ?? payload.searchDepth ?? deep?.depth ?? null,
    pv: pvArrayFromPayload(payload),
    rootMove: payload.rootMove ?? null,
    rootWinRate: hasWinRate ? Number(payload.rootWinRate) : null,
    evalKind: hasScore ? "score" : hasWinRate ? "winrate" : hasDist ? "distance" : "none",
    rootMoves: Array.isArray(payload.rootMoves) ? [...payload.rootMoves] : [],
  };
}
import {
  WALL_CLOCK_RANGE,
  LOCAL_VISITS_RANGE,
  clampVisits,
  sliderPositionFromVisits,
  defaultPlayerAiSettings,
  describePlayerAiSettings,
  isLocalEngine,
  isLocalMctsEngine,
  isRemoteEngine,
  isZeroInkEngine,
  isCloudRemoteEngine,
  isTitaniumEngine,
  isQuoridorV3Engine,
  isAceEngine,
  isAceFamily,
  isAceV8Family,
  isAceV10Family,
  normalizePlayerType,
  getEngineConfig,
  resolveTitaniumEngineMode,
  resolveCatLmrCeiling,
  resolveCores,
  clampCores,
  defaultCoreCount,
  TITANIUM_DEPTH_UNLIMITED,
  migrateTitaniumDepthLimit,
  clampTitaniumDepthLimit,
  allocateWholeGameTime,
  chargeThinkMsForSeat,
  clockLogUsedMs,
  trimThinkLogToPly,
  tightenThinkAllocation,
  defaultAnalysisThreadCount,
  supportsWholeGameTime,
  hasSeatClock,
  isGorisansonEngine,
} from "../lib/timeControl.js";
import { playerColorName } from "../lib/playerColors.js";
import { ponderCandidateSlots } from "../lib/enginePonder.js";
import {
  loadPersistedPlaySettings,
  savePersistedPlaySettings,
} from "../lib/persistedPlaySettings.js";
import { hasNativeTitaniumLazySmp } from "../lib/titaniumRuntime.js";

const HAS_NATIVE_TITANIUM_LAZY_SMP = hasNativeTitaniumLazySmp();

function isSavedSettingsValid(playerType, saved, engineConfigs) {
  if (playerType === PlayerType.Human) {
    return saved?.wallClockSeconds != null;
  }
  if (isTitaniumEngine(playerType, engineConfigs)) {
    return saved.wallClockSeconds != null;
  }
  if (isAceFamily(playerType, engineConfigs)) {
    return saved.strengthLevel != null && saved.wallClockSeconds != null;
  }
  if (isLocalEngine(playerType, engineConfigs)) {
    return saved.wallClockSeconds != null && saved.visitsBudget != null;
  }
  if (playerType === PlayerType.ZeroInk) {
    return saved.timeToMove != null;
  }
  if (isRemoteEngine(playerType, engineConfigs)) {
    return saved.strengthLevel != null && saved.timeToMove != null;
  }
  return false;
}

export class AppController {
  constructor() {
    this.session = new GameSession();
    this.engines = new Map();
    this.engineConfigs = getAllEngineConfigs();

    const titaniumDefault = defaultPlayerAiSettings(
      PlayerType.TitaniumV17,
      this.engineConfigs,
    );
    const humanDefault = defaultPlayerAiSettings(
      PlayerType.Human,
      this.engineConfigs,
    );
    const persisted = loadPersistedPlaySettings();
    const playDefaults = {
      players: [PlayerType.Human, PlayerType.TitaniumV17],
      playerAiSettings: [humanDefault, { ...titaniumDefault }],
      playerAiSettingsMemory: [{}, {}],
    };
    const restored = persisted
      ? {
          players: persisted.players.map((p) => normalizePlayerType(p)),
          playerAiSettings: persisted.playerAiSettings ?? [{}, {}],
          playerAiSettingsMemory: persisted.playerAiSettingsMemory ?? [{}, {}],
          displayEvalBar: persisted.displayEvalBar !== false,
          showBestMoveHint: persisted.showBestMoveHint !== false,
        }
      : playDefaults;
    const visionTuning = getVisionTuning();
    this.settings = {
      ...restored,
      rotateBoard: false,
      displayCoordinates: true,
      displayRemainingWalls: true,
      displayEvalBar: restored.displayEvalBar !== false,
      showCatVision: false,
      catVision: { ...DEFAULT_CAT_VISION_SETTINGS },
      showLmrVision: false,
      lmrVisionShallow: true,
      pathBiasPercent: visionTuning.pathBiasPercent,
      lmrAggressionPercent: visionTuning.lmrAggressionPercent,
      showBestMoveHint: restored.showBestMoveHint !== false,
      uiMode: "play",
      analysisEngine: {
        unlimited: true,
        wallClockSeconds: 5,
        cores: defaultAnalysisThreadCount(),
        searchDepthLimit: 0,
      },
    };
    for (let seat = 0; seat < 2; seat++) {
      const playerType = this.settings.players[seat];
      this.ensurePlayerAiSettingsSlot(seat + 1, playerType);
    }

    this.replay = null;
    this.catViz = null;
    this.catVizLoading = false;
    this.catVizError = null;
    this._catFetchSeq = 0;
    this._catMovesKey = null;
    this.catHintDismissed = false;
    this.showCatHint = false;
    this.lmrShallowByPosition = new Map();
    this.lmrSearchByPosition = new Map();
    this.lmrVizLive = null;
    this.lmrVizLoading = false;
    this.lmrVizError = null;
    this._lmrFetchSeq = 0;
    this._lmrShallowKey = null;
    this._lmrShallowDepth = 0;
    this._lmrDisplayViz = null;
    this.lmrHintDismissed = false;
    this.showLmrHint = false;

    this.engineStatus = {};
    this.engineErrors = {};
    this.searchInfoBySeat = [null, null];
    this.moveThinkLog = [];
    // Completed history remains visible after a clock reset, while this credit
    // makes the replacement clock start at its full configured value.
    this._clockResetCreditMs = [0, 0];
    this._humanThinkStartedAt = null;
    this._humanTimedOut = [false, false];
    this.settingsChangelog = [];
    this.initialBudgetHint = null;
    this.lastThinkBySeat = [null, null];
    /** Frozen per-seat card after each played move — kept while opponent thinks. */
    this.lastCompletedThinkBySeat = [null, null];
    this.eval = { score: 0.5, p1: 0.5, pv: [] };
    this.evalCacheByMode = {
      play: new Map(),
      analysis: new Map(),
      replay: new Map(),
    };
    this.analysisSession = new AnalysisEngineSession();
    this.analysisEval = null;
    this.analysisEvalError = null;
    this._analysisPositionKey = null;
    this.reviewSession = new ReviewAnalysisSession();
    this.reviewAnalysis = this.reviewSession.snapshot();
    this.reviewSession.onUpdate = (result) => {
      this.reviewAnalysis = {
        ...result,
        classifications: classifyReviewMoves(
          result.positions,
          this.replay?.algebraic ?? [],
        ),
      };
      if (this.replay) {
        for (let i = 0; i < result.positions.length; i += 1) {
          const position = result.positions[i];
          if (position?.status !== "done" || !position.eval) {
            continue;
          }
          const key = positionKeyFromActions(this.replay.actions.slice(0, i));
          this._cacheEvalState("replay", key, {
            ...position.eval,
            source: "review-batch",
          });
        }
      }
      this.onChange?.();
    };
    this.analysisSession.onUpdate = (result, err) => {
      if (err) {
        this.analysisEvalError = err;
      } else {
        this.analysisEval = result;
        this.analysisEvalError = null;
        const key = this._analysisPositionKey ?? this.currentPositionKey();
        const evalState = analysisResultToEvalState(result);
        if (evalState) {
          this._cacheEvalState(this._evalModeKey(), key, {
            ...evalState,
            source: "analysis-engine",
          });
        }
      }
      this.onChange?.();
    };
    this.aiThinking = false;
    this.liveSearch = null;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this._moveRequestSeq = 0;
    this._gameGeneration = 0;
    this._thinkAiSettings = null;
    this._thinkClockLastDepth = null;
    this._thinkClockLastPv = null;
    this._clockTickId = null;
    this._illegalRetriesByPly = {};
    this._maxIllegalRetries = 2;
    this._engineFailureRetryBySeat = {};
    this._engineFailureRetryTimer = null;
    this._maxEngineFailureRetries = 10;
    this._engineRecoveryActive = false;
    this._engineRecoverySeat = -1;
    /** Skip onSessionChange → onChange while applyEngineMove is mid-apply (snapshot not ready). */
    this._suppressSessionNotify = false;
    this._activeSearchSeq = 0;
    this.enginesPaused = false;
    this._playNowLock = false;
    /** Serialize engine commits — concurrent applyEngineMove must not double-apply. */
    this._engineApplyChain = Promise.resolve();
    this._terminalOverlayDismissed = false;
    this._gameHalted = false;
    this._submittedFinishedGames = new Set();
    this._lastDiagnostic = null;
    this.startupConfirmed = false;
    this._activeAiAbort = null;
    this.titaniumLegalityOracle = new TitaniumLegalityOracle({
      createRuntime: createTitaniumLegalityRuntime,
    });
    this.legalityOracleState = { ready: false, error: null };
    this.migrateLegacyPlayerTypes();
    // First paint: Titanium vs local αβ adversary should not always be White.
    this.maybeRandomizeTitaniumAdversarySeats();
    this.initialBudgetHint = describeTimeBudget(
      this.settings.players,
      this.settings.playerAiSettings,
      this.engineConfigs,
    );
  }

  /**
   * The eval bar never competes with an active play engine. If a seat engine
   * is thinking, its live info-card payload is the eval source. The dedicated
   * analysis session is only for positions with no play search to mirror:
   * paused Play, Analysis, and Review.
   */
  _hasBorrowablePlaySearch() {
    return (
      this.settings.uiMode === "play" &&
      this.aiThinking &&
      this.thinkingSeatIndex != null
    );
  }

  _analysisShouldBeActive() {
    if (this._hasBorrowablePlaySearch()) {
      return false;
    }
    if (this.settings.uiMode === "analysis") {
      return !this.enginesPaused;
    }
    if (this.settings.uiMode === "replay") {
      return false;
    }
    return this.enginesPaused;
  }

  setAnalysisEngineSetting(key, value) {
    if (!this.settings.analysisEngine) {
      this.settings.analysisEngine = {
        unlimited: true,
        wallClockSeconds: 5,
        cores: defaultAnalysisThreadCount(),
        searchDepthLimit: 0,
      };
    }
    this.settings.analysisEngine = {
      ...this.settings.analysisEngine,
      [key]: value,
    };
    this._analysisPositionKey = null; // force a re-search with the new setting
    if (this.settings.uiMode === "replay" && this.replay) {
      this._startReviewAnalysis();
    }
    this.onChange?.();
  }

  _syncAnalysisSessionActive() {
    const should = this._analysisShouldBeActive();
    if (should && !this.analysisSession.isActive()) {
      this.analysisSession.start();
      this._analysisPositionKey = null; // force a fresh search on the current position
    } else if (!should && this.analysisSession.isActive()) {
      this.analysisSession.stop();
      this.analysisEval = null;
    }
  }

  _syncAnalysisPositionIfNeeded(positionKey) {
    if (
      !this.analysisSession.isActive() ||
      positionKey === this._analysisPositionKey
    ) {
      return;
    }
    this._analysisPositionKey = positionKey;
    this.analysisEval = null;
    this.analysisEvalError = null;
    this.analysisSession.setPosition(
      this.session.actions,
      this.settings.analysisEngine,
    );
  }

  _evalModeKey() {
    return this.settings.uiMode === "replay"
      ? "replay"
      : this.settings.uiMode === "analysis"
        ? "analysis"
        : "play";
  }

  _cacheEvalState(mode, positionKey, evalState) {
    const map = this.evalCacheByMode?.[mode];
    if (!map || !positionKey || !evalState) {
      return;
    }
    map.set(positionKey, { ...evalState });
  }

  _cachedEvalState(positionKey) {
    const cached =
      this.evalCacheByMode?.[this._evalModeKey()]?.get(positionKey);
    return cached ? { ...cached, cached: true } : null;
  }

  _seedReviewPositions(actions) {
    return Array.from({ length: actions.length + 1 }, (_, index) => {
      const key = positionKeyFromActions(actions.slice(0, index));
      const cached = this.evalCacheByMode.replay.get(key);
      return cached
        ? { index, status: "done", eval: { ...cached, source: "review-batch" } }
        : null;
    });
  }

  _startReviewAnalysis() {
    if (!this.replay) {
      return;
    }
    this.analysisSession.stop();
    this.analysisEval = null;
    this._analysisPositionKey = null;
    this.reviewSession.start(
      this.replay.actions,
      this.settings.analysisEngine,
      this._seedReviewPositions(this.replay.actions),
    );
  }

  _stopReviewAnalysis() {
    this.reviewSession.stop({ destroyClients: true });
    this.reviewAnalysis = this.reviewSession.snapshot();
  }

  toggleReviewAnalysisPaused() {
    this.reviewSession.togglePaused();
  }

  _liveEngineEvalState(positionKey) {
    if (
      this.settings.uiMode !== "play" ||
      !this.aiThinking ||
      this.thinkingSeatIndex == null ||
      !(this.liveSearch || this.searchInfoBySeat[this.thinkingSeatIndex])
    ) {
      return null;
    }
    const seat = this.thinkingSeatIndex;
    const playerType = this.settings.players[seat];
    const active = this.searchInfoBySeat[seat] ?? null;
    const live = this.liveSearch ?? null;
    const depthLog = active?.depthLog?.length
      ? active.depthLog
      : (live?.depthLog ?? []);
    const completed = thinkSnapshotToSearchPayload(
      this.lastCompletedThinkBySeat?.[seat],
    );
    const payload = sanitizeSearchPayloadForEngine(
      mergeThinkSnapshots(completed, {
        ...(live ?? {}),
        ...(active ?? {}),
        depthLog,
      }),
      playerType,
      this.engineConfigs,
    );
    const evalState = searchPayloadToEvalState(
      payload,
      this.session.playerToMove,
    );
    if (!evalState) {
      return null;
    }
    const withSource = {
      ...evalState,
      source: "play-live",
    };
    this._cacheEvalState("play", positionKey, withSource);
    return withSource;
  }

  _latestCompletedEngineEvalState() {
    if (this.settings.uiMode !== "play") {
      return null;
    }
    let bestSeat = null;
    let bestSnap = null;
    for (let seat = 0; seat < 2; seat++) {
      const snap =
        this.lastCompletedThinkBySeat?.[seat] ?? this.lastThinkBySeat?.[seat];
      if (
        !snap ||
        snap.live ||
        (snap.score == null &&
          snap.rootScore == null &&
          snap.rootWinRate == null &&
          !snap.depthLog?.length)
      ) {
        continue;
      }
      if (!bestSnap || (snap.ply ?? -1) > (bestSnap.ply ?? -1)) {
        bestSeat = seat;
        bestSnap = snap;
      }
    }
    if (!bestSnap || bestSeat == null) {
      return null;
    }
    const playerType = this.settings.players[bestSeat];
    const evalState = searchPayloadToEvalState(
      sanitizeSearchPayloadForEngine(
        {
          ...bestSnap,
          rootScore: bestSnap.score ?? bestSnap.rootScore,
          rootWinRate: bestSnap.rootWinRate ?? null,
          searchDepth: bestSnap.depth ?? bestSnap.searchDepth,
        },
        playerType,
        this.engineConfigs,
      ),
      bestSeat + 1,
    );
    return evalState
      ? {
          ...evalState,
          source: "play-last",
        }
      : null;
  }

  getState() {
    const snapshot = this.session.getSnapshot();
    const distanceEval = naiveDistanceEval(this.session.board);
    const terminal = snapshot.winner != null || snapshot.isDraw;
    const positionKey = this.currentPositionKey();

    if (this._analysisShouldBeActive()) {
      this._syncAnalysisPositionIfNeeded(positionKey);
    }
    const liveAnalysisEvalRaw = this._analysisShouldBeActive()
      ? analysisResultToEvalState(this.analysisEval)
      : null;
    const liveAnalysisEval = liveAnalysisEvalRaw
      ? { ...liveAnalysisEvalRaw, source: "analysis-engine" }
      : null;
    if (liveAnalysisEval) {
      this._cacheEvalState(this._evalModeKey(), positionKey, liveAnalysisEval);
    }
    const livePlayEval = this._liveEngineEvalState(positionKey);
    const latestCompletedPlayEval = this._latestCompletedEngineEvalState();
    const cachedEval = this._cachedEvalState(positionKey);
    const distanceEvalStateForSnapshot = distanceEvalState(
      snapshot,
      distanceEval,
    );
    const terminalEval = terminal ? terminalEvalState(snapshot) : null;
    const reviewPendingEvalState = {
      p1: 0.5,
      margin: 0,
      whiteDist: distanceEval.whiteDist,
      blackDist: distanceEval.blackDist,
      playerToMove: snapshot.playerToMove,
      pv: [],
      rootMoves: [],
      source: "review-pending",
      pending: true,
    };
    const playPendingEvalState = {
      p1: 0.5,
      margin: 0,
      playerToMove: snapshot.playerToMove,
      pv: [],
      rootMoves: [],
      source: "play-pending",
      pending: true,
    };
    const resolvedEval = terminal
      ? (terminalEval ??
          liveAnalysisEval ??
          cachedEval ??
          distanceEvalStateForSnapshot)
      : this.settings.uiMode === "replay"
        ? (cachedEval ?? reviewPendingEvalState)
        : this.settings.uiMode === "play" && this.aiThinking
          ? (livePlayEval ?? playPendingEvalState)
          : (latestCompletedPlayEval ??
            liveAnalysisEval ??
            cachedEval ??
            distanceEvalStateForSnapshot);

    return {
      ...snapshot,
      settings: { ...this.settings },
      engineStatus: { ...this.engineStatus },
      engineErrors: { ...this.engineErrors },
      aiThinking: terminal ? false : this.aiThinking,
      liveSearch: terminal ? null : this.liveSearch,
      thinkingPlayerType: terminal ? null : this.thinkingPlayerType,
      thinkingSeatIndex: terminal ? null : this.thinkingSeatIndex,
      eval: resolvedEval,
      analysisEngineActive:
        this.analysisSession.isActive() ||
        this.reviewAnalysis.status === "running",
      analysisEvalDepth:
        resolvedEval?.depth ?? this.analysisEval?.depth ?? null,
      analysisEvalError: this.analysisEvalError,
      gameClocks: this._gameClockStates(),
      reviewAnalysis: {
        ...this.reviewAnalysis,
        visiblePosition: this.replay
          ? (this.reviewAnalysis.positions?.[this.replay.index] ?? null)
          : null,
      },
      searchGeneration: this._activeSearchSeq,
      positionKey,
      strengthLevelPresets: STRENGTH_LEVEL_PRESETS,
      timeToMovePresets: TIME_TO_MOVE_PRESETS,
      playerOptionGroups: getPlayerOptionGroups(),
      playerOptions: flattenPlayerOptions(getPlayerOptionGroups()),
      playerAiSettingsUi: this.getPlayerAiSettingsUi(),
      timeBudgetHint: describeTimeBudget(
        this.settings.players,
        this.settings.playerAiSettings,
        this.engineConfigs,
      ),
      searchInfoLine: describeActiveSearchInfo(
        this.settings.players,
        this.searchInfoBySeat,
        this.engineConfigs,
        {
          thinkingSeatIndex: terminal ? null : this.thinkingSeatIndex,
          aiThinking: terminal ? false : this.aiThinking,
        },
      ),
      activeSearchInfo:
        this.thinkingSeatIndex != null
          ? this.searchInfoBySeat[this.thinkingSeatIndex]
          : null,
      moveThinkLog: this.moveThinkLog,
      settingsChangelog: this.settingsChangelog,
      initialBudgetHint: this.initialBudgetHint,
      lastThinkBySeat: this.lastThinkBySeat,
      lastCompletedThinkBySeat: this.lastCompletedThinkBySeat,
      uiMode: this.settings.uiMode,
      catViz: this.catViz,
      catVizLoading: this.catVizLoading,
      catVizError: this.catVizError,
      showCatHint: this.showCatHint && this.settings.showCatVision,
      lmrViz: this.resolveLmrViz(),
      lmrVisionShallow: this.settings.lmrVisionShallow,
      lmrVizLoading: this.lmrVizLoading,
      lmrVizError: this.lmrVizError,
      showLmrHint: this.showLmrHint && this.settings.showLmrVision,
      canRedo: snapshot.canRedo,
      futureActions: snapshot.futureActions ?? [],
      enginesPaused: this.enginesPaused,
      replay: this.replay
        ? {
            index: this.replay.index,
            total: this.replay.actions.length,
            code: this.replay.code,
            meta: this.replay.meta,
            algebraic: [...(this.replay.algebraic ?? [])],
          }
        : null,
      terminalOverlayDismissed: this._terminalOverlayDismissed,
      gameHalted: this._gameHalted,
      engineRecovery: {
        active: this._engineRecoveryActive,
        seatIndex: this._engineRecoverySeat,
        attempt: this._engineRecoverySeat >= 0
          ? (this._engineFailureRetryBySeat[
              this._engineFailureRetryKey(this._engineRecoverySeat)
            ]?.attempt ?? 0)
          : 0,
        max: this._maxEngineFailureRetries,
      },
      endReason: snapshot.endReason ?? null,
      legalityOracleState: { ...this.legalityOracleState },
      playReplayCode:
        this.session.actions.length > 0 && this.settings.uiMode === "play"
          ? encodeReplayFromActions(
              this.session.actions,
              this.session.winner
                ? {
                    winner: this.session.winner === 1 ? "white" : "black",
                    plies: this.session.actions.length,
                  }
                : null,
            )
          : null,
    };
  }

  onChange = null;
  onLiveUpdate = null;
  _liveUpdateLastMs = 0;

  /** Remap retired player keys (Titanium, Ace v7 aliases) to current engine slots. */
  migrateLegacyPlayerTypes() {
    this.settings.players = this.settings.players.map((p) =>
      normalizePlayerType(p),
    );
  }

  persistPlaySettings() {
    if (this.settings.uiMode !== "play") {
      return;
    }
    savePersistedPlaySettings(this.settings);
  }

  restorePersistedPlayMatchup() {
    const persisted = loadPersistedPlaySettings();
    const titaniumDefault = defaultPlayerAiSettings(
      PlayerType.TitaniumV17,
      this.engineConfigs,
    );
    const playDefaults = {
      players: [PlayerType.Human, PlayerType.TitaniumV17],
      playerAiSettings: [null, { ...titaniumDefault }],
      playerAiSettingsMemory: [{}, {}],
    };
    const restored = persisted
      ? {
          players: persisted.players.map((p) => normalizePlayerType(p)),
          playerAiSettings: persisted.playerAiSettings ?? [{}, {}],
          playerAiSettingsMemory: persisted.playerAiSettingsMemory ?? [{}, {}],
          displayEvalBar: persisted.displayEvalBar !== false,
          showBestMoveHint: persisted.showBestMoveHint !== false,
        }
      : playDefaults;
    this.settings.players = restored.players;
    this.settings.playerAiSettings = restored.playerAiSettings;
    this.settings.playerAiSettingsMemory = restored.playerAiSettingsMemory;
    this.settings.displayEvalBar = restored.displayEvalBar !== false;
    this.settings.showBestMoveHint = restored.showBestMoveHint !== false;
    for (let seat = 0; seat < 2; seat++) {
      const playerType = this.settings.players[seat];
      if (playerType !== PlayerType.Human) {
        this.ensurePlayerAiSettingsSlot(seat + 1, playerType);
      }
    }
    this.destroyAllEngines();
  }

  /**
   * Analysis/Review mode: both seats are Human (free play / view-only per
   * uiMode), evaluation comes from the dedicated warm AnalysisEngineSession
   * instead of a per-seat AI, so no bot player is configured here.
   */
  applyAnalysisEvaluatorDefaults() {
    this.settings.players = [PlayerType.Human, PlayerType.Human];
    this.settings.playerAiSettings = [null, null];
    this.settings.playerAiSettingsMemory = [{}, {}];
    if (!this.settings.analysisEngine) {
      this.settings.analysisEngine = {
        unlimited: true,
        wallClockSeconds: 5,
        cores: defaultAnalysisThreadCount(),
        searchDepthLimit: 0,
      };
    }
    this.destroyAllEngines();
  }

  isHumanVsAiPlay() {
    if (this.isFreePlayMode()) {
      return false;
    }
    const humanSeat = this.settings.players.indexOf(PlayerType.Human);
    if (humanSeat < 0) {
      return false;
    }
    return this.settings.players[1 - humanSeat] !== PlayerType.Human;
  }

  _abortEngineSearch({
    bumpRequestSeq = false,
    stoppedBy = "cancelled",
    seatIndex = null,
  } = {}) {
    const seat = seatIndex ?? this.thinkingSeatIndex;
    if (
      this._activeAiAbort &&
      (seat == null || this.thinkingSeatIndex === seat)
    ) {
      this._activeAiAbort.abort();
      this._activeAiAbort = null;
    }
    if (seat != null) {
      void this._stopSeatEngineSearch(seat);
      this.lastThinkBySeat[seat] = buildThinkSeatSnapshot({
        engine: this.engineLabelForSeat(seat),
        live: false,
        stoppedBy,
        depthLog: this.searchInfoBySeat[seat]?.depthLog ?? [],
        searchDepth: this.searchInfoBySeat[seat]?.searchDepth,
        whiteDist: this.searchInfoBySeat[seat]?.whiteDist,
        blackDist: this.searchInfoBySeat[seat]?.blackDist,
        rootScore: this.searchInfoBySeat[seat]?.rootScore,
        nodes: this.searchInfoBySeat[seat]?.nodes,
        simulations: this.searchInfoBySeat[seat]?.simulations,
      });
      if (this.searchInfoBySeat[seat]) {
        this.searchInfoBySeat[seat] = {
          ...this.searchInfoBySeat[seat],
          stoppedBy,
        };
      }
      this.engineStatus[seat] = "idle";
    }
    if (seat == null || this.thinkingSeatIndex === seat) {
      this.aiThinking = false;
      this.thinkingPlayerType = null;
      this.thinkingSeatIndex = null;
      this.liveSearch = null;
    }
    if (bumpRequestSeq) {
      this._moveRequestSeq += 1;
      this._activeSearchSeq = 0;
    }
  }

  /** Stop search on one seat only — never touches the other engine client. */
  async _stopSeatEngineSearch(seatIndex) {
    const engine = this.getEngineForSeat(seatIndex);
    if (!engine?.cancelSearch) {
      return;
    }
    await engine.cancelSearch();
  }

  _cancelActiveAiSearch() {
    this._abortEngineSearch({ bumpRequestSeq: true });
  }

  _undoPlyCount() {
    if (this.isFreePlayMode()) {
      return 1;
    }
    if (!this.isHumanVsAiPlay()) {
      return 1;
    }
    if (
      this.session.isHumanTurn(this.settings.players) &&
      this.session.actions.length > 0
    ) {
      return 2;
    }
    return 1;
  }

  _finishUndo({ requestAi = false } = {}) {
    this.moveThinkLog = trimThinkLogToPly(
      this.moveThinkLog,
      this.session.actions.length,
    );
    this._humanTimedOut = [false, false];
    this.liveSearch = null;
    this.engineErrors = {};
    for (const engine of this.engines.values()) {
      engine.resetConnection();
    }
    this.handleCatPositionChanged();
    this.onChange?.();
    if (requestAi && !this.isFreePlayMode() && !this.enginesPaused) {
      this.maybeRequestAiMove();
    }
  }

  setPlayer(playerNum, playerType) {
    if (playerType === PlayerType.Pavlosdais) {
      return;
    }
    playerType = normalizePlayerType(playerType);
    const seatIndex = playerNum - 1;
    const prevType = this.settings.players[seatIndex];
    this.settings.players[seatIndex] = playerType;
    if (prevType !== playerType) {
      this._moveRequestSeq += 1;
      this.aiThinking = false;
      this.thinkingPlayerType = null;
      this.thinkingSeatIndex = null;
      this.destroyEngineForSeat(seatIndex);
    }
    this.ensurePlayerAiSettingsSlot(playerNum, playerType);

    if (
      playerType !== PlayerType.Human &&
      playerType !== PlayerType.GorisansonMCTS &&
      playerType !== PlayerType.QuoridorV3
    ) {
      this.syncRemoteEngine(playerType);
    }
    this.persistPlaySettings();
    this.onChange?.();
    this.maybeRequestAiMove();
  }

  ensurePlayerAiSettingsSlot(playerNum, playerType) {
    const index = playerNum - 1;
    const memory = this.settings.playerAiSettingsMemory[index] ?? {};

    if (playerType === PlayerType.Human) {
      let saved = memory[PlayerType.Human];
      if (saved?.wallClockSeconds != null) {
        this.settings.playerAiSettings[index] = { ...saved };
        return;
      }
      const created = defaultPlayerAiSettings(
        PlayerType.Human,
        this.engineConfigs,
      );
      memory[PlayerType.Human] = { ...created };
      this.settings.playerAiSettingsMemory[index] = memory;
      this.settings.playerAiSettings[index] = created;
      return;
    }

    let saved = memory[playerType];
    if (saved?.strength != null && saved.timeToMove == null) {
      saved = {
        strengthLevel: StrengthLevel.Alpha,
        timeToMove: saved.strength,
      };
      memory[playerType] = saved;
    }
    if (saved && isSavedSettingsValid(playerType, saved, this.engineConfigs)) {
      if (
        isTitaniumEngine(playerType, this.engineConfigs) &&
        saved.searchDepthLimit == null &&
        !saved.titaniumNet
      ) {
        saved = {
          ...saved,
          searchDepthLimit: TITANIUM_DEPTH_UNLIMITED,
          visitsBudget: saved.visitsBudget ?? 0,
          cores: resolveCores(saved),
        };
      }
      if (
        isTitaniumEngine(playerType, this.engineConfigs) &&
        saved.searchDepthLimit == null &&
        saved.titaniumNet
      ) {
        saved = {
          ...saved,
          searchDepthLimit: migrateTitaniumDepthLimit(saved),
          visitsBudget: saved.visitsBudget ?? 0,
          cores: resolveCores(saved),
        };
      }
      if (isTitaniumEngine(playerType, this.engineConfigs)) {
        saved = {
          ...saved,
          cores: resolveCores(saved),
        };
      }
      this.settings.playerAiSettings[index] = { ...saved };
      return;
    }

    const created = defaultPlayerAiSettings(playerType, this.engineConfigs);
    memory[playerType] = { ...created };
    this.settings.playerAiSettingsMemory[index] = memory;
    this.settings.playerAiSettings[index] = created;
  }

  rememberPlayerAiSettings(playerNum, aiSettings) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (!aiSettings) {
      return;
    }
    if (playerType === PlayerType.Human) {
      const clockOnly = {
        wallClockSeconds: aiSettings.wallClockSeconds,
        wholeGameTime: aiSettings.wholeGameTime !== false,
      };
      const memory = this.settings.playerAiSettingsMemory[index] ?? {};
      memory[PlayerType.Human] = { ...clockOnly };
      this.settings.playerAiSettingsMemory[index] = memory;
      this.settings.playerAiSettings[index] = { ...clockOnly };
      this.persistPlaySettings();
      return;
    }
    const memory = this.settings.playerAiSettingsMemory[index] ?? {};
    memory[playerType] = { ...aiSettings };
    this.settings.playerAiSettingsMemory[index] = memory;
    this.settings.playerAiSettings[index] = { ...aiSettings };
    this.persistPlaySettings();
  }

  recordSettingsChange(playerNum, field, from, to) {
    if (
      this.settings.uiMode !== "play" ||
      this.session.winner != null ||
      this.session.isDraw ||
      from === to
    ) {
      return;
    }
    const seat = playerColorName(playerNum);
    this.settingsChangelog.push({
      ply: this.session.actions.length,
      seat,
      player: this.engineLabelForSeat(playerNum - 1),
      field,
      from,
      to,
    });
  }

  getPlayerAiSettingsUiForSlot(playerNum) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    const current = this.settings.playerAiSettings[index];
    const isTitanium = isTitaniumEngine(playerType, this.engineConfigs);
    const hasNativeTitaniumLazySmp = isTitanium && HAS_NATIVE_TITANIUM_LAZY_SMP;
    const cores = resolveCores(current);

    return {
      playerNum,
      playerType,
      isHuman: playerType === PlayerType.Human,
      isLocal: isLocalEngine(playerType, this.engineConfigs),
      isTitanium,
      isQuoridorV3: isQuoridorV3Engine(playerType, this.engineConfigs),
      isAceEngine: isAceEngine(playerType, this.engineConfigs),
      isAceV10Family: isAceV10Family(playerType, this.engineConfigs),
      isAceV8Family: isAceV8Family(playerType, this.engineConfigs),
      isAceFamily: isAceFamily(playerType, this.engineConfigs),
      isLocalMcts: isLocalMctsEngine(playerType, this.engineConfigs),
      isRemote: isRemoteEngine(playerType, this.engineConfigs),
      isZeroInk: isZeroInkEngine(playerType, this.engineConfigs),
      titaniumNet: migrateTitaniumDepthLimit(current),
      searchDepthLimit: clampTitaniumDepthLimit(
        current?.searchDepthLimit ?? migrateTitaniumDepthLimit(current),
      ),
      cores,
      hasNativeTitaniumLazySmp,
      strengthLevel: isAceFamily(playerType, this.engineConfigs)
        ? clampAceV10Tier(
            migrateAceV10Strength(current?.strengthLevel ?? 0),
            playerType,
          )
        : (current?.strengthLevel ?? StrengthLevel.Alpha),
      timeToMove: current?.timeToMove ?? TimeToMove.Short,
      wallClockSeconds:
        current?.wallClockSeconds ?? WALL_CLOCK_RANGE.defaultSeconds,
      wholeGameTime: current?.wholeGameTime !== false,
      visitsBudget: clampVisits(
        current?.visitsBudget ?? LOCAL_VISITS_RANGE.default,
      ),
      visitsSliderPosition: sliderPositionFromVisits(
        current?.visitsBudget ?? LOCAL_VISITS_RANGE.default,
      ),
      wallclockRange: WALL_CLOCK_RANGE,
      visitsRange: {
        min: 0,
        max: LOCAL_VISITS_RANGE.sliderSteps,
        step: 1,
      },
      hint: describePlayerAiSettings(playerType, current, this.engineConfigs),
      engineName: this.engineLabelForSeat(index),
    };
  }

  getPlayerAiSettingsUi() {
    return [
      this.getPlayerAiSettingsUiForSlot(1),
      this.getPlayerAiSettingsUiForSlot(2),
    ];
  }

  _aiSettingsNeedSessionReset(prevAi, nextAi, playerType) {
    if (isTitaniumEngine(playerType, this.engineConfigs)) {
      return (
        prevAi.wallClockSeconds !== nextAi.wallClockSeconds ||
        clampTitaniumDepthLimit(
          prevAi.searchDepthLimit ?? migrateTitaniumDepthLimit(prevAi),
        ) !==
          clampTitaniumDepthLimit(
            nextAi.searchDepthLimit ?? migrateTitaniumDepthLimit(nextAi),
          ) ||
        prevAi.visitsBudget !== nextAi.visitsBudget ||
        resolveCores(prevAi) !== resolveCores(nextAi)
      );
    }
    if (isAceFamily(playerType, this.engineConfigs)) {
      return (
        prevAi.wallClockSeconds !== nextAi.wallClockSeconds ||
        prevAi.strengthLevel !== nextAi.strengthLevel
      );
    }
    if (isLocalMctsEngine(playerType, this.engineConfigs)) {
      return (
        prevAi.wallClockSeconds !== nextAi.wallClockSeconds ||
        prevAi.visitsBudget !== nextAi.visitsBudget ||
        (isGorisansonEngine(playerType, this.engineConfigs) &&
          prevAi.gorisansonNet !== nextAi.gorisansonNet)
      );
    }
    if (isZeroInkEngine(playerType, this.engineConfigs)) {
      return prevAi.timeToMove !== nextAi.timeToMove;
    }
    if (isCloudRemoteEngine(playerType, this.engineConfigs)) {
      return (
        prevAi.strengthLevel !== nextAi.strengthLevel ||
        prevAi.timeToMove !== nextAi.timeToMove
      );
    }
    return false;
  }

  _afterLivePlayerSettingChange(playerNum, { rebindEngine = false } = {}) {
    const seatIndex = playerNum - 1;
    const wasThinkingHere =
      this.aiThinking && this.thinkingSeatIndex === seatIndex;
    if (wasThinkingHere) {
      this._cancelActiveAiSearch();
    }
    if (rebindEngine) {
      this.destroyEngineForSeat(seatIndex);
    } else {
      const playerType = this.settings.players[seatIndex];
      if (
        isTitaniumEngine(playerType, this.engineConfigs) ||
        isAceFamily(playerType, this.engineConfigs)
      ) {
        const engine = this.engines.get(this.engineSeatKey(seatIndex));
        engine?.resetConnection?.();
      }
    }
    this._resumeAfterTimeSettingsChange();
    this.persistPlaySettings();
    this.onChange?.();
    const isActiveSeat =
      this.session.playerToMove - 1 === seatIndex &&
      this.settings.players[seatIndex] !== PlayerType.Human;
    if (
      isActiveSeat &&
      !this.session.winner &&
      !this.session.isDraw &&
      !this.replay
    ) {
      this.maybeRequestAiMove();
    }
  }

  setPlayerStrengthLevel(playerNum, strengthLevel, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (isZeroInkEngine(playerType, this.engineConfigs)) {
      return;
    }
    if (
      !isCloudRemoteEngine(playerType, this.engineConfigs) &&
      !isTitaniumEngine(playerType, this.engineConfigs) &&
      !isAceFamily(playerType, this.engineConfigs)
    ) {
      return;
    }
    const current = this.settings.playerAiSettings[index] ?? {};
    const next = Number(strengthLevel);
    this.recordSettingsChange(
      playerNum,
      "strength",
      current.strengthLevel,
      next,
    );
    const storedStrength = isAceFamily(playerType, this.engineConfigs)
      ? clampAceV10Tier(next, playerType)
      : next;
    this.rememberPlayerAiSettings(playerNum, {
      ...current,
      strengthLevel: storedStrength,
    });
    if (!silent) {
      this._afterLivePlayerSettingChange(playerNum, { rebindEngine: true });
    }
  }

  setPlayerTimeToMove(playerNum, timeToMove, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (!isRemoteEngine(playerType, this.engineConfigs)) {
      return;
    }
    const current = this.settings.playerAiSettings[index] ?? {};
    const next = Number(timeToMove);
    this.recordSettingsChange(
      playerNum,
      "timeToMove",
      current.timeToMove,
      next,
    );
    this.rememberPlayerAiSettings(playerNum, {
      ...current,
      timeToMove: next,
    });
    if (!silent) {
      this._afterLivePlayerSettingChange(playerNum, { rebindEngine: true });
    }
  }

  setPlayerWallClock(playerNum, seconds, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (
      !isLocalMctsEngine(playerType, this.engineConfigs) &&
      !isTitaniumEngine(playerType, this.engineConfigs) &&
      !isAceFamily(playerType, this.engineConfigs)
    ) {
      return;
    }
    const current = this.settings.playerAiSettings[index] ?? {};
    const next = Number(seconds);
    this.recordSettingsChange(
      playerNum,
      "wallClockSeconds",
      current.wallClockSeconds,
      next,
    );
    this.rememberPlayerAiSettings(playerNum, {
      ...current,
      wallClockSeconds: next,
    });
    if (!silent) {
      this._afterLivePlayerSettingChange(playerNum);
    }
  }

  setPlayerWholeGameTime(playerNum, enabled, { silent = false } = {}) {
    const index = playerNum - 1;
    const current = this.settings.playerAiSettings[index] ?? {};
    this.rememberPlayerAiSettings(playerNum, {
      ...current,
      wholeGameTime: Boolean(enabled),
    });
    if (!silent) {
      this._afterLivePlayerSettingChange(playerNum);
    }
  }

  _gameDistanceForClock(
    seatIndex,
    { clockSearchHint = null, searchTelemetry = null } = {},
  ) {
    const actions = this.session.actions.map((action) => toAlgebraic(action));
    if (searchTelemetry) {
      return estimateConservativeGameDistance({
        board: this.session.board,
        actions,
        depthLog: searchTelemetry.depthLog ?? null,
        whiteDist: searchTelemetry.whiteDist ?? null,
        blackDist: searchTelemetry.blackDist ?? null,
      });
    }
    const hint =
      clockSearchHint ??
      clockSearchHintFromState({
        positionKey: this.currentPositionKey(),
        seatIndex,
        liveSearch: this.liveSearch,
        searchInfo: this.searchInfoBySeat[seatIndex],
      });
    return estimateConservativeGameDistance({
      board: this.session.board,
      actions,
      depthLog: hint?.depthLog ?? null,
      whiteDist: hint?.whiteDist ?? null,
      blackDist: hint?.blackDist ?? null,
    });
  }

  _wholeGameClockAllocation(
    seatIndex,
    aiSettings,
    {
      clockSearchHint = null,
      searchTelemetry = null,
      includeActiveThink = false,
    } = {},
  ) {
    const totalMs = Math.max(
      250,
      Number(aiSettings?.wallClockSeconds ?? WALL_CLOCK_RANGE.defaultSeconds) *
        1000,
    );
    const usedMs = includeActiveThink
      ? this._seatClockUsedMs(seatIndex, { includeActiveTurn: true })
      : this._seatClockUsedMs(seatIndex, { includeActiveTurn: false });
    const ownMovesPlayed = this.session.actions.reduce(
      (count, _action, plyIndex) =>
        count + (plyIndex % 2 === seatIndex ? 1 : 0),
      0,
    );
    const distanceToWin = this._gameDistanceForClock(seatIndex, {
      clockSearchHint,
      searchTelemetry,
    });
    return {
      totalMs,
      usedMs,
      distanceToWin,
      ...allocateWholeGameTime({
        totalMs,
        usedMs,
        ownMovesPlayed,
        distanceToWin,
      }),
    };
  }

  _managedClockSettings(seatIndex, aiSettings, clockSearchHint = null) {
    const playerType = this.settings.players[seatIndex];
    if (
      !supportsWholeGameTime(playerType, this.engineConfigs) ||
      aiSettings?.wholeGameTime === false
    ) {
      return { ...aiSettings };
    }
    const {
      remainingMs,
      moveBudgetMs,
      expectedMovesLeft,
      handoffReserveMs,
      totalMs,
      distanceToWin,
    } = this._wholeGameClockAllocation(seatIndex, aiSettings, {
      clockSearchHint,
      includeActiveThink: false,
    });
    return {
      ...aiSettings,
      wallClockSeconds: moveBudgetMs / 1000,
      wholeGameTotalSeconds: totalMs / 1000,
      wholeGameRemainingSeconds: remainingMs / 1000,
      wholeGameExpectedMovesLeft: expectedMovesLeft,
      wholeGameDistanceToWin: distanceToWin,
      wholeGameHandoffReserveMs: handoffReserveMs,
    };
  }

  _refreshThinkClockFromSearch(seatIndex, info, depthLog) {
    const think = this._thinkAiSettings;
    const ai = this.settings.playerAiSettings[seatIndex] ?? {};
    const playerType = this.settings.players[seatIndex];
    if (
      !think ||
      ai.wholeGameTime === false ||
      !supportsWholeGameTime(playerType, this.engineConfigs)
    ) {
      return false;
    }
    const remainingPlies = remainingPliesFromDepthLog(depthLog);
    const pvKey = pvTokensFromDepthLog(depthLog).join(" ");
    if (isGorisansonEngine(playerType, this.engineConfigs)) {
      const tickKey =
        remainingPlies != null
          ? `r${remainingPlies}|${pvKey}`
          : pvKey
            ? `pv:${pvKey}`
            : "";
      if (!tickKey || tickKey === this._thinkClockLastPv) {
        return false;
      }
      this._thinkClockLastPv = tickKey;
    } else {
      const liveDepth =
        info.searchDepth ?? deepestDepthEntry(depthLog)?.depth ?? null;
      if (liveDepth == null || liveDepth === this._thinkClockLastDepth) {
        return false;
      }
      this._thinkClockLastDepth = liveDepth;
    }

    const allocation = this._wholeGameClockAllocation(seatIndex, ai, {
      searchTelemetry: {
        depthLog,
        whiteDist: info.whiteDist,
        blackDist: info.blackDist,
      },
      includeActiveThink: true,
    });
    const prevBudgetMs = Math.round((think.wallClockSeconds ?? 0) * 1000);
    const tightened = tightenThinkAllocation(prevBudgetMs, allocation);

    this._thinkAiSettings = {
      ...think,
      wallClockSeconds: tightened.moveBudgetMs / 1000,
      wholeGameRemainingSeconds: tightened.remainingMs / 1000,
      wholeGameExpectedMovesLeft: tightened.expectedMovesLeft,
      wholeGameDistanceToWin: allocation.distanceToWin,
      wholeGameHandoffReserveMs: tightened.handoffReserveMs,
    };
    return true;
  }

  _formatClockLabel(remainingMs) {
    const totalSeconds = remainingMs / 1000;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = Math.floor(totalSeconds % 60);
    const tenths = Math.floor((totalSeconds % 1) * 10);
    return minutes > 0
      ? `${minutes}:${String(seconds).padStart(2, "0")}`
      : `${seconds}.${tenths}`;
  }

  _clockHandoffGraceMs(seatIndex) {
    const fromThink = this._thinkAiSettings?.wholeGameHandoffReserveMs;
    if (fromThink != null && Number.isFinite(fromThink)) {
      return Math.max(0, fromThink);
    }
    const ai = this.settings.playerAiSettings[seatIndex] ?? {};
    const totalMs = Math.max(
      250,
      Number(ai.wallClockSeconds ?? WALL_CLOCK_RANGE.defaultSeconds) * 1000,
    );
    const usedMs = this._seatClockUsedMs(seatIndex, {
      includeActiveTurn: false,
    });
    const ownMovesPlayed = this.session.actions.reduce(
      (count, _action, plyIndex) =>
        count + (plyIndex % 2 === seatIndex ? 1 : 0),
      0,
    );
    return allocateWholeGameTime({
      totalMs,
      usedMs,
      ownMovesPlayed,
      distanceToWin: this._gameDistanceForClock(seatIndex),
    }).handoffReserveMs;
  }

  _seatClockOverBudget(seatIndex, remainingMs) {
    return remainingMs <= -this._clockHandoffGraceMs(seatIndex);
  }

  _seatUsesWholeGameClock(seatIndex) {
    const playerType = this.settings.players[seatIndex];
    const ai = this.settings.playerAiSettings[seatIndex] ?? {};
    if (playerType === PlayerType.Human) {
      return ai.wholeGameTime !== false;
    }
    return (
      supportsWholeGameTime(playerType, this.engineConfigs) &&
      ai.wholeGameTime !== false
    );
  }

  _seatClockUsedMs(seatIndex, { includeActiveTurn = true } = {}) {
    const playerType = this.settings.players[seatIndex];
    const ai = this.settings.playerAiSettings[seatIndex] ?? {};
    if (!hasSeatClock(playerType, this.engineConfigs, ai)) {
      return 0;
    }
    if (playerType === PlayerType.Human && ai.wholeGameTime === false) {
      const onTurn =
        this.session.playerToMove - 1 === seatIndex &&
        this.session.isHumanTurn(this.settings.players) &&
        !this.aiThinking;
      if (!onTurn || !includeActiveTurn || this._humanThinkStartedAt == null) {
        return 0;
      }
      return Math.max(0, performance.now() - this._humanThinkStartedAt);
    }
    const completedMs = clockLogUsedMs(this.moveThinkLog, seatIndex);
    let usedMs = Math.max(
      0,
      completedMs - Math.max(0, this._clockResetCreditMs?.[seatIndex] ?? 0),
    );
    if (!includeActiveTurn) {
      return usedMs;
    }
    if (playerType === PlayerType.Human) {
      const onTurn =
        this.session.playerToMove - 1 === seatIndex &&
        this.session.isHumanTurn(this.settings.players) &&
        !this.aiThinking;
      if (onTurn && this._humanThinkStartedAt != null) {
        usedMs += Math.max(0, performance.now() - this._humanThinkStartedAt);
      }
    } else if (
      this.aiThinking &&
      this.thinkingSeatIndex === seatIndex &&
      this._thinkStartedAt != null
    ) {
      usedMs += Math.max(0, performance.now() - this._thinkStartedAt);
    }
    return usedMs;
  }

  _resumeAfterTimeSettingsChange() {
    const sessionForfeit = this.session.endReason === "time";
    const flaggedSeat = this._humanTimedOut?.some(Boolean) ?? false;
    if (!sessionForfeit && !flaggedSeat) {
      return false;
    }
    this._clockResetCreditMs = [
      clockLogUsedMs(this.moveThinkLog, 0),
      clockLogUsedMs(this.moveThinkLog, 1),
    ];
    this._humanTimedOut = [false, false];
    this._humanThinkStartedAt = null;
    this._gameHalted = false;
    this._terminalOverlayDismissed = false;
    if (sessionForfeit) {
      this.session.clearTimeForfeit();
    }
    this._syncHumanClockTurn();
    return true;
  }

  _gameClockStates() {
    return [0, 1].map((seatIndex) => {
      const playerType = this.settings.players[seatIndex];
      const ai = this.settings.playerAiSettings[seatIndex] ?? {};
      if (!hasSeatClock(playerType, this.engineConfigs, ai)) {
        return null;
      }
      const totalMs = Math.max(
        250,
        Number(ai.wallClockSeconds ?? WALL_CLOCK_RANGE.defaultSeconds) * 1000,
      );
      const usedMs = this._seatClockUsedMs(seatIndex);
      const remainingMs = this._humanTimedOut?.[seatIndex]
        ? 0
        : Math.max(0, totalMs - usedMs);
      return {
        totalMs,
        remainingMs,
        label: this._formatClockLabel(remainingMs),
      };
    });
  }

  _clockTickerNeeded() {
    if (
      this.settings.uiMode !== "play" ||
      this.session.winner != null ||
      this.session.isDraw
    ) {
      return false;
    }
    if (this.aiThinking && this.thinkingSeatIndex != null) {
      const playerType = this.settings.players[this.thinkingSeatIndex];
      const ai = this.settings.playerAiSettings[this.thinkingSeatIndex] ?? {};
      if (
        hasSeatClock(playerType, this.engineConfigs, ai) &&
        this._seatUsesWholeGameClock(this.thinkingSeatIndex)
      ) {
        return true;
      }
    }
    const humanSeat = this.session.playerToMove - 1;
    if (
      this.session.isHumanTurn(this.settings.players) &&
      !this.aiThinking &&
      this.settings.players[humanSeat] === PlayerType.Human
    ) {
      const ai = this.settings.playerAiSettings[humanSeat] ?? {};
      if (hasSeatClock(PlayerType.Human, this.engineConfigs, ai)) {
        return true;
      }
    }
    return false;
  }

  _syncHumanClockTurn() {
    if (
      this.settings.uiMode !== "play" ||
      this.session.winner != null ||
      this.session.isDraw
    ) {
      this._humanThinkStartedAt = null;
      return;
    }
    const seat = this.session.playerToMove - 1;
    const ai = this.settings.playerAiSettings[seat] ?? {};
    if (
      !this.session.isHumanTurn(this.settings.players) ||
      this.settings.players[seat] !== PlayerType.Human ||
      this.aiThinking ||
      !hasSeatClock(PlayerType.Human, this.engineConfigs, ai) ||
      this._humanTimedOut?.[seat]
    ) {
      this._humanThinkStartedAt = null;
      return;
    }
    if (this._humanThinkStartedAt == null) {
      this._humanThinkStartedAt = performance.now();
      this._startClockTicker();
    }
  }

  _flagHumanOnTime(seatIndex) {
    if (this.settings.players[seatIndex] !== PlayerType.Human) {
      return;
    }
    if (this._humanTimedOut?.[seatIndex]) {
      return;
    }
    this._humanTimedOut = this._humanTimedOut ?? [false, false];
    this._humanTimedOut[seatIndex] = true;

    const thinkStarted = this._humanThinkStartedAt;
    this._humanThinkStartedAt = null;
    if (
      thinkStarted != null &&
      hasSeatClock(
        PlayerType.Human,
        this.engineConfigs,
        this.settings.playerAiSettings[seatIndex],
      )
    ) {
      this.moveThinkLog.push({
        ply: this.session.actions.length + 1,
        move: "(time)",
        engine: "Human",
        thinkMs: Math.round(performance.now() - thinkStarted),
        stoppedBy: "flag",
      });
    }

    if (this.session.forfeitOnTime(seatIndex + 1)) {
      this.maybeSubmitFinishedGame();
    }
    this.onChange?.();
  }

  _startClockTicker() {
    if (this._clockTickId != null) {
      return;
    }
    this._clockTickId = setInterval(() => {
      if (!this._clockTickerNeeded()) {
        clearInterval(this._clockTickId);
        this._clockTickId = null;
        return;
      }
      const seat = this.thinkingSeatIndex;
      if (seat != null && this.aiThinking) {
        const playerType = this.settings.players[seat];
        const ai = this.settings.playerAiSettings[seat] ?? {};
        if (
          hasSeatClock(playerType, this.engineConfigs, ai) &&
          this._seatUsesWholeGameClock(seat)
        ) {
          const remainingMs = this._gameClockStates()[seat]?.remainingMs ?? 0;
          if (this._seatClockOverBudget(seat, remainingMs)) {
            this._flagEngineOnTime(seat);
            return;
          }
        }
      }
      const humanSeat = this.session.playerToMove - 1;
      if (
        this.session.isHumanTurn(this.settings.players) &&
        !this.aiThinking &&
        this.settings.players[humanSeat] === PlayerType.Human &&
        !this._humanTimedOut?.[humanSeat]
      ) {
        const remainingMs =
          this._gameClockStates()[humanSeat]?.remainingMs ?? 0;
        if (this._seatClockOverBudget(humanSeat, remainingMs)) {
          this._flagHumanOnTime(humanSeat);
          return;
        }
      }
      this.onChange?.();
    }, 100);
  }

  _flagEngineOnTime(seatIndex) {
    if (!this.aiThinking || this.thinkingSeatIndex !== seatIndex) {
      return;
    }
    this._moveRequestSeq += 1; // discard a late worker result
    this._gameGeneration += 1;
    this._activeAiAbort?.abort();
    this._activeAiAbort = null;
    this.destroyEngineForSeat(seatIndex); // hard-stop a synchronous WASM search
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this._thinkStartedAt = null;
    this._thinkAiSettings = null;
    this._thinkClockLastDepth = null;
    this.engineStatus[seatIndex] = "flagged";
    this.engineErrors[seatIndex] = null;
    if (this.session.forfeitOnTime(seatIndex + 1)) {
      this.maybeSubmitFinishedGame();
    }
    this.onChange?.();
  }

  setPlayerVisitsBudget(playerNum, visits, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (!isLocalMctsEngine(playerType, this.engineConfigs)) {
      return;
    }
    const current = this.settings.playerAiSettings[index] ?? {};
    const next = clampVisits(visits);
    this.recordSettingsChange(
      playerNum,
      "visitsBudget",
      current.visitsBudget,
      next,
    );
    this.rememberPlayerAiSettings(playerNum, {
      ...current,
      visitsBudget: next,
    });
    if (!silent) {
      this._afterLivePlayerSettingChange(playerNum);
    }
  }

  setPlayerCores(playerNum, cores, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (!isTitaniumEngine(playerType, this.engineConfigs)) {
      return;
    }
    const current = this.settings.playerAiSettings[index] ?? {};
    const next = clampCores(cores);
    this.recordSettingsChange(playerNum, "cores", resolveCores(current), next);
    this.rememberPlayerAiSettings(playerNum, {
      ...current,
      cores: next,
    });
    if (!silent) {
      this._afterLivePlayerSettingChange(playerNum, { rebindEngine: true });
    }
  }

  /** @deprecated use setPlayerCores */
  setPlayerThreads(playerNum, threads, options = {}) {
    this.setPlayerCores(playerNum, threads, options);
  }

  toggleRotateBoard() {
    this.settings.rotateBoard = !this.settings.rotateBoard;
    this.onChange?.();
  }

  toggleEnginesPaused(force) {
    const next = typeof force === "boolean" ? force : !this.enginesPaused;
    if (next === this.enginesPaused) {
      return;
    }
    this.enginesPaused = next;
    if (this.settings.uiMode === "replay") {
      if (next) {
        this.reviewSession.pause();
      } else {
        this.reviewSession.resume();
      }
      this.onChange?.();
      return;
    }
    if (this.enginesPaused && this.aiThinking) {
      this._cancelActiveAiSearch();
    }
    this._syncAnalysisSessionActive();
    this.onChange?.();
    if (!this.enginesPaused) {
      this.maybeRequestAiMove();
    }
  }

  toggleDisplayCoordinates() {
    this.settings.displayCoordinates = !this.settings.displayCoordinates;
    this.onChange?.();
  }

  toggleDisplayRemainingWalls() {
    this.settings.displayRemainingWalls = !this.settings.displayRemainingWalls;
    this.onChange?.();
  }

  toggleDisplayEvalBar() {
    this.settings.displayEvalBar = !this.settings.displayEvalBar;
    this.persistPlaySettings();
    this.onChange?.();
  }

  toggleCatVision(enabled = !this.settings.showCatVision) {
    this.settings.showCatVision = Boolean(enabled);
    if (this.settings.showCatVision) {
      this.settings.showLmrVision = false;
      if (!this.catHintDismissed) {
        this.showCatHint = true;
      }
      this.showLmrHint = false;
      this.invalidateCatCache();
      this.refreshCatViz();
    } else {
      this._catFetchSeq += 1;
      this._catMovesKey = null;
      this.catViz = null;
      this.catVizError = null;
      this.catVizLoading = false;
      this.showCatHint = false;
    }
    this.onChange?.();
  }

  updateCatVisionSettings(patch) {
    this.settings.catVision = {
      ...DEFAULT_CAT_VISION_SETTINGS,
      ...(this.settings.catVision ?? {}),
      ...(patch ?? {}),
    };
    this.onChange?.();
  }

  setVisionMode(mode) {
    const next = mode === "cat" || mode === "lmr" ? mode : "off";
    if (next === "cat") {
      this.toggleCatVision(true);
      return;
    }
    if (next === "lmr") {
      this.toggleLmrVision(true);
      return;
    }
    const hadCat = this.settings.showCatVision;
    const hadLmr = this.settings.showLmrVision;
    this.settings.showCatVision = false;
    this.settings.showLmrVision = false;
    if (hadCat) {
      this._catFetchSeq += 1;
      this._catMovesKey = null;
      this.catViz = null;
      this.catVizError = null;
      this.catVizLoading = false;
      this.showCatHint = false;
    }
    if (hadLmr) {
      this._lmrFetchSeq += 1;
      this._lmrShallowKey = null;
      this.lmrVizLive = null;
      this.lmrVizError = null;
      this.lmrVizLoading = false;
      this.showLmrHint = false;
    }
    this.onChange?.();
  }

  toggleLmrVision(enabled = !this.settings.showLmrVision) {
    this.settings.showLmrVision = Boolean(enabled);
    if (this.settings.showLmrVision) {
      this.settings.showCatVision = false;
      this.catViz = null;
      this.showCatHint = false;
      if (!this.lmrHintDismissed) {
        this.showLmrHint = true;
      }
      this.lmrVizError = null;
      this.invalidateLmrCache();
      this.refreshLmrShallow();
      if (
        this.aiThinking &&
        this.thinkingPlayerType &&
        isTitaniumEngine(this.thinkingPlayerType, this.engineConfigs) &&
        this.liveSearch
      ) {
        this.ingestLmrSearchPayload(
          {
            live: true,
            searchDepth: this.liveSearch.searchDepth,
            depthLog: this.liveSearch.depthLog,
            lmrProfile: this.liveSearch.lmrProfile,
            lmrReSearches: this.liveSearch.lmrReSearches,
            rootMoves: this.liveSearch.rootMoves,
          },
          this.lmrPositionKey(),
        );
      }
      this.onChange?.();
    } else {
      this._lmrFetchSeq += 1;
      this._lmrShallowKey = null;
      this.lmrVizLive = null;
      this.lmrVizError = null;
      this.lmrVizLoading = false;
      this.showLmrHint = false;
    }
    this.onChange?.();
  }

  toggleBestMoveHint(enabled = !this.settings.showBestMoveHint) {
    this.settings.showBestMoveHint = Boolean(enabled);
    this.persistPlaySettings();
    this.onChange?.();
  }

  toggleLmrShallow(enabled = !this.settings.lmrVisionShallow) {
    this.settings.lmrVisionShallow = Boolean(enabled);
    if (this.settings.showLmrVision) {
      this._lmrShallowKey = null;
      this.scheduleLmrRefresh();
      this.onChange?.();
    }
  }

  /** Disabled legacy CAT path tilt hook. Kept so old settings do not break callers. */
  setPathBiasPercent(value) {
    const tuning = applyVisionTuning({ pathBiasPercent: value });
    this.settings.pathBiasPercent = tuning.pathBiasPercent;
    this._catMovesKey = null;
    this._catFetchSeq += 1;
    if (this.settings.showCatVision) {
      this.scheduleCatRefresh();
    }
    if (this.settings.showLmrVision) {
      this.scheduleLmrRefresh();
    }
    this.onChange?.();
  }

  /** LMR tuning -500..150% (-177 = current engine default). Visualization worker only. */
  setLmrAggressionPercent(value) {
    const tuning = applyVisionTuning({ lmrAggressionPercent: value });
    this.settings.lmrAggressionPercent = tuning.lmrAggressionPercent;
    this._lmrShallowKey = null;
    if (this.settings.showLmrVision) {
      this.scheduleLmrRefresh();
    }
    this.onChange?.();
  }

  /** @deprecated use setLmrAggressionPercent */
  setLmrAggressiveness(value) {
    const frac = Math.max(0, Math.min(1, Number(value) || 0));
    this.setLmrAggressionPercent(Math.round(frac * 100));
  }

  lmrPlanDepthHint() {
    // Fixed visualization budget: idDepth 11 gives a 10-ply child search, so
    // the LMR tuning slider has one stable meaning independent of live search.
    return 11;
  }

  dismissLmrHint() {
    this.lmrHintDismissed = true;
    this.showLmrHint = false;
    this.onChange?.();
  }

  invalidateLmrCache() {
    this._lmrShallowKey = null;
  }

  lmrPositionKey() {
    return this.catMovesKey();
  }

  lmrTimeSecForPosition() {
    const seat = this.session.playerToMove - 1;
    const playerType = this.settings.players[seat];
    const ai = this.settings.playerAiSettings[seat];
    if (isTitaniumEngine(playerType, this.engineConfigs)) {
      return Number(ai?.wallClockSeconds) || 10;
    }
    return 10;
  }

  isTitaniumThinkEntry(entry) {
    return String(entry?.engine ?? "")
      .toLowerCase()
      .includes("titanium");
  }

  ingestLmrSearchPayload(payload, positionKey = this.lmrPositionKey()) {
    if (!payload?.rootMoves?.length && !payload?.moves?.length) {
      return null;
    }
    const depthLog = payload.depthLog ?? [];
    const deep = deepestDepthEntry(depthLog);
    const planViz = this.lmrShallowByPosition.get(positionKey);
    const searchDepth = payload.searchDepth ?? deep?.depth;
    if (searchDepth && searchDepth !== this._lmrShallowDepth) {
      this._lmrShallowDepth = searchDepth;
      this._lmrShallowKey = null;
      if (this.settings.lmrVisionShallow) {
        this.refreshLmrShallow();
      }
    }

    const viz = buildLmrViz({
      source: payload.live ? "search-live" : "search",
      searchDepth,
      depthLog,
      lmrProfile: payload.lmrProfile,
      lmrReSearches: payload.lmrReSearches,
      rootMoves: payload.rootMoves ?? payload.moves,
      planMoves: planViz?.moves,
    });
    if (!viz) {
      return null;
    }
    this.lmrSearchByPosition.set(positionKey, viz);
    if (!planViz && !this._lmrMergePending?.has(positionKey)) {
      if (!this._lmrMergePending) {
        this._lmrMergePending = new Set();
      }
      this._lmrMergePending.add(positionKey);
      this.refreshLmrShallow().finally(() => {
        this._lmrMergePending?.delete(positionKey);
        const plan = this.lmrShallowByPosition.get(positionKey);
        if (plan?.moves?.length) {
          this.ingestLmrSearchPayload(payload, positionKey);
          this.onChange?.();
        }
      });
    }
    const thinkingHere =
      this.aiThinking &&
      this.thinkingPlayerType &&
      isTitaniumEngine(this.thinkingPlayerType, this.engineConfigs) &&
      this.session.actions.length ===
        positionKey.split("|").filter(Boolean).length;
    if (thinkingHere) {
      this.lmrVizLive = { ...viz, moveIndex: new Map(viz.moveIndex) };
    }
    return viz;
  }

  resolveLmrViz() {
    if (!this.settings.showLmrVision) {
      return null;
    }
    const posKey = this.lmrPositionKey();
    if (!this.settings.lmrVisionShallow) {
      // Live mode: the engine's actual per-root-move depths at the current
      // search depth (streaming while thinking, else last completed search).
      const live =
        (this.aiThinking && this.lmrVizLive) ||
        this.lmrSearchByPosition.get(posKey) ||
        this.lmrVizLive ||
        null;
      if (live) {
        this._lmrDisplayViz = live;
        return live;
      }
      // No search data yet for this position — fall through to the plan.
    }
    const viz = this.lmrShallowByPosition.get(posKey) ?? null;
    if (viz) {
      this._lmrDisplayViz = viz;
      return viz;
    }
    if (this.lmrVizLoading && this._lmrDisplayViz) {
      return this._lmrDisplayViz;
    }
    return null;
  }

  scheduleLmrRefresh() {
    if (!this.settings.showLmrVision || this.settings.uiMode === "replay") {
      return;
    }
    this.refreshLmrShallow();
  }

  async refreshLmrShallow() {
    const posKey = this.lmrPositionKey();
    const timeSec = this.lmrTimeSecForPosition();
    const idDepth = this.lmrPlanDepthHint();
    const lmrAggressionPercent =
      this.settings.lmrAggressionPercent ?? LMR_AGGRESSION_DEFAULT;
    const pathBiasPercent = this.settings.pathBiasPercent ?? 0;
    const fetchKey = `${posKey}|${timeSec}|d${idDepth}|pb${pathBiasPercent}|la${lmrAggressionPercent}`;
    if (
      fetchKey === this._lmrShallowKey &&
      this.lmrShallowByPosition.has(posKey)
    ) {
      return;
    }
    const seq = ++this._lmrFetchSeq;
    if (this.settings.showLmrVision) {
      this.lmrVizLoading = true;
      this.lmrVizError = null;
      this.onChange?.();
    }

    const moves = this.session.actions.map((action) => toAlgebraic(action));
    try {
      const data = await fetchLmrSnapshot(moves, timeSec, idDepth);
      if (seq !== this._lmrFetchSeq) {
        return;
      }
      this._lmrShallowKey = fetchKey;
      const shallow = buildLmrViz({ ...data, source: "shallow" });
      if (shallow) {
        this.lmrShallowByPosition.set(posKey, shallow);
      }
      this.lmrVizLoading = false;
      this.lmrVizError = null;
      if (this.settings.showLmrVision) {
        this.onChange?.();
      }
    } catch (err) {
      if (seq !== this._lmrFetchSeq) {
        return;
      }
      this.lmrVizError = err?.message ?? String(err);
      this.lmrVizLoading = false;
      if (this.settings.showLmrVision) {
        this.onChange?.();
      }
    }
  }

  dismissCatHint() {
    this.catHintDismissed = true;
    this.showCatHint = false;
    this.onChange?.();
  }

  /** Dismiss terminal game overlay without starting a new game or changing settings. */
  dismissTerminalOverlay() {
    this._terminalOverlayDismissed = true;
    this.onChange?.();
  }

  catMovesKey() {
    return this.session.actions.map((action) => toAlgebraic(action)).join("|");
  }

  currentPositionKey() {
    return canonicalPositionKeyFromBoard(this.session.board);
  }

  confirmStartup() {
    this.startupConfirmed = true;
  }

  async initializeLegalityOracle() {
    try {
      await this.titaniumLegalityOracle.ensureReady();
      this.legalityOracleState = { ready: true, error: null };
    } catch (error) {
      this.legalityOracleState = { ready: false, error };
    }
    void this.prewarmTitaniumWasmEngines();
    this.prewarmCatVision();
    this.onChange?.();
    return this.legalityOracleState;
  }

  prewarmCatVision() {
    const moves = this.session.actions.map((action) => toAlgebraic(action));
    void prewarmCatSnapshot(moves);
  }

  /** Cold-start WASM + thread pool before first move (UCI-style isready). */
  async prewarmTitaniumWasmEngines() {
    const tasks = [];
    for (let seat = 0; seat < this.settings.players.length; seat++) {
      const playerType = this.settings.players[seat];
      if (playerType === PlayerType.Human) {
        continue;
      }
      const engine = this.getEngineForSeat(seat);
      if (typeof engine?.prewarm === "function") {
        const ai = this.settings.playerAiSettings[seat] ?? {};
        if (isTitaniumEngine(playerType, this.engineConfigs)) {
          const mode = resolveTitaniumEngineMode(
            ai,
            playerType,
            this.engineConfigs,
          );
          const catLmrCeiling =
            playerType === PlayerType.TitaniumV16 ||
            playerType === PlayerType.TitaniumV17
              ? resolveCatLmrCeiling(ai)
              : 800;
          const threads = resolveCores(ai);
          tasks.push(
            engine.prewarm(mode, catLmrCeiling, threads).catch((err) => {
              console.warn(
                `Titanium WASM prewarm failed for seat ${seat}`,
                err,
              );
            }),
          );
        } else {
          tasks.push(
            engine.prewarm().catch((err) => {
              console.warn(`Engine prewarm failed for seat ${seat}`, err);
            }),
          );
        }
        continue;
      }
      if (typeof engine?.initWorkers === "function") {
        tasks.push(
          engine.initWorkers().catch((err) => {
            console.warn(`Engine init failed for seat ${seat}`, err);
          }),
        );
      }
    }
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }
  }

  hasAiPlayerSelected(players = this.settings.players) {
    return players.some((playerType) => playerType !== PlayerType.Human);
  }

  assertLegalityOracleReady(players = this.settings.players) {
    if (!this.hasAiPlayerSelected(players)) {
      return true;
    }
    if (this.legalityOracleState.ready) {
      return true;
    }
    const message =
      this.legalityOracleState.error?.message ??
      "Titanium legality oracle is not ready";
    throw new Error(message);
  }

  invalidateCatCache() {
    this._catMovesKey = null;
  }

  handleCatPositionChanged({ clearViz = false } = {}) {
    this._catFetchSeq += 1;
    this._catMovesKey = null;
    if (clearViz) {
      this.catViz = null;
      this._lmrDisplayViz = null;
    }
    this.catVizError = null;
    this.prewarmCatVision();
    this.scheduleCatRefresh();
    this.scheduleLmrRefresh();
  }

  scheduleCatRefresh() {
    if (!this.settings.showCatVision || this.settings.uiMode === "replay") {
      return;
    }
    const key = this.catMovesKey();
    if (key === this._catMovesKey && this.catViz && !this.catVizError) {
      return;
    }
    this.refreshCatViz();
  }

  /** Titanium vs Quoridor v3 / Gorisanson: 50/50 White/Black on load and each new game. */
  maybeRandomizeTitaniumAdversarySeats() {
    const { players, playerAiSettings, playerAiSettingsMemory } = this.settings;
    if (players.includes(PlayerType.Human)) {
      return;
    }
    const titaniumSeat = (i) =>
      isTitaniumEngine(players[i], this.engineConfigs);
    const localAdversarySeat = (i) =>
      players[i] === PlayerType.QuoridorV3 ||
      players[i] === PlayerType.GorisansonMCTS;
    const isTiVsLocal =
      (titaniumSeat(0) && localAdversarySeat(1)) ||
      (localAdversarySeat(0) && titaniumSeat(1));
    if (!isTiVsLocal) {
      return;
    }
    if (Math.random() >= 0.5) {
      return;
    }
    this.settings.players = [players[1], players[0]];
    this.settings.playerAiSettings = [playerAiSettings[1], playerAiSettings[0]];
    this.settings.playerAiSettingsMemory = [
      playerAiSettingsMemory[1],
      playerAiSettingsMemory[0],
    ];
  }

  newGame() {
    this._gameGeneration += 1;
    this._moveRequestSeq += 1;
    this._activeSearchSeq = 0;
    this._stopReviewAnalysis();
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.enginesPaused = false;
    this.liveSearch = null;
    this.destroyAllEngines();
    this.maybeRandomizeTitaniumAdversarySeats();
    this.engineErrors = {};
    this.engineStatus = {};
    this.replay = null;
    this.moveThinkLog = [];
    this._clockResetCreditMs = [0, 0];
    this._humanThinkStartedAt = null;
    this._humanTimedOut = [false, false];
    this._illegalRetriesByPly = {};
    this.settingsChangelog = [];
    this._submittedFinishedGames.clear();
    this.initialBudgetHint = describeTimeBudget(
      this.settings.players,
      this.settings.playerAiSettings,
      this.engineConfigs,
    );
    this.lastThinkBySeat = [null, null];
    this.lastCompletedThinkBySeat = [null, null];
    this.searchInfoBySeat = [null, null];
    this.catHintDismissed = false;
    this.showCatHint = false;
    this.settings.uiMode = "play";
    this.eval = { score: 0.5, p1: 0.5, pv: [] };
    this._syncAnalysisSessionActive();
    this._terminalOverlayDismissed = false;
    this._gameHalted = false;
    this._resetEngineFailureRecovery();
    this.session.reset();
    this.catViz = null;
    this._lmrDisplayViz = null;
    this.handleCatPositionChanged();
    this.onChange?.();
    this._prewarmAiEngines();
    this.maybeRequestAiMove();
  }

  /**
   * Kick off WASM module load + thread-pool init for both AI seats right at
   * game start, instead of paying that cost lazily inside the first move's
   * think-time budget. Fire-and-forget: getEngineForSeat's cache means the
   * later real move request picks up the same (by-then-likely-warm)
   * instance. Safe to call for any engine kind -- initWorkers is optional
   * chained, so it's a no-op for clients that don't have it (e.g. ACE JS).
   */
  _prewarmAiEngines() {
    for (let seatIndex = 0; seatIndex < 2; seatIndex++) {
      const playerType = this.settings.players[seatIndex];
      if (!playerType || playerType === PlayerType.Human) {
        continue;
      }
      const engine = this.getEngineForSeat(seatIndex);
      engine?.initWorkers?.().catch(() => {
        // Swallow -- the real move request will retry init and surface any
        // genuine failure through the normal error path.
      });
    }
  }

  isFreePlayMode() {
    return this.settings.uiMode === "analysis";
  }

  setUiMode(mode) {
    const prevMode = this.settings.uiMode;
    const actionsBeforeModeSwitch = [...this.session.actions];
    const replayFromCurrentGame =
      mode === "replay" && !this.replay && actionsBeforeModeSwitch.length > 0
        ? {
            actions: actionsBeforeModeSwitch,
            algebraic: actionsBeforeModeSwitch.map((action) =>
              toAlgebraic(action),
            ),
            index: actionsBeforeModeSwitch.length,
            code: encodeReplayFromActions(
              actionsBeforeModeSwitch,
              this.session.winner
                ? {
                    winner: this.session.winner === 1 ? "white" : "black",
                    plies: actionsBeforeModeSwitch.length,
                  }
                : null,
            ),
            meta: null,
          }
        : null;
    this.settings.uiMode = mode;
    if (prevMode === "replay" && mode !== "replay") {
      this._stopReviewAnalysis();
    }
    if (mode === "play" && prevMode !== "play") {
      this.restorePersistedPlayMatchup();
    }
    // Analysis and Review are always Human vs Human -- evaluation comes from
    // the dedicated warm analysis session, never a per-seat AI. Play mode's
    // actual player/engine choices are preserved (see restorePersistedPlayMatchup above).
    if (mode !== "play" && prevMode === "play") {
      this.applyAnalysisEvaluatorDefaults();
      // "Paused" means something different per mode (see _analysisShouldBeActive) --
      // a stale paused-in-Play flag must not silently deactivate the analysis
      // session the instant you switch to Analysis/Review.
      this.enginesPaused = false;
    }
    if (replayFromCurrentGame) {
      this.replay = replayFromCurrentGame;
      this.applyReplayIndex();
    }
    if (mode === "analysis") {
      this._moveRequestSeq += 1;
      this.replay = null;
      this.aiThinking = false;
      this.thinkingPlayerType = null;
      this.liveSearch = null;
    }
    if (mode === "replay" && this.replay) {
      this.enginesPaused = false;
      this._startReviewAnalysis();
    }
    this._syncAnalysisSessionActive();
    this.scheduleCatRefresh();
    this.onChange?.();
  }

  loadAnalysisPosition(code) {
    this._moveRequestSeq += 1;
    this._abortEngineSearch({ bumpRequestSeq: false });
    this._stopReviewAnalysis();
    const trimmed = code.trim();
    const { actions } = decodeReplayCode(trimmed);
    this.replay = null;
    this.aiThinking = false;
    this.liveSearch = null;
    this.engineErrors = {};
    for (const engine of this.engines.values()) {
      engine.resetConnection();
    }
    this.session.rebuildFromActions(actions);
    this.handleCatPositionChanged();
    this.onChange?.();
  }

  async refreshCatViz() {
    if (!this.settings.showCatVision) {
      return;
    }
    const movesKey = this.catMovesKey();
    const seq = ++this._catFetchSeq;
    this.catVizLoading = true;
    this.catVizError = null;
    this.onChange?.();

    const moves = this.session.actions.map((action) => toAlgebraic(action));
    try {
      const data = await fetchCatSnapshot(moves);
      if (seq !== this._catFetchSeq) {
        return;
      }
      const squares = data.squares ?? [];
      const reachableRaw = data.reachable ?? [];
      const reachable =
        reachableRaw.length === 81
          ? reachableRaw.map((v) => v === 1 || v === true || v === "1")
          : null;
      const walls = data.walls ?? [];

      this.catViz = {
        squares,
        reachable,
        wallIndex: indexCatWalls(walls),
        whiteDist: data.whiteDist,
        blackDist: data.blackDist,
        hotCm: data.hotCm ?? 160,
        coldCm: data.coldCm ?? 60,
        maxCm: data.maxCm ?? 400,
        skippedSquares:
          data.skippedSquares ?? reachable?.filter((r) => !r).length ?? 0,
        skippedWallCount: walls.filter((w) => w.skip ?? w.pruned).length,
        searchableWallCount: walls.filter(
          (w) => w.search ?? !(w.skip ?? w.pruned),
        ).length,
      };
      this._catMovesKey = movesKey;
      this.catVizError = null;
    } catch (err) {
      if (seq !== this._catFetchSeq) {
        return;
      }
      this.catVizError = err.message ?? String(err);
    } finally {
      if (seq === this._catFetchSeq) {
        this.catVizLoading = false;
        this.onChange?.();
      }
    }
  }

  /** Leave replay scrubber but keep the current position — human can play from here. */
  continueFromReplay() {
    if (!this.replay) {
      return;
    }
    this._moveRequestSeq += 1;
    this._stopReviewAnalysis();
    this.replay = null;
    this.settings.uiMode = "play";
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.liveSearch = null;
    this.moveThinkLog = [];
    this._syncAnalysisSessionActive();
    this.onChange?.();
    this.maybeRequestAiMove();
  }

  loadReplay(code) {
    this._moveRequestSeq += 1;
    this._abortEngineSearch({ bumpRequestSeq: false });
    this._stopReviewAnalysis();
    const trimmed = code.trim();
    const { actions, meta, algebraic } = decodeReplayCode(trimmed);
    this.replay = {
      actions,
      algebraic,
      index: actions.length,
      code: trimmed.startsWith("tq1")
        ? trimmed
        : encodeReplayFromActions(actions, meta),
      meta,
    };
    this.settings.uiMode = "replay";
    this.applyAnalysisEvaluatorDefaults();
    this.enginesPaused = false;
    this.aiThinking = false;
    this.liveSearch = null;
    this.engineErrors = {};
    for (const engine of this.engines.values()) {
      engine.resetConnection();
    }
    this.applyReplayIndex();
    this._syncAnalysisSessionActive();
    this._startReviewAnalysis();
    this.onChange?.();
  }

  applyReplayIndex() {
    if (!this.replay) {
      return;
    }
    const slice = this.replay.actions.slice(0, this.replay.index);
    this.session.rebuildFromActions(slice);
  }

  setReplayIndex(index) {
    if (!this.replay) {
      return;
    }
    this.replay.index = Math.max(
      0,
      Math.min(index, this.replay.actions.length),
    );
    this.applyReplayIndex();
    this.onChange?.();
  }

  replayStep(delta) {
    if (!this.replay) {
      return;
    }
    this.setReplayIndex(this.replay.index + delta);
  }

  setMoveListPly(ply) {
    const nextPly = Math.max(0, Math.round(Number(ply) || 0));
    if (this.replay) {
      this.setReplayIndex(nextPly);
      return;
    }
    const lineLength =
      this.session.lineActions?.().length ?? this.session.actions.length;
    if (this.aiThinking) {
      this._cancelActiveAiSearch();
    }
    const moved = this.session.jumpToPly?.(nextPly);
    if (!moved) {
      return;
    }
    this._moveRequestSeq += 1;
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this.searchInfoBySeat = [null, null];
    if (nextPly < lineLength && this.settings.uiMode === "play") {
      this.enginesPaused = true;
    }
    this.handleCatPositionChanged({ clearViz: true });
    this._syncAnalysisSessionActive();
    this.onChange?.();
  }

  exportReplayCode() {
    if (!this.replay) {
      return encodeReplayFromActions(this.session.actions);
    }
    return this.replay.code;
  }

  undo() {
    if (this.replay) {
      return;
    }
    if (this.aiThinking) {
      this._cancelActiveAiSearch();
      if (!this.session.undo()) {
        this.onChange?.();
        return;
      }
      this._finishUndo({ requestAi: true });
      return;
    }
    this._moveRequestSeq += 1;
    const plies = this._undoPlyCount();
    let undone = 0;
    for (let i = 0; i < plies; i++) {
      if (!this.session.undo()) {
        break;
      }
      undone++;
    }
    if (undone === 0) {
      return;
    }
    this._finishUndo({ requestAi: true });
  }

  redo() {
    if (this.aiThinking || this.replay) {
      return;
    }
    this._moveRequestSeq += 1;
    this.liveSearch = null;
    if (!this.session.redo()) {
      return;
    }
    this._finishUndo({ requestAi: true });
  }

  tryAction(action) {
    if (this.replay || this.aiThinking) {
      return;
    }

    const freePlay = this.isFreePlayMode();
    const manualWhilePaused = this.enginesPaused;
    if (
      !freePlay &&
      !manualWhilePaused &&
      !this.session.isHumanTurn(this.settings.players)
    ) {
      return;
    }

    const actingSeat = this.session.playerToMove - 1;
    if (this._humanTimedOut?.[actingSeat]) {
      return;
    }
    const humanThinkStarted = this._humanThinkStartedAt;

    const applied = this.session.applyAction(action);
    if (!applied) {
      return;
    }

    if (
      this.settings.players[actingSeat] === PlayerType.Human &&
      hasSeatClock(
        PlayerType.Human,
        this.engineConfigs,
        this.settings.playerAiSettings[actingSeat],
      )
    ) {
      const thinkMs =
        humanThinkStarted != null
          ? Math.round(performance.now() - humanThinkStarted)
          : 0;
      this._humanThinkStartedAt = null;
      this.moveThinkLog.push({
        ply: this.session.actions.length,
        move: toAlgebraic(action),
        engine: "Human",
        thinkMs,
        stoppedBy: "human",
      });
    }

    this.handleCatPositionChanged();
    this.maybeSubmitFinishedGame();
    this.onChange?.();
    if (freePlay || manualWhilePaused) {
      return;
    }
    this.continueAiAfterEngineSync(action);
  }

  /** After any ply, sync remote seats then request the next AI move. */
  continueAiAfterEngineSync(action, actingSeat = null) {
    const gameGeneration = this._gameGeneration;
    if (actingSeat == null) {
      actingSeat = this.session.playerToMove === 2 ? 0 : 1;
    }
    void this.syncEnginesAfterMove(action, actingSeat)
      .catch(async (err) => {
        if (gameGeneration !== this._gameGeneration) {
          return;
        }
        console.error("Engine position sync failed after ply", err);
        const positionKey = this.currentPositionKey();
        const moveHistory = this.session.actions;
        const diagnostic = buildDiagnosticContext({
          session: this.session,
          settings: this.settings,
          reason: "remote-sync-failure",
        });
        this._lastDiagnostic = diagnostic;
        const message = `${err?.message ?? String(err)}\n\n${diagnostic}`;
        const recoveries = [];
        for (let seat = 0; seat < this.settings.players.length; seat++) {
          const playerType = this.settings.players[seat];
          if (playerType === PlayerType.Human) {
            continue;
          }
          const engineEntry = getEngineEntryForPlayer(
            playerType,
            this.settings.playerAiSettings[seat],
          );
          if (
            !engineEntry ||
            engineEntry.backend !== EngineBackendKind.REMOTE_WS
          ) {
            continue;
          }
          this.engineErrors[seat] = message;
          this.engineStatus[seat] = "error";
          const engine = this.getEngineForSeat(seat);
          if (engine?.markDesynced) {
            engine.markDesynced(message);
            recoveries.push(
              engine
                .recoverFromDesync({
                  moveHistory,
                  gameSnapshot: this.session.getEngineSnapshot(),
                  isFreshGame: moveHistory.length === 0,
                  positionKey,
                })
                .catch((resyncErr) => {
                  console.error("Remote resync failed", resyncErr);
                  throw resyncErr;
                }),
            );
          }
        }
        if (recoveries.length) {
          await Promise.all(recoveries);
          for (let seat = 0; seat < this.settings.players.length; seat++) {
            const engine = this.getEngineForSeat(seat);
            if (engine?.syncState === SyncState.SYNCED) {
              this.engineErrors[seat] = null;
              this.engineStatus[seat] = "idle";
            }
          }
        }
        this.onChange?.();
      })
      .finally(() => {
        if (gameGeneration !== this._gameGeneration) {
          return;
        }
        if (!this.enginesPaused) {
          this.maybeRequestAiMove();
          this.maybePonderInactiveEngines();
        }
      });
  }

  onSessionChange() {
    if (this._suppressSessionNotify) {
      return;
    }
    if (!this.aiThinking) {
      this.lmrVizLive = null;
    }
    this.handleCatPositionChanged();
    this.scheduleLmrRefresh();
    this.onChange?.();
  }

  createAceClient(config, seatIndex) {
    const playerType = this.settings.players[seatIndex];
    const aiSettings = this.settings.playerAiSettings[seatIndex] ?? {};
    const tier = resolveAceTier(aiSettings.strengthLevel, playerType);
    const generation = aceGenerationFromPlayerType(playerType);
    if (tier.kind.endsWith("-js")) {
      if (generation === 13) return new AceV13JsEngineClient(config);
      return new AceV10JsEngineClient(config);
    }
    return new AceRustWasmEngineClient({
      ...config,
      engineMode: tier.engineMode,
    });
  }

  createEngineClient(config, seatIndex = 0) {
    if (config.kind === "local") {
      return new GorisansonEngineClient(config);
    }
    if (config.kind === "quoridor-v3") {
      return new QuoridorV3EngineClient(config);
    }
    if (config.kind === "zeroink") {
      return new ZeroInkEngineClient(config);
    }
    if (
      config.kind === "ace-v8-family" ||
      config.kind === "ace-v10-family" ||
      config.kind === "ace-v13-family"
    ) {
      return this.createAceClient(config, seatIndex);
    }
    if (config.kind === "titanium") {
      const ai = this.settings.playerAiSettings[seatIndex] ?? {};
      const playerType = this.settings.players[seatIndex];
      const engineMode = resolveTitaniumEngineMode(
        ai,
        playerType,
        this.engineConfigs,
      );
      const patched = {
        ...config,
        engineMode,
        cores: resolveCores(ai),
      };
      return HAS_NATIVE_TITANIUM_LAZY_SMP
        ? new TitaniumEngineClient(patched, { seatId: `seat-${seatIndex}` })
        : new TitaniumWasmEngineClient(patched);
    }
    return new EngineClient(config);
  }

  destroyEngineForSeat(seatIndex) {
    const seatKey = this.engineSeatKey(seatIndex);
    const engine = this.engines.get(seatKey);
    if (!engine) {
      return;
    }
    engine.destroy?.();
    this.engines.delete(seatKey);
  }

  destroyAllEngines() {
    for (const engine of this.engines.values()) {
      engine.onBestMove = null;
      engine.onError = null;
      engine.onInfo = null;
      engine.destroy?.();
    }
    this.engines.clear();
  }

  /** Fingerprint of settings that require a fresh engine client (applied on next move). */
  engineBindKey(seatIndex) {
    const playerType = this.settings.players[seatIndex];
    const ai = this.settings.playerAiSettings[seatIndex] ?? {};
    if (isAceFamily(playerType, this.engineConfigs)) {
      const tier = resolveAceTier(ai.strengthLevel, playerType);
      const generation = aceGenerationFromPlayerType(playerType);
      const backend = tier.kind.endsWith("-js") ? "js" : "wasm";
      return `${playerType}|${backend}|${tier.engineMode}`;
    }
    if (isTitaniumEngine(playerType, this.engineConfigs)) {
      const backend = HAS_NATIVE_TITANIUM_LAZY_SMP ? "native" : "wasm";
      const mode = resolveTitaniumEngineMode(
        ai,
        playerType,
        this.engineConfigs,
      );
      const cat =
        playerType === PlayerType.TitaniumV16 ||
        playerType === PlayerType.TitaniumV17
          ? `|cat${resolveCatLmrCeiling(ai)}`
          : "";
      const cores = `|c${resolveCores(ai)}`;
      return `${playerType}|${backend}|${mode}${cat}${cores}`;
    }
    const kind =
      getEngineConfig(playerType, this.engineConfigs)?.kind ?? playerType;
    return `${playerType}|${kind}`;
  }

  getEngineForSeat(seatIndex) {
    const playerType = this.settings.players[seatIndex];
    if (!playerType || playerType === PlayerType.Human) {
      return null;
    }

    const config = getEngineConfig(playerType, this.engineConfigs);
    if (!config || config.disabled) {
      return null;
    }

    const seatKey = this.engineSeatKey(seatIndex);
    const bindKey = this.engineBindKey(seatIndex);
    const cached = this.engines.get(seatKey);
    if (
      cached &&
      (cached.config?.key !== config.key || cached._bindKey !== bindKey)
    ) {
      cached.destroy?.();
      this.engines.delete(seatKey);
    }

    if (!this.engines.has(seatKey)) {
      const engine = this.createEngineClient(config, seatIndex);
      engine._bindKey = bindKey;
      engine._bindGeneration = this._gameGeneration;
      engine.onStatus = (status) => {
        const prev = this.engineStatus[seatIndex];
        this.engineStatus[seatIndex] = status;
        if (prev !== status) {
          this.onChange?.();
        }
      };
      engine.onInfo = (info) => {
        if (
          info.connectionEpoch != null &&
          engine.connectionEpoch != null &&
          info.connectionEpoch !== engine.connectionEpoch
        ) {
          return;
        }
        const prev = this.searchInfoBySeat[seatIndex] ?? {};
        const depthLog = info.depthLog?.length
          ? mergeDepthLogs(prev.depthLog, info.depthLog)
          : (prev.depthLog ?? []);
        const rootMoves = coalesceRootMoves(info.rootMoves, prev.rootMoves);
        this.searchInfoBySeat[seatIndex] = finalizeSearchInfo({
          ...prev,
          ...info,
          rootMoves,
          depthLog,
        });
        const siMerged = this.searchInfoBySeat[seatIndex];
        const requestedThreads = Number(siMerged?.requestedThreads);
        const effectiveThreads = Number(siMerged?.effectiveThreads);
        if (
          isTitaniumEngine(playerType, this.engineConfigs) &&
          Number.isFinite(requestedThreads) &&
          Number.isFinite(effectiveThreads) &&
          requestedThreads > effectiveThreads &&
          effectiveThreads >= 1
        ) {
          const ai = this.settings.playerAiSettings[seatIndex] ?? {};
          const nextCores = clampCores(effectiveThreads);
          if (resolveCores(ai) !== nextCores) {
            this.settings.playerAiSettings[seatIndex] = {
              ...ai,
              cores: nextCores,
              threads: nextCores,
            };
            const memory = this.settings.playerAiSettingsMemory?.[seatIndex];
            if (memory?.[playerType]) {
              memory[playerType] = {
                ...memory[playerType],
                cores: nextCores,
                threads: nextCores,
              };
            }
            this.persistPlaySettings();
          }
        }
        if (info.thinking) {
          if (!this.aiThinking || this.thinkingSeatIndex !== seatIndex) {
            return;
          }
          const si = this.searchInfoBySeat[seatIndex];
          const liveDepthLog = si.depthLog ?? [];
          const deepLive = deepestDepthEntry(liveDepthLog);
          const liveRootScore = scoreFromDepthLog(
            liveDepthLog,
            info.rootScore ?? this.liveSearch?.rootScore,
          );
          const livePv = deepLive?.pv ?? info.pv ?? this.liveSearch?.pv ?? "";
          this.liveSearch = {
            playerType,
            seatIndex,
            playerLabel: this.engineLabelForSeat(seatIndex),
            requestSeq: this._activeSearchSeq,
            positionKey: this.currentPositionKey(),
            pv: livePv,
            simulations: si.simulations ?? 0,
            nodes: si.nodes ?? 0,
            selectedWorkerNodes:
              info.selectedWorkerNodes ?? si.selectedWorkerNodes,
            totalNodesAcrossWorkers:
              info.totalNodesAcrossWorkers ?? si.totalNodesAcrossWorkers,
            nodeSource: info.nodeSource ?? si.nodeSource,
            estimatedTotalNodes:
              info.estimatedTotalNodes ?? si.estimatedTotalNodes,
            progress: info.progress,
            mode:
              info.mode ??
              info.stoppedBy ??
              (isTitaniumEngine(playerType, this.engineConfigs)
                ? "minimax"
                : isAceFamily(playerType, this.engineConfigs)
                  ? resolveAceTier(
                      this.settings.playerAiSettings[seatIndex]?.strengthLevel,
                      playerType,
                    ).engineMode
                  : "mcts"),
            searchDepth: info.searchDepth ?? this.liveSearch?.searchDepth,
            depthLog: liveDepthLog,
            rootWinRate:
              info.rootWinRate != null
                ? info.rootWinRate
                : this.liveSearch?.rootWinRate,
            whiteDist: info.whiteDist ?? this.liveSearch?.whiteDist,
            blackDist: info.blackDist ?? this.liveSearch?.blackDist,
            rootMoves: siMerged?.rootMoves ?? this.liveSearch?.rootMoves,
            rootMove: info.rootMove ?? this.liveSearch?.rootMove,
            lmrProfile: info.lmrProfile ?? this.liveSearch?.lmrProfile,
            lmrReSearches: info.lmrReSearches ?? this.liveSearch?.lmrReSearches,
            helperStarts: info.helperStarts ?? this.liveSearch?.helperStarts,
            helperStartsTotal:
              info.helperStartsTotal ?? this.liveSearch?.helperStartsTotal,
            requestedThreads:
              info.requestedThreads ?? this.liveSearch?.requestedThreads,
            effectiveThreads:
              info.effectiveThreads ?? this.liveSearch?.effectiveThreads,
            threaded: info.threaded ?? this.liveSearch?.threaded,
            fallbackReason:
              info.fallbackReason ?? this.liveSearch?.fallbackReason,
            rootScore: liveRootScore,
            elapsedMs: info.elapsedMs ?? this.liveSearch?.elapsedMs,
            rolloutVerdict:
              info.rolloutVerdict ?? this.liveSearch?.rolloutVerdict,
            rolloutVisits: info.rolloutVisits ?? this.liveSearch?.rolloutVisits,
            rolloutWins: info.rolloutWins ?? this.liveSearch?.rolloutWins,
            wholeGameExpectedMovesLeft:
              this._thinkAiSettings?.wholeGameExpectedMovesLeft ?? null,
            wholeGameDistanceToWin:
              this._thinkAiSettings?.wholeGameDistanceToWin ?? null,
            wholeGameMoveBudgetSeconds:
              this._thinkAiSettings?.wallClockSeconds ?? null,
          };
          const clockRefreshed = this._refreshThinkClockFromSearch(
            seatIndex,
            info,
            liveDepthLog,
          );
          if (clockRefreshed && this._thinkAiSettings) {
            this.liveSearch = {
              ...this.liveSearch,
              wholeGameExpectedMovesLeft:
                this._thinkAiSettings.wholeGameExpectedMovesLeft,
              wholeGameDistanceToWin:
                this._thinkAiSettings.wholeGameDistanceToWin,
              wholeGameMoveBudgetSeconds:
                this._thinkAiSettings.wallClockSeconds,
            };
          }
          const liveDepth =
            info.searchDepth ?? deepestDepthEntry(liveDepthLog)?.depth;
          const depthTick =
            liveDepth != null && liveDepth !== (prev.searchDepth ?? 0);
          const rootTick = Boolean(info.rootMoves?.length);
          if (
            this.settings.showLmrVision &&
            isTitaniumEngine(playerType, this.engineConfigs) &&
            (rootTick || depthTick)
          ) {
            this.ingestLmrSearchPayload(
              {
                live: true,
                searchDepth: liveDepth,
                depthLog: liveDepthLog,
                lmrProfile: info.lmrProfile ?? this.liveSearch.lmrProfile,
                lmrReSearches:
                  info.lmrReSearches ?? this.liveSearch.lmrReSearches,
                rootMoves: info.rootMoves ?? this.liveSearch.rootMoves,
              },
              this.lmrPositionKey(),
            );
          }
          const now = performance.now();
          if (now - this._liveUpdateLastMs >= 16) {
            this._liveUpdateLastMs = now;
            (this.onLiveUpdate ?? this.onChange)?.();
          }
          return;
        }
        if (
          info.progress !== undefined &&
          info.p1 === undefined &&
          !info.pv &&
          !info.stoppedBy
        ) {
          return;
        }
        if (
          info.stoppedBy &&
          this.aiThinking &&
          this.thinkingSeatIndex === seatIndex &&
          this._activeSearchSeq !== this._moveRequestSeq
        ) {
          return;
        }
        if (info.pv) {
          this.eval.pv = info.pv;
        }
        if (info.stoppedBy) {
          const si = this.searchInfoBySeat[seatIndex] ?? {};
          this.snapshotThinkSeat(seatIndex, {
            live: false,
            ply: this.session.actions.length + 1,
            depthLog: si.depthLog,
            searchDepth: si.searchDepth,
            whiteDist: si.whiteDist,
            blackDist: si.blackDist,
            rootScore: si.rootScore,
            nodes: si.nodes,
            simulations: si.simulations,
            rootWinRate: si.rootWinRate,
            stoppedBy: info.stoppedBy,
            rootMoves: si.rootMoves,
            engine: this.engineLabelForSeat(seatIndex),
            rolloutVerdict: si.rolloutVerdict,
            rolloutVisits: si.rolloutVisits,
            rolloutWins: si.rolloutWins,
          });
        }
        this.onChange?.();
      };
      engine.onError = (err) => {
        if (engine._bindGeneration !== this._gameGeneration) {
          return;
        }
        if (this.thinkingSeatIndex !== seatIndex) {
          return;
        }
        if (isAbortError(err)) {
          return;
        }
        this.recordEngineFailure(playerType, {
          ply: this.session.actions.length + 1,
          error: err,
          budget: describePlayerAiSettings(
            playerType,
            this.settings.playerAiSettings[seatIndex],
            this.engineConfigs,
          ),
        });
        this.onChange?.();
      };
      this.engines.set(seatKey, engine);
    }

    return this.engines.get(seatKey);
  }

  getEngine(playerType) {
    return this.getEngineForSeat(this.seatIndexForPlayerType(playerType));
  }

  /** Keep engine clients in sync after every ply (incremental makemove echo). */
  async syncEnginesAfterMove(action, _actingSeat = null) {
    const positionKey = this.currentPositionKey();
    const historyLength = this.session.actions.length;
    const moveHistory = this.session.actions;
    const ops = [];
    for (let seat = 0; seat < this.settings.players.length; seat++) {
      const playerType = this.settings.players[seat];
      if (playerType === PlayerType.Human) {
        continue;
      }
      const engineEntry = getEngineEntryForPlayer(
        playerType,
        this.settings.playerAiSettings[seat],
      );
      if (!engineEntry) {
        continue;
      }
      const engine = this.getEngineForSeat(seat);
      const echo = engine?.echoCommittedMove?.(
        action,
        positionKey,
        historyLength,
        moveHistory,
      );
      if (echo?.then) {
        ops.push(echo);
      }
    }
    if (ops.length) {
      await Promise.all(ops);
    }
  }

  /** @deprecated alias — remote-only name kept for call sites being migrated */
  async syncRemoteEnginesAfterMove(action, actingSeat = null) {
    return this.syncEnginesAfterMove(action, actingSeat);
  }

  syncRemoteEngine(playerType) {
    const engine = this.getEngine(playerType);
    if (!engine?.syncGameState) {
      return;
    }

    const moveHistory = this.session.actions;
    const positionKey = this.currentPositionKey();
    engine.syncGameState({
      moveHistory,
      gameSnapshot: this.session.getEngineSnapshot(),
      isFreshGame: moveHistory.length === 0,
      positionKey,
    });
  }

  /** Stop background ponder on all engines before a real search. Safe no-op until pondering ships. */
  stopAllPonders() {
    for (const engine of this.engines.values()) {
      engine.stopPonder?.();
    }
  }

  /**
   * Future: remote `go ponder` + local predicted-line MCTS (node cap only).
   * @see docs/video/09-pondering-prep.md
   */
  maybePonderInactiveEngines() {
    if (this.session.winner != null || this.session.isDraw || this.aiThinking) {
      return;
    }
    const { playerToMove } = this.session.getSnapshot();
    for (const { slot, playerType } of ponderCandidateSlots(
      this.settings.players,
      playerToMove,
    )) {
      const engine = this.getEngineForSeat(slot);
      if (!engine?.ponder) {
        continue;
      }
      // Not enabled yet — wire aiSettings + sync before calling engine.ponder(...)
    }
  }

  engineLabelForSeat(seatIndex) {
    const playerType = this.settings.players[seatIndex];
    if (!playerType || playerType === PlayerType.Human) {
      return "Human";
    }
    if (isAceFamily(playerType, this.engineConfigs)) {
      const strength =
        this.settings.playerAiSettings[seatIndex]?.strengthLevel ?? 0;
      return aceDisplayName(strength, playerType);
    }
    const config = getEngineConfig(playerType, this.engineConfigs);
    return config?.name ?? playerType;
  }

  maybeSubmitFinishedGame() {
    if (this.replay || (this.session.winner == null && !this.session.isDraw)) {
      return;
    }
    const payload = finishedGamePayload({
      actions: this.session.actions,
      winner: this.session.winner,
      isDraw: this.session.isDraw,
      players: [...this.settings.players],
      playerAiSettings: this.settings.playerAiSettings.map((settings) =>
        settings ? { ...settings } : null,
      ),
      engineLabels: [this.engineLabelForSeat(0), this.engineLabelForSeat(1)],
      initialBudgetHint: this.initialBudgetHint,
      moveThinkLog: this.moveThinkLog.map((entry) => ({ ...entry })),
    });
    const signature = finishedGameSignature(payload);
    if (!payload || !signature || this._submittedFinishedGames.has(signature)) {
      return;
    }
    this._submittedFinishedGames.add(signature);
    void submitFinishedGame(payload).catch((err) => {
      console.debug?.("finished-game training submit skipped", err);
    });
  }

  /** @deprecated prefer engineLabelForSeat(seatIndex) when seat is known */
  engineLabel(playerType) {
    const seatIndex = this.seatIndexForPlayerType(playerType);
    if (seatIndex >= 0) {
      return this.engineLabelForSeat(seatIndex);
    }
    const normalized = normalizePlayerType(playerType);
    const config = getEngineConfig(normalized, this.engineConfigs);
    return config?.name ?? playerType;
  }

  engineSeatKey(seatIndex) {
    return `seat-${seatIndex}`;
  }

  _isStaleEngineMoveResponse({
    moveKey,
    requestPly,
    requestHistory,
    requestPositionKey,
    currentPositionKey,
    historyTokens,
    actionsLength,
    sessionActions,
  }) {
    const currentHistory = historyTokens.join(" ");
    if (requestHistory && currentHistory !== requestHistory) {
      return true;
    }
    if (actionsLength !== requestPly) {
      return true;
    }
    if (
      requestPositionKey &&
      currentPositionKey &&
      requestPositionKey !== currentPositionKey
    ) {
      return true;
    }
    const last = sessionActions[sessionActions.length - 1];
    if (last && toAlgebraic(last) === moveKey) {
      return true;
    }
    return false;
  }

  _ignoreStaleEngineMove({
    seatIndex,
    playerType,
    requestSeq,
    moveKey,
    reason,
    sessionActions,
  }) {
    logAiRequestEvent("AI_IDENTITY_VALIDATED", {
      requestSeq,
      ok: false,
      reason,
      decodedMove: moveKey,
    });
    console.warn("Ignoring stale engine move response", {
      playerType,
      seatIndex,
      requestSeq,
      reason,
      suggested: moveKey,
    });
    const last = sessionActions[sessionActions.length - 1];
    if (
      last &&
      toAlgebraic(last) === moveKey &&
      typeof this.engineErrors[seatIndex] === "string" &&
      this.engineErrors[seatIndex].includes("canonical-illegal")
    ) {
      this.engineErrors[seatIndex] = null;
      this.engineStatus[seatIndex] = "idle";
    }
    if (this.thinkingSeatIndex === seatIndex) {
      this.aiThinking = false;
      this.thinkingPlayerType = null;
      this.thinkingSeatIndex = null;
      this.onChange?.();
      queueMicrotask(() => this.maybeRequestAiMove());
    }
    return "stale";
  }

  seatIndexForPlayerType(playerType) {
    if (
      this.thinkingSeatIndex != null &&
      this.settings.players[this.thinkingSeatIndex] === playerType
    ) {
      return this.thinkingSeatIndex;
    }
    const ptm = this.session.playerToMove - 1;
    if (this.settings.players[ptm] === playerType) {
      return ptm;
    }
    return this.settings.players.indexOf(playerType);
  }

  isActionLegal(action) {
    const label = this.session.actionToLabel(action);
    return this.session
      .getSnapshot()
      .validActions.some((mv) => this.session.actionToLabel(mv) === label);
  }

  rejectIllegalEngineMove({
    playerType,
    seatIndex,
    action,
    requestSeq,
    requestPly,
    requestHistory,
    searchInfo,
    rustError,
  }) {
    const snapshot = this.session.getSnapshot();
    const suggested = this.session.actionToLabel(action);
    const legal = snapshot.validActions.map((mv) =>
      this.session.actionToLabel(mv),
    );
    const ply = snapshot.actions.length + 1;
    const position =
      this.session.actions.map((a) => toAlgebraic(a)).join(" ") || "(start)";
    const retries = (this._illegalRetriesByPly[ply] ?? 0) + 1;
    this._illegalRetriesByPly[ply] = retries;

    const illegalMsg = rustError
      ? String(rustError)
      : `REJECTED illegal move ${suggested} on ply ${ply} — board unchanged (${legal.length} legal)`;

    const diagnostic = buildDiagnosticContext({
      session: this.session,
      settings: this.settings,
      request: {
        requestSeq,
        gameGeneration: this._gameGeneration,
        seatIndex,
      },
      move: suggested,
      decodedMove: suggested,
      reason: rustError ? "titanium-illegal" : "canonical-illegal",
    });
    this._lastDiagnostic = diagnostic;

    console.error("Engine produced illegal move", {
      playerType,
      seatIndex,
      suggested,
      ply,
      diagnostic,
    });

    this.getEngineForSeat(seatIndex)?.clearQueuedSearches?.();

    this.searchInfoBySeat[seatIndex] = {
      ...(this.searchInfoBySeat[seatIndex] ?? {}),
      illegalMove: suggested,
      illegalMovePly: ply,
      legalMovesCount: legal.length,
      illegalDetail: diagnostic,
    };
    this.engineErrors[seatIndex] = `${illegalMsg}\n\n${diagnostic}`;
    this.engineStatus[seatIndex] = "error";

    const budgetHint = describePlayerAiSettings(
      playerType,
      this._thinkAiSettings ?? this.settings.playerAiSettings[seatIndex],
      this.engineConfigs,
    );

    this.moveThinkLog.push({
      ply,
      move: suggested,
      engine: this.engineLabelForSeat(seatIndex),
      budget: budgetHint,
      error: `${illegalMsg}\n\n${diagnostic}`,
      rejected: true,
      legalSample: legal.slice(0, 12).join(" "),
      stoppedBy: "illegal",
      thinkMs: resolveThinkMs(searchInfo ?? {}, this._thinkStartedAt),
      nodes: searchInfo?.nodes ?? searchInfo?.simulations ?? 0,
      depthLog: searchInfo?.depthLog ? [...searchInfo.depthLog] : [],
    });

    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this.lmrVizLive = null;
    this._thinkStartedAt = null;
    this._thinkAiSettings = null;
    this._thinkClockLastDepth = null;

    if (retries <= this._maxIllegalRetries) {
      const engine = this.getEngineForSeat(seatIndex);
      if (engine?.recoverFromDesync) {
        const positionKey = this.currentPositionKey();
        void engine.recoverFromDesync({
          moveHistory: this.session.actions,
          gameSnapshot: this.session.getEngineSnapshot(),
          isFreshGame: this.session.actions.length === 0,
          positionKey,
        });
      }
      const retryGen = this._gameGeneration;
      this.moveThinkLog.push({
        ply,
        move: null,
        engine: this.engineLabelForSeat(seatIndex),
        budget: budgetHint,
        note: `auto-retry ${retries}/${this._maxIllegalRetries} after illegal ${suggested}`,
        stoppedBy: "retry",
      });
      this.engineErrors[seatIndex] =
        `${illegalMsg} — retrying (${retries}/${this._maxIllegalRetries})`;
      this.onChange?.();
      queueMicrotask(() => {
        if (retryGen !== this._gameGeneration) {
          return;
        }
        this.maybeRequestAiMove();
      });
    } else {
      this.engineErrors[seatIndex] =
        `HALTED: illegal move ${suggested} on ply ${ply} after ${retries} attempts — fix engine or undo`;
      this._haltGameOnEngineFailure(seatIndex);
      this.onChange?.();
    }
    return false;
  }

  _engineFailureRetryKey(seatIndex) {
    return `${this._gameGeneration}:${seatIndex}`;
  }

  _clearEngineFailureRetryTimer() {
    if (this._engineFailureRetryTimer != null) {
      clearTimeout(this._engineFailureRetryTimer);
      this._engineFailureRetryTimer = null;
    }
  }

  _resetEngineFailureRecovery() {
    this._clearEngineFailureRetryTimer();
    this._engineFailureRetryBySeat = {};
    this._engineRecoveryActive = false;
    this._engineRecoverySeat = -1;
  }

  _clearEngineFailureRecovery(seatIndex) {
    const key = this._engineFailureRetryKey(seatIndex);
    delete this._engineFailureRetryBySeat[key];
    if (this._engineRecoveryActive && this._engineRecoverySeat === seatIndex) {
      this._clearEngineFailureRetryTimer();
      this._engineRecoveryActive = false;
      this._engineRecoverySeat = -1;
      this._gameHalted = false;
      this.engineErrors[seatIndex] = null;
      this.engineStatus[seatIndex] = "idle";
    }
  }

  _finalizeEngineFailure(seatIndex, message) {
    this._engineRecoveryActive = false;
    this._engineRecoverySeat = -1;
    this._clearEngineFailureRetryTimer();
    this._gameHalted = true;
    this.enginesPaused = true;
    this.engineErrors[seatIndex] =
      `${message}\n\nGave up after ${this._maxEngineFailureRetries} search retries.`;
    this.engineStatus[seatIndex] = "error";
    this._cancelActiveAiSearch();
    this.stopAllPonders();
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this.onChange?.();
  }

  async _recoverEngineAfterFailure(seatIndex) {
    if (!this._engineRecoveryActive || this._engineRecoverySeat !== seatIndex) {
      return;
    }
    if (this.session.winner != null || this.session.isDraw) {
      return;
    }
    const positionKey = this.currentPositionKey();
    const aiSettings =
      this.settings.playerAiSettings[seatIndex] ??
      defaultPlayerAiSettings(
        this.settings.players[seatIndex],
        this.engineConfigs,
      );
    const recoveryCtx = {
      moveHistory: this.session.actions,
      gameSnapshot: this.session.getEngineSnapshot(),
      isFreshGame: this.session.actions.length === 0,
      positionKey,
      aiSettings,
    };
    try {
      const engine = this.getEngineForSeat(seatIndex);
      if (engine?.recoverFromDesync) {
        await engine.recoverFromDesync(recoveryCtx);
      }
    } catch (err) {
      console.warn("Engine restart before retry failed", err);
    }
    if (!this._engineRecoveryActive || this._engineRecoverySeat !== seatIndex) {
      return;
    }
    const key = this._engineFailureRetryKey(seatIndex);
    const retry = this._engineFailureRetryBySeat[key];
    const attempt = retry?.attempt ?? 0;
    this.engineErrors[seatIndex] =
      `${retry?.lastMessage ?? "Engine error"}\n\nRetrying search (${attempt}/${this._maxEngineFailureRetries})…`;
    this.engineStatus[seatIndex] = "connecting";
    this.onChange?.();
    this.maybeRequestAiMove();
  }

  _handleEngineFailure({
    seatIndex,
    playerType,
    ply,
    error,
    budget,
  }) {
    if (isAbortError(error)) {
      return;
    }
    const failSeat =
      seatIndex >= 0
        ? seatIndex
        : this.thinkingSeatIndex ?? this.seatIndexForPlayerType(playerType);
    if (failSeat < 0) {
      return;
    }

    const baseMessage =
      typeof error === "string" ? error : formatEngineFailureMessage(error);
    const position =
      this.session.actions.map((a) => toAlgebraic(a)).join(" ") || "(start)";
    const legal = this.session
      .getSnapshot()
      .validActions.map((mv) => this.session.actionToLabel(mv))
      .slice(0, 24)
      .join(" ");
    const detail = `position="${position}" toMove=${this.session.playerToMove} legalSample=[${legal}]`;
    const fullMessage = `${baseMessage} | ${detail}`;

    console.error("Engine failure", {
      playerType,
      ply,
      seatIndex: failSeat,
      message: fullMessage,
      stack: error?.stack,
    });

    const key = this._engineFailureRetryKey(failSeat);
    const retry = this._engineFailureRetryBySeat[key] ?? { attempt: 0 };
    retry.attempt += 1;
    retry.lastMessage = fullMessage;
    this._engineFailureRetryBySeat[key] = retry;

    this._engineRecoveryActive = true;
    this._engineRecoverySeat = failSeat;
    this._gameHalted = true;
    this._terminalOverlayDismissed = false;
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this._thinkStartedAt = null;
    this._cancelActiveAiSearch();
    this.stopAllPonders();

    const si = this.searchInfoBySeat[failSeat] ?? {};
    const thinkMs = resolveThinkMs(si, null);
    const engineLabel =
      failSeat >= 0
        ? this.engineLabelForSeat(failSeat)
        : this.engineLabel(playerType);
    const plyNum = ply ?? this.session.actions.length + 1;

    if (retry.attempt > this._maxEngineFailureRetries) {
      this.moveThinkLog.push({
        ply: plyNum,
        move: null,
        engine: engineLabel,
        budget: budget ?? "",
        error: fullMessage,
        stoppedBy: "error",
        nodes: si.nodes ?? si.simulations ?? 0,
        searchDepth: si.searchDepth,
        depthLog: si.depthLog ? [...si.depthLog] : [],
        thinkMs,
      });
      this._finalizeEngineFailure(failSeat, fullMessage);
      return;
    }

    const delayMs = engineFailureBackoffMs(retry.attempt);
    const statusMsg = `${fullMessage}\n\nRetrying search (${retry.attempt}/${this._maxEngineFailureRetries}) in ${(delayMs / 1000).toFixed(1)}s…`;
    this.engineErrors[failSeat] = statusMsg;
    this.engineStatus[failSeat] = "error";
    this.snapshotThinkSeat(failSeat, {
      live: false,
      ply: plyNum,
      move: null,
      error: statusMsg,
      stoppedBy: "error",
      engine: engineLabel,
      depthLog: si.depthLog,
      searchDepth: si.searchDepth,
      nodes: si.nodes ?? si.simulations,
      thinkMs,
    });
    this.moveThinkLog.push({
      ply: plyNum,
      move: null,
      engine: engineLabel,
      budget: budget ?? "",
      error: statusMsg,
      stoppedBy: "error",
      nodes: si.nodes ?? si.simulations ?? 0,
      searchDepth: si.searchDepth,
      depthLog: si.depthLog ? [...si.depthLog] : [],
      thinkMs,
    });
    this.onChange?.();

    this._clearEngineFailureRetryTimer();
    const gen = this._gameGeneration;
    this._engineFailureRetryTimer = setTimeout(() => {
      if (gen !== this._gameGeneration) {
        return;
      }
      void this._recoverEngineAfterFailure(failSeat);
    }, delayMs);
  }

  _haltGameOnEngineFailure(failSeat) {
    this._finalizeEngineFailure(
      failSeat,
      this.engineErrors[failSeat] ?? "Engine error",
    );
  }

  _rejectEngineMove(seatIndex, message, { ply, budget, playerType } = {}) {
    this._handleEngineFailure({
      seatIndex,
      playerType: playerType ?? this.settings.players[seatIndex],
      ply: ply ?? this.session.actions.length + 1,
      error: message,
      budget,
    });
  }

  recordEngineFailure(playerType, { ply, error, budget }) {
    this._handleEngineFailure({
      playerType,
      ply,
      error,
      budget,
      seatIndex:
        this.thinkingSeatIndex ?? this.seatIndexForPlayerType(playerType),
    });
  }

  snapshotThinkSeat(seatIndex, fields) {
    if (seatIndex < 0) {
      return;
    }
    this.lastThinkBySeat[seatIndex] = buildThinkSeatSnapshot({
      engine: fields.engine ?? this.engineLabelForSeat(seatIndex),
      ...fields,
    });
  }

  snapshotCompletedThinkSeat(seatIndex, fields) {
    if (seatIndex < 0) {
      return;
    }
    const snap = buildThinkSeatSnapshot({
      engine: fields.engine ?? this.engineLabelForSeat(seatIndex),
      live: false,
      ...fields,
    });
    this.lastThinkBySeat[seatIndex] = snap;
    this.lastCompletedThinkBySeat[seatIndex] = snap;
  }

  async applyEngineMove(params) {
    const prior = this._engineApplyChain;
    let releaseApply;
    this._engineApplyChain = prior.then(
      () =>
        new Promise((resolve) => {
          releaseApply = resolve;
        }),
    );
    await prior;
    try {
      return await this._applyEngineMoveLocked(params);
    } finally {
      releaseApply();
    }
  }

  async _applyEngineMoveLocked({
    action,
    playerType,
    seatIndex,
    requestSeq,
    requestPly,
    requestPlayerToMove,
    requestHistory,
    requestPositionKey,
    connectionEpoch,
    gameGeneration,
    engine,
    validationSignal = null,
    fromPlayNow = false,
  }) {
    const moveKey = toAlgebraic(action);
    const current = this.session.getSnapshot();
    const currentSeat = current.playerToMove - 1;
    const currentPlayerType = this.settings.players[currentSeat];
    const currentPositionKey = this.currentPositionKey();
    const aiSettings =
      this._thinkAiSettings ?? this.settings.playerAiSettings[seatIndex] ?? {};
    const engineEntry = getEngineEntryForPlayer(playerType, aiSettings);

    logAiRequestEvent("AI_FINAL_RESULT_RECEIVED", {
      requestSeq,
      gameGeneration,
      seatIndex,
      sideToMove: requestPlayerToMove,
      engineId: playerType,
      backend: engineEntry?.backend,
      positionKey: requestPositionKey ?? currentPositionKey,
      connectionEpoch:
        engineEntry?.backend === EngineBackendKind.REMOTE_WS
          ? connectionEpoch
          : undefined,
      raw: moveKey,
    });

    const identity = validateEngineResultIdentity({
      engineEntry,
      resultContext: {
        requestSeq,
        gameGeneration,
        positionKey: requestPositionKey ?? currentPositionKey,
        seatIndex,
        sideToMove: requestPlayerToMove,
        engineId: playerType,
        connectionEpoch,
      },
      currentContext: {
        requestSeq: this._moveRequestSeq,
        gameGeneration: this._gameGeneration,
        positionKey: currentPositionKey,
        seatIndex: currentSeat,
        sideToMove: current.playerToMove,
        engineId: currentPlayerType,
        connectionEpoch: engine?.connectionEpoch,
        syncState: engine?.syncState ?? "SYNCED",
      },
    });

    const plyMismatch =
      current.actions.length !== requestPly ||
      current.playerToMove !== requestPlayerToMove;

    if (!identity.ok || plyMismatch) {
      return this._ignoreStaleEngineMove({
        seatIndex,
        playerType,
        requestSeq,
        moveKey,
        reason: plyMismatch ? "stale-ply" : identity.reason,
        sessionActions: current.actions,
      });
    }

    logAiRequestEvent("AI_IDENTITY_VALIDATED", {
      requestSeq,
      ok: true,
      decodedMove: moveKey,
    });

    const siBeforeMove = finalizeSearchInfo(
      this.searchInfoBySeat[seatIndex] ?? {},
    );

    const canonicalLegalMoves = current.validActions.map((a) => toAlgebraic(a));
    const historyTokens = this.session.actions.map((a) => toAlgebraic(a));

    const identityGate = validateEngineMoveBeforeCommit({
      move: moveKey,
      state: canonicalStateFromBoard(this.session.board),
      request: {
        requestSeq,
        gameGeneration,
        positionKey: requestPositionKey ?? currentPositionKey,
        seatIndex,
        sideToMove: requestPlayerToMove,
        connectionEpoch,
      },
      current: {
        requestSeq: this._moveRequestSeq,
        gameGeneration: this._gameGeneration,
        positionKey: currentPositionKey,
        seatIndex: currentSeat,
      },
      canonicalLegalMoves,
    });

    if (!identityGate.ok) {
      const staleGateReasons = new Set([
        "stale-request-seq",
        "stale-game-generation",
        "stale-position",
        "wrong-seat",
        "wrong-side",
      ]);
      const staleLegality =
        staleGateReasons.has(identityGate.reason) ||
        (identityGate.reason === "canonical-illegal" &&
          this._isStaleEngineMoveResponse({
            moveKey,
            requestPly,
            requestHistory,
            requestPositionKey,
            currentPositionKey,
            historyTokens,
            actionsLength: current.actions.length,
            sessionActions: current.actions,
          }));
      if (staleLegality) {
        return this._ignoreStaleEngineMove({
          seatIndex,
          playerType,
          requestSeq,
          moveKey,
          reason: identityGate.reason,
          sessionActions: current.actions,
        });
      }
      logAiRequestEvent("AI_LEGALITY_VALIDATED", {
        requestSeq,
        ok: false,
        reason: identityGate.reason,
        decodedMove: moveKey,
      });
      this._rejectEngineMove(
        seatIndex,
        `REJECTED ${identityGate.reason} (move ${moveKey}, ply ${requestPly + 1})`,
        {
          ply: requestPly + 1,
          playerType,
          budget: describePlayerAiSettings(
            playerType,
            this._thinkAiSettings ??
              this.settings.playerAiSettings[seatIndex] ??
              {},
            this.engineConfigs,
          ),
        },
      );
      return identityGate.reason;
    }

    const legality = await validateMoveLegality({
      move: moveKey,
      canonicalLegalMoves,
      titaniumOracle: this.titaniumLegalityOracle,
      historyTokens,
      positionKey: currentPositionKey,
      signal: validationSignal ?? undefined,
      trustCanonicalOnly: fromPlayNow,
    });

    if (!legality.ok) {
      const staleLegality =
        legality.reason === "canonical-illegal" &&
        this._isStaleEngineMoveResponse({
          moveKey,
          requestPly,
          requestHistory,
          requestPositionKey,
          currentPositionKey,
          historyTokens,
          actionsLength: current.actions.length,
          sessionActions: current.actions,
        });
      if (staleLegality) {
        return this._ignoreStaleEngineMove({
          seatIndex,
          playerType,
          requestSeq,
          moveKey,
          reason: legality.reason,
          sessionActions: current.actions,
        });
      }
      logAiRequestEvent("AI_LEGALITY_VALIDATED", {
        requestSeq,
        ok: false,
        reason: legality.reason,
        decodedMove: moveKey,
      });
      const diagnostic = buildDiagnosticContext({
        session: this.session,
        settings: this.settings,
        request: {
          requestSeq,
          gameGeneration,
          seatIndex,
          connectionEpoch,
        },
        move: moveKey,
        decodedMove: moveKey,
        reason: legality.reason,
        titaniumResult: legality.titanium,
        oracleState: this.legalityOracleState,
      });
      this._lastDiagnostic = diagnostic;
      console.warn("Engine move rejected at gate", legality.reason, diagnostic);
      const oracleMsg =
        legality.reason === "titanium-oracle-unavailable"
          ? `Local legality checker unavailable: ${legality.titanium?.error?.message ?? "unknown error"}`
          : legality.reason === "titanium-position-invalid"
            ? `Titanium rejected position: ${legality.titanium?.error?.message ?? "invalid"}`
            : `REJECTED ${legality.reason}`;
      this._rejectEngineMove(seatIndex, `${oracleMsg}\n\n${diagnostic}`);
      return legality.reason;
    }

    logAiRequestEvent("AI_LEGALITY_VALIDATED", {
      requestSeq,
      ok: true,
      decodedMove: moveKey,
    });

    if (!this.isActionLegal(action)) {
      return this.rejectIllegalEngineMove({
        playerType,
        seatIndex,
        action,
        requestSeq,
        requestPly,
        requestHistory,
        searchInfo: siBeforeMove,
      });
    }

    const posKeyBeforeMove = this.session.actions
      .map((a) => toAlgebraic(a))
      .join("|");
    if (
      isTitaniumEngine(playerType, this.engineConfigs) &&
      siBeforeMove.rootMoves?.length
    ) {
      this.ingestLmrSearchPayload(
        {
          live: false,
          searchDepth: siBeforeMove.searchDepth,
          depthLog: siBeforeMove.depthLog,
          lmrProfile: siBeforeMove.lmrProfile,
          lmrReSearches: siBeforeMove.lmrReSearches,
          rootMoves: siBeforeMove.rootMoves,
        },
        posKeyBeforeMove,
      );
    }

    const completedEngineLabel = this.engineLabelForSeat(seatIndex);
    const budgetHint = describePlayerAiSettings(
      playerType,
      this._thinkAiSettings ?? this.settings.playerAiSettings[seatIndex],
      this.engineConfigs,
    );

    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this.lmrVizLive = null;

    if (isWallAction(action)) {
      const trial = new QuoridorBoard();
      for (const prior of this.session.actions) {
        trial.takeAction(prior);
      }
      trial.takeAction(action);
      const wallInv = assertPostWallInvariants(canonicalStateFromBoard(trial));
      if (!wallInv.ok) {
        const diagnostic = buildDiagnosticContext({
          session: this.session,
          settings: this.settings,
          request: { requestSeq, gameGeneration, seatIndex },
          move: moveKey,
          reason: wallInv.reason,
        });
        this._lastDiagnostic = diagnostic;
        this._rejectEngineMove(
          seatIndex,
          `REJECTED ${wallInv.reason}\n\n${diagnostic}`,
        );
        return wallInv.reason;
      }
    }

    this._suppressSessionNotify = true;
    const applied = this.session.applyAction(action);
    this._suppressSessionNotify = false;
    if (applied) {
      this._clearEngineFailureRecovery(seatIndex);
      this.handleCatPositionChanged();
      const plyNum = this.session.actions.length;
      const si = siBeforeMove;
      // Game clocks use elapsed wall time, including worker and message
      // overhead—not the engine's self-reported search-only duration.
      const wallThink =
        this._thinkStartedAt != null
          ? Math.round(performance.now() - this._thinkStartedAt)
          : resolveThinkMs(si, null);
      const budgetMs = Math.round(
        (this._thinkAiSettings?.wallClockSeconds ?? 0) * 1000,
      );
      const handoffMs = this._thinkAiSettings?.wholeGameHandoffReserveMs ?? 0;
      const usesWholeGameClock = this._seatUsesWholeGameClock(seatIndex);
      // Whole-game bank always deducts real wall time. Move budget only caps
      // WASM movetime — capping the charge too made the clock jump upward.
      const thinkMs = chargeThinkMsForSeat({
        wallThinkMs: wallThink,
        moveBudgetMs: budgetMs,
        handoffMs,
        usesWholeGameClock,
      });
      this._thinkStartedAt = null;
      const moveLabel = this.session.actionToLabel(action);
      this._thinkAiSettings = null;
      this._thinkClockLastDepth = null;
      this.snapshotCompletedThinkSeat(seatIndex, {
        move: moveLabel,
        ply: plyNum,
        depthLog: si.depthLog,
        searchDepth: si.searchDepth,
        whiteDist: si.whiteDist,
        blackDist: si.blackDist,
        rootScore: si.rootScore,
        nodes: si.nodes,
        simulations: si.simulations,
        selectedWorkerNodes: si.selectedWorkerNodes,
        totalNodes: si.totalNodes,
        totalNodesAcrossWorkers: si.totalNodesAcrossWorkers,
        mainThreadNodes: si.mainThreadNodes,
        helperNodes: si.helperNodes,
        nodeSource: si.nodeSource,
        estimatedTotalNodes: false,
        progress: si.progress,
        rootWinRate: si.rootWinRate,
        stoppedBy: si.stoppedBy ?? si.mode ?? "?",
        rootMoves: si.rootMoves,
        lmrProfile: si.lmrProfile,
        lmrReSearches: si.lmrReSearches,
        helperStarts: si.helperStarts,
        helperStartsTotal: si.helperStartsTotal,
        requestedThreads: si.requestedThreads,
        effectiveThreads: si.effectiveThreads,
        threaded: si.threaded,
        fallbackReason: si.fallbackReason,
        engine: completedEngineLabel,
        thinkMs,
      });
      this.moveThinkLog.push({
        ply: plyNum,
        move: moveLabel,
        engine: completedEngineLabel,
        budget: budgetHint,
        stoppedBy: si.stoppedBy ?? si.mode ?? "?",
        nodes: si.nodes ?? si.simulations ?? 0,
        searchDepth: si.searchDepth,
        whiteDist: si.whiteDist,
        blackDist: si.blackDist,
        rootScore: scoreFromDepthLog(si.depthLog, si.rootScore),
        rootWinRate: si.rootWinRate,
        depthLog: si.depthLog ? [...si.depthLog] : [],
        rootMoves: si.rootMoves ? [...si.rootMoves] : [],
        lmrProfile: si.lmrProfile ?? null,
        lmrReSearches: si.lmrReSearches ?? null,
        helperStarts: si.helperStarts ?? null,
        helperStartsTotal: si.helperStartsTotal ?? null,
        requestedThreads: si.requestedThreads ?? null,
        effectiveThreads: si.effectiveThreads ?? null,
        threaded: si.threaded ?? null,
        fallbackReason: si.fallbackReason ?? null,
        thinkMs,
      });
    }
    if (this.session.winner != null || this.session.isDraw) {
      this.maybeSubmitFinishedGame();
      this._cancelActiveAiSearch();
      this.stopAllPonders();
      this.engineErrors[seatIndex] = null;
      this.engineStatus[seatIndex] = "idle";
      this.onChange?.();
      return true;
    }
    if (!applied) {
      return this.rejectIllegalEngineMove({
        playerType,
        seatIndex,
        action,
        requestSeq,
        requestPly,
        requestHistory,
        searchInfo: siBeforeMove,
      });
    }

    this.engineErrors[seatIndex] = null;
    this.engineStatus[seatIndex] = "idle";
    logAiRequestEvent("AI_MOVE_COMMITTED", {
      requestSeq,
      gameGeneration,
      seatIndex,
      decodedMove: moveKey,
    });
    this.onChange?.();
    this.continueAiAfterEngineSync(action, seatIndex);
    logAiRequestEvent("AI_REQUEST_FINALLY", { requestSeq, seatIndex });
    return true;
  }

  maybeRequestAiMove() {
    if (!this.startupConfirmed) {
      return;
    }
    if (this._gameHalted && !this._engineRecoveryActive) {
      this.aiThinking = false;
      return;
    }
    if (this.enginesPaused && !this._engineRecoveryActive) {
      return;
    }
    if (this.replay || this.isFreePlayMode()) {
      this.aiThinking = false;
      return;
    }
    if (this.session.winner != null || this.session.isDraw) {
      this.aiThinking = false;
      this.liveSearch = null;
      return;
    }
    if (this.aiThinking) {
      return;
    }

    this.stopAllPonders();

    const seatIndex = this.session.playerToMove - 1;
    const playerType = this.settings.players[seatIndex];
    if (playerType === PlayerType.Human) {
      this.aiThinking = false;
      this._syncHumanClockTurn();
      return;
    }
    if (this.engineErrors[seatIndex] && !this._engineRecoveryActive) {
      this.aiThinking = false;
      return;
    }

    const engine = this.getEngineForSeat(seatIndex);
    if (!engine) {
      this.aiThinking = false;
      return;
    }

    const requestSnapshot = this.session.getSnapshot();
    const requestSeq = ++this._moveRequestSeq;
    this._activeSearchSeq = requestSeq;
    const requestPly = requestSnapshot.actions.length;
    const requestPlayerToMove = requestSnapshot.playerToMove;
    const requestHistory = this.session.actions
      .map((a) => toAlgebraic(a))
      .join(" ");
    const requestPositionKey = this.currentPositionKey();

    const playerIndex = requestPlayerToMove - 1;
    let aiSettings = this.settings.playerAiSettings[playerIndex];
    if (!aiSettings) {
      aiSettings = defaultPlayerAiSettings(playerType, this.engineConfigs);
      this.settings.playerAiSettings[playerIndex] = aiSettings;
    }
    const engineEntry = getEngineEntryForPlayer(playerType, aiSettings);
    if (!engineEntry) {
      this.aiThinking = false;
      return;
    }

    logAiRequestEvent("AI_REQUEST_ENTER", {
      requestSeq,
      gameGeneration: this._gameGeneration,
      seatIndex,
      sideToMove: requestPlayerToMove,
      engineId: playerType,
      backend: engineEntry.backend,
      positionKey: requestPositionKey,
    });

    this.aiThinking = true;
    this.thinkingPlayerType = playerType;
    this.thinkingSeatIndex = seatIndex;
    // Initialization, thread-pool startup, and position synchronization are
    // free. The Titanium worker starts this clock immediately before go().
    this._thinkStartedAt = null;
    this.engineErrors[seatIndex] = null;
    this.engineStatus[seatIndex] = "searching";
    const clockSearchHint = clockSearchHintFromState({
      positionKey: requestPositionKey,
      seatIndex,
      liveSearch: this.liveSearch,
      searchInfo: this.searchInfoBySeat[seatIndex],
    });
    this.searchInfoBySeat[seatIndex] = { depthLog: [] };
    this.liveSearch = {
      playerType,
      seatIndex,
      playerLabel: this.engineLabelForSeat(seatIndex),
      mode: "searching",
      depthLog: [],
      requestSeq,
      positionKey: requestPositionKey,
    };
    this._syncAnalysisSessionActive();
    this.lmrVizLive = null;
    if (
      this.settings.showLmrVision &&
      isTitaniumEngine(playerType, this.engineConfigs)
    ) {
      this.scheduleLmrRefresh();
    }
    this.onChange?.();

    const gameGeneration = this._gameGeneration;
    const moveHistory = this.session.actions;
    const isFreshGame = moveHistory.length === 0;
    const requestAiSettings = this._managedClockSettings(
      seatIndex,
      aiSettings,
      clockSearchHint,
    );
    this._thinkAiSettings = { ...requestAiSettings };
    this._thinkClockLastDepth = null;
    this._thinkClockLastPv = null;
    this.liveSearch = {
      ...this.liveSearch,
      wholeGameExpectedMovesLeft:
        requestAiSettings.wholeGameExpectedMovesLeft ?? null,
      wholeGameDistanceToWin:
        requestAiSettings.wholeGameDistanceToWin ?? null,
      wholeGameMoveBudgetSeconds: requestAiSettings.wallClockSeconds ?? null,
    };
    if (this._seatUsesWholeGameClock(seatIndex)) {
      const remMs = Math.round(
        (requestAiSettings.wholeGameRemainingSeconds ?? 0) * 1000,
      );
      const budgetMs = Math.round(
        (requestAiSettings.wallClockSeconds ?? 0) * 1000,
      );
      if (remMs <= 0 && budgetMs <= 0) {
        this._flagEngineOnTime(seatIndex);
        return;
      }
    }

    if (this._activeAiAbort) {
      this._activeAiAbort.abort();
    }
    const abortController = new AbortController();
    this._activeAiAbort = abortController;
    const capturedSignal = abortController.signal;

    logAiRequestEvent("AI_CONTROLLER_FOUND", {
      requestSeq,
      engineId: playerType,
      backend: engineEntry.backend,
    });
    logAiRequestEvent("AI_BACKEND_SELECTED", {
      requestSeq,
      backend: engineEntry.backend,
    });
    logAiRequestEvent("AI_REQUEST_STARTED", {
      requestSeq,
      positionKey: requestPositionKey,
    });

    engine.onBestMove = (action, _raw, meta) =>
      resolveOnBestMoveResult(
        engine,
        this.applyEngineMove({
          action,
          playerType,
          seatIndex,
          requestSeq,
          requestPly,
          requestPlayerToMove,
          requestHistory,
          requestPositionKey,
          connectionEpoch: meta?.connectionEpoch,
          gameGeneration,
          engine,
        }).finally(() => {
          if (this._activeAiAbort === abortController) {
            this._activeAiAbort = null;
          }
        }),
      );

    engine.onError = (err) => {
      if (gameGeneration !== this._gameGeneration) {
        return;
      }
      if (
        requestSeq !== this._moveRequestSeq ||
        this.thinkingSeatIndex !== seatIndex
      ) {
        return;
      }
      if (isAbortError(err)) {
        return;
      }
      this.recordEngineFailure(playerType, {
        ply: requestPly + 1,
        error: err,
        budget: describePlayerAiSettings(
          playerType,
          this._thinkAiSettings ?? aiSettings,
          this.engineConfigs,
        ),
      });
      this.onChange?.();
    };

    void requestEngineMove({
      engineEntry,
      controller: engine,
      request: {
        history: moveHistory,
        sideToMove: requestPlayerToMove,
        aiSettings: requestAiSettings,
        signal: capturedSignal,
        gameSnapshot: this.session.getEngineSnapshot(),
        isFreshGame,
        positionKey: requestPositionKey,
        requestSeq,
        gameGeneration,
        onSearchStart: () => {
          if (
            gameGeneration === this._gameGeneration &&
            requestSeq === this._moveRequestSeq &&
            this.aiThinking &&
            this.thinkingSeatIndex === seatIndex &&
            this._thinkStartedAt == null
          ) {
            this._thinkStartedAt = performance.now();
            this._startClockTicker();
            this.onChange?.();
          }
        },
      },
    }).catch((err) => {
      if (capturedSignal.aborted || isAbortError(err)) {
        return;
      }
      const stillThisSeat =
        gameGeneration === this._gameGeneration &&
        requestSeq === this._moveRequestSeq &&
        this.thinkingSeatIndex === seatIndex;
      if (stillThisSeat) {
        engine.onError?.(err);
        return;
      }
      if (
        gameGeneration === this._gameGeneration &&
        this.session.playerToMove - 1 === seatIndex &&
        playerType !== PlayerType.Human &&
        !this.engineErrors[seatIndex]
      ) {
        this.recordEngineFailure(playerType, {
          ply: requestPly + 1,
          error: err,
          budget: describePlayerAiSettings(
            playerType,
            this._thinkAiSettings ?? aiSettings,
            this.engineConfigs,
          ),
        });
        this.onChange?.();
      }
    });
  }

  // ── New public API ────────────────────────────────────────────────────────

  /**
   * Start a new game with the given players and strength settings.
   */
  newGameWithPlayers({ players, playerAiSettings } = {}) {
    if (players && players.length === 2) {
      for (let seat = 0; seat < 2; seat++) {
        const playerType = normalizePlayerType(players[seat]);
        this.settings.players[seat] = playerType;
        if (playerAiSettings?.[seat]) {
          this.settings.playerAiSettings[seat] = Object.assign(
            {},
            playerAiSettings[seat],
          );
          const memory = this.settings.playerAiSettingsMemory[seat] || {};
          memory[playerType] = Object.assign({}, playerAiSettings[seat]);
          this.settings.playerAiSettingsMemory[seat] = memory;
        } else {
          this.ensurePlayerAiSettingsSlot(seat + 1, playerType);
        }
      }
    }
    try {
      this.assertLegalityOracleReady(this.settings.players);
    } catch (error) {
      this.engineErrors = {
        0: error.message,
        1: error.message,
      };
      this.onChange?.();
      return;
    }
    this.confirmStartup();
    this.persistPlaySettings();
    this.newGame();
  }

  /**
   * Change players mid-game without resetting the board position.
   */
  changePlayers({ players, playerAiSettings } = {}) {
    if (!players || !players.length) return;
    this._cancelActiveAiSearch();
    for (let seat = 0; seat < 2; seat++) {
      const playerType = normalizePlayerType(
        players[seat] || this.settings.players[seat],
      );
      const prevType = this.settings.players[seat];
      const prevAi = { ...(this.settings.playerAiSettings[seat] ?? {}) };
      this.settings.players[seat] = playerType;
      if (prevType !== playerType) {
        this._moveRequestSeq += 1;
        this.destroyEngineForSeat(seat);
      }
      if (playerAiSettings?.[seat]) {
        this.settings.playerAiSettings[seat] = Object.assign(
          {},
          playerAiSettings[seat],
        );
        const memory = this.settings.playerAiSettingsMemory[seat] || {};
        memory[playerType] = Object.assign({}, playerAiSettings[seat]);
        this.settings.playerAiSettingsMemory[seat] = memory;
      } else {
        this.ensurePlayerAiSettingsSlot(seat + 1, playerType);
      }
      const nextAi = this.settings.playerAiSettings[seat] ?? {};
      if (
        prevType === playerType &&
        playerType !== PlayerType.Human &&
        this._aiSettingsNeedSessionReset(prevAi, nextAi, playerType)
      ) {
        const engine = this.engines.get(this.engineSeatKey(seat));
        engine?.resetConnection?.();
      }
    }
    this._resumeAfterTimeSettingsChange();
    this.persistPlaySettings();
    this.onChange && this.onChange();
    this.maybeRequestAiMove();
  }

  /**
   * @deprecated use undo() — kept for callers that expected the old name.
   */
  undoWithPause() {
    this.undo();
  }

  /**
   * Stop current search and play the best move found so far (Stockfish-style: clock expired).
   */
  playNow() {
    if (this._playNowLock || !this.aiThinking) return;
    const seatIndex = this.thinkingSeatIndex;
    if (seatIndex == null) return;

    const snapshot = this.session.getSnapshot();
    const liveSearchSnap = this.liveSearch
      ? {
          ...this.liveSearch,
          depthLog: [...(this.liveSearch.depthLog ?? [])],
        }
      : null;
    const validKeys = new Set(
      snapshot.validActions.map((mv) => toAlgebraic(mv)),
    );

    const stateForCheck = {
      aiThinking: true,
      liveSearch: liveSearchSnap,
      thinkingSeatIndex: seatIndex,
      winner: snapshot.winner,
      isDraw: snapshot.isDraw,
      playerToMove: snapshot.playerToMove,
      settings: this.settings,
      actions: snapshot.actions,
      validActions: snapshot.validActions,
      searchGeneration: this._activeSearchSeq,
    };

    let bestAlgebraic = resolveLiveBestMoveKey(stateForCheck);
    if (!bestAlgebraic) {
      const searchInfo = this.searchInfoBySeat[seatIndex] ?? {};
      const fallback = pvFirstMoveFromLiveSearch({
        ...(liveSearchSnap ?? {}),
        depthLog: liveSearchSnap?.depthLog ?? searchInfo.depthLog ?? [],
        rootMoves: liveSearchSnap?.rootMoves ?? searchInfo.rootMoves ?? [],
        pv: liveSearchSnap?.pv,
      });
      if (fallback && validKeys.has(fallback)) {
        bestAlgebraic = fallback;
      }
    }
    if (!bestAlgebraic) return;

    let action;
    try {
      action = parseAlgebraic(bestAlgebraic);
    } catch {
      return;
    }

    if (!validKeys.has(bestAlgebraic)) return;

    const playerType = this.settings.players[seatIndex];
    const requestPly = snapshot.actions.length;
    const requestPlayerToMove = snapshot.playerToMove;
    const requestHistory = snapshot.actions
      .map((a) => toAlgebraic(a))
      .join(" ");
    const requestPositionKey = this.currentPositionKey();
    const gameGeneration = this._gameGeneration;
    const engine = this.getEngineForSeat(seatIndex);
    const requestSeq = this._moveRequestSeq;

    this._playNowLock = true;
    void (async () => {
      try {
        if (this._activeAiAbort && this.thinkingSeatIndex === seatIndex) {
          this._activeAiAbort.abort();
          this._activeAiAbort = null;
        }
        await this._stopSeatEngineSearch(seatIndex);

        if (engine?.echoCommittedMove) {
          try {
            await engine.echoCommittedMove(
              action,
              requestPositionKey,
              requestPly + 1,
              [...snapshot.actions, action],
            );
          } catch (err) {
            console.warn(
              "Play now engine echo failed; next search will resync",
              err,
            );
          }
        } else if (engine?.makeMoves) {
          engine.makeMoves([action]);
        }

        const si = this.searchInfoBySeat[seatIndex] ?? {};
        this.lastThinkBySeat[seatIndex] = buildThinkSeatSnapshot({
          engine: this.engineLabelForSeat(seatIndex),
          live: false,
          stoppedBy: "time",
          depthLog: si.depthLog ?? [],
          searchDepth: si.searchDepth,
          whiteDist: si.whiteDist,
          blackDist: si.blackDist,
          rootScore: si.rootScore,
          nodes: si.nodes,
          simulations: si.simulations,
        });
        this.searchInfoBySeat[seatIndex] = { ...si, stoppedBy: "time" };
        this.aiThinking = false;
        this.thinkingPlayerType = null;
        this.thinkingSeatIndex = null;
        this.liveSearch = null;
        this.engineStatus[seatIndex] = "idle";
        this.onChange?.();

        const result = await this.applyEngineMove({
          action,
          playerType,
          seatIndex,
          requestSeq,
          requestPly,
          requestPlayerToMove,
          requestHistory,
          requestPositionKey,
          gameGeneration,
          engine,
          fromPlayNow: true,
        });

        if (result !== true) {
          const reason =
            typeof result === "string" ? result : "play-now-failed";
          this.engineErrors[seatIndex] =
            `Play now failed (${reason}) — search cancelled`;
          this.engineStatus[seatIndex] = "error";
          this.onChange?.();
          queueMicrotask(() => this.maybeRequestAiMove());
        }
      } finally {
        this._playNowLock = false;
      }
    })();
  }

  /**
   * Parse and load a game from space-separated algebraic notation.
   * Returns { error: string } on failure, null on success.
   */
  loadNotationString(text) {
    if (!text || !text.trim()) return null;
    const tokens = tokenizeAlgebraicNotation(text);
    if (tokens.length === 0) {
      return { error: "No moves found in notation" };
    }
    const actions = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      try {
        const action = parseAlgebraic(token);
        if (!action) return { error: "Could not parse move: " + token };
        actions.push(action);
      } catch (err) {
        return {
          error:
            'Invalid move "' +
            token +
            '": ' +
            (err && err.message ? err.message : err),
        };
      }
    }
    try {
      this._gameGeneration += 1;
      this._moveRequestSeq += 1;
      this._cancelActiveAiSearch();
      this.destroyAllEngines();
      this.aiThinking = false;
      this.thinkingPlayerType = null;
      this.thinkingSeatIndex = null;
      this.liveSearch = null;
      this.engineErrors = {};
      this.engineStatus = {};
      this._resetEngineFailureRecovery();
      this._gameHalted = false;
      this.replay = null;
      this.moveThinkLog = [];
      this.settings.uiMode = "play";
      this._syncAnalysisSessionActive();
      this.session.rebuildFromActions(actions);
      this.handleCatPositionChanged();
      this.confirmStartup();
      this.onChange?.();
      this.maybeRequestAiMove();
      return null;
    } catch (err) {
      return {
        error:
          "Failed to apply moves: " + (err && err.message ? err.message : err),
      };
    }
  }
}
