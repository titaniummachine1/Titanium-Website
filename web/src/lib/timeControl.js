/**
 * Per-player AI settings — matches scraped quoridor-ai.netlify.app controls.
 *
 * Remote (Ishtar/Ka): AI Strength (Beg→Alpha) + AI Time (Immediate→Long) sliders.
 * Local (Gorisanson): wall-clock + visit-budget sliders.
 */

import { PlayerType, StrengthLevel, TimeToMove } from "./engineConfig.js";
import { aceDisplayName } from "./aceTier.js";

/** Scraped StrengthLevel slider — legacy label, kept for remote UI parity. */
export const STRENGTH_LEVEL_PRESETS = [
  { id: StrengthLevel.Beginner, label: "Beg." },
  { id: StrengthLevel.Intermediate, label: "Inter." },
  { id: StrengthLevel.Advanced, label: "Adv." },
  { id: StrengthLevel.Expert, label: "Expert" },
  { id: StrengthLevel.Alpha, label: "Alpha" },
];

/** Scraped timeToMove slider — drives visit count on cloud engines. */
export const TIME_TO_MOVE_PRESETS = [
  { id: TimeToMove.Intuition, label: "Immediate" },
  { id: TimeToMove.Short, label: "Short" },
  { id: TimeToMove.Medium, label: "Medium" },
  { id: TimeToMove.Long, label: "Long" },
];

export const WALL_CLOCK_RANGE = {
  min: 0.25,
  max: 600,
  step: 1,
  sliderSteps: 1000,
  defaultSeconds: 60,
};

/** Baseline whole-game move horizon for clock spreading (per side). */
export const WHOLE_GAME_PLAN_MOVES = 30;

/**
 * Remaining own-move horizon for budget math.
 * Floor: (30 − plies already played). Raised when the minimum remaining plies
 * (PV length + leaf min race when main line is known, else engine/board race)
 * says the game still has more plies to play.
 */
export function resolveExpectedMovesLeft({
  ownMovesPlayed = 0,
  distanceToWin = null,
} = {}) {
  const played = Math.max(0, Number(ownMovesPlayed) || 0);
  const planTail = Math.max(1, WHOLE_GAME_PLAN_MOVES - played);
  const dist = Number(distanceToWin);
  const distFloor = Number.isFinite(dist) && dist > 0 ? Math.ceil(dist) : 0;
  return Math.max(planTail, distFloor, 1);
}

/**
 * Allocate one timed engine search from a whole-game clock.
 *
 * The engine receives less than the displayed remaining clock so worker
 * messaging and deadline cleanup cannot flag an otherwise completed move.
 * Spread uses {@link resolveExpectedMovesLeft}: 30-move baseline, bumped by
 * PV length + leaf race (or engine/board race) when the position needs more.
 */
export function allocateWholeGameTime({
  totalMs,
  usedMs,
  ownMovesPlayed,
  distanceToWin = null,
}) {
  const total = Math.max(250, Number(totalMs) || 0);
  const used = Math.max(0, Number(usedMs) || 0);
  const remainingMs = Math.max(0, total - used);
  const expectedMovesLeft = resolveExpectedMovesLeft({
    ownMovesPlayed,
    distanceToWin,
  });
  const remainingFraction = remainingMs / total;
  const spendFactor =
    remainingFraction <= 0.1 ? 0.75 : remainingFraction <= 0.25 ? 1 : 1.35;
  const shareCap = remainingFraction <= 0.1 ? 0.1 : 0.2;
  const grossBudgetMs = Math.min(
    remainingMs * shareCap,
    (remainingMs / expectedMovesLeft) * spendFactor,
  );
  const handoffReserveMs = Math.min(300, Math.max(50, grossBudgetMs * 0.05));
  const moveBudgetMs =
    remainingMs > 0 ? Math.max(1, grossBudgetMs - handoffReserveMs) : 0;

  return {
    totalMs: total,
    remainingMs,
    moveBudgetMs,
    expectedMovesLeft,
    handoffReserveMs,
  };
}

/**
 * Mid-think refresh: never grant more search time than the opening budget, but
 * tighten when a deeper PV/dist says the game will run longer.
 */
