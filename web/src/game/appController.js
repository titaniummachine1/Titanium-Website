import { GameSession } from './gameSession.js';
import { naiveDistanceEval, parseAlgebraic, isWallAction, QuoridorBoard } from '../lib/gameLogic.js';
import { decodeReplayCode, encodeReplayFromActions } from '../lib/replayCode.js';
import {
  LMR_AGGRESSION_DEFAULT,
  fetchCatSnapshot,
  indexCatWalls,
  prewarmCatSnapshot,
  applyVisionTuning,
  getVisionTuning,
} from '../lib/catHeatmap.js';
import { buildLmrViz, fetchLmrSnapshot } from '../lib/lmrHeatmap.js';
import { toAlgebraic } from '../lib/gameLogic.js';
import { EngineClient } from '../lib/engineClient.js';
import { GorisansonEngineClient } from '../lib/localMctsEngine.js';
import { TitaniumEngineClient } from '../lib/titaniumRustClient.js';
import { TitaniumWasmEngineClient } from '../lib/titaniumWasmClient.js';
import { resolveOnBestMoveResult } from '../lib/onBestMoveResult.js';
import { positionKeyFromActions, resolveLiveBestMoveKey, pvFirstMoveFromLiveSearch, coalesceRootMoves } from '../lib/liveBestMove.js';
import { positionKeyFromHistory as historyPositionKey, SyncState } from '../lib/remoteSync.js';
import {
  buildDiagnosticContext,
  validateEngineMoveBeforeCommit,
  canonicalStateFromBoard,
  canonicalPositionKeyFromBoard,
  assertPostWallInvariants,
} from '../lib/canonicalState.js';
import { TitaniumLegalityOracle } from '../lib/titaniumLegalityOracle.js';
import { createTitaniumLegalityRuntime } from '../lib/titaniumLegalityRuntime.js';
import { validateMoveLegality } from '../lib/validateMoveLegality.js';
import { isAbortError } from '../lib/engineAbort.js';
import { resolveDisplayNodes } from '../lib/searchNodes.js';
import { getEngineEntryForPlayer } from '../engines/engineRegistry.js';
import { requestEngineMove } from '../engines/requestEngineMove.js';
import { validateEngineResultIdentity } from '../engines/validateEngineResultIdentity.js';
import { logAiRequestEvent } from '../engines/aiRequestLog.js';
import { EngineBackendKind } from '../engines/engineBackend.js';
import {
  finishedGamePayload,
  finishedGameSignature,
  submitFinishedGame,
} from '../lib/trainingSubmit.js';
import { AceV10JsEngineClient } from '../lib/aceV10JsEngine.js';
import { AceV13JsEngineClient } from '../lib/aceV13JsEngine.js';
import { AceRustWasmEngineClient } from '../lib/aceRustWasmClient.js';
import {
  resolveAceTier,
  aceDisplayName,
  clampAceV10Tier,
  migrateAceV10Strength,
  defaultAceCompareAiSettings,
  aceGenerationFromPlayerType,
} from '../lib/aceTier.js';
import { QuoridorV3EngineClient } from '../lib/quoridorV3Engine.js';
import { ZeroInkEngineClient } from '../lib/zeroInkEngine.js';
import { PlayerType, StrengthLevel, TimeToMove } from '../lib/engineConfig.js';
import {
  STRENGTH_LEVEL_PRESETS,
  TIME_TO_MOVE_PRESETS,
  getAllEngineConfigs,
  getPlayerOptionGroups,
  flattenPlayerOptions,
  describeTimeBudget,
  describeActiveSearchInfo,
} from '../lib/playerRegistry.js';

const DEFAULT_CAT_VISION_SETTINGS = Object.freeze({
  showSquares: true,
  showWalls: true,
  squareOpacity: 1,
  wallOpacity: 1,
});

function mergeDepthLogs(existing, incoming) {
  const byDepth = new Map((existing ?? []).map((entry) => [entry.depth, entry]));
  for (const entry of incoming ?? []) {
    byDepth.set(entry.depth, entry);
  }
  return [...byDepth.values()].sort((a, b) => a.depth - b.depth);
}

function deepestDepthEntry(depthLog) {
  if (!depthLog?.length) {
    return null;
  }
  return depthLog.reduce((best, entry) => (entry.depth > (best?.depth ?? 0) ? entry : best));
}

function scoreFromDepthLog(depthLog, rootScore) {
  const deep = deepestDepthEntry(depthLog);
  if (deep?.score != null && Number.isFinite(Number(deep.score))) {
    return deep.score;
  }
  return rootScore ?? null;
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
    rootScore: scoreFromDepthLog(depthLog, info?.rootScore),
    pv: deep?.pv ?? info?.pv ?? '',
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
    pv: deep?.pv ?? '',
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
    stoppedBy: stoppedBy ?? (live ? 'searching' : '?'),
    rootMoves: rootMoves ? [...rootMoves] : [],
    lmrProfile: lmrProfile ?? null,
    lmrReSearches: lmrReSearches ?? null,
    helperStarts: helperStarts ?? null,
    helperStartsTotal: helperStartsTotal ?? null,
    requestedThreads: requestedThreads ?? null,
    effectiveThreads: effectiveThreads ?? null,
    threaded: threaded ?? null,
    depthLog: depthLog ? [...depthLog] : [],
    thinkMs: thinkMs ?? null,
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
  TITANIUM_NET_HARD,
  migrateTitaniumNet,
} from '../lib/timeControl.js';
import { playerColorName } from '../lib/playerColors.js';
import { ponderCandidateSlots } from '../lib/enginePonder.js';
import {
  loadPersistedPlaySettings,
  savePersistedPlaySettings,
} from '../lib/persistedPlaySettings.js';
import { hasNativeTitaniumLazySmp } from '../lib/titaniumRuntime.js';

