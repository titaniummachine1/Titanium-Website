/**
 * Opponent registry — local, remote, and future competition targets.
 */

import { PlayerType, TimeToMove, getEngineList } from './engineConfig.js';
import {
  STRENGTH_LEVEL_PRESETS,
  TIME_TO_MOVE_PRESETS,
  describeAiSettingsForPlayers,
  formatWallClock,
  getEngineConfig,
  isQuoridorV3Engine,
  isAceEngine,
} from './timeControl.js';

export { STRENGTH_LEVEL_PRESETS, TIME_TO_MOVE_PRESETS };
/** @deprecated use TIME_TO_MOVE_PRESETS */
export const TIME_PRESETS = TIME_TO_MOVE_PRESETS;

const GORISANSON_ENGINE = {
  kind: 'local',
  name: 'Gorisanson (JS, original)',
  key: PlayerType.GorisansonMCTS,
  tooltip: 'Original JavaScript MCTS — first boss (github.com/gorisanson/quoridor-ai)',
  uctConst: 0.2,
};

const TITANIUM_V16_ENGINE = {
  kind: 'titanium',
  name: 'Titanium v16',
  key: PlayerType.TitaniumV16,
  engineMode: 'titanium-v16',
  tooltip:
    'Titanium v16 — embedded pawn LUT, instant cold start. Easy/Medium/Hard sets CAT ceiling (500/800/1000 cm).',
};

const TITANIUM_V17_ENGINE = {
  kind: 'titanium',
  name: 'Titanium v17',
  key: PlayerType.TitaniumV17,
  engineMode: 'titanium-v17',
  tooltip:
    'Titanium v17 — current strongest (SF history, q-search, CAT LMR, lazy top-N, ACE LMP/RFP). Pawn LUT builds on first load (~1–2s).',
};

const ZERO_INK_ENGINE = {
  kind: 'zeroink',
  name: 'zero.ink (AlphaZero)',
  key: PlayerType.ZeroInk,
  // Difficulty maps to MCTS visits — same `visits`-by-timeToMove shape the cloud
  // engines (Ishtar/Ka) use. The Time preset picks the level; the client POSTs
  // the matching visit count to /api/play.
  visits: {
    [TimeToMove.Intuition]: 3_200,
    [TimeToMove.Short]: 32_000,
    [TimeToMove.Medium]: 128_000,
    [TimeToMove.Long]: 400_000,
  },
  tooltip:
    'quoridor-zero.ink AlphaZero net over REST. Needs network access.',
};

const ACE_V13_ENGINE = {
  kind: 'ace-v13-family',
  name: 'ACE v13',
  key: PlayerType.AceV13,
  tooltip:
    'ACE v13 — use Version slider: JS (HTML) → Rust → MoveGen+ (no EME)',
};

export function getAllEngineConfigs() {
  const remote = getEngineList().map((entry) => ({
    ...entry,
    kind: 'remote',
  }));
  return [
    GORISANSON_ENGINE,
    TITANIUM_V17_ENGINE,
    TITANIUM_V16_ENGINE,
    ACE_V13_ENGINE,
    ZERO_INK_ENGINE,
    ...remote,
  ];
}

export function getPlayerOptionGroups() {
  return [
    {
      label: 'Human',
      options: [{ value: PlayerType.Human, label: 'Human', disabled: false }],
    },
    {
      label: 'Local — beat these first',
      options: [
        {
          value: PlayerType.GorisansonMCTS,
          label: 'Gorisanson (JS, original)',
          disabled: false,
          tooltip: GORISANSON_ENGINE.tooltip,
        },
        {
          value: PlayerType.TitaniumV17,
          label: TITANIUM_V17_ENGINE.name,
          disabled: false,
          tooltip: TITANIUM_V17_ENGINE.tooltip,
        },
        {
          value: PlayerType.TitaniumV16,
          label: TITANIUM_V16_ENGINE.name,
          disabled: false,
          tooltip: TITANIUM_V16_ENGINE.tooltip,
        },
        {
          value: PlayerType.AceV13,
          label: ACE_V13_ENGINE.name,
          disabled: false,
          tooltip: ACE_V13_ENGINE.tooltip,
        },
      ],
    },
    {
      label: 'Remote',
      options: [
        { value: PlayerType.IshtarV3, label: 'Ishtar', disabled: false },
        { value: PlayerType.KaAI, label: 'Ka', disabled: false },
        {
          value: PlayerType.ZeroInk,
          label: ZERO_INK_ENGINE.name,
          disabled: false,
          tooltip: ZERO_INK_ENGINE.tooltip,
        },
      ],
    },
  ];
}