export function tightenThinkAllocation(
  previousBudgetMs,
  { moveBudgetMs, handoffReserveMs, ...rest } = {},
) {
  const prev = Math.max(0, Number(previousBudgetMs) || 0);
  const next = Math.max(0, Number(moveBudgetMs) || 0);
  const tightened =
    prev > 0 && next > 0 ? Math.min(prev, next) : prev > 0 ? prev : next;
  const handoff = Math.max(0, Number(handoffReserveMs) || 0);
  return {
    ...rest,
    moveBudgetMs: tightened,
    handoffReserveMs: handoff,
  };
}

/**
 * Wall time to deduct from a whole-game bank after a think completes.
 * Per-move budgets cap WASM movetime only — never under-charge the bank.
 */
export function chargeThinkMsForSeat({
  wallThinkMs,
  moveBudgetMs = 0,
  handoffMs = 0,
  usesWholeGameClock = false,
} = {}) {
  if (wallThinkMs == null || !Number.isFinite(Number(wallThinkMs))) {
    return null;
  }
  const wall = Math.max(0, Math.round(Number(wallThinkMs)));
  const budget = Math.max(0, Math.round(Number(moveBudgetMs) || 0));
  const handoff = Math.max(0, Math.round(Number(handoffMs) || 0));
  if (usesWholeGameClock) {
    return wall;
  }
  if (budget > 0) {
    return Math.min(wall, budget + handoff);
  }
  return wall;
}

/** Sum completed think time for one seat from canonical, one-based ply logs. */
export function clockLogUsedMs(entries, seatIndex) {
  return (entries ?? []).reduce((sum, entry) => {
    const entrySeat = Number.isFinite(entry?.ply) ? (entry.ply - 1) % 2 : -1;
    return entrySeat === seatIndex && Number.isFinite(entry?.thinkMs)
      ? sum + Math.max(0, Number(entry.thinkMs))
      : sum;
  }, 0);
}

/** Drop telemetry for moves that no longer exist after undo/jump-to-ply. */
export function trimThinkLogToPly(entries, plyCount) {
  const lastPly = Math.max(0, Math.trunc(Number(plyCount) || 0));
  return (entries ?? []).filter(
    (entry) => Number.isFinite(entry?.ply) && entry.ply <= lastPly,
  );
}

export function wallClockFromSlider(position) {
  const t = Math.max(
    0,
    Math.min(1, Number(position) / WALL_CLOCK_RANGE.sliderSteps),
  );
  const raw =
    WALL_CLOCK_RANGE.min *
    Math.pow(WALL_CLOCK_RANGE.max / WALL_CLOCK_RANGE.min, t);
  const quantum =
    raw < 1 ? 0.01 : raw < 10 ? 0.1 : raw < 60 ? 0.5 : raw < 180 ? 1 : 5;
  return Math.max(
    WALL_CLOCK_RANGE.min,
    Math.min(WALL_CLOCK_RANGE.max, Math.round(raw / quantum) * quantum),
  );
}

export function wallClockSliderPosition(seconds) {
  const value = Math.max(
    WALL_CLOCK_RANGE.min,
    Math.min(
      WALL_CLOCK_RANGE.max,
      Number(seconds) || WALL_CLOCK_RANGE.defaultSeconds,
    ),
  );
  return Math.round(
    (Math.log(value / WALL_CLOCK_RANGE.min) /
      Math.log(WALL_CLOCK_RANGE.max / WALL_CLOCK_RANGE.min)) *
      WALL_CLOCK_RANGE.sliderSteps,
  );
}

/** Upper cap for the thread slider when logical CPU count is unknown or very high. */
export const THREADS_HARD_MAX = 8;

/** Default Titanium / local search thread count. */
export const DEFAULT_THREAD_COUNT = 8;

/** Max threads in the UI — machine logical CPUs, capped at 8; 8 if unknown. */
export function threadsSliderMax() {
  if (typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0) {
    return Math.max(
      1,
      Math.min(navigator.hardwareConcurrency, THREADS_HARD_MAX),
    );
  }
  return THREADS_HARD_MAX;
}

/** Default thread count for new Titanium seats (clamped to slider max). */
export function defaultThreadCount() {
  return Math.min(DEFAULT_THREAD_COUNT, threadsSliderMax());
}

/**
 * Analysis/Review's dedicated warm engine session is single-purpose (one
 * search at a time, not N concurrent seats), so unlike Play mode it's not
 * capped at THREADS_HARD_MAX=8 -- it uses the device's full logical CPU
 * count, up to a generous safety ceiling to avoid pathological values on
 * exotic hardware.
 */