const HAS_NATIVE_TITANIUM_LAZY_SMP = hasNativeTitaniumLazySmp();

function isSavedSettingsValid(playerType, saved, engineConfigs) {
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

    const titaniumDefault = defaultPlayerAiSettings(PlayerType.TitaniumV16, this.engineConfigs);
    const persisted = loadPersistedPlaySettings();
    const playDefaults = {
      players: [PlayerType.Human, PlayerType.TitaniumV16],
      playerAiSettings: [null, { ...titaniumDefault }],
      playerAiSettingsMemory: [{}, {}],
    };
    const restored = persisted
      ? {
          players: persisted.players.map((p) => normalizePlayerType(p)),
          playerAiSettings: persisted.playerAiSettings ?? [{}, {}],
          playerAiSettingsMemory: persisted.playerAiSettingsMemory ?? [{}, {}],
        }
      : playDefaults;
    const visionTuning = getVisionTuning();
    this.settings = {
      ...restored,
      rotateBoard: false,
      displayCoordinates: true,
      displayRemainingWalls: true,
      displayEvalBar: true,
      showCatVision: false,
      catVision: { ...DEFAULT_CAT_VISION_SETTINGS },
      showLmrVision: false,
      lmrVisionShallow: true,
      pathBiasPercent: visionTuning.pathBiasPercent,
      lmrAggressionPercent: visionTuning.lmrAggressionPercent,
      showBestMoveHint: true,
      uiMode: 'play',
    };
    for (let seat = 0; seat < 2; seat++) {
      const playerType = this.settings.players[seat];
      if (playerType !== PlayerType.Human) {
        this.ensurePlayerAiSettingsSlot(seat + 1, playerType);
      }
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
    this.settingsChangelog = [];
    this.initialBudgetHint = null;
    this.lastThinkBySeat = [null, null];
    /** Frozen per-seat card after each played move — kept while opponent thinks. */
    this.lastCompletedThinkBySeat = [null, null];
    this.eval = { score: 0.5, p1: 0.5, pv: [] };
    this.aiThinking = false;
    this.liveSearch = null;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this._moveRequestSeq = 0;
    this._gameGeneration = 0;
    this._thinkAiSettings = null;
    this._illegalRetriesByPly = {};
    this._maxIllegalRetries = 2;
    /** Skip onSessionChange → onChange while applyEngineMove is mid-apply (snapshot not ready). */
    this._suppressSessionNotify = false;
    this._activeSearchSeq = 0;
    this.enginesPaused = false;
    this._playNowLock = false;
    /** Serialize engine commits — concurrent applyEngineMove must not double-apply. */
    this._engineApplyChain = Promise.resolve();
    this._terminalOverlayDismissed = false;
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

  getState() {
    const snapshot = this.session.getSnapshot();
    const distanceEval = naiveDistanceEval(this.session.board);
    const terminal = snapshot.winner != null || snapshot.isDraw;

    return {
      ...snapshot,
      settings: { ...this.settings },
      engineStatus: { ...this.engineStatus },
      engineErrors: { ...this.engineErrors },
      aiThinking: terminal ? false : this.aiThinking,
      liveSearch: terminal ? null : this.liveSearch,
      thinkingPlayerType: terminal ? null : this.thinkingPlayerType,
      thinkingSeatIndex: terminal ? null : this.thinkingSeatIndex,
      eval: {
        p1: distanceEval.p1,
        margin: distanceEval.margin,
        whiteDist: distanceEval.whiteDist,
        blackDist: distanceEval.blackDist,
        pv: this.eval.pv ?? [],
      },
      searchGeneration: this._activeSearchSeq,
      positionKey: this.currentPositionKey(),
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
      activeSearchInfo: this.thinkingSeatIndex != null
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
      enginesPaused: this.enginesPaused,
      replay: this.replay
        ? {
          index: this.replay.index,
          total: this.replay.actions.length,
          code: this.replay.code,
          meta: this.replay.meta,
        }
        : null,
      terminalOverlayDismissed: this._terminalOverlayDismissed,
      legalityOracleState: { ...this.legalityOracleState },
      playReplayCode:
        this.session.actions.length > 0 && this.settings.uiMode === 'play'
          ? encodeReplayFromActions(
            this.session.actions,
            this.session.winner
              ? {
                winner: this.session.winner === 1 ? 'white' : 'black',
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
    this.settings.players = this.settings.players.map((p) => normalizePlayerType(p));
  }

  persistPlaySettings() {
    if (this.settings.uiMode !== 'play') {
      return;
    }
    savePersistedPlaySettings(this.settings);
  }

  restorePersistedPlayMatchup() {
    const persisted = loadPersistedPlaySettings();
    const titaniumDefault = defaultPlayerAiSettings(PlayerType.TitaniumV16, this.engineConfigs);
    const playDefaults = {
      players: [PlayerType.Human, PlayerType.TitaniumV16],
      playerAiSettings: [null, { ...titaniumDefault }],
      playerAiSettingsMemory: [{}, {}],
    };
    const restored = persisted
      ? {
          players: persisted.players.map((p) => normalizePlayerType(p)),
          playerAiSettings: persisted.playerAiSettings ?? [{}, {}],
          playerAiSettingsMemory: persisted.playerAiSettingsMemory ?? [{}, {}],
        }
      : playDefaults;
    this.settings.players = restored.players;
    this.settings.playerAiSettings = restored.playerAiSettings;
    this.settings.playerAiSettingsMemory = restored.playerAiSettingsMemory;
    for (let seat = 0; seat < 2; seat++) {
      const playerType = this.settings.players[seat];
      if (playerType !== PlayerType.Human) {
        this.ensurePlayerAiSettingsSlot(seat + 1, playerType);
      }
    }
    this.destroyAllEngines();
  }

  applyAnalysisCompareDefaults() {
    const v13Js = defaultPlayerAiSettings(PlayerType.AceV13, this.engineConfigs);
    v13Js.strengthLevel = 0;
    const titaniumDefault = defaultPlayerAiSettings(PlayerType.TitaniumV16, this.engineConfigs);
    this.settings.players = [PlayerType.AceV13, PlayerType.TitaniumV16];
    this.settings.playerAiSettings = [v13Js, titaniumDefault];
    const memory = [{}, {}];
    memory[0][PlayerType.AceV13] = { ...v13Js };
    memory[1][PlayerType.TitaniumV16] = { ...titaniumDefault };
    this.settings.playerAiSettingsMemory = memory;
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

  _abortEngineSearch({ bumpRequestSeq = false, stoppedBy = 'cancelled', seatIndex = null } = {}) {
    const seat = seatIndex ?? this.thinkingSeatIndex;
    if (this._activeAiAbort && (seat == null || this.thinkingSeatIndex === seat)) {
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
      this.engineStatus[seat] = 'idle';
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
    if (this.session.isHumanTurn(this.settings.players) && this.session.actions.length > 0) {
      return 2;
    }
    return 1;
  }

  _finishUndo({ requestAi = false } = {}) {
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
    if (playerType === PlayerType.Human) {
      return;
    }

    const memory = this.settings.playerAiSettingsMemory[index] ?? {};
    let saved = memory[playerType];
    if (saved?.strength != null && saved.timeToMove == null) {
      saved = {
        strengthLevel: StrengthLevel.Alpha,
        timeToMove: saved.strength,
      };
      memory[playerType] = saved;
    }
    if (saved && isSavedSettingsValid(playerType, saved, this.engineConfigs)) {
      if (isTitaniumEngine(playerType, this.engineConfigs) && !saved.titaniumNet) {
        saved = {
          ...saved,
          titaniumNet: migrateTitaniumNet(TITANIUM_NET_HARD),
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
    if (playerType === PlayerType.Human || !aiSettings) {
      return;
    }
    const memory = this.settings.playerAiSettingsMemory[index] ?? {};
    memory[playerType] = { ...aiSettings };
    this.settings.playerAiSettingsMemory[index] = memory;
    this.settings.playerAiSettings[index] = { ...aiSettings };
    this.persistPlaySettings();
  }

  recordSettingsChange(playerNum, field, from, to) {
    if (this.settings.uiMode !== 'play' || this.session.winner != null || this.session.isDraw || from === to) {
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
      titaniumNet: migrateTitaniumNet(current?.titaniumNet ?? TITANIUM_NET_HARD),
      cores,
      hasNativeTitaniumLazySmp,
      strengthLevel: isAceFamily(playerType, this.engineConfigs)
        ? clampAceV10Tier(migrateAceV10Strength(current?.strengthLevel ?? 0), playerType)
        : (current?.strengthLevel ?? StrengthLevel.Alpha),
      timeToMove: current?.timeToMove ?? TimeToMove.Short,
      wallClockSeconds: current?.wallClockSeconds ?? WALL_CLOCK_RANGE.defaultSeconds,
      visitsBudget: clampVisits(current?.visitsBudget ?? LOCAL_VISITS_RANGE.default),
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
    return [this.getPlayerAiSettingsUiForSlot(1), this.getPlayerAiSettingsUiForSlot(2)];
  }

  _aiSettingsNeedSessionReset(prevAi, nextAi, playerType) {
    if (isTitaniumEngine(playerType, this.engineConfigs)) {
      return (
        prevAi.wallClockSeconds !== nextAi.wallClockSeconds ||
        prevAi.titaniumNet !== nextAi.titaniumNet ||
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
        prevAi.visitsBudget !== nextAi.visitsBudget
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
    this.persistPlaySettings();
    this.onChange?.();
    const isActiveSeat =
      this.session.playerToMove - 1 === seatIndex &&
      this.settings.players[seatIndex] !== PlayerType.Human;
    if (isActiveSeat && !this.session.winner && !this.session.isDraw && !this.replay) {
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
    this.recordSettingsChange(playerNum, 'strength', current.strengthLevel, next);
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
    this.recordSettingsChange(playerNum, 'timeToMove', current.timeToMove, next);
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
    this.recordSettingsChange(playerNum, 'wallClockSeconds', current.wallClockSeconds, next);
    this.rememberPlayerAiSettings(playerNum, {
      ...current,
      wallClockSeconds: next,
    });
    if (!silent) {
      this._afterLivePlayerSettingChange(playerNum);
    }
  }

  setPlayerVisitsBudget(playerNum, visits, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (!isLocalMctsEngine(playerType, this.engineConfigs)) {
      return;
    }
    const current = this.settings.playerAiSettings[index] ?? {};
    const next = clampVisits(visits);
    this.recordSettingsChange(playerNum, 'visitsBudget', current.visitsBudget, next);
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
    this.recordSettingsChange(playerNum, 'cores', resolveCores(current), next);
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
    const next = typeof force === 'boolean' ? force : !this.enginesPaused;
    if (next === this.enginesPaused) {
      return;
    }
    this.enginesPaused = next;
    if (this.enginesPaused && this.aiThinking) {
      this._cancelActiveAiSearch();
    }
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
    const next = mode === 'cat' || mode === 'lmr' ? mode : 'off';
    if (next === 'cat') {
      this.toggleCatVision(true);
      return;
    }
    if (next === 'lmr') {
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
    return String(entry?.engine ?? '').toLowerCase().includes('titanium');
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
      source: payload.live ? 'search-live' : 'search',
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
      this.session.actions.length === positionKey.split('|').filter(Boolean).length;
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
    if (!this.settings.showLmrVision || this.settings.uiMode === 'replay') {
      return;
    }
    this.refreshLmrShallow();
  }

  async refreshLmrShallow() {
    const posKey = this.lmrPositionKey();
    const timeSec = this.lmrTimeSecForPosition();
    const idDepth = this.lmrPlanDepthHint();
    const lmrAggressionPercent = this.settings.lmrAggressionPercent ?? LMR_AGGRESSION_DEFAULT;
    const pathBiasPercent = this.settings.pathBiasPercent ?? 0;
    const fetchKey = `${posKey}|${timeSec}|d${idDepth}|pb${pathBiasPercent}|la${lmrAggressionPercent}`;
    if (fetchKey === this._lmrShallowKey && this.lmrShallowByPosition.has(posKey)) {
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
      const shallow = buildLmrViz({ ...data, source: 'shallow' });
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
    return this.session.actions.map((action) => toAlgebraic(action)).join('|');
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

  /** Cold-start WASM workers before the first AI move so info/PV telemetry is live immediately. */
  async prewarmTitaniumWasmEngines() {
    const tasks = [];
    for (let seat = 0; seat < this.settings.players.length; seat++) {
      const playerType = this.settings.players[seat];
      if (!isTitaniumEngine(playerType, this.engineConfigs)) {
        continue;
      }
      const engine = this.getEngineForSeat(seat);
      if (typeof engine?.prewarm === 'function') {
        const ai = this.settings.playerAiSettings[seat] ?? {};
        const mode = resolveTitaniumEngineMode(ai, playerType, this.engineConfigs);
        const catLmrCeiling =
          playerType === PlayerType.TitaniumV16 ? resolveCatLmrCeiling(ai) : 800;
        const threads = resolveCores(ai);
        tasks.push(
          engine.prewarm(mode, catLmrCeiling, threads).catch((err) => {
            console.warn(`Titanium WASM prewarm failed for seat ${seat}`, err);
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
    const message = this.legalityOracleState.error?.message
      ?? 'Titanium legality oracle is not ready';
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
    if (!this.settings.showCatVision || this.settings.uiMode === 'replay') {
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
    const titaniumSeat = (i) => isTitaniumEngine(players[i], this.engineConfigs);
    const localAdversarySeat = (i) =>
      players[i] === PlayerType.QuoridorV3 || players[i] === PlayerType.GorisansonMCTS;
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
    this.settings.uiMode = 'play';
    this.eval = { score: 0.5, p1: 0.5, pv: [] };
    this._terminalOverlayDismissed = false;
    this.session.reset();
    this.catViz = null;
    this._lmrDisplayViz = null;
    this.handleCatPositionChanged();
    this.onChange?.();
    this.maybeRequestAiMove();
  }

  isFreePlayMode() {
    return this.settings.uiMode === 'analysis';
  }

  setUiMode(mode) {
    const prevMode = this.settings.uiMode;
    this.settings.uiMode = mode;
    if (mode === 'play' && prevMode !== 'play') {
      this.restorePersistedPlayMatchup();
    }
    if (mode === 'analysis') {
      this._moveRequestSeq += 1;
      this.replay = null;
      this.aiThinking = false;
      this.thinkingPlayerType = null;
      this.liveSearch = null;
      if (prevMode !== 'analysis') {
        this.applyAnalysisCompareDefaults();
      }
    }
    this.scheduleCatRefresh();
    this.onChange?.();
  }

  loadAnalysisPosition(code) {
    this._moveRequestSeq += 1;
    this._abortEngineSearch({ bumpRequestSeq: false });
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
          ? reachableRaw.map((v) => v === 1 || v === true || v === '1')
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
        searchableWallCount: walls.filter((w) => w.search ?? !(w.skip ?? w.pruned)).length,
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
    this.replay = null;
    this.settings.uiMode = 'play';
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.liveSearch = null;
    this.moveThinkLog = [];
    this.onChange?.();
    this.maybeRequestAiMove();
  }

  loadReplay(code) {
    this._moveRequestSeq += 1;
    this._abortEngineSearch({ bumpRequestSeq: false });
    const trimmed = code.trim();
    const { actions, meta, algebraic } = decodeReplayCode(trimmed);
    this.replay = {
      actions,
      algebraic,
      index: actions.length,
      code: trimmed.startsWith('tq1') ? trimmed : encodeReplayFromActions(actions, meta),
      meta,
    };
    this.settings.uiMode = 'replay';
    this.aiThinking = false;
    this.liveSearch = null;
    this.engineErrors = {};
    for (const engine of this.engines.values()) {
      engine.resetConnection();
    }
    this.applyReplayIndex();
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
    this.replay.index = Math.max(0, Math.min(index, this.replay.actions.length));
    this.applyReplayIndex();
    this.onChange?.();
  }

  replayStep(delta) {
    if (!this.replay) {
      return;
    }
    this.setReplayIndex(this.replay.index + delta);
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
    if (!freePlay && !manualWhilePaused && !this.session.isHumanTurn(this.settings.players)) {
      return;
    }

    const applied = this.session.applyAction(action);
    if (!applied) {
      return;
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
    void this.syncRemoteEnginesAfterMove(action, actingSeat)
      .catch(async (err) => {
        if (gameGeneration !== this._gameGeneration) {
          return;
        }
        console.error('Engine position sync failed after ply', err);
        const positionKey = this.currentPositionKey();
        const moveHistory = this.session.actions;
        const diagnostic = buildDiagnosticContext({
          session: this.session,
          settings: this.settings,
          reason: 'remote-sync-failure',
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
          if (!engineEntry || engineEntry.backend !== EngineBackendKind.REMOTE_WS) {
            continue;
          }
          this.engineErrors[seat] = message;
          this.engineStatus[seat] = 'error';
          const engine = this.getEngineForSeat(seat);
          if (engine?.markDesynced) {
            engine.markDesynced(message);
            recoveries.push(
              engine.recoverFromDesync({
                moveHistory,
                gameSnapshot: this.session.getEngineSnapshot(),
                isFreshGame: moveHistory.length === 0,
                positionKey,
              }).catch((resyncErr) => {
                console.error('Remote resync failed', resyncErr);
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
              this.engineStatus[seat] = 'idle';
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
    if (tier.kind.endsWith('-js')) {
      if (generation === 13) return new AceV13JsEngineClient(config);
      return new AceV10JsEngineClient(config);
    }
    return new AceRustWasmEngineClient({ ...config, engineMode: tier.engineMode });
  }

  createEngineClient(config, seatIndex = 0) {
    if (config.kind === 'local') {
      return new GorisansonEngineClient(config);
    }
    if (config.kind === 'quoridor-v3') {
      return new QuoridorV3EngineClient(config);
    }
    if (config.kind === 'zeroink') {
      return new ZeroInkEngineClient(config);
    }
    if (
      config.kind === 'ace-v8-family' ||
      config.kind === 'ace-v10-family' ||
      config.kind === 'ace-v13-family'
    ) {
      return this.createAceClient(config, seatIndex);
    }
    if (config.kind === 'titanium') {
      const ai = this.settings.playerAiSettings[seatIndex] ?? {};
      const playerType = this.settings.players[seatIndex];
      const engineMode = resolveTitaniumEngineMode(ai, playerType, this.engineConfigs);
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
      const backend = tier.kind.endsWith('-js') ? 'js' : 'wasm';
      return `${playerType}|${backend}|${tier.engineMode}`;
    }
    if (isTitaniumEngine(playerType, this.engineConfigs)) {
      const backend = HAS_NATIVE_TITANIUM_LAZY_SMP ? 'native' : 'wasm';
      const mode = resolveTitaniumEngineMode(ai, playerType, this.engineConfigs);
      const cat =
        playerType === PlayerType.TitaniumV16
          ? `|cat${resolveCatLmrCeiling(ai)}`
          : '';
      const cores = `|c${resolveCores(ai)}`;
      return `${playerType}|${backend}|${mode}${cat}${cores}`;
    }
    const kind = getEngineConfig(playerType, this.engineConfigs)?.kind ?? playerType;
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
    if (cached && (cached.config?.key !== config.key || cached._bindKey !== bindKey)) {
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
        if (info.thinking) {
          if (!this.aiThinking || this.thinkingSeatIndex !== seatIndex) {
            return;
          }
          const si = this.searchInfoBySeat[seatIndex];
          const liveDepthLog = si.depthLog ?? [];
          const deepLive = deepestDepthEntry(liveDepthLog);
          const liveRootScore = scoreFromDepthLog(liveDepthLog, info.rootScore ?? this.liveSearch?.rootScore);
          const livePv = deepLive?.pv ?? info.pv ?? this.liveSearch?.pv ?? '';
          this.liveSearch = {
            playerType,
            seatIndex,
            playerLabel: this.engineLabelForSeat(seatIndex),
            requestSeq: this._activeSearchSeq,
            positionKey: this.currentPositionKey(),
            pv: livePv,
            simulations: si.simulations ?? 0,
            nodes: si.nodes ?? 0,
            selectedWorkerNodes: info.selectedWorkerNodes ?? si.selectedWorkerNodes,
            totalNodesAcrossWorkers: info.totalNodesAcrossWorkers ?? si.totalNodesAcrossWorkers,
            nodeSource: info.nodeSource ?? si.nodeSource,
            estimatedTotalNodes: info.estimatedTotalNodes ?? si.estimatedTotalNodes,
            progress: info.progress,
            mode:
              info.mode ??
              info.stoppedBy ??
              (isTitaniumEngine(playerType, this.engineConfigs)
                ? 'minimax'
                : isAceFamily(playerType, this.engineConfigs)
                  ? resolveAceTier(
                      this.settings.playerAiSettings[seatIndex]?.strengthLevel,
                      playerType,
                    ).engineMode
                  : 'mcts'),
            searchDepth: info.searchDepth ?? this.liveSearch?.searchDepth,
            depthLog: liveDepthLog,
            rootWinRate:
              info.rootWinRate != null ? info.rootWinRate : this.liveSearch?.rootWinRate,
            whiteDist: info.whiteDist ?? this.liveSearch?.whiteDist,
            blackDist: info.blackDist ?? this.liveSearch?.blackDist,
            rootMoves: siMerged?.rootMoves ?? this.liveSearch?.rootMoves,
            rootMove: info.rootMove ?? this.liveSearch?.rootMove,
            lmrProfile: info.lmrProfile ?? this.liveSearch?.lmrProfile,
            lmrReSearches: info.lmrReSearches ?? this.liveSearch?.lmrReSearches,
            helperStarts: info.helperStarts ?? this.liveSearch?.helperStarts,
            helperStartsTotal: info.helperStartsTotal ?? this.liveSearch?.helperStartsTotal,
            requestedThreads: info.requestedThreads ?? this.liveSearch?.requestedThreads,
            effectiveThreads: info.effectiveThreads ?? this.liveSearch?.effectiveThreads,
            threaded: info.threaded ?? this.liveSearch?.threaded,
            rootScore: liveRootScore,
            elapsedMs: info.elapsedMs ?? this.liveSearch?.elapsedMs,
            rolloutVerdict: info.rolloutVerdict ?? this.liveSearch?.rolloutVerdict,
            rolloutVisits: info.rolloutVisits ?? this.liveSearch?.rolloutVisits,
            rolloutWins: info.rolloutWins ?? this.liveSearch?.rolloutWins,
          };
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
                lmrReSearches: info.lmrReSearches ?? this.liveSearch.lmrReSearches,
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
        if (info.progress !== undefined && info.p1 === undefined && !info.pv && !info.stoppedBy) {
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

  /** Keep remote engine clients in sync after every ply (incremental makemove echo). */
  async syncRemoteEnginesAfterMove(action, _actingSeat = null) {
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
      if (!engineEntry || engineEntry.backend !== EngineBackendKind.REMOTE_WS) {
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
      return 'Human';
    }
    if (isAceFamily(playerType, this.engineConfigs)) {
      const strength = this.settings.playerAiSettings[seatIndex]?.strengthLevel ?? 0;
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
      console.debug?.('finished-game training submit skipped', err);
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
    return this.session.getSnapshot().validActions.some(
      (mv) => this.session.actionToLabel(mv) === label,
    );
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
    const legal = snapshot.validActions.map((mv) => this.session.actionToLabel(mv));
    const ply = snapshot.actions.length + 1;
    const position = this.session.actions.map((a) => toAlgebraic(a)).join(' ') || '(start)';
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
      reason: rustError ? 'titanium-illegal' : 'canonical-illegal',
    });
    this._lastDiagnostic = diagnostic;

    console.error('Engine produced illegal move', {
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
    this.engineStatus[seatIndex] = 'error';

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
      legalSample: legal.slice(0, 12).join(' '),
      stoppedBy: 'illegal',
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
        stoppedBy: 'retry',
      });
      this.engineErrors[seatIndex] = `${illegalMsg} — retrying (${retries}/${this._maxIllegalRetries})`;
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
      this.onChange?.();
    }
    return false;
  }

  recordEngineFailure(playerType, { ply, error, budget }) {
    if (isAbortError(error)) {
      return;
    }
    const message = error?.message ?? String(error ?? 'Engine error');
    const position = this.session.actions.map((a) => toAlgebraic(a)).join(' ') || '(start)';
    const legal = this.session
      .getSnapshot()
      .validActions.map((mv) => this.session.actionToLabel(mv))
      .slice(0, 24)
      .join(' ');
    const detail = `position="${position}" toMove=${this.session.playerToMove} legalSample=[${legal}]`;
    const failSeat = this.thinkingSeatIndex ?? this.seatIndexForPlayerType(playerType);
    const fullMessage = `${message} | ${detail}`;
    console.error('Engine search failed', {
      playerType,
      ply,
      engine: failSeat >= 0 ? this.engineLabelForSeat(failSeat) : this.engineLabel(playerType),
      message: fullMessage,
      stack: error?.stack,
    });
    if (failSeat >= 0) {
      this.engineErrors[failSeat] = fullMessage;
    }
    if (failSeat >= 0) {
      this.engineStatus[failSeat] = 'error';
    }
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this._thinkStartedAt = null;

    const si = this.searchInfoBySeat[failSeat] ?? {};
    const thinkMs = resolveThinkMs(si, null);
    this.snapshotThinkSeat(failSeat, {
      live: false,
      ply,
      move: null,
      error: fullMessage,
      stoppedBy: 'error',
      engine: failSeat >= 0 ? this.engineLabelForSeat(failSeat) : this.engineLabel(playerType),
      depthLog: si.depthLog,
      searchDepth: si.searchDepth,
      whiteDist: si.whiteDist,
      blackDist: si.blackDist,
      nodes: si.nodes ?? si.simulations,
      simulations: si.simulations ?? si.nodes,
      thinkMs,
    });
    this.moveThinkLog.push({
      ply,
      move: null,
      engine: failSeat >= 0 ? this.engineLabelForSeat(failSeat) : this.engineLabel(playerType),
      budget: budget ?? '',
      error: fullMessage,
      stoppedBy: 'error',
      nodes: si.nodes ?? si.simulations ?? 0,
      searchDepth: si.searchDepth,
      whiteDist: si.whiteDist,
      blackDist: si.blackDist,
      depthLog: si.depthLog ? [...si.depthLog] : [],
      thinkMs,
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
      () => new Promise((resolve) => { releaseApply = resolve; }),
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

    logAiRequestEvent('AI_FINAL_RESULT_RECEIVED', {
      requestSeq,
      gameGeneration,
      seatIndex,
      sideToMove: requestPlayerToMove,
      engineId: playerType,
      backend: engineEntry?.backend,
      positionKey: requestPositionKey ?? currentPositionKey,
      connectionEpoch: engineEntry?.backend === EngineBackendKind.REMOTE_WS
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
        syncState: engine?.syncState ?? 'SYNCED',
      },
    });

    const plyMismatch =
      current.actions.length !== requestPly ||
      current.playerToMove !== requestPlayerToMove;

    if (!identity.ok || plyMismatch) {
      logAiRequestEvent('AI_IDENTITY_VALIDATED', {
        requestSeq,
        ok: false,
        reason: plyMismatch ? 'stale-ply' : identity.reason,
        decodedMove: moveKey,
      });
      console.warn('Ignoring stale engine move response', {
        playerType,
        seatIndex,
        requestSeq,
        reason: identity.reason,
        suggested: moveKey,
      });
      if (this.thinkingSeatIndex === seatIndex) {
        this.aiThinking = false;
        this.thinkingPlayerType = null;
        this.thinkingSeatIndex = null;
        this.onChange?.();
        queueMicrotask(() => this.maybeRequestAiMove());
      }
      return 'stale';
    }

    logAiRequestEvent('AI_IDENTITY_VALIDATED', {
      requestSeq,
      ok: true,
      decodedMove: moveKey,
    });

    const siBeforeMove = finalizeSearchInfo(this.searchInfoBySeat[seatIndex] ?? {});

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
      logAiRequestEvent('AI_LEGALITY_VALIDATED', {
        requestSeq,
        ok: false,
        reason: identityGate.reason,
        decodedMove: moveKey,
      });
      if (this.thinkingSeatIndex === seatIndex) {
        this.aiThinking = false;
        this.thinkingPlayerType = null;
        this.thinkingSeatIndex = null;
        this.liveSearch = null;
      }
      this.engineErrors[seatIndex] = `REJECTED ${identityGate.reason}`;
      this.engineStatus[seatIndex] = 'error';
      this.onChange?.();
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
      logAiRequestEvent('AI_LEGALITY_VALIDATED', {
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
      console.warn('Engine move rejected at gate', legality.reason, diagnostic);
      if (this.thinkingSeatIndex === seatIndex) {
        this.aiThinking = false;
        this.thinkingPlayerType = null;
        this.thinkingSeatIndex = null;
        this.liveSearch = null;
      }
      const oracleMsg =
        legality.reason === 'titanium-oracle-unavailable'
          ? `Local legality checker unavailable: ${legality.titanium?.error?.message ?? 'unknown error'}`
          : legality.reason === 'titanium-position-invalid'
            ? `Titanium rejected position: ${legality.titanium?.error?.message ?? 'invalid'}`
            : `REJECTED ${legality.reason}`;
      this.engineErrors[seatIndex] = `${oracleMsg}\n\n${diagnostic}`;
      this.engineStatus[seatIndex] = 'error';
      this.onChange?.();
      return legality.reason;
    }

    logAiRequestEvent('AI_LEGALITY_VALIDATED', {
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

    const posKeyBeforeMove = this.session.actions.map((a) => toAlgebraic(a)).join('|');
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
        this.engineErrors[seatIndex] = `REJECTED ${wallInv.reason}\n\n${diagnostic}`;
        this.engineStatus[seatIndex] = 'error';
        this.aiThinking = false;
        this.onChange?.();
        return wallInv.reason;
      }
    }

    this._suppressSessionNotify = true;
    const applied = this.session.applyAction(action);
    this._suppressSessionNotify = false;
    if (applied) {
      this.handleCatPositionChanged();
      const plyNum = this.session.actions.length;
      const si = siBeforeMove;
      const thinkMs = resolveThinkMs(si, this._thinkStartedAt);
      this._thinkStartedAt = null;
      const moveLabel = this.session.actionToLabel(action);
      this._thinkAiSettings = null;
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
        stoppedBy: si.stoppedBy ?? si.mode ?? '?',
        rootMoves: si.rootMoves,
        lmrProfile: si.lmrProfile,
        lmrReSearches: si.lmrReSearches,
        helperStarts: si.helperStarts,
        helperStartsTotal: si.helperStartsTotal,
        requestedThreads: si.requestedThreads,
        effectiveThreads: si.effectiveThreads,
        threaded: si.threaded,
        engine: completedEngineLabel,
        thinkMs,
      });
      this.moveThinkLog.push({
        ply: plyNum,
        move: moveLabel,
        engine: completedEngineLabel,
        budget: budgetHint,
        stoppedBy: si.stoppedBy ?? si.mode ?? '?',
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
        thinkMs,
      });
    }
    if (this.session.winner != null || this.session.isDraw) {
      this.maybeSubmitFinishedGame();
      this._cancelActiveAiSearch();
      this.stopAllPonders();
      this.engineErrors[seatIndex] = null;
      this.engineStatus[seatIndex] = 'idle';
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
    this.engineStatus[seatIndex] = 'idle';
    logAiRequestEvent('AI_MOVE_COMMITTED', {
      requestSeq,
      gameGeneration,
      seatIndex,
      decodedMove: moveKey,
    });
    this.onChange?.();
    this.continueAiAfterEngineSync(action, seatIndex);
    logAiRequestEvent('AI_REQUEST_FINALLY', { requestSeq, seatIndex });
    return true;
  }

  maybeRequestAiMove() {
    if (!this.startupConfirmed) {
      return;
    }
    if (this.enginesPaused) {
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
    const requestHistory = this.session.actions.map((a) => toAlgebraic(a)).join(' ');
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

    logAiRequestEvent('AI_REQUEST_ENTER', {
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
    this._thinkStartedAt = performance.now();
    this.engineErrors[seatIndex] = null;
    this.engineStatus[seatIndex] = 'searching';
    this.searchInfoBySeat[seatIndex] = { depthLog: [] };
    this.liveSearch = {
      playerType,
      seatIndex,
      playerLabel: this.engineLabelForSeat(seatIndex),
      mode: 'searching',
      depthLog: [],
      requestSeq,
      positionKey: requestPositionKey,
    };
    this.lmrVizLive = null;
    if (this.settings.showLmrVision && isTitaniumEngine(playerType, this.engineConfigs)) {
      this.scheduleLmrRefresh();
    }
    this.onChange?.();

    const gameGeneration = this._gameGeneration;
    const moveHistory = this.session.actions;
    const isFreshGame = moveHistory.length === 0;
    this._thinkAiSettings = { ...aiSettings };

    if (this._activeAiAbort) {
      this._activeAiAbort.abort();
    }
    const abortController = new AbortController();
    this._activeAiAbort = abortController;
    const capturedSignal = abortController.signal;

    logAiRequestEvent('AI_CONTROLLER_FOUND', {
      requestSeq,
      engineId: playerType,
      backend: engineEntry.backend,
    });
    logAiRequestEvent('AI_BACKEND_SELECTED', { requestSeq, backend: engineEntry.backend });
    logAiRequestEvent('AI_REQUEST_STARTED', { requestSeq, positionKey: requestPositionKey });

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
      if (requestSeq !== this._moveRequestSeq || this.thinkingSeatIndex !== seatIndex) {
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
        aiSettings,
        signal: capturedSignal,
        gameSnapshot: this.session.getEngineSnapshot(),
        isFreshGame,
        positionKey: requestPositionKey,
        requestSeq,
        gameGeneration,
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
        queueMicrotask(() => this.maybeRequestAiMove());
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
        if (playerType !== PlayerType.Human && playerAiSettings && playerAiSettings[seat]) {
          this.settings.playerAiSettings[seat] = Object.assign({}, playerAiSettings[seat]);
          const memory = this.settings.playerAiSettingsMemory[seat] || {};
          memory[playerType] = Object.assign({}, playerAiSettings[seat]);
          this.settings.playerAiSettingsMemory[seat] = memory;
        } else if (playerType !== PlayerType.Human) {
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
      const playerType = normalizePlayerType(players[seat] || this.settings.players[seat]);
      const prevType = this.settings.players[seat];
      const prevAi = { ...(this.settings.playerAiSettings[seat] ?? {}) };
      this.settings.players[seat] = playerType;
      if (prevType !== playerType) {
        this._moveRequestSeq += 1;
        this.destroyEngineForSeat(seat);
      }
      if (playerType !== PlayerType.Human && playerAiSettings && playerAiSettings[seat]) {
        this.settings.playerAiSettings[seat] = Object.assign({}, playerAiSettings[seat]);
        const memory = this.settings.playerAiSettingsMemory[seat] || {};
        memory[playerType] = Object.assign({}, playerAiSettings[seat]);
        this.settings.playerAiSettingsMemory[seat] = memory;
      } else if (playerType !== PlayerType.Human) {
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
    const validKeys = new Set(snapshot.validActions.map((mv) => toAlgebraic(mv)));

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
    const requestHistory = snapshot.actions.map((a) => toAlgebraic(a)).join(' ');
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

        const si = this.searchInfoBySeat[seatIndex] ?? {};
        this.lastThinkBySeat[seatIndex] = buildThinkSeatSnapshot({
          engine: this.engineLabelForSeat(seatIndex),
          live: false,
          stoppedBy: 'time',
          depthLog: si.depthLog ?? [],
          searchDepth: si.searchDepth,
          whiteDist: si.whiteDist,
          blackDist: si.blackDist,
          rootScore: si.rootScore,
          nodes: si.nodes,
          simulations: si.simulations,
        });
        this.searchInfoBySeat[seatIndex] = { ...si, stoppedBy: 'time' };
        this.aiThinking = false;
        this.thinkingPlayerType = null;
        this.thinkingSeatIndex = null;
        this.liveSearch = null;
        this.engineStatus[seatIndex] = 'idle';
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
          const reason = typeof result === 'string' ? result : 'play-now-failed';
          this.engineErrors[seatIndex] = `Play now failed (${reason}) — search cancelled`;
          this.engineStatus[seatIndex] = 'error';
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
    const tokens = text.trim().split(/\s+/).filter(Boolean);
    const actions = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      try {
        const action = parseAlgebraic(token);
        if (!action) return { error: 'Could not parse move: ' + token };
        actions.push(action);
      } catch (err) {
        return { error: 'Invalid move "' + token + '": ' + (err && err.message ? err.message : err) };
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
      this.replay = null;
      this.moveThinkLog = [];
      this.settings.uiMode = 'play';
      this.session.rebuildFromActions(actions);
      this.handleCatPositionChanged();
      this.confirmStartup();
      this.onChange?.();
      this.maybeRequestAiMove();
      return null;
    } catch (err) {
      return { error: 'Failed to apply moves: ' + (err && err.message ? err.message : err) };
    }
  }
}
