import { GameSession } from './gameSession.js';
import { naiveDistanceEval } from '../lib/gameLogic.js';
import { decodeReplayCode, encodeReplayFromActions } from '../lib/replayCode.js';
import { fetchCatSnapshot, indexCatWalls } from '../lib/catHeatmap.js';
import { buildLmrViz, fetchLmrSnapshot } from '../lib/lmrHeatmap.js';
import { toAlgebraic } from '../lib/gameLogic.js';
import { EngineClient } from '../lib/engineClient.js';
import { GorisansonEngineClient, TitaniumEngineClient } from '../lib/localMctsEngine.js';
import { TitaniumWasmEngineClient } from '../lib/titaniumWasmClient.js';
import { useStaticEngineBackend } from '../lib/engineBackend.js';
import { validateMovesWithRust } from '../lib/rustMoveValidate.js';
import { resolveOnBestMoveResult } from '../lib/onBestMoveResult.js';
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

/** Total nodes/sims for display — prefer engine total, else deepest ID row. */
function resolveTotalNodes(info) {
  const depthLog = info?.depthLog ?? [];
  const deep = deepestDepthEntry(depthLog);
  return Math.max(
    Number(info?.nodes) || 0,
    Number(info?.simulations) || 0,
    Number(deep?.nodes) || 0,
  );
}

function finalizeSearchInfo(info) {
  const depthLog = info?.depthLog ? [...info.depthLog] : [];
  const deep = deepestDepthEntry(depthLog);
  const nodes = resolveTotalNodes(info);
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
  rootWinRate,
  stoppedBy,
  rootMoves,
  lmrProfile,
  lmrReSearches,
  thinkMs,
}) {
  const deep = deepestDepthEntry(depthLog);
  const resolvedNodes = resolveTotalNodes({ nodes, simulations, depthLog });
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
    rootWinRate,
    stoppedBy: stoppedBy ?? (live ? 'searching' : '?'),
    rootMoves: rootMoves ? [...rootMoves] : [],
    lmrProfile: lmrProfile ?? null,
    lmrReSearches: lmrReSearches ?? null,
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
  isTitaniumEngine,
  isQuoridorV3Engine,
  isAceEngine,
  isAceFamily,
  isAceV8Family,
  isAceV10Family,
  normalizePlayerType,
  getEngineConfig,
} from '../lib/timeControl.js';
import { playerColorName } from '../lib/playerColors.js';
import { ponderCandidateSlots } from '../lib/enginePonder.js';
import {
  loadPersistedPlaySettings,
  savePersistedPlaySettings,
} from '../lib/persistedPlaySettings.js';