export const ANALYSIS_THREADS_SAFETY_CAP = 32;

export function analysisThreadsMax() {
  if (typeof navigator !== "undefined" && navigator.hardwareConcurrency > 0) {
    return Math.max(
      1,
      Math.min(navigator.hardwareConcurrency, ANALYSIS_THREADS_SAFETY_CAP),
    );
  }
  return THREADS_HARD_MAX;
}

export function defaultAnalysisThreadCount() {
  return analysisThreadsMax();
}

export function clampAnalysisCores(cores) {
  const n = Number(cores);
  if (!Number.isFinite(n)) {
    return defaultAnalysisThreadCount();
  }
  return Math.max(1, Math.min(analysisThreadsMax(), Math.round(n)));
}

/** @deprecated use defaultThreadCount */
export function defaultCoreCount() {
  return defaultThreadCount();
}

/** @deprecated use threadsSliderMax */
export function coresSliderMax() {
  return threadsSliderMax();
}

export function clampCores(cores) {
  const n = Number(cores);
  if (!Number.isFinite(n)) {
    return defaultThreadCount();
  }
  return Math.max(1, Math.min(threadsSliderMax(), Math.round(n)));
}

/** @deprecated use clampCores */
export const clampThreads = clampCores;

/** Read thread count from saved settings (`cores` / legacy `threads`). */
export function resolveThreads(aiSettings) {
  if (aiSettings?.cores != null) {
    return clampCores(aiSettings.cores);
  }
  if (aiSettings?.threads != null) {
    return clampCores(aiSettings.threads);
  }
  return defaultThreadCount();
}

/** @deprecated use resolveThreads */
export function resolveCores(aiSettings) {
  return resolveThreads(aiSettings);
}

/** Titanium search depth cap. 0 = engine default (128 ply in WASM). */
export const TITANIUM_DEPTH_UNLIMITED = 0;
export const TITANIUM_DEPTH_RANGE = {
  min: 0,
  max: 64,
  default: TITANIUM_DEPTH_UNLIMITED,
};

export function clampTitaniumDepthLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return TITANIUM_DEPTH_UNLIMITED;
  }
  return Math.min(TITANIUM_DEPTH_RANGE.max, Math.max(1, Math.round(n)));
}

/** WASM/Rust: <=0 uses engine default 128; positive capped at 64 in browser WASM. */
export function resolveTitaniumMaxDepth(aiSettings) {
  if (aiSettings?.searchDepthLimit != null) {
    return clampTitaniumDepthLimit(aiSettings.searchDepthLimit);
  }
  return migrateTitaniumDepthLimit(aiSettings);
}

export function migrateTitaniumDepthLimit(saved) {
  if (saved?.searchDepthLimit != null) {
    return clampTitaniumDepthLimit(saved.searchDepthLimit);
  }
  const net = saved?.titaniumNet;
  if (net === "frozen" || net === TITANIUM_NET_EASY) return 16;
  if (net === "live" || net === TITANIUM_NET_MEDIUM) return 32;
  return TITANIUM_DEPTH_UNLIMITED;
}

export function formatTitaniumDepthLimit(limit) {
  const n = clampTitaniumDepthLimit(limit);
  if (n === TITANIUM_DEPTH_UNLIMITED) {
    return "unlimited";
  }
  return `d≤${n}`;
}

/** Gorisanson strength: Easy = vanilla MCTS, Medium = CAT-guided rollouts. */
export const GORISANSON_NET_EASY = "easy";
export const GORISANSON_NET_MEDIUM = "medium";

export function migrateGorisansonNet(net) {
  return net === GORISANSON_NET_MEDIUM ? GORISANSON_NET_MEDIUM : GORISANSON_NET_EASY;
}

export function gorisansonNetLabel(aiSettings) {
  return migrateGorisansonNet(aiSettings?.gorisansonNet) === GORISANSON_NET_MEDIUM
    ? "Medium (CAT)"
    : "Easy";
}

/** @deprecated Titanium Easy/Medium/Hard — migrated to searchDepthLimit. */
export const TITANIUM_NET_EASY = "easy";
export const TITANIUM_NET_MEDIUM = "medium";
export const TITANIUM_NET_HARD = "hard";

