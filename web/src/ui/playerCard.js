/**
 * Compact player card — shown above and below the board.
 *
 * Shows: pawn icon, player name, turn status, thinking progress,
 * current best move, depth, nodes, elapsed time, and a "Play now" button.
 *
 * The "top" card (Black, seat 1) and "bottom" card (White, seat 0)
 * swap visual positions when the board is flipped, but the canonical
 * seat assignment never changes.
 */

import { PlayerType } from '../lib/engineConfig.js';
import { playerColorName } from '../lib/playerColors.js';
import { formatScoreForCard, isMateScore } from '../lib/engineScore.js';

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

/**
 * Render a player card element into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} state   Full app state
 * @param {number} seatIndex  0=White, 1=Black
 * @param {object} controller
 */
export function renderPlayerCard(container, state, seatIndex, controller) {
  const playerType = state.settings.players[seatIndex];
  const isHuman = playerType === PlayerType.Human;
  const isThinking = state.aiThinking && state.thinkingSeatIndex === seatIndex;
  const isMyTurn = !state.winner && !state.isDraw && state.playerToMove === seatIndex + 1;
  const colorName = playerColorName(seatIndex + 1);

  // Resolve what to show
  const liveSnap = isThinking ? state.liveSearch : null;
  const completedSnap = state.lastCompletedThinkBySeat?.[seatIndex];
  const snap = liveSnap ?? completedSnap;

  const engineName = resolveEngineName(playerType, state, seatIndex);
  const bestMove = snap?.move ?? (liveSnap ? null : completedSnap?.move ?? null);
  const depth = resolveDepth(snap);
  const nodes = resolveNodes(snap);
  const score = resolvePayloadScore(snap);
  const thinkMs = liveSnap?.elapsedMs ?? snap?.thinkMs ?? null;
  const rootWinRate = snap?.rootWinRate ?? null;

  // Status line
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

  // Score display
  let scoreDisplay = '';
  const isMate = isMateScore(score);
  if (score != null && Number.isFinite(Number(score))) {
    scoreDisplay = formatScoreForCard(score);
  } else if (rootWinRate != null) {
    scoreDisplay = `${(rootWinRate * 100).toFixed(0)}%`;
  }

  // Play Now button: show when thinking and we have at least one completed move OR a best move from live search
  const hasValidBestMove = isThinking && (
    state.liveSearch?.move != null ||
    (completedSnap?.move != null && completedSnap.move !== '(none)')
  );

  container.innerHTML = `
    <div class="player-card player-card--seat${seatIndex}${isMyTurn ? ' player-card--active' : ''}${state.winner === seatIndex + 1 ? ' player-card--winner' : ''}">
      <div class="player-card__left">
        <div class="player-card__pawn pawn-icon pawn-icon--seat${seatIndex}"></div>
        <div class="player-card__info">
          <div class="player-card__name">${escHtml(colorName)}
            <span class="player-card__engine-label">${escHtml(isHuman ? 'Human' : engineName)}</span>
          </div>
          ${statusText ? `<div class="player-card__status${isThinking ? ' player-card__status--thinking' : ''}">${escHtml(statusText)}</div>` : ''}
          ${bestMove && !isThinking ? `<div class="player-card__bestmove">played <strong>${escHtml(bestMove)}</strong></div>` : ''}
          ${isThinking && liveSnap?.pv ? `<div class="player-card__bestmove">pv <strong>${escHtml(liveSnap.pv.trim().split(/\s+/)[0] || '…')}</strong></div>` : ''}
        </div>
      </div>
      <div class="player-card__right">
        <div class="player-card__stats">
          ${scoreDisplay ? `<span class="player-card__score${isMate ? ' player-card__score--mate' : ''}">${escHtml(scoreDisplay)}</span>` : ''}
          ${depth != null ? `<span class="player-card__stat"><span class="player-card__stat-label">d</span>${depth}</span>` : ''}
          ${nodes > 0 ? `<span class="player-card__stat"><span class="player-card__stat-label">n</span>${escHtml(formatNodes(nodes))}</span>` : ''}
          ${thinkMs != null ? `<span class="player-card__stat">${escHtml(formatMs(thinkMs))}</span>` : ''}
        </div>
        ${hasValidBestMove ? `<button class="btn btn--playnow" data-action="play-now" title="Stop search and play current best move">Play now</button>` : ''}
      </div>
    </div>
  `;

  // Wire Play Now
  container.querySelector('[data-action="play-now"]')?.addEventListener('click', () => {
    controller.playNow?.();
  });
}

function resolveEngineName(playerType, state, seatIndex) {
  if (playerType === PlayerType.Human) return 'Human';
  if (playerType === PlayerType.TitaniumMinimax) return 'Titanium v15';
  if (playerType === PlayerType.TitaniumV15Frozen) return 'Titanium v15 (frozen)';
  if (playerType === PlayerType.GorisansonMCTS) return 'Gorisanson';
  if (playerType === PlayerType.QuoridorV3) return 'Quoridor v3';
  if (playerType === PlayerType.KaAI) return 'Ka';
  if (playerType === PlayerType.IshtarV3 || playerType === PlayerType.IshtarPonder) return 'Ishtar';
  if (playerType === PlayerType.AceV10) return 'ACE v10';
  if (playerType === PlayerType.AceV13) return 'ACE v13';
  if (playerType === PlayerType.AceV8) return 'ACE v8';
  return String(playerType);
}
