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
import { formatScoreForCard, isMateScore, mateInfo } from '../lib/engineScore.js';
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

function escAttr(s) {
  return escHtml(s).replace(/"/g, '&quot;');
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

/**
 * Spinner ring around the player's colour token while it thinks.
 * It lives in document.body — not in the card's innerHTML — so the card's
 * frequent live re-renders (each engine depth/data refresh) never recreate it
 * and restart its animation. We only reposition it; the spin stays smooth.
 */
function updatePawnSpinner(container, active, seatIndex) {
  let spinner = container._pawnSpinner;
  if (!active) {
    if (spinner?.parentNode) spinner.parentNode.removeChild(spinner);
    return;
  }
  const pawnEl = container.querySelector('.player-card__pawn');
  if (!pawnEl) return;
  if (!spinner) {
    spinner = document.createElement('div');
    spinner.className = 'pawn-spinner';
    container._pawnSpinner = spinner;
  }
  spinner.dataset.seat = String(seatIndex);
  const r = pawnEl.getBoundingClientRect();
  spinner.style.left = `${r.left - 4}px`;
  spinner.style.top = `${r.top - 4}px`;
  spinner.style.width = `${r.width + 8}px`;
  spinner.style.height = `${r.height + 8}px`;
  if (spinner.parentNode !== document.body) document.body.appendChild(spinner);
}

export function renderPlayerCard(container, state, seatIndex, controller) {
  const playerType = state.settings.players[seatIndex];
  const isHuman = playerType === PlayerType.Human;
  const isThinking = state.aiThinking && state.thinkingSeatIndex === seatIndex;
  const isMyTurn = !state.winner && !state.isDraw && state.playerToMove === seatIndex + 1;
  const colorName = playerColorName(seatIndex + 1);
  const ui = state.playerAiSettingsUi?.[seatIndex];

  const engineStatus = state.engineStatus?.[seatIndex];
  const engineError = state.engineErrors?.[seatIndex];
  const hasError =
    !isHuman && engineStatus === 'error' && typeof engineError === 'string' && engineError.length > 0;

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
    if (state.winner === seatIndex + 1) {
      const plies = state.actions?.length ?? 0;
      const moves = Math.ceil(plies / 2);
      statusText = `Won in ${moves} move${moves === 1 ? '' : 's'}!`;
    } else {
      statusText = '';
    }
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
    // A *forced* win (e.g. the endgame certificate) reports a flat mate score with
    // no real distance, so formatScoreForCard collapses it to "Won!". The game isn't
    // actually over yet — show the winning pawn's real moves-to-goal instead.
    const mate = mateInfo(score);
    if (mate && mate.dist === 0 && !state.winner && !state.isDraw) {
      const winningSeat = mate.sign > 0 ? seatIndex : 1 - seatIndex;
      const dist = winningSeat === 0 ? state.eval?.whiteDist : state.eval?.blackDist;
      if (Number.isFinite(dist) && dist > 0) {
        scoreDisplay = mate.sign > 0 ? `Win in ${dist}` : `Lose in ${dist}`;
      } else {
        scoreDisplay = mate.sign > 0 ? 'Winning' : 'Losing';
      }
    }
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
          <div class="player-card__pawn pawn-icon pawn-icon--seat${seatIndex}">${
            hasError
              ? `<button type="button" class="pawn-icon__error" data-action="copy-engine-error" data-seat="${seatIndex}" title="Engine error — click to copy:&#10;${escAttr(engineError)}" aria-label="Engine error, click to copy">!</button>`
              : ''
          }</div>
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

  updatePawnSpinner(container, isThinking && !hasError, seatIndex);

  container.querySelector('[data-action="play-now"]')?.addEventListener('click', () => {
    controller.playNow?.();
  });

  container
    .querySelector('[data-action="copy-engine-error"]')
    ?.addEventListener('click', (event) => {
      event.stopPropagation();
      const btn = event.currentTarget;
      const seat = Number(btn.getAttribute('data-seat'));
      const message = String(state.engineErrors?.[seat] ?? '');
      const flashCopied = () => {
        btn.classList.add('pawn-icon__error--copied');
        btn.textContent = '✓';
      };
      const fallbackCopy = () => {
        try {
          const ta = document.createElement('textarea');
          ta.value = message;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          ta.remove();
        } catch {
          /* clipboard unavailable — error is still shown in the tooltip */
        }
      };
      if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(message).then(flashCopied, () => {
          fallbackCopy();
          flashCopied();
        });
      } else {
        fallbackCopy();
        flashCopied();
      }
    });
}