/** @deprecated Use TITANIUM_NET_* — kept for saved-prefs migration. */
export const TITANIUM_NET_LIVE = TITANIUM_NET_MEDIUM;
export const TITANIUM_NET_FROZEN = TITANIUM_NET_EASY;

export function migrateTitaniumNet(net) {
  if (net === "frozen" || net === TITANIUM_NET_EASY) return TITANIUM_NET_EASY;
  if (net === "live" || net === TITANIUM_NET_MEDIUM) return TITANIUM_NET_MEDIUM;
  if (net === "hard" || net === TITANIUM_NET_HARD) return TITANIUM_NET_HARD;
  return TITANIUM_NET_HARD;
}

export function resolveTitaniumEngineMode(
  aiSettings,
  playerType,
  engineConfigs,
) {
  void aiSettings;
  void engineConfigs;
  if (playerType === PlayerType.TitaniumV18) {
    return "titanium-v18";
  }
  if (playerType === PlayerType.TitaniumV17) {
    return "titanium-v17";
  }
  return "titanium-v16";
}

/** v16/v17 CAT LMR ceiling — single production profile (former Hard tier). */
export function resolveCatLmrCeiling(_aiSettings) {
  return 1000;
}

export function catLmrCeilingLabel(aiSettings) {
  return `CAT ${resolveCatLmrCeiling(aiSettings)}`;
}

export function titaniumNetLabel(aiSettings) {
  return formatTitaniumDepthLimit(
    aiSettings?.searchDepthLimit ?? migrateTitaniumDepthLimit(aiSettings),
  );
}

/** Default think budget for legacy Quoridor v3 client (removed from UI, kept for imports). */
export const QUORIDOR_V3_WALL_CLOCK_DEFAULT = 0.5;

/** Default wall clock for ACE engines (Rust + JS HTML). */
export const ACE_WALL_CLOCK_DEFAULT = 10;

/** Exponential visit cap for local MCTS — slider is linear, stored value is log-spaced. */
export const LOCAL_VISITS_RANGE = {
  min: 1_000,
  max: 2_000_000_000,
  default: 66_000,
  sliderSteps: 1_000,
};

/** 0 = no node cap (wall-clock only). Slider max maps here, not 2B. */
export const UNLIMITED_VISITS = 0;

/** @deprecated use UNLIMITED_VISITS — kept so saved settings at 2B map to unlimited */
export const TITANIUM_NODE_CAP = UNLIMITED_VISITS;

export function isUnlimitedVisits(visits) {
  const n = Number(visits);
  return !Number.isFinite(n) || n <= 0 || n >= LOCAL_VISITS_RANGE.max;
}

export function clampVisits(visits) {
  const n = Number(visits);
  if (!Number.isFinite(n)) {
    return LOCAL_VISITS_RANGE.default;
  }
  if (isUnlimitedVisits(n)) {
    return UNLIMITED_VISITS;
  }
  return Math.max(LOCAL_VISITS_RANGE.min, Math.round(n));
}

/** Node budget for workers — 0 means unlimited (time-only). */
export function resolveMaxNodes(visitsBudget) {
  return isUnlimitedVisits(visitsBudget)
    ? UNLIMITED_VISITS
    : clampVisits(visitsBudget);
}

/** Map slider position (0 … sliderSteps) → visit count. */
export function visitsFromSliderPosition(position) {
  const { min, max, sliderSteps } = LOCAL_VISITS_RANGE;
  const t = Math.min(1, Math.max(0, Number(position) / sliderSteps));
  if (t <= 0) {
    return min;
  }
  if (t >= 1) {
    return UNLIMITED_VISITS;
  }
  return clampVisits(min * (max / min) ** t);
}

/** Map visit count → slider position for rendering. */
export function sliderPositionFromVisits(visits) {
  const { min, max, sliderSteps } = LOCAL_VISITS_RANGE;
  const clamped = clampVisits(visits);
  if (clamped <= min) {
    return 0;
  }
  if (isUnlimitedVisits(clamped)) {
    return sliderSteps;
  }
  const t = Math.log(clamped / min) / Math.log(max / min);
  return Math.round(t * sliderSteps);
}

