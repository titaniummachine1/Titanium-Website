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
import { resolveDisplayNodes } from '../lib/searchNodes.js';
import { canPlayNow, resolveLiveBestMoveKey } from '../lib/liveBestMove.js';
import { aceStrengthPresetsForPlayerType } from '../lib/aceTier.js';
import {
  STRENGTH_LEVEL_PRESETS,
  TIME_TO_MOVE_PRESETS,
  formatWallClock,
  titaniumNetLabel,
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
  return resolveDisplayNodes(snap);
}

function formatNodesLine(snap) {
  const n = resolveNodes(snap);
  if (n <= 0) return '';
  return `n${formatNodes(n)}`;
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

  if (ui.isRemote && !ui.isZeroInk) {
    const strength = expandStrengthLabel(
      STRENGTH_LEVEL_PRESETS.find((p) => p.id === (ui.strengthLevel ?? StrengthLevel.Alpha))?.label
        ?? 'Alpha',
    );
    const time = TIME_TO_MOVE_PRESETS.find((p) => p.id === (ui.timeToMove ?? TimeToMove.Short))?.label
      ?? 'Short';
    return `${engine} · ${strength} · ${time}`;
  }

  if (ui.isZeroInk) {
    const time = TIME_TO_MOVE_PRESETS.find((p) => p.id === (ui.timeToMove ?? TimeToMove.Short))?.label
      ?? 'Short';
    return `${engine} · ${time}`;
  }

  if (ui.isAceFamily) {
    const tiers = aceStrengthPresetsForPlayerType(ui.playerType);
    const tier = tiers.find((t) => t.id === (ui.strengthLevel ?? 0))?.label ?? 'JS';
    return `${engine} · ${tier} · ${formatTimeSummary(ui.wallClockSeconds)}`;
  }

  if (ui.isTitanium) {
    const net = titaniumNetLabel({ titaniumNet: ui.titaniumNet });
    const threads = ui.isTitanium && ui.cores > 1 ? ` · ${ui.cores} threads` : '';
    return `${engine} · ${net} · ${formatTimeSummary(ui.wallClockSeconds)}${threads}`;
  }

  return `${engine} · ${formatTimeSummary(ui.wallClockSeconds)}`;
}

function shortEngineName(playerType) {
  if (playerType === PlayerType.TitaniumMinimax || playerType === PlayerType.TitaniumV15Frozen) {
    return 'Titanium';
  }
  if (playerType === PlayerType.GorisansonMCTS) return 'Gorisanson';
  if (playerType === PlayerType.KaAI) return 'Ka';
  if (playerType === PlayerType.ZeroInk) return 'zero.ink';
  if (playerType === PlayerType.IshtarV3 || playerType === PlayerType.IshtarPonder) return 'Ishtar';
  if (playerType === PlayerType.AceV10) return 'ACE v10';
  if (playerType === PlayerType.AceV13) return 'ACE v13';
  return String(playerType);
}

/**
 * Spinner ring around the player's colour token while it thinks.
 * Reuses one DOM node across card re-renders (smooth animation) and stays
 * anchored to the pawn so it scrolls with the layout.
 */
function updatePawnSpinner(container, active, seatIndex) {
  const pawnEl = container.querySelector('.player-card__pawn');
  let spinner = container._pawnSpinner;

  if (!active || !pawnEl) {
    spinner?.remove();
    container._pawnSpinner = null;
    return;
  }

  if (!spinner) {
    spinner = document.createElement('div');
    spinner.className = 'pawn-spinner';
    container._pawnSpinner = spinner;
  }

  spinner.dataset.seat = String(seatIndex);
  if (spinner.parentNode !== pawnEl) {
    pawnEl.appendChild(spinner);
  }
}

