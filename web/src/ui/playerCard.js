/**
 * Compact player card — read-only during play.
 *
 * Shows: pawn icon, engine config summary, turn/thinking status,
 * live telemetry (score, depth, nodes, PV), and Play now when safe.
 *
 * Interactive engine settings live only in the unified player dialog.
 */

import { PlayerType, StrengthLevel, TimeToMove } from '../lib/engineConfig.js';
import { playerColorName } from '../lib/playerColors.js';
import { formatScoreForCard, isMateScore } from '../lib/engineScore.js';
import { canPlayNow, resolveLiveBestMoveKey } from '../lib/liveBestMove.js';
import { aceStrengthPresetsForPlayerType } from '../lib/aceTier.js';
import {
  STRENGTH_LEVEL_PRESETS,
  TIME_TO_MOVE_PRESETS,
  formatWallClock,
} from '../lib/timeControl.js';

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatMs(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  const n = Number(ms);
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`;
}

function formatNodes(n) {
  if (!n || n <= 0) return '';
  return Number(n).toLocaleString();
}

function resolvePayloadScore(snap) {
  if (!snap) return null;
  const deep = deepestEntry(snap.depthLog);
  return deep?.score ?? snap.score ?? snap.rootScore ?? null;
}

function deepestEntry(depthLog) {
  if (!depthLog?.length) return null;
  return depthLog.reduce((best, e) => (e.depth > (best?.depth ?? 0) ? e : best));
}

function resolveNodes(snap) {
  if (!snap) return 0;
  const deep = deepestEntry(snap.depthLog);
  return Math.max(
    Number(snap.nodes) || 0,
    Number(snap.simulations) || 0,
    Number(deep?.nodes) || 0,
  );
}

function resolveDepth(snap) {
  if (!snap) return null;
  const deep = deepestEntry(snap.depthLog);
  return deep?.depth ?? snap.depth ?? snap.searchDepth ?? null;
}

function expandStrengthLabel(label) {
  switch (label) {
    case 'Beg.': return 'Beginner';
    case 'Inter.': return 'Intermediate';
    case 'Adv.': return 'Advanced';
    default: return label;
  }
}

function formatTimeSummary(seconds) {
  const formatted = formatWallClock(seconds ?? 10);
  if (formatted.endsWith('ms')) return formatted;
  if (formatted.endsWith('s') && !formatted.includes(' ')) {
    return formatted.replace(/s$/, ' s');
  }
  return formatted;
}

/** Compact read-only config line for the card, e.g. "Ka · Alpha · Long". */
export function compactPlayerConfigSummary(ui) {
  if (!ui || ui.isHuman) return 'Human';

  const engine = shortEngineName(ui.playerType);

  if (ui.isRemote) {
    const strength = expandStrengthLabel(
      STRENGTH_LEVEL_PRESETS.find((p) => p.id === (ui.strengthLevel ?? StrengthLevel.Alpha))?.label
        ?? 'Alpha',
    );
    const time = TIME_TO_MOVE_PRESETS.find((p) => p.id === (ui.timeToMove ?? TimeToMove.Short))?.label
      ?? 'Short';
    return `${engine} · ${strength} · ${time}`;
  }

  if (ui.isAceFamily) {
    const tiers = aceStrengthPresetsForPlayerType(ui.playerType);
    const tier = tiers.find((t) => t.id === (ui.strengthLevel ?? 0))?.label ?? 'JS';
    return `${engine} · ${tier} · ${formatTimeSummary(ui.wallClockSeconds)}`;
  }

  if (ui.isTitanium) {
    const strength = expandStrengthLabel(
      STRENGTH_LEVEL_PRESETS.find((p) => p.id === (ui.strengthLevel ?? StrengthLevel.Alpha))?.label
        ?? 'Alpha',
    );
    return `${engine} · ${strength} · ${formatTimeSummary(ui.wallClockSeconds)}`;
  }

  return `${engine} · ${formatTimeSummary(ui.wallClockSeconds)}`;
}

function shortEngineName(playerType) {
  if (playerType === PlayerType.TitaniumMinimax || playerType === PlayerType.TitaniumV15Frozen) {
    return 'Titanium';
  }
  if (playerType === PlayerType.GorisansonMCTS) return 'Gorisanson';
  if (playerType === PlayerType.QuoridorV3) return 'Quoridor v3';
  if (playerType === PlayerType.KaAI) return 'Ka';
  if (playerType === PlayerType.IshtarV3 || playerType === PlayerType.IshtarPonder) return 'Ishtar';
  if (playerType === PlayerType.AceV8) return 'ACE v8';
  if (playerType === PlayerType.AceV10) return 'ACE v10';
  if (playerType === PlayerType.AceV13) return 'ACE v13';
  return String(playerType);
}

export function renderPlayerCard(container, state, seatIndex, controller) {
  const playerType = state.settings.players[seatIndex];
  const isHuman = playerType === PlayerType.Human;
  const isThinking = state.aiThinking && state.thinkingSeatIndex === seatIndex;
  const isMyTurn = !state.winner && !state.isDraw && state.playerToMove === seatIndex + 1;
  const colorName = playerColorName(seatIndex + 1);
  const ui = state.playerAiSettingsUi?.[seatIndex];

  const liveSnap = isThinking ? state.liveSearch : null;
  const completedSnap = state.lastCompletedThinkBySeat?.[seatIndex];
  const snap = liveSnap ?? completedSnap;

  const configSummary = compactPlayerConfigSummary(ui);
  const bestMove = snap?.move ?? (liveSnap ? null : completedSnap?.move ?? null);
  const depth = resolveDepth(snap);
  const nodes = resolveNodes(snap);
  const score = resolvePayloadScore(snap);
  const thinkMs = liveSnap?.elapsedMs ?? snap?.thinkMs ?? null;
  const rootWinRate = snap?.rootWinRate ?? null;

  const livePvMove = isThinking
    ? resolveLiveBestMoveKey({
      ...state,
      thinkingSeatIndex: seatIndex,
      searchGeneration: state.searchGeneration,
    })
    : null;

  let statusText = '';
  if (state.winner) {
    statusText = state.winner === seatIndex + 1 ? 'Winner!' : '';
  } else if (state.isDraw) {
    statusText = 'Draw';
  } else if (isThinking) {
    statusText = 'Thinking…';
  } else if (isMyTurn && isHuman) {
    statusText = 'Your turn';
  } else if (isMyTurn) {
    statusText = 'Waiting…';
  }

  let scoreDisplay = '';
  const isMate = isMateScore(score);
  if (score != null && Number.isFinite(Number(score))) {
    scoreDisplay = formatScoreForCard(score);
  } else if (rootWinRate != null) {
    scoreDisplay = `${(rootWinRate * 100).toFixed(0)}%`;
  }

  const showPlayNow = isThinking && canPlayNow({
    ...state,
    thinkingSeatIndex: seatIndex,
    searchGeneration: state.searchGeneration,
  });

  container.innerHTML = `
    <div class="player-card player-card--seat${seatIndex}${isMyTurn ? ' player-card--active' : ''}${state.winner === seatIndex + 1 ? ' player-card--winner' : ''}" data-player-card-seat="${seatIndex}">
      <div class="player-card__main">
        <div class="player-card__left">
          <div class="player-card__pawn pawn-icon pawn-icon--seat${seatIndex}"></div>
          <div class="player-card__info">
            <div class="player-card__name">${escHtml(colorName)}</div>
            <div class="player-card__config">${escHtml(configSummary)}</div>
            ${statusText ? `<div class="player-card__status${isThinking ? ' player-card__status--thinking' : ''}" data-player-card-status="${seatIndex}">${escHtml(statusText)}</div>` : ''}
            ${bestMove && !isThinking ? `<div class="player-card__bestmove">played <strong>${escHtml(bestMove)}</strong></div>` : ''}
            ${livePvMove ? `<div class="player-card__bestmove">pv <strong>${escHtml(livePvMove)}</strong></div>` : ''}
          </div>
        </div>
        <div class="player-card__right">
          <div class="player-card__stats">
            ${scoreDisplay ? `<span class="player-card__score${isMate ? ' player-card__score--mate' : ''}">${escHtml(scoreDisplay)}</span>` : ''}
            ${depth != null ? `<span class="player-card__stat"><span class="player-card__stat-label">d</span>${depth}</span>` : ''}
            ${nodes > 0 ? `<span class="player-card__stat"><span class="player-card__stat-label">n</span>${escHtml(formatNodes(nodes))}</span>` : ''}
            ${thinkMs != null ? `<span class="player-card__stat">${escHtml(formatMs(thinkMs))}</span>` : ''}
          </div>
          ${showPlayNow ? `<button class="btn btn--playnow" data-action="play-now" title="Stop search and play current best move">Play now</button>` : ''}
        </div>
      </div>
    </div>
  `;

  container.querySelector('[data-action="play-now"]')?.addEventListener('click', () => {
    controller.playNow?.();
  });
}