/** Map retired UI keys to their current engine slot. */
export function normalizePlayerType(playerType) {
  if (playerType === PlayerType.AceV7 || playerType === PlayerType.AceV7Ti) {
    return PlayerType.AceV13;
  }
  if (
    playerType === "titanium" ||
    playerType === "titanium-minimax" ||
    playerType === "titanium-v15-frozen"
  ) {
    return PlayerType.TitaniumV18;
  }
  // Retired ACE/Quoridor variants migrate to the current Titanium line.
  if (
    playerType === PlayerType.AceV8 ||
    playerType === PlayerType.AceV8Ti ||
    playerType === PlayerType.AceV8TiPmc ||
    playerType === PlayerType.AceV8Js ||
    playerType === PlayerType.QuoridorV3 ||
    playerType === PlayerType.AceV10
  ) {
    return PlayerType.TitaniumV18;
  }
  // Keep TitaniumV17 as a selectable legacy compare target (do not remap to V18).
  return playerType;
}

export function isAceV8Family(playerType, engineConfigs) {
  const normalized = normalizePlayerType(playerType);
  return (
    normalized === PlayerType.AceV8 ||
    getEngineConfig(normalized, engineConfigs)?.kind === "ace-v8-family"
  );
}

export function isAceV10Family(playerType, engineConfigs) {
  const normalized = normalizePlayerType(playerType);
  return (
    normalized === PlayerType.AceV10 ||
    getEngineConfig(normalized, engineConfigs)?.kind === "ace-v10-family"
  );
}

export function isAceV13Family(playerType, engineConfigs) {
  const normalized = normalizePlayerType(playerType);
  return (
    normalized === PlayerType.AceV13 ||
    getEngineConfig(normalized, engineConfigs)?.kind === "ace-v13-family"
  );
}

export function isGorisansonEngine(playerType, engineConfigs) {
  return (
    (playerType === PlayerType.GorisansonMCTS ||
      getEngineConfig(playerType, engineConfigs)?.kind === "local") &&
    playerType === PlayerType.GorisansonMCTS
  );
}

/** Engines with a reliable wall-clock stop and a search-start notification. */
export function supportsWholeGameTime(playerType, engineConfigs) {
  return (
    isTitaniumEngine(playerType, engineConfigs) ||
    isAceV13Family(playerType, engineConfigs) ||
    isGorisansonEngine(playerType, engineConfigs)
  );
}

/** Seat shows a running clock in play (human bank/per-move or engine whole-game). */
export function hasSeatClock(playerType, engineConfigs, aiSettings) {
  if (playerType === PlayerType.Human) {
    return aiSettings != null && Number(aiSettings.wallClockSeconds) > 0;
  }
  return (
    supportsWholeGameTime(playerType, engineConfigs) &&
    aiSettings?.wholeGameTime !== false
  );
}

export function defaultHumanClockSettings() {
  return {
    wallClockSeconds: WALL_CLOCK_RANGE.defaultSeconds,
    wholeGameTime: true,
  };
}

export function isAceFamily(playerType, engineConfigs) {
  return (
    isAceV8Family(playerType, engineConfigs) ||
    isAceV10Family(playerType, engineConfigs) ||
    isAceV13Family(playerType, engineConfigs)
  );
}

export function getEngineConfig(playerType, engineConfigs) {
  const normalized = normalizePlayerType(playerType);
  const direct = engineConfigs.find((entry) => entry.key === normalized);
  if (direct) {
    return direct;
  }
  return undefined;
}

export function isZeroInkEngine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.ZeroInk ||
    getEngineConfig(playerType, engineConfigs)?.kind === "zeroink"
  );
}

export function isRemoteEngine(playerType, engineConfigs) {
  const kind = getEngineConfig(playerType, engineConfigs)?.kind;
  // zero.ink is remote but uses time presets only (no Beg→Alpha strength slider).
  return kind === "remote" || kind === "zeroink";
}

/** Ka / Ishtar cloud engines — strength + thinking mode. */
export function isCloudRemoteEngine(playerType, engineConfigs) {
  return (
    isRemoteEngine(playerType, engineConfigs) &&
    !isZeroInkEngine(playerType, engineConfigs)
  );
}

export function isLocalEngine(playerType, engineConfigs) {
  const kind = getEngineConfig(playerType, engineConfigs)?.kind;
  return kind === "local" || kind === "quoridor-v3";
}

export function isTitaniumEngine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.TitaniumV16 ||
    playerType === PlayerType.TitaniumV17 ||
    playerType === PlayerType.TitaniumV18 ||
    getEngineConfig(playerType, engineConfigs)?.kind === "titanium"
  );
}

