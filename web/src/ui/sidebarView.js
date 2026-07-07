/**
 * Right-side column: moves card (always) + review playback card (Review mode
 * only). Analysis mode has no sidebar card; its engine settings live in the
 * Settings dialog.
 */

import { toAlgebraic } from '../lib/gameLogic.js';
import { openPlayerDialog } from './playerDialog.js';
import { openLoadNotationDialog } from './gameControls.js';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const playback = {
  timerId: null,
  speed: 1,
};

function stopAutoplay() {
  if (playback.timerId != null) {
    clearInterval(playback.timerId);
    playback.timerId = null;
  }
}

function startAutoplay(controller) {
  stopAutoplay();
  const stepMs = Math.max(60, Math.round(700 / playback.speed));
  playback.timerId = setInterval(() => {
    const state = controller.getState();
    const replay = state.replay;
    if (!replay || replay.index >= replay.total) {
      stopAutoplay();
      controller.onChange?.();
      return;
    }
    controller.replayStep(1);
  }, stepMs);
}

export function renderSidebar(container, state, controller) {
  const showReview = state.uiMode === 'replay';

  container.innerHTML = `
    <div class="sidebar-stack">
      ${renderSidebarToolbar()}
      ${renderMovesCard(state)}
      ${showReview ? renderReviewPlaybackCard(state) : ''}
    </div>
  `;

  wireSidebarToolbar(container, controller);
  wireMovesCard(container, state, controller);
  if (showReview) {
    wireReviewPlaybackCard(container, controller);
  } else {
    stopAutoplay();
  }
}

function renderSidebarToolbar() {
  return `
    <div class="sidebar-toolbar">
      <button type="button" class="btn btn--icon sidebar-toolbar__btn" data-action="sidebar-new-game" title="New game" aria-label="New game">+</button>
      <button type="button" class="btn btn--icon sidebar-toolbar__btn" data-action="sidebar-settings" title="Settings" aria-label="Settings">&#9881;</button>
    </div>
  `;
}

function wireSidebarToolbar(container, controller) {
  container.querySelector('[data-action="sidebar-new-game"]')?.addEventListener('click', () => {
    openPlayerDialog(controller.getState(), controller, { mode: 'newgame' });
  });
  container.querySelector('[data-action="sidebar-settings"]')?.addEventListener('click', () => {
    openPlayerDialog(controller.getState(), controller, { mode: 'settings' });
  });
}

function moveLabelsForState(state) {
  if (state.uiMode === 'replay') {
    return state.replay?.algebraic ?? [];
  }
  return (state.actions ?? []).map((action) => toAlgebraic(action));
}

function renderMovesCard(state) {
  const moves = moveLabelsForState(state);
  const classifications = state.reviewAnalysis?.classifications ?? [];
  const visiblePly = state.uiMode === 'replay' ? (state.replay?.index ?? moves.length) : moves.length;
  const movePairs = [];
  for (let i = 0; i < moves.length; i += 2) {
    movePairs.push({
      num: Math.floor(i / 2) + 1,
      white: moves[i],
      whitePly: i,
      black: moves[i + 1] ?? '',
      blackPly: i + 1,
    });
  }

  const bodyHtml = movePairs.length === 0
    ? '<p class="moves-card__empty">No moves yet</p>'
    : movePairs.map((p) =>
        `<div class="moves-card__pair">
          <span class="moves-card__num">${p.num}.</span>
          ${renderMoveCell(p.white, classifications[p.whitePly], p.whitePly >= visiblePly)}
          ${renderMoveCell(p.black, classifications[p.blackPly], p.blackPly >= visiblePly)}
        </div>`,
      ).join('');

  let statusHtml = '';
  if (state.winner) {
    statusHtml = `<p class="moves-card__result">${state.winner === 1 ? 'White' : 'Black'} wins</p>`;
  } else if (state.isDraw) {
    statusHtml = '<p class="moves-card__result">Draw</p>';
  }

  const errors = Object.entries(state.engineErrors ?? {})
    .filter(([, m]) => m)
    .map(([seat, m]) => `${seat === '0' ? 'White' : 'Black'}: ${escHtml(m)}`)
    .join(' | ');

  return `
    <section class="moves-card">
      <div class="moves-card__header">
        <h2 class="moves-card__title">Moves <span class="moves-card__count">${moves.length}</span></h2>
        <div class="moves-card__header-actions">
          <button type="button" class="btn btn--small moves-card__load" data-action="load-moves" title="Load game from notation">Load</button>
          <button type="button" class="btn btn--small moves-card__copy" data-action="copy-moves" title="Copy game notation" ${moves.length ? '' : 'disabled'}>Copy</button>
        </div>
      </div>
      <div class="moves-card__list" data-moves-list>${bodyHtml}</div>
      ${statusHtml}
      ${errors ? `<p class="moves-card__errors">${errors}</p>` : ''}
    </section>
  `;
}