export function flattenPlayerOptions(groups) {
  return groups.flatMap((group) => group.options);
}

export function describeTimeBudget(players, playerAiSettings, engineConfigs) {
  return describeAiSettingsForPlayers(players, playerAiSettings, engineConfigs);
}

export function describeActiveSearchInfo(
  players,
  searchInfoBySeat,
  engineConfigs,
  { thinkingSeatIndex = null, aiThinking = false } = {},
) {
  const formatOne = (playerType, seatIndex) => {
    const info = searchInfoBySeat?.[seatIndex];
    const line = describeSearchInfo(playerType, info, engineConfigs);
    if (!line) {
      return '';
    }
    if (aiThinking && thinkingSeatIndex != null && seatIndex !== thinkingSeatIndex) {
      return '';
    }
    const aiSeats = players
      .map((p, i) => (p !== PlayerType.Human ? i : -1))
      .filter((i) => i >= 0);
    if (aiSeats.length > 1 && !aiThinking) {
      const label = seatIndex === 0 ? 'W' : 'B';
      return `${label} ${line}`;
    }
    return line;
  };
  return players
    .map((playerType, seatIndex) =>
      playerType === PlayerType.Human ? '' : formatOne(playerType, seatIndex),
    )
    .filter(Boolean)
    .join(' · ');
}

import { formatEngineScore, isMateScore, mateInfo } from './engineScore.js';
import { resolveDisplayNodes } from './searchNodes.js';

export { formatEngineScore, isMateScore, mateInfo };

const SEARCH_STOP_LABELS = {
  visits: 'hit cap',
  time: 'time',
  converged: 'converged',
  trivial: 'instant',
  opening: 'opening',
  minimax: 'minimax',
  ace: 'ACE v8',
  'ace-v10-js': 'ACE v10 JS',
  'ace-v10': 'ACE v10 Rust',
  'ace-v10-ti': 'ACE v10 MoveGen+',
  'ace-v10-ti-pmc': 'ACE v10 MoveGen+ EME',
  'ace-v13-js': 'ACE v13 JS',
  'ace-v13': 'ACE v13 Rust',
  'ace-v13-ti': 'ACE v13 MoveGen+',
  'titanium-v17': 'Titanium v17',
  'titanium-v16': 'Titanium v16',
  zeroink: 'zero.ink',
  mcts: 'MCTS',
  hybrid: 'hybrid',
  race: 'win path',
  searching: 'searching',
};

function pickSearchDepthSource(liveSearch, searchInfo) {
  if (liveSearch?.depthLog?.length > 0) {
    return { depthLog: liveSearch.depthLog, header: liveSearch, live: true };
  }
  if (searchInfo?.depthLog?.length > 0) {
    return { depthLog: searchInfo.depthLog, header: searchInfo, live: false };
  }
  if (liveSearch?.mode) {
    return { depthLog: null, header: liveSearch, live: true };
  }
  return null;
}