function isSavedSettingsValid(playerType, saved, engineConfigs) {
  if (isTitaniumEngine(playerType, engineConfigs)) {
    return (
      saved.strengthLevel != null &&
      saved.wallClockSeconds != null &&
      saved.visitsBudget != null
    );
  }
  if (isAceFamily(playerType, engineConfigs)) {
    return saved.strengthLevel != null && saved.wallClockSeconds != null;
  }
  if (isLocalEngine(playerType, engineConfigs)) {
    return saved.wallClockSeconds != null && saved.visitsBudget != null;
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

    const v15Live = defaultPlayerAiSettings(PlayerType.TitaniumMinimax, this.engineConfigs);
    const persisted = loadPersistedPlaySettings();
    const playDefaults = {
      players: [PlayerType.Human, PlayerType.TitaniumMinimax],
      playerAiSettings: [null, { ...v15Live }],
      playerAiSettingsMemory: [{}, {}],
    };
    const restored = persisted
      ? {
          players: persisted.players.map((p) => normalizePlayerType(p)),
          playerAiSettings: persisted.playerAiSettings ?? [{}, {}],
          playerAiSettingsMemory: persisted.playerAiSettingsMemory ?? [{}, {}],
        }
      : playDefaults;
    this.settings = {
      ...restored,
      rotateBoard: false,
      displayCoordinates: true,
      displayRemainingWalls: true,
      displayEvalBar: true,
      showCatVision: false,
      showLmrVision: false,
      lmrVisionShallow: false,
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

    this.session.subscribe(() => this.onSessionChange());
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

    return {
      ...snapshot,
      settings: { ...this.settings },
      engineStatus: { ...this.engineStatus },
      engineErrors: { ...this.engineErrors },
      eval: {
        p1: distanceEval.p1,
        margin: distanceEval.margin,
        whiteDist: distanceEval.whiteDist,
        blackDist: distanceEval.blackDist,
        pv: this.eval.pv ?? [],
      },
      liveSearch: this.liveSearch,
      aiThinking: this.aiThinking,
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
      thinkingPlayerType: this.thinkingPlayerType,
      thinkingSeatIndex: this.thinkingSeatIndex,
      searchInfoLine: describeActiveSearchInfo(
        this.settings.players,
        this.searchInfoBySeat,
        this.engineConfigs,
        {
          thinkingSeatIndex: this.thinkingSeatIndex,
          aiThinking: this.aiThinking,
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
      replay: this.replay
        ? {
          index: this.replay.index,
          total: this.replay.actions.length,
          code: this.replay.code,
          meta: this.replay.meta,
        }
        : null,
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
    const v15Live = defaultPlayerAiSettings(PlayerType.TitaniumMinimax, this.engineConfigs);
    const playDefaults = {
      players: [PlayerType.Human, PlayerType.TitaniumMinimax],
      playerAiSettings: [null, { ...v15Live }],
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
    const v15 = defaultPlayerAiSettings(PlayerType.TitaniumMinimax, this.engineConfigs);
    this.settings.players = [PlayerType.AceV13, PlayerType.TitaniumMinimax];
    this.settings.playerAiSettings = [v13Js, v15];
    const memory = [{}, {}];
    memory[0][PlayerType.AceV13] = { ...v13Js };
    memory[1][PlayerType.TitaniumMinimax] = { ...v15 };
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

  _cancelActiveAiSearch() {
    const seat = this.thinkingSeatIndex;
    if (seat != null) {
      this.getEngineForSeat(seat)?.cancelSearch?.();
      this.lastThinkBySeat[seat] = buildThinkSeatSnapshot({
        engine: this.engineLabelForSeat(seat),
        live: false,
        stoppedBy: 'cancelled',
        depthLog: this.searchInfoBySeat[seat]?.depthLog ?? [],
        searchDepth: this.searchInfoBySeat[seat]?.searchDepth,
        whiteDist: this.searchInfoBySeat[seat]?.whiteDist,
        blackDist: this.searchInfoBySeat[seat]?.blackDist,
        rootScore: this.searchInfoBySeat[seat]?.rootScore,
        nodes: this.searchInfoBySeat[seat]?.nodes,
        simulations: this.searchInfoBySeat[seat]?.simulations,
      });
    }
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this._moveRequestSeq += 1;
    this._activeSearchSeq = 0;
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
    this.onChange?.();
    if (requestAi && !this.isFreePlayMode()) {
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

    return {
      playerNum,
      playerType,
      isHuman: playerType === PlayerType.Human,
      isLocal: isLocalEngine(playerType, this.engineConfigs),
      isTitanium: isTitaniumEngine(playerType, this.engineConfigs),
      isQuoridorV3: isQuoridorV3Engine(playerType, this.engineConfigs),
      isAceEngine: isAceEngine(playerType, this.engineConfigs),
      isAceV10Family: isAceV10Family(playerType, this.engineConfigs),
      isAceV8Family: isAceV8Family(playerType, this.engineConfigs),
      isAceFamily: isAceFamily(playerType, this.engineConfigs),
      isLocalMcts: isLocalMctsEngine(playerType, this.engineConfigs),
      isRemote: isRemoteEngine(playerType, this.engineConfigs),
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

  setPlayerStrengthLevel(playerNum, strengthLevel, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (
      !isRemoteEngine(playerType, this.engineConfigs) &&
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
      this.onChange?.();
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
      this.onChange?.();
    }
  }

  setPlayerWallClock(playerNum, seconds, { silent = false } = {}) {
    const index = playerNum - 1;
    const playerType = this.settings.players[index];
    if (!isLocalMctsEngine(playerType, this.engineConfigs)) {
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
      this.onChange?.();
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
      this.onChange?.();
    }
  }

  toggleRotateBoard() {
    this.settings.rotateBoard = !this.settings.rotateBoard;
    this.onChange?.();
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

  toggleLmrShallow(enabled = !this.settings.lmrVisionShallow) {
    this.settings.lmrVisionShallow = Boolean(enabled);
    if (this.settings.showLmrVision) {
      this._lmrShallowKey = null;
      this.scheduleLmrRefresh();
      this.onChange?.();
    }
  }

  lmrPlanDepthHint() {
    const posKey = this.lmrPositionKey();
    const fromSearch =
      this.liveSearch?.searchDepth ??
      this.lmrSearchByPosition.get(posKey)?.searchDepth ??
      this.lmrVizLive?.searchDepth;
    if (fromSearch != null && fromSearch > 0) {
      return fromSearch;
    }
    const timeSec = this.lmrTimeSecForPosition();
    return Math.min(12, Math.max(6, Math.round(Math.log2(timeSec) * 2 + 4)));
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
    if (this.settings.lmrVisionShallow) {
      return this.lmrShallowByPosition.get(posKey) ?? null;
    }
    if (
      this.aiThinking &&
      this.lmrVizLive &&
      this.thinkingPlayerType &&
      isTitaniumEngine(this.thinkingPlayerType, this.engineConfigs)
    ) {
      return this.lmrVizLive;
    }
    return this.lmrSearchByPosition.get(posKey) ?? null;
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
    const fetchKey = `${posKey}|${timeSec}|d${idDepth}`;
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

  catMovesKey() {
    return this.session.actions.map((action) => toAlgebraic(action)).join('|');
  }

  invalidateCatCache() {
    this._catMovesKey = null;
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
    this.aiThinking = false;
    this.thinkingPlayerType = null;
    this.thinkingSeatIndex = null;
    this.liveSearch = null;
    this.destroyAllEngines();
    this.maybeRandomizeTitaniumAdversarySeats();
    this.engineErrors = {};
    this.engineStatus = {};
    this.replay = null;
    this.moveThinkLog = [];
    this._illegalRetriesByPly = {};
    this.settingsChangelog = [];
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
    this.session.reset();
    this.invalidateCatCache();
    this.scheduleCatRefresh();
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
    const trimmed = code.trim();
    const { actions } = decodeReplayCode(trimmed);
    this.replay = null;
    this.aiThinking = false;
    this.liveSearch = null;
    this.session.rebuildFromActions(actions);
    this.invalidateCatCache();
    this.scheduleCatRefresh();
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
      this.catViz = null;
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
    if (!freePlay && !this.session.isHumanTurn(this.settings.players)) {
      return;
    }

    const applied = this.session.applyAction(action);
    if (!applied) {
      return;
    }

    this.onChange?.();
    if (freePlay) {
      return;
    }
    this.continueAiAfterEngineSync(action);
  }

  /** After any ply, sync remote seats then request the next AI move (never stall on sync failure). */
  continueAiAfterEngineSync(action) {
    const gameGeneration = this._gameGeneration;
    void this.syncRemoteEnginesAfterMove(action)
      .catch((err) => {
        if (gameGeneration !== this._gameGeneration) {
          return;
        }
        console.error('Engine position sync failed after ply', err);
        for (let seat = 0; seat < this.settings.players.length; seat++) {
          if (this.settings.players[seat] === PlayerType.Human) {
            continue;
          }
          const message = err?.message ?? String(err);
          this.engineErrors[seat] = message;
          this.engineStatus[seat] = 'error';
          const engine = this.getEngineForSeat(seat);
          if (engine) {
            engine.appliedPlies = 0;
          }
        }
        this.onChange?.();
      })
      .finally(() => {
        if (gameGeneration !== this._gameGeneration) {
          return;
        }
        this.maybeRequestAiMove();
        this.maybePonderInactiveEngines();
      });
  }

  onSessionChange() {
    if (this._suppressSessionNotify) {
      return;
    }
    if (!this.aiThinking) {
      this.lmrVizLive = null;
    }
    this.scheduleCatRefresh();
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
    if (useStaticEngineBackend()) {
      return new AceRustWasmEngineClient({ ...config, engineMode: tier.engineMode });
    }
    return new TitaniumEngineClient(
      { ...config, kind: 'ace', engineMode: tier.engineMode },
      { seatId: this.engineSeatKey(seatIndex) },
    );
  }

  createEngineClient(config, seatIndex = 0) {
    if (config.kind === 'local') {
      return new GorisansonEngineClient(config);
    }
    if (config.kind === 'quoridor-v3') {
      return new QuoridorV3EngineClient(config);
    }
    if (
      config.kind === 'ace-v8-family' ||
      config.kind === 'ace-v10-family' ||
      config.kind === 'ace-v13-family'
    ) {
      return this.createAceClient(config, seatIndex);
    }
    if (config.kind === 'titanium') {
      if (useStaticEngineBackend()) {
        return new TitaniumWasmEngineClient(config);
      }
      return new TitaniumEngineClient(config, { seatId: this.engineSeatKey(seatIndex) });
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
      const backend = tier.kind.endsWith('-js')
        ? 'js'
        : useStaticEngineBackend()
          ? 'wasm'
          : 'rust';
      return `${playerType}|${backend}|${tier.engineMode}`;
    }
    if (isTitaniumEngine(playerType, this.engineConfigs)) {
      const backend = useStaticEngineBackend() ? 'wasm' : 'native';
      const mode =
        getEngineConfig(playerType, this.engineConfigs)?.engineMode ?? 'titanium-v15';
      return `${playerType}|${backend}|${mode}|${ai.strengthLevel ?? ''}`;
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
        const prev = this.searchInfoBySeat[seatIndex] ?? {};
        const depthLog = info.depthLog?.length
          ? mergeDepthLogs(prev.depthLog, info.depthLog)
          : (prev.depthLog ?? []);
        this.searchInfoBySeat[seatIndex] = finalizeSearchInfo({
          ...prev,
          ...info,
          depthLog,
        });
        if (info.thinking) {
          if (
            !this.aiThinking ||
            this.thinkingSeatIndex !== seatIndex ||
            this._activeSearchSeq !== this._moveRequestSeq
          ) {
            return;
          }
          const si = this.searchInfoBySeat[seatIndex];
          const liveDepthLog = si.depthLog ?? [];
          const liveRootScore = scoreFromDepthLog(liveDepthLog, info.rootScore ?? this.liveSearch?.rootScore);
          this.liveSearch = {
            playerType,
            seatIndex,
            playerLabel: this.engineLabelForSeat(seatIndex),
            requestSeq: this._activeSearchSeq,
            simulations: si.simulations ?? 0,
            nodes: si.nodes ?? 0,
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
            rootMoves: info.rootMoves ?? this.liveSearch?.rootMoves,
            lmrProfile: info.lmrProfile ?? this.liveSearch?.lmrProfile,
            lmrReSearches: info.lmrReSearches ?? this.liveSearch?.lmrReSearches,
            rootScore: liveRootScore,
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
        const message = err?.message ?? String(err ?? 'Engine error');
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

  /** Keep engine clients in sync after every ply (incremental makemove or full replay). */
  async syncRemoteEnginesAfterMove(action) {
    const ops = [];
    for (let seat = 0; seat < this.settings.players.length; seat++) {
      if (this.settings.players[seat] === PlayerType.Human) {
        continue;
      }
      const p = this.getEngineForSeat(seat)?.makeMoves?.([action]);
      if (p?.then) {
        ops.push(p);
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
    engine.syncGameState({
      moveHistory,
      gameSnapshot: this.session.getEngineSnapshot(),
      isFreshGame: moveHistory.length === 0,
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
    const detail =
      `position="${position}" engineHistory="${requestHistory ?? position}" requestSeq=${requestSeq} requestPly=${requestPly} retry=${retries}/${this._maxIllegalRetries}`;

    console.error('Engine produced illegal move', {
      playerType,
      seatIndex,
      suggested,
      ply,
      position,
      requestSeq,
      requestPly,
      retries,
      playerToMove: snapshot.playerToMove,
      playerPositions: snapshot.playerPositions,
      wallsRemaining: snapshot.wallsRemaining,
      legalCount: legal.length,
      legalSample: legal.slice(0, 40),
    });

    this.getEngineForSeat(seatIndex)?.clearQueuedSearches?.();

    this.searchInfoBySeat[seatIndex] = {
      ...(this.searchInfoBySeat[seatIndex] ?? {}),
      illegalMove: suggested,
      illegalMovePly: ply,
      legalMovesCount: legal.length,
      illegalDetail: detail,
    };
    this.engineErrors[seatIndex] = illegalMsg;
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
      error: `${illegalMsg} | ${detail}`,
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
      if (engine) {
        engine.appliedPlies = 0;
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

  async applyEngineMove({
    action,
    playerType,
    seatIndex,
    requestSeq,
    requestPly,
    requestPlayerToMove,
    requestHistory,
    gameGeneration,
    engine,
  }) {
    const current = this.session.getSnapshot();
    const currentSeat = current.playerToMove - 1;
    const currentPlayerType = this.settings.players[currentSeat];
    const stale =
      gameGeneration !== this._gameGeneration ||
      requestSeq !== this._moveRequestSeq ||
      current.actions.length !== requestPly ||
      current.playerToMove !== requestPlayerToMove ||
      currentSeat !== seatIndex ||
      currentPlayerType !== playerType;
    if (stale) {
      console.warn('Ignoring stale engine move response', {
        playerType,
        seatIndex,
        requestSeq,
        currentSeq: this._moveRequestSeq,
        requestPly,
        currentPly: current.actions.length,
        requestPlayerToMove,
        currentPlayerToMove: current.playerToMove,
        currentPlayerType,
        suggested: this.session.actionToLabel(action),
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

    const siBeforeMove = finalizeSearchInfo(this.searchInfoBySeat[seatIndex] ?? {});

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

    if (!useStaticEngineBackend()) {
      const trialMoves = [
        ...this.session.actions.map((a) => toAlgebraic(a)),
        toAlgebraic(action),
      ];
      const rust = await validateMovesWithRust(trialMoves);
      if (!rust.ok) {
        return this.rejectIllegalEngineMove({
          playerType,
          seatIndex,
          action,
          requestSeq,
          requestPly,
          requestHistory,
          searchInfo: siBeforeMove,
          rustError: rust.error,
        });
      }
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

    this._suppressSessionNotify = true;
    const applied = this.session.applyAction(action);
    this._suppressSessionNotify = false;
    if (applied) {
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
        rootWinRate: si.rootWinRate,
        stoppedBy: si.stoppedBy ?? si.mode ?? '?',
        rootMoves: si.rootMoves,
        lmrProfile: si.lmrProfile,
        lmrReSearches: si.lmrReSearches,
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
        thinkMs,
      });
    }
    if (this.session.winner != null || this.session.isDraw) {
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
    this.onChange?.();
    this.continueAiAfterEngineSync(action);
    return true;
  }

  maybeRequestAiMove() {
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
    };
    this.lmrVizLive = null;
    if (this.settings.showLmrVision && isTitaniumEngine(playerType, this.engineConfigs)) {
      this.scheduleLmrRefresh();
    }
    this.onChange?.();

    const gameGeneration = this._gameGeneration;
    engine.onBestMove = (action) =>
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
          gameGeneration,
          engine,
        }),
      );

    engine.onError = (err) => {
      if (gameGeneration !== this._gameGeneration) {
        return;
      }
      if (requestSeq !== this._moveRequestSeq || this.thinkingSeatIndex !== seatIndex) {
        return;
      }
      this.recordEngineFailure(playerType, {
        ply: requestPly + 1,
        error: err,
        budget: describePlayerAiSettings(
          playerType,
          this._thinkAiSettings ?? this.settings.playerAiSettings[seatIndex],
          this.engineConfigs,
        ),
      });
      this.onChange?.();
    };

    const playerIndex = requestPlayerToMove - 1;
    let aiSettings = this.settings.playerAiSettings[playerIndex];
    if (!aiSettings) {
      aiSettings = defaultPlayerAiSettings(playerType, this.engineConfigs);
      this.settings.playerAiSettings[playerIndex] = aiSettings;
    }
    const moveHistory = this.session.actions;
    const isFreshGame = moveHistory.length === 0;
    this._thinkAiSettings = { ...aiSettings };

    engine.requestMove({
      aiSettings,
      gameSnapshot: this.session.getEngineSnapshot(),
      moveHistory,
      isFreshGame,
    });
  }
}
