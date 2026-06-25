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

/** Live vs pinned NNUE weights for Titanium v15 (one engine entry in the UI). */
export const TITANIUM_NET_LIVE = 'live';
export const TITANIUM_NET_FROZEN = 'frozen';

export function resolveTitaniumEngineMode(aiSettings, playerType, engineConfigs) {
  if (playerType === PlayerType.TitaniumV15Frozen) {
    return 'titanium-v15-frozen';
  }
  const config = getEngineConfig(playerType, engineConfigs);
  const net = aiSettings?.titaniumNet ?? TITANIUM_NET_LIVE;
  if (net === TITANIUM_NET_FROZEN || config?.engineMode === 'titanium-v15-frozen') {
    return 'titanium-v15-frozen';
  }
  return config?.engineMode ?? 'titanium-v15';
}

export function titaniumNetLabel(aiSettings) {
  const net = aiSettings?.titaniumNet ?? TITANIUM_NET_LIVE;
  return net === TITANIUM_NET_FROZEN ? 'Frozen' : 'Live';
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

export function isRemoteEngine(playerType, engineConfigs) {
  const kind = getEngineConfig(playerType, engineConfigs)?.kind;
  // zero.ink is a remote engine too — REST instead of WebSocket. It shares the
  // cloud-engine settings UI (thinking-mode selector → per-engine `visits` map).
  return kind === 'remote' || kind === 'zeroink';
}

export function isLocalEngine(playerType, engineConfigs) {
  const kind = getEngineConfig(playerType, engineConfigs)?.kind;
  return kind === 'local' || kind === 'quoridor-v3';
}

export function isTitaniumEngine(playerType, engineConfigs) {
  return (
    playerType === PlayerType.Titanium ||
    playerType === PlayerType.TitaniumMinimax ||
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
      titaniumNet: TITANIUM_NET_LIVE,
      wallClockSeconds: WALL_CLOCK_RANGE.defaultSeconds,
      visitsBudget: UNLIMITED_VISITS,
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
      const net = titaniumNetLabel(aiSettings);
      const budgetLabel = 'nodes';
      return `${config.name}: ${time} · ${cap} ${budgetLabel} · ${net} NNUE`;
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

  if (isRemoteEngine(playerType, engineConfigs) && config.visits) {
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