function buildSearchDepthHeader(header, { live }) {
  if (!header) {
    return '';
  }
  const parts = [];
  if (header.playerLabel) {
    parts.push(escapeHtml(header.playerLabel));
  }
  if (live) {
    parts.push('searching');
  } else if (header.time != null) {
    parts.push(formatWallClock(header.time / 1000));
  }
  const isAb =
    header.stoppedBy === 'minimax' ||
    header.mode === 'minimax' ||
    header.stoppedBy === 'ace' ||
    header.stoppedBy === 'ace-v10-js' ||
    header.stoppedBy === 'ace-v10' ||
    header.stoppedBy === 'ace-v10-ti' ||
    header.stoppedBy === 'ace-v10-ti-pmc' ||
    header.stoppedBy === 'ace-v13-js' ||
    header.stoppedBy === 'ace-v13' ||
    header.stoppedBy === 'ace-v13-ti' ||
    header.mode === 'ace-v10-js' ||
    header.mode === 'ace-v10' ||
    header.mode === 'ace-v10-ti' ||
    header.mode === 'ace-v10-ti-pmc' ||
    header.mode === 'ace-v13-js' ||
    header.mode === 'ace-v13' ||
    header.mode === 'ace-v13-ti' ||
    header.stoppedBy === 'titanium-v17' ||
    header.mode === 'titanium-v17' ||
    header.stoppedBy === 'titanium-v16' ||
    header.mode === 'titanium-v16' ||
    header.playerLabel?.includes('Titanium') ||
    header.playerLabel?.includes('Quoridor v3') ||
    header.playerLabel?.includes('ACE v8') ||
    header.playerLabel?.includes('ACE v13');
  const displayNodes = resolveDisplayNodes(header);
  if (displayNodes > 0) {
    parts.push(`${displayNodes.toLocaleString()} nodes`);
  } else if (header.simulations != null && !isAb) {
    parts.push(`${Number(header.simulations).toLocaleString()} sims`);
  }
  if (header.whiteDist != null) {
    parts.push(`W${header.whiteDist} B${header.blackDist}`);
  }
  const stopKey = header.stoppedBy ?? header.mode;
  const stopLabel = SEARCH_STOP_LABELS[stopKey];
  if (stopLabel && !live) {
    parts.push(stopLabel);
  }
  if (!parts.length) {
    return '';
  }
  return `<div class="search-depth__header">${parts.join(' · ')}</div>`;
}

