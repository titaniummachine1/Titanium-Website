/**
 * Per-player AI settings — matches scraped quoridor-ai.netlify.app controls.
 *
 * Remote (Ishtar/Ka): AI Strength (Beg→Alpha) + AI Time (Immediate→Long) sliders.
 * Local (Gorisanson): wall-clock + visit-budget sliders.
 */

import { PlayerType, StrengthLevel, TimeToMove } from './engineConfig.js';
import { aceDisplayName } from './aceTier.js';

/** Scraped StrengthLevel slider — legacy label, kept for remote UI parity. */
export const STRENGTH_LEVEL_PRESETS = [
  { id: StrengthLevel.Beginner, label: 'Beg.' },
  { id: StrengthLevel.Intermediate, label: 'Inter.' },
  { id: StrengthLevel.Advanced, label: 'Adv.' },
  { id: StrengthLevel.Expert, label: 'Expert' },
  { id: StrengthLevel.Alpha, label: 'Alpha' },
];

/** Scraped timeToMove slider — drives visit count on cloud engines. */
export const TIME_TO_MOVE_PRESETS = [
  { id: TimeToMove.Intuition, label: 'Immediate' },
  { id: TimeToMove.Short, label: 'Short' },
  { id: TimeToMove.Medium, label: 'Medium' },
  { id: TimeToMove.Long, label: 'Long' },
];

export const WALL_CLOCK_RANGE = {
  min: 0.5,
  max: 60,
  step: 0.5,
  defaultSeconds: 10,
};

/** Upper cap for the thread slider when logical CPU count is unknown or very high. */
export const THREADS_HARD_MAX = 8;

/** Default Titanium / local search thread count. */
export const DEFAULT_THREAD_COUNT = 8;

/** Max threads in the UI — machine logical CPUs, capped at 8; 8 if unknown. */
export function threadsSliderMax() {
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency > 0) {
    return Math.max(1, Math.min(navigator.hardwareConcurrency, THREADS_HARD_MAX));
  }
  return THREADS_HARD_MAX;
}

/** Default thread count for new Titanium seats (clamped to slider max). */
export function defaultThreadCount() {
  return Math.min(DEFAULT_THREAD_COUNT, threadsSliderMax());
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

/** Titanium difficulty tiers (NNUE weight sets). */
export const TITANIUM_NET_EASY = 'easy';
export const TITANIUM_NET_MEDIUM = 'medium';
export const TITANIUM_NET_HARD = 'hard';

/** @deprecated Use TITANIUM_NET_* — kept for saved-prefs migration. */
export const TITANIUM_NET_LIVE = TITANIUM_NET_MEDIUM;
export const TITANIUM_NET_FROZEN = TITANIUM_NET_EASY;

export function migrateTitaniumNet(net) {
  if (net === 'frozen' || net === TITANIUM_NET_EASY) return TITANIUM_NET_EASY;
  if (net === 'live' || net === TITANIUM_NET_MEDIUM) return TITANIUM_NET_MEDIUM;
  if (net === 'hard' || net === TITANIUM_NET_HARD) return TITANIUM_NET_HARD;
  return TITANIUM_NET_HARD;
}

export function resolveTitaniumEngineMode(aiSettings, playerType, engineConfigs) {
  if (playerType === PlayerType.TitaniumV16) {
    return 'titanium-v16';
  }
  if (playerType === PlayerType.TitaniumV15Frozen) {
    return 'titanium-v15-frozen';
  }
  const config = getEngineConfig(playerType, engineConfigs);
  const net = migrateTitaniumNet(aiSettings?.titaniumNet ?? TITANIUM_NET_HARD);
  if (net === TITANIUM_NET_EASY || config?.engineMode === 'titanium-v15-frozen') {
    return 'titanium-v15-frozen';
  }
  if (net === TITANIUM_NET_MEDIUM || config?.engineMode === 'titanium-v15-medium') {
    return 'titanium-v15-medium';
  }
  return config?.engineMode ?? 'titanium-v15';
}

/** v16 CAT LMR ceiling (cm) from Easy/Medium/Hard difficulty. */
export function resolveCatLmrCeiling(aiSettings) {
  const net = migrateTitaniumNet(aiSettings?.titaniumNet ?? TITANIUM_NET_HARD);
  if (net === TITANIUM_NET_EASY) return 500;
  if (net === TITANIUM_NET_MEDIUM) return 800;
  return 1000;
}

export function catLmrCeilingLabel(aiSettings) {
  return `CAT ${resolveCatLmrCeiling(aiSettings)}`;
}

export function titaniumNetLabel(aiSettings) {
  const net = migrateTitaniumNet(aiSettings?.titaniumNet ?? TITANIUM_NET_HARD);
  if (net === TITANIUM_NET_EASY) return 'Easy';
  if (net === TITANIUM_NET_MEDIUM) return 'Medium';
  return 'Hard';
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
  return isUnlimitedVisits(visitsBudget) ? UNLIMITED_VISITS : clampVisits(visitsBudget);
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
    playerType === PlayerType.AceV8 ||
    playerType === PlayerType.AceV8Ti ||
    playerType === PlayerType.AceV8TiPmc ||
    playerType === PlayerType.AceV8Js ||
    playerType === PlayerType.QuoridorV3
  ) {
    return PlayerType.TitaniumMinimax;
  }
  if (playerType === PlayerType.TitaniumV15Frozen) {
    return PlayerType.TitaniumMinimax;
  }
  if (playerType === PlayerType.Titanium) {
    return PlayerType.TitaniumMinimax;
  }
  if (playerType === PlayerType.AceV10) {
    return PlayerType.TitaniumMinimax;
  }
  return playerType;
}