export function isQuoridorV3Engine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.QuoridorV3 ||
    getEngineConfig(playerType, engineConfigs)?.kind === "quoridor-v3"
  );
}

export function isAceV8JsEngine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.AceV8Js ||
    getEngineConfig(playerType, engineConfigs)?.kind === "ace-v8-js"
  );
}

export function isAceEngine(playerType, engineConfigs) {
  return isAceFamily(playerType, engineConfigs);
}

/** @deprecated use isAceEngine */
export const isAceV7Engine = isAceEngine;

export function isLocalMctsEngine(playerType, engineConfigs) {
  const kind = getEngineConfig(playerType, engineConfigs)?.kind;
  return (
    kind === "local" ||
    kind === "titanium" ||
    kind === "quoridor-v3" ||
    kind === "ace-v8-family" ||
    kind === "ace-v10-family" ||
    kind === "ace-v13-family"
  );
}

/** Map visit slider → iterative-deepening cap for Quoridor v3 (4–30 plies). */
export function maxDepthFromVisitsBudget(visits) {
  const t = sliderPositionFromVisits(visits) / LOCAL_VISITS_RANGE.sliderSteps;
  return Math.round(4 + t * 26);
}

export function formatMaxDepth(depth) {
  return `≤d${Math.min(30, Math.max(4, Math.round(depth)))}`;
}

/** Higher UCT = more exploration — weaker play (mirrors strength tiers). */
export function uctFromStrengthLevel(strengthLevel) {
  const level = Math.min(
    4,
    Math.max(0, Number(strengthLevel ?? StrengthLevel.Alpha)),
  );
  return [0.55, 0.45, 0.35, 0.28, 0.2][level];
}

export function defaultPlayerAiSettings(playerType, engineConfigs) {
  if (playerType === PlayerType.Human) {
    return defaultHumanClockSettings();
  }
  if (isTitaniumEngine(playerType, engineConfigs)) {
    return {
      searchDepthLimit: TITANIUM_DEPTH_UNLIMITED,
      wallClockSeconds: WALL_CLOCK_RANGE.defaultSeconds,
      wholeGameTime: true,
      visitsBudget: UNLIMITED_VISITS,
      cores: defaultThreadCount(),
    };
  }
  if (isQuoridorV3Engine(playerType, engineConfigs)) {
    return {
      wallClockSeconds: QUORIDOR_V3_WALL_CLOCK_DEFAULT,
      visitsBudget: visitsFromSliderPosition(
        Math.round(LOCAL_VISITS_RANGE.sliderSteps * 0.45),
      ),
    };
  }
  if (isAceFamily(playerType, engineConfigs)) {
    return {
      strengthLevel: 0,
      wallClockSeconds: ACE_WALL_CLOCK_DEFAULT,
      wholeGameTime: isAceV13Family(playerType, engineConfigs),
    };
  }
  if (isGorisansonEngine(playerType, engineConfigs)) {
    return {
      wallClockSeconds: WALL_CLOCK_RANGE.defaultSeconds,
      wholeGameTime: true,
      visitsBudget: LOCAL_VISITS_RANGE.default,
      gorisansonNet: GORISANSON_NET_EASY,
    };
  }
  if (isLocalEngine(playerType, engineConfigs)) {
    return {
      wallClockSeconds: WALL_CLOCK_RANGE.defaultSeconds,
      visitsBudget: LOCAL_VISITS_RANGE.default,
    };
  }
  if (isZeroInkEngine(playerType, engineConfigs)) {
    return {
      timeToMove: TimeToMove.Short,
    };
  }
  return {
    strengthLevel: StrengthLevel.Alpha,
    timeToMove: TimeToMove.Short,
  };
}

export function formatWallClock(seconds) {
  if (seconds < 1) {
    return `${(seconds * 1000).toFixed(0)}ms`;
  }
  if (Number.isInteger(seconds)) {
    return `${seconds}s`;
  }
  return `${seconds.toFixed(1)}s`;
}

export function formatVisits(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) {
    return "?";
  }
  if (v >= 1_000_000_000) {
    const billions = v / 1_000_000_000;
    return billions >= 10
      ? `${Math.round(billions)}B`
      : `${billions.toFixed(1)}B`;
  }
  if (v >= 1_000_000) {
    return `${(v / 1_000_000).toFixed(1)}M`;
  }
  if (v >= 10_000) {
    return `${(v / 1_000).toFixed(1)}k`;
  }
  return Math.round(v).toLocaleString();
}