/** Stable card layout key — excludes live depth/nodes/pv so we can patch in place. */
export function playerCardStructureKey(state, seatIndex) {
  const playerType = state.settings.players[seatIndex];
  const isHuman = playerType === PlayerType.Human;
  const isThinking = state.aiThinking && state.thinkingSeatIndex === seatIndex;
  const isMyTurn = !state.winner && !state.isDraw && state.playerToMove === seatIndex + 1;
  const ui = state.playerAiSettingsUi?.[seatIndex];
  const engineStatus = state.engineStatus?.[seatIndex];
  const engineError = state.engineErrors?.[seatIndex];
  const hasError =
    !isHuman && engineStatus === 'error' && typeof engineError === 'string' && engineError.length > 0;
  const completedSnap = state.lastCompletedThinkBySeat?.[seatIndex];
  const bestMove = !isThinking ? completedSnap?.move ?? null : null;

  return JSON.stringify({
    seatIndex,
    playerType,
    isHuman,
    isThinking,
    isMyTurn,
    winner: state.winner,
    isDraw: state.isDraw,
    configSummary: compactPlayerConfigSummary(ui),
    hasError,
    engineError: hasError ? engineError : '',
    bestMove,
  });
}

function derivePlayerCardView(state, seatIndex) {
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

  const bestMove = snap?.move ?? (liveSnap ? null : completedSnap?.move ?? null);
  const depth = resolveDepth(snap);
  const nodes = resolveNodes(snap);
  const nodesLine = formatNodesLine(snap);
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

  return {
    playerType,
    isHuman,
    isThinking,
    isMyTurn,
    colorName,
    hasError,
    engineError,
    configSummary: compactPlayerConfigSummary(ui),
    bestMove,
    livePvMove,
    statusText,
    scoreDisplay,
    isMate,
    depth,
    nodes,
    nodesLine,
    thinkMs,
    showPlayNow,
    selectedWorkerNodes: snap?.selectedWorkerNodes,
    totalNodesAcrossWorkers: snap?.totalNodesAcrossWorkers,
    nodeSource: snap?.nodeSource,
    progress: snap?.progress,
  };
}

/** Patch live telemetry without tearing down the card DOM (keeps spinner animation). */
export function patchPlayerCardLive(container, state, seatIndex, controller) {
  const view = derivePlayerCardView(state, seatIndex);
  const card = container.querySelector(`[data-player-card-seat="${seatIndex}"]`);
  if (!card) {
    return false;
  }

  card.classList.toggle('player-card--active', view.isMyTurn);
  card.classList.toggle('player-card--winner', state.winner === seatIndex + 1);

  const statusEl = card.querySelector(`[data-player-card-status="${seatIndex}"]`);
  if (view.statusText) {
    if (statusEl) {
      statusEl.textContent = view.statusText;
      statusEl.classList.toggle('player-card__status--thinking', view.isThinking);
    }
  } else if (statusEl) {
    statusEl.remove();
  }

  const infoEl = card.querySelector('.player-card__info');
  let playedEl = infoEl?.querySelector('[data-player-card-played]');
  if (view.bestMove && !view.isThinking) {
    if (!playedEl && infoEl) {
      playedEl = document.createElement('div');
      playedEl.className = 'player-card__bestmove';
      playedEl.dataset.playerCardPlayed = '1';
      infoEl.appendChild(playedEl);
    }
    if (playedEl) {
      playedEl.innerHTML = `played <strong>${escHtml(view.bestMove)}</strong>`;
    }
  } else if (playedEl) {
    playedEl.remove();
  }

  let pvEl = infoEl?.querySelector('[data-player-card-pv]');
  if (view.livePvMove) {
    if (!pvEl && infoEl) {
      pvEl = document.createElement('div');
      pvEl.className = 'player-card__bestmove';
      pvEl.dataset.playerCardPv = '1';
      infoEl.appendChild(pvEl);
    }
    if (pvEl) {
      pvEl.innerHTML = `pv <strong>${escHtml(view.livePvMove)}</strong>`;
    }
  } else if (pvEl) {
    pvEl.remove();
  }

  const statsEl = card.querySelector('.player-card__stats');
  if (statsEl) {
    const parts = [];
    if (view.scoreDisplay) {
      parts.push(
        `<span class="player-card__score${view.isMate ? ' player-card__score--mate' : ''}">${escHtml(view.scoreDisplay)}</span>`,
      );
    }
    if (view.depth != null) {
      parts.push(
        `<span class="player-card__stat"><span class="player-card__stat-label">d</span>${view.depth}</span>`,
      );
    }
    if (view.nodesLine) {
      parts.push(`<span class="player-card__stat">${escHtml(view.nodesLine)}</span>`);
    } else if (view.nodes > 0) {
      parts.push(
        `<span class="player-card__stat"><span class="player-card__stat-label">n</span>${escHtml(formatNodes(view.nodes))}</span>`,
      );
    }
    if (view.thinkMs != null) {
      parts.push(`<span class="player-card__stat">${escHtml(formatMs(view.thinkMs))}</span>`);
    }
    statsEl.innerHTML = parts.join('');
  }

  const playBtn = card.querySelector('[data-action="play-now"]');
  if (view.showPlayNow && !playBtn) {
    const right = card.querySelector('.player-card__right');
    const btn = document.createElement('button');
    btn.className = 'btn btn--playnow';
    btn.dataset.action = 'play-now';
    btn.title = 'Stop search and play current best move';
    btn.textContent = 'Play now';
    btn.addEventListener('click', () => controller.playNow?.());
    right?.appendChild(btn);
  } else if (!view.showPlayNow && playBtn) {
    playBtn.remove();
  }

  updatePawnSpinner(container, view.isThinking && !view.hasError, seatIndex);
  return true;
}