export function isAceV8Family(playerType, engineConfigs) {
  const normalized = normalizePlayerType(playerType);
  return (
    normalized === PlayerType.AceV8 ||
    getEngineConfig(normalized, engineConfigs)?.kind === 'ace-v8-family'
  );
}

export function isAceV10Family(playerType, engineConfigs) {
  const normalized = normalizePlayerType(playerType);
  return (
    normalized === PlayerType.AceV10 ||
    getEngineConfig(normalized, engineConfigs)?.kind === 'ace-v10-family'
  );
}

export function isAceV13Family(playerType, engineConfigs) {
  const normalized = normalizePlayerType(playerType);
  return (
    normalized === PlayerType.AceV13 ||
    getEngineConfig(normalized, engineConfigs)?.kind === 'ace-v13-family'
  );
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
    getEngineConfig(playerType, engineConfigs)?.kind === 'zeroink'
  );
}

export function isRemoteEngine(playerType, engineConfigs) {
  const kind = getEngineConfig(playerType, engineConfigs)?.kind;
  // zero.ink is remote but uses time presets only (no Beg→Alpha strength slider).
  return kind === 'remote' || kind === 'zeroink';
}

/** Ka / Ishtar cloud engines — strength + thinking mode. */
export function isCloudRemoteEngine(playerType, engineConfigs) {
  return isRemoteEngine(playerType, engineConfigs) && !isZeroInkEngine(playerType, engineConfigs);
}

export function isLocalEngine(playerType, engineConfigs) {
  const kind = getEngineConfig(playerType, engineConfigs)?.kind;
  return kind === 'local' || kind === 'quoridor-v3';
}

export function isTitaniumEngine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.Titanium ||
    playerType === PlayerType.TitaniumMinimax ||
    playerType === PlayerType.TitaniumV16 ||
    playerType === PlayerType.TitaniumV15Frozen ||
    getEngineConfig(playerType, engineConfigs)?.kind === 'titanium'
  );
}

export function isQuoridorV3Engine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.QuoridorV3 ||
    getEngineConfig(playerType, engineConfigs)?.kind === 'quoridor-v3'
  );
}