export function formatVisitsCap(n) {
  if (isUnlimitedVisits(n)) {
    return "unlimited";
  }
  return `≤${formatVisits(clampVisits(n))}`;
}

function strengthLevelLabel(level) {
  return (
    STRENGTH_LEVEL_PRESETS.find((preset) => preset.id === level)?.label ??
    "Alpha"
  );
}

function timeToMoveLabel(timeMode) {
  return (
    TIME_TO_MOVE_PRESETS.find((preset) => preset.id === timeMode)?.label ??
    "Short"
  );
}

export function describePlayerAiSettings(
  playerType,
  aiSettings,
  engineConfigs,
) {
  if (playerType === PlayerType.Human || !aiSettings) {
    return "";
  }
  const config = getEngineConfig(playerType, engineConfigs);
  if (!config) {
    return "";
  }

  if (isLocalMctsEngine(playerType, engineConfigs)) {
    const time = formatWallClock(
      aiSettings.wallClockSeconds ?? WALL_CLOCK_RANGE.defaultSeconds,
    );
    const cap = formatVisitsCap(
      aiSettings.visitsBudget ?? LOCAL_VISITS_RANGE.default,
    );
    if (isTitaniumEngine(playerType, engineConfigs)) {
      const depthLabel = formatTitaniumDepthLimit(
        aiSettings.searchDepthLimit ?? migrateTitaniumDepthLimit(aiSettings),
      );
      const tier =
        playerType === PlayerType.TitaniumV16
          ? catLmrCeilingLabel(aiSettings)
          : "NNUE";
      const budgetLabel = "nodes";
      const cores = resolveCores(aiSettings);
      const threads = cores > 1 ? ` · ${cores} threads` : "";
      return `${config.name}: ${time} · ${cap} ${budgetLabel} · ${depthLabel}${threads}`;
    }
    if (isQuoridorV3Engine(playerType, engineConfigs)) {
      const depthCap = formatMaxDepth(
        maxDepthFromVisitsBudget(aiSettings.visitsBudget),
      );
      return `${config.name}: ${time} · ${depthCap}`;
    }
    if (isGorisansonEngine(playerType, engineConfigs)) {
      const cap = formatVisitsCap(
        aiSettings.visitsBudget ?? LOCAL_VISITS_RANGE.default,
      );
      const bank =
        aiSettings.wholeGameTime !== false ? "whole game" : "per move";
      const tier = gorisansonNetLabel(aiSettings);
      return `${config.name}: ${time} · ${cap} · ${bank} · ${tier}`;
    }
    if (isAceFamily(playerType, engineConfigs)) {
      return `${aceDisplayName(aiSettings.strengthLevel, playerType)}: ${time}`;
    }
    return `${config.name}: ${time} · ${cap}`;
  }

  if (isZeroInkEngine(playerType, engineConfigs) && config?.visits) {
    const timeMode = aiSettings.timeToMove ?? TimeToMove.Short;
    const visits = config.visits[timeMode];
    const time = timeToMoveLabel(timeMode);
    return `${config.name}: ${time} (~${visits.toLocaleString()} visits)`;
  }

  if (isCloudRemoteEngine(playerType, engineConfigs) && config.visits) {
    const timeMode = aiSettings.timeToMove ?? TimeToMove.Short;
    const visits = config.visits[timeMode];
    const parallelism = config.settings?.parallelism?.[timeMode];
    const strength = strengthLevelLabel(
      aiSettings.strengthLevel ?? StrengthLevel.Alpha,
    );
    const time = timeToMoveLabel(timeMode);
    let text = `${config.name}: ${strength} · ${time} (~${visits.toLocaleString()} visits)`;
    if (parallelism) {
      text += ` · ${parallelism} threads`;
    }
    return text;
  }

  return config.name;
}

export function describeAiSettingsForPlayers(
  players,
  playerAiSettings,
  engineConfigs,
) {
  const lines = players
    .map((playerType, index) =>
      describePlayerAiSettings(
        playerType,
        playerAiSettings[index],
        engineConfigs,
      ),
    )
    .filter(Boolean);
  return lines.length ? lines.join(" · ") : "No AI selected.";
}