function bindPlayerCardActions(container, state, seatIndex, controller) {
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

export function renderPlayerCard(container, state, seatIndex, controller) {
  const structureKey = playerCardStructureKey(state, seatIndex);
  if (
    container._playerCardStructureKey === structureKey &&
    container.querySelector(`[data-player-card-seat="${seatIndex}"]`)
  ) {
    patchPlayerCardLive(container, state, seatIndex, controller);
    return;
  }

  container._playerCardStructureKey = structureKey;
  const view = derivePlayerCardView(state, seatIndex);

  const spinner = container._pawnSpinner;
  if (spinner) {
    spinner.remove();
  }

  container.innerHTML = `
    <div class="player-card player-card--seat${seatIndex}${view.isMyTurn ? ' player-card--active' : ''}${state.winner === seatIndex + 1 ? ' player-card--winner' : ''}" data-player-card-seat="${seatIndex}">
      <div class="player-card__main">
        <div class="player-card__left">
          <div class="player-card__pawn pawn-icon pawn-icon--seat${seatIndex}">${
            view.hasError
              ? `<button type="button" class="pawn-icon__error" data-action="copy-engine-error" data-seat="${seatIndex}" title="Engine error — click to copy:&#10;${escAttr(view.engineError)}" aria-label="Engine error, click to copy">!</button>`
              : ''
          }</div>
          <div class="player-card__info">
            <div class="player-card__name">${escHtml(view.colorName)}</div>
            <div class="player-card__config">${escHtml(view.configSummary)}</div>
            ${view.statusText ? `<div class="player-card__status${view.isThinking ? ' player-card__status--thinking' : ''}" data-player-card-status="${seatIndex}">${escHtml(view.statusText)}</div>` : ''}
            ${view.bestMove && !view.isThinking ? `<div class="player-card__bestmove" data-player-card-played="1">played <strong>${escHtml(view.bestMove)}</strong></div>` : ''}
            ${view.livePvMove ? `<div class="player-card__bestmove" data-player-card-pv="1">pv <strong>${escHtml(view.livePvMove)}</strong></div>` : ''}
          </div>
        </div>
        <div class="player-card__right">
          <div class="player-card__stats">
            ${view.scoreDisplay ? `<span class="player-card__score${view.isMate ? ' player-card__score--mate' : ''}">${escHtml(view.scoreDisplay)}</span>` : ''}
            ${view.depth != null ? `<span class="player-card__stat"><span class="player-card__stat-label">d</span>${view.depth}</span>` : ''}
            ${view.nodes > 0 ? `<span class="player-card__stat"><span class="player-card__stat-label">n</span>${escHtml(formatNodes(view.nodes))}</span>` : ''}
            ${view.thinkMs != null ? `<span class="player-card__stat">${escHtml(formatMs(view.thinkMs))}</span>` : ''}
          </div>
          ${view.showPlayNow ? `<button class="btn btn--playnow" data-action="play-now" title="Stop search and play current best move">Play now</button>` : ''}
        </div>
      </div>
    </div>
  `;

  updatePawnSpinner(container, view.isThinking && !view.hasError, seatIndex);
  bindPlayerCardActions(container, state, seatIndex, controller);
}