export function buildSearchDepthPanel(liveSearch, searchInfo) {
  const source = pickSearchDepthSource(liveSearch, searchInfo);
  if (!source) {
    return '';
  }
  const header = buildSearchDepthHeader(source.header, { live: source.live });
  if (!source.depthLog?.length) {
    return header;
  }

  const byDepth = new Map(source.depthLog.map((entry) => [entry.depth, entry]));
  const newestFirst = [...source.depthLog].sort((a, b) => b.depth - a.depth);
  const rows = newestFirst
    .map((entry) => {
      const prev = byDepth.get(entry.depth - 1);
      const delta =
        prev && Number.isFinite(entry.score) && Number.isFinite(prev.score)
          ? entry.score - prev.score
          : null;
      const deltaClass =
        delta == null ? '' : delta > 0 ? 'search-depth__delta--up' : delta < 0 ? 'search-depth__delta--down' : '';
      const deltaText =
        delta == null ? '' : ` (${delta > 0 ? '+' : ''}${formatEngineScore(delta)})`;
      const pv = entry.pv ? `<span class="search-depth__pv">${escapeHtml(entry.pv)}</span>` : '';
      return `<tr>
        <td class="search-depth__d">d${entry.depth}</td>
        <td class="search-depth__eval">${formatEngineScore(entry.score)}${deltaText ? `<span class="search-depth__delta ${deltaClass}">${escapeHtml(deltaText)}</span>` : ''}</td>
        <td class="search-depth__nodes">${Number(entry.nodes ?? 0).toLocaleString()}</td>
        <td class="search-depth__pvcell">${pv}</td>
      </tr>`;
    })
    .join('');
  const wrSource = source.live ? liveSearch : searchInfo;
  const showWr =
    wrSource?.rootWinRate != null &&
    wrSource.stoppedBy !== 'minimax' &&
    wrSource.mode !== 'minimax' &&
    !wrSource.playerLabel?.includes('Titanium');
  const wr = showWr
    ? `<div class="search-depth__wr">Win rate: <strong>${(wrSource.rootWinRate * 100).toFixed(1)}%</strong></div>`
    : '';
  return `${header}${wr}<table class="search-depth"><thead><tr><th>depth</th><th>eval</th><th>nodes</th><th>pv</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** Update depth panel in place during live search — avoids full sidebar re-render. */
export function updateSearchDepthPanel(container, state) {
  const host = container.querySelector('.status-panel');
  if (!host) {
    return;
  }
  const html = buildSearchDepthPanel(state.liveSearch, state.activeSearchInfo);
  const aiLine = host.querySelector('.status-line--search-info');
  if (aiLine) {
    aiLine.hidden = Boolean(html);
  }

  let panel = host.querySelector('.search-depth-panel');
  if (!html) {
    panel?.remove();
    return;
  }

  const pinTop = !panel || panel.scrollTop < 4;
  if (!panel) {
    panel = document.createElement('div');
    panel.className = 'search-depth-panel';
    host.appendChild(panel);
  }
  panel.innerHTML = html;
  if (pinTop) {
    panel.scrollTop = 0;
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function describeSearchInfo(playerType, searchInfo, engineConfigs) {
  if (!searchInfo || playerType === PlayerType.Human) {
    return '';
  }
  const config = getEngineConfig(playerType, engineConfigs);
  if (
    (config?.kind === 'local' ||
      config?.kind === 'titanium' ||
      config?.kind === 'quoridor-v3' ||
      config?.kind === 'ace') &&
    searchInfo.time != null
  ) {
    const isMinimax =
      searchInfo.stoppedBy === 'minimax' ||
      searchInfo.mode === 'minimax' ||
      config.engineMode === 'minimax' ||
      isQuoridorV3Engine(playerType, engineConfigs) ||
      isAceEngine(playerType, engineConfigs);
    const budgetLabel = isMinimax
      ? `${resolveDisplayNodes(searchInfo).toLocaleString()} nodes`
      : `${searchInfo.simulations?.toLocaleString() ?? '?'} sims`;
    const winPart =
      !isMinimax && searchInfo.rootWinRate != null
        ? ` · wr ${(searchInfo.rootWinRate * 100).toFixed(0)}%`
        : '';
    const distPart =
      searchInfo.whiteDist != null
        ? ` · W${searchInfo.whiteDist} B${searchInfo.blackDist}`
        : '';
    const limit = SEARCH_STOP_LABELS[searchInfo.stoppedBy] ?? '';
    const suffix = limit ? ` (${limit})` : '';
    const profile =
      searchInfo.profileName && isMinimax ? ` · ${searchInfo.profileName}` : '';
    const requestedThreads = Number(searchInfo.requestedThreads) || 0;
    const effectiveThreads = Number(searchInfo.effectiveThreads) || 0;
    const helperPart =
      config?.kind === 'titanium' && effectiveThreads > 1
        ? ` · t${effectiveThreads} h${searchInfo.helperStarts ?? 0}`
        : config?.kind === 'titanium' && requestedThreads > 1 && effectiveThreads === 1
          ? ` · t1/${requestedThreads} fallback`
          : '';
    return `${formatWallClock(searchInfo.time / 1000)} · ${budgetLabel}${winPart}${distPart}${profile}${helperPart}${suffix}`;
  }
  if (config?.kind === 'remote') {
    const parts = [];
    if (searchInfo.time != null) {
      parts.push(`${searchInfo.time}ms`);
    }
    if (searchInfo.visits != null) {
      parts.push(`${searchInfo.visits.toLocaleString()} visits`);
    }
    return parts.length ? `Last think: ${parts.join(' · ')}` : '';
  }
  if (config?.kind === 'zeroink' && searchInfo.time != null) {
    const parts = [formatWallClock(searchInfo.time / 1000)];
    if (searchInfo.visits != null) {
      parts.push(`${searchInfo.visits.toLocaleString()} visits`);
    }
    if (searchInfo.rootWinRate != null) {
      parts.push(`wr ${(searchInfo.rootWinRate * 100).toFixed(0)}%`);
    }
    return parts.join(' · ');
  }
  return '';
}