export function isAceV8JsEngine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.AceV8Js ||
    getEngineConfig(playerType, engineConfigs)?.kind === 'ace-v8-js'
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
    kind === 'local' ||
    kind === 'titanium' ||
    kind === 'quoridor-v3' ||
    kind === 'ace-v8-family' ||
    kind === 'ace-v10-family' ||
    kind === 'ace-v13-family'
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
  const level = Math.min(4, Math.max(0, Number(strengthLevel ?? StrengthLevel.Alpha)));
  return [0.55, 0.45, 0.35, 0.28, 0.2][level];
}

export function defaultPlayerAiSettings(playerType, engineConfigs) {
  if (playerType === PlayerType.Human) {
    return null;
  }
  if (isTitaniumEngine(playerType, engineConfigs)) {
    return {
      titaniumNet: TITANIUM_NET_HARD,
      wallClockSeconds: WALL_CLOCK_RANGE.defaultSeconds,
      visitsBudget: UNLIMITED_VISITS,
      cores: defaultThreadCount(),
    };
  }
  if (isQuoridorV3Engine(playerType, engineConfigs)) {
    return {
      wallClockSeconds: QUORIDOR_V3_WALL_CLOCK_DEFAULT,
      visitsBudget: visitsFromSliderPosition(Math.round(LOCAL_VISITS_RANGE.sliderSteps * 0.45)),
    };
  }
  if (isAceFamily(playerType, engineConfigs)) {
    return {
      strengthLevel: 0,
      wallClockSeconds: ACE_WALL_CLOCK_DEFAULT,
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
    return '?';
  }
  if (v >= 1_000_000_000) {
    const billions = v / 1_000_000_000;
    return billions >= 10 ? `${Math.round(billions)}B` : `${billions.toFixed(1)}B`;
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
    return 'unlimited';
  }
  return `≤${formatVisits(clampVisits(n))}`;
}

function strengthLevelLabel(level) {
  return STRENGTH_LEVEL_PRESETS.find((preset) => preset.id === level)?.label ?? 'Alpha';
}

function timeToMoveLabel(timeMode) {
  return TIME_TO_MOVE_PRESETS.find((preset) => preset.id === timeMode)?.label ?? 'Short';
}

export function describePlayerAiSettings(playerType, aiSettings, engineConfigs) {
  if (playerType === PlayerType.Human || !aiSettings) {
    return '';
  }
  const config = getEngineConfig(playerType, engineConfigs);
  if (!config) {
    return '';
  }

  if (isLocalMctsEngine(playerType, engineConfigs)) {
    const time = formatWallClock(aiSettings.wallClockSeconds ?? WALL_CLOCK_RANGE.defaultSeconds);
    const cap = formatVisitsCap(aiSettings.visitsBudget ?? LOCAL_VISITS_RANGE.default);
    if (isTitaniumEngine(playerType, engineConfigs)) {
      const tier =
        playerType === PlayerType.TitaniumV16
          ? catLmrCeilingLabel(aiSettings)
          : `${titaniumNetLabel(aiSettings)} NNUE`;
      const budgetLabel = 'nodes';
      const cores = resolveCores(aiSettings);
      const threads = cores > 1 ? ` · ${cores} threads` : '';
      return `${config.name}: ${time} · ${cap} ${budgetLabel} · ${tier}${threads}`;
    }
    if (isQuoridorV3Engine(playerType, engineConfigs)) {
      const depthCap = formatMaxDepth(maxDepthFromVisitsBudget(aiSettings.visitsBudget));
      return `${config.name}: ${time} · ${depthCap}`;
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
    const strength = strengthLevelLabel(aiSettings.strengthLevel ?? StrengthLevel.Alpha);
    const time = timeToMoveLabel(timeMode);
    let text = `${config.name}: ${strength} · ${time} (~${visits.toLocaleString()} visits)`;
    if (parallelism) {
      text += ` · ${parallelism} threads`;
    }
    return text;
  }

  return config.name;
}

export function describeAiSettingsForPlayers(players, playerAiSettings, engineConfigs) {
  const lines = players
    .map((playerType, index) =>
      describePlayerAiSettings(playerType, playerAiSettings[index], engineConfigs),
    )
    .filter(Boolean);
  return lines.length ? lines.join(' · ') : 'No AI selected.';
}