function renderMoveCell(move, classification, isFuture) {
  if (!move) {
    return '<span class="moves-card__move"></span>';
  }
  const cls = classification?.classification ?? 'pending';
  const label = classification?.label ?? '...';
  const title = classification?.bestMove ? `Best: ${classification.bestMove}` : label;
  return (
    '<span class="moves-card__move' + (isFuture ? ' moves-card__move--future' : '') + '">' +
      '<span class="moves-card__move-text">' + escHtml(move) + '</span>' +
      (classification
        ? '<span class="move-class move-class--' + escHtml(cls) + '" title="' + escHtml(title) + '">' + escHtml(label) + '</span>'
        : '') +
    '</span>'
  );
}

function wireMovesCard(container, state, controller) {
  const list = container.querySelector('[data-moves-list]');
  if (list) list.scrollTop = list.scrollHeight;

  container.querySelector('[data-action="load-moves"]')?.addEventListener('click', () => {
    openLoadNotationDialog(controller);
  });

  container.querySelector('[data-action="copy-moves"]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const notation = moveLabelsForState(state).join(' ');
    navigator.clipboard.writeText(notation).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = notation;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    btn.textContent = 'OK';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
  });
}

function renderReviewPlaybackCard(state) {
  const replay = state.replay;
  const index = replay?.index ?? 0;
  const total = replay?.total ?? 0;
  const review = state.reviewAnalysis ?? {};
  const isPlaying = playback.timerId != null;
  const speeds = [0.5, 1, 2, 4];
  const completed = review.completed ?? 0;
  const reviewTotal = review.total ?? 0;
  const workerCount = review.workerCount ?? 0;
  const isPaused = review.status === 'paused' || review.paused;
  const verb = review.status === 'complete'
    ? 'Reviewed'
    : isPaused
      ? 'Paused'
      : 'Reviewing';
  const analysisStatus = `${verb} ${completed} / ${reviewTotal} with ${workerCount} worker${workerCount === 1 ? '' : 's'}`;

  return `
    <section class="review-card">
      <h2 class="review-card__title">Review</h2>
      ${reviewTotal ? `<p class="review-card__status">${escHtml(analysisStatus)}</p>` : ''}
      <input type="range" class="replay-slider playback-bar__slider" data-review-slider min="0" max="${total}" value="${index}" ${total ? '' : 'disabled'} />
      ${total ? `<p class="review-card__status">Move ${index} / ${total}</p>` : ''}
      <div class="playback-bar__speeds">
        ${speeds.map((s) => `<button type="button" class="btn btn--small speed-btn ${playback.speed === s ? 'speed-btn--active' : ''}" data-speed="${s}">${s}x</button>`).join('')}
      </div>
      <button type="button" class="btn playback-bar__playpause playback-bar__playpause--icon" data-action="review-playpause" title="${isPlaying ? 'Pause replay' : 'Play replay'}" aria-label="${isPlaying ? 'Pause replay' : 'Play replay'}" ${total ? '' : 'disabled'}>${isPlaying ? '&#10074;&#10074;' : '&#9654;'}</button>
    </section>
  `;
}

function wireReviewPlaybackCard(container, controller) {
  container.querySelector('[data-action="review-playpause"]')?.addEventListener('click', () => {
    if (playback.timerId != null) {
      stopAutoplay();
    } else {
      startAutoplay(controller);
    }
    controller.onChange?.();
  });

  const slider = container.querySelector('[data-review-slider]');
  slider?.addEventListener('input', () => {
    stopAutoplay();
    controller.setReplayIndex(Number(slider.value));
  });

  container.querySelectorAll('[data-speed]').forEach((btn) => {
    btn.addEventListener('click', () => {
      playback.speed = Number(btn.dataset.speed);
      if (playback.timerId != null) {
        startAutoplay(controller);
      }
      controller.onChange?.();
    });
  });
}
