/**
 * Compact controls bar and notation bar beneath the board.
 *
 * Controls:
 *   New game | Undo | Flip board | Copy notation | Load notation | Change players
 *
 * Notation bar:
 *   Scrollable move list + error display.
 */

import { toAlgebraic } from '../lib/gameLogic.js';
import { openPlayerDialog } from './playerDialog.js';
import { formatEngineScore } from '../lib/engineScore.js';
import {
  formatCanonicalGameLog,
  canonicalStateFromBoard,
  blockedEdgesFromCanonicalWalls,
  legalMovesFromBoard,
  positionKeyFromHistory,
} from '../lib/canonicalState.js';

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function renderGameControls(container, state, controller) {
  const canUndo = state.actions.length > 0 && !state.winner && !state.isDraw;
  const undoPaused = controller._undoPaused ?? false;

  container.innerHTML = `
    <div class="game-controls">
      <button type="button" class="btn btn--small game-controls__btn" data-action="new-game" title="Start a new game">New game</button>
      <button type="button" class="btn btn--small game-controls__btn" data-action="undo" ${canUndo ? '' : 'disabled'} title="Undo last move">Undo</button>
      <button type="button" class="btn btn--small game-controls__btn" data-action="flip" title="Flip board orientation">Flip</button>
      <button type="button" class="btn btn--small game-controls__btn" data-action="logs" title="Show AI thinking log for last move">Logs</button>
      <button type="button" class="btn btn--small game-controls__btn" data-action="load-notation" title="Load game from notation">Load</button>
      <button type="button" class="btn btn--small game-controls__btn" data-action="change-players" title="Change players and engine settings">Settings</button>
    </div>
    ${undoPaused ? '<div class="undo-pause-banner">Engine paused after undo — resuming shortly…</div>' : ''}
  `;

  wireControls(container, state, controller);
}

function wireControls(container, state, controller) {
  container.querySelector('[data-action="new-game"]')?.addEventListener('click', () => {
    openPlayerDialog(controller.getState(), controller, { mode: 'newgame' });
  });

  container.querySelector('[data-action="undo"]')?.addEventListener('click', () => {
    controller.undoWithPause?.();
  });

  container.querySelector('[data-action="flip"]')?.addEventListener('click', () => {
    controller.toggleRotateBoard?.();
  });

  container.querySelector('[data-action="logs"]')?.addEventListener('click', () => {
    openLogsDialog(controller.getState());
  });

  container.querySelector('[data-action="load-notation"]')?.addEventListener('click', () => {
    openLoadNotationDialog(controller);
  });

  container.querySelector('[data-action="change-players"]')?.addEventListener('click', () => {
    openPlayerDialog(controller.getState(), controller, { mode: 'settings' });
  });
}

function formatGameLogHeader(state) {
  if (!state.board) {
    return '';
  }
  const history = (state.actions ?? []).map((a) => toAlgebraic(a));
  const canon = canonicalStateFromBoard(state.board);
  const blockedEdges = blockedEdgesFromCanonicalWalls(canon);
  const legalMoves =
    state.winner != null || state.isDraw ? [] : legalMovesFromBoard(state.board);
  const positionKey = positionKeyFromHistory(state.actions ?? []);
  return formatCanonicalGameLog({
    history,
    state: canon,
    legalMoves,
    positionKey,
    blockedEdges,
    isFlipped: state.settings?.rotateBoard ?? false,
    winner: state.winner ?? null,
    isDraw: state.isDraw ?? false,
  });
}

function formatLogsText(state) {
  const lines = [formatGameLogHeader(state)];
  const snaps = state.lastCompletedThinkBySeat ?? [];
  const players = state.settings?.players ?? [];
  const errors = state.engineErrors ?? {};

  for (let seat = 0; seat < 2; seat++) {
    const snap = snaps[seat];
    const errMsg = errors[seat];
    const color = seat === 0 ? 'White' : 'Black';
    const engine = players[seat] ?? 'AI';

    if (!snap && !errMsg) continue;

    lines.push(`=== ${color} (${engine}) — move: ${snap?.move ?? '?'} ===`);

    if (errMsg) {
      lines.push(`  ⚠ ENGINE ERROR: ${errMsg}`);
    }

    if (snap) {
      const log = snap.depthLog ?? [];
      if (log.length === 0) {
        const score = snap.score ?? snap.rootScore;
        lines.push(`  depth ${snap.depth ?? snap.searchDepth ?? '?'}  score ${score != null ? formatEngineScore(score) : '?'}  nodes ${(snap.nodes ?? 0).toLocaleString()}  ${snap.pv ? 'pv ' + snap.pv : ''}`);
      } else {
        for (const e of log) {
          const score = e.score ?? e.rootScore;
          const scoreStr = score != null ? formatEngineScore(score) : '?';
          const nodes = (e.nodes ?? 0).toLocaleString();
          const pv = e.pv ? '  pv ' + e.pv : '';
          lines.push(`  d${e.depth}  ${scoreStr}  ${nodes}n${pv}`);
        }
      }
      if (snap.thinkMs != null) lines.push(`  total: ${(snap.thinkMs / 1000).toFixed(2)}s`);
    }
    lines.push('');
  }

  if (lines.length === 0) return '(no AI thinking logs available)';
  return lines.join('\n');
}

function openLogsDialog(state) {
  const existing = document.querySelector('.logs-dialog-overlay');
  if (existing) { existing.remove(); return; }

  const text = formatLogsText(state);

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay logs-dialog-overlay';
  overlay.innerHTML = `
    <div class="load-dialog" role="dialog" aria-modal="true" aria-label="AI thinking logs" style="max-width:600px">
      <div class="load-dialog__header">
        <h2 class="load-dialog__title">AI thinking logs</h2>
        <button type="button" class="load-dialog__close load-dialog__close--dismiss" aria-label="Close">✕</button>
      </div>
      <div class="load-dialog__body">
        <textarea class="load-dialog__input" rows="18" spellcheck="false" readonly style="font-family:monospace;font-size:0.78rem">${escHtml(text)}</textarea>
      </div>
      <div class="load-dialog__footer">
        <button type="button" class="btn btn--primary" data-action="copy-logs">Copy</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('.load-dialog__close--dismiss')?.addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  overlay.querySelector('[data-action="copy-logs"]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    navigator.clipboard.writeText(text).catch(() => {
      const ta = overlay.querySelector('textarea');
      ta?.select();
      document.execCommand('copy');
    });
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });

  overlay.querySelector('textarea')?.focus();
}

function openLoadNotationDialog(controller) {
  const existing = document.querySelector('.load-notation-dialog');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay load-notation-dialog';
  overlay.innerHTML = `
    <div class="load-dialog" role="dialog" aria-modal="true" aria-label="Load notation">
      <div class="load-dialog__header">
        <h2 class="load-dialog__title">Load notation</h2>
        <button class="load-dialog__close" data-action="close">✕</button>
      </div>
      <div class="load-dialog__body">
        <textarea class="load-dialog__input" placeholder="Paste game notation here…" rows="5" spellcheck="false"></textarea>
        <div class="load-dialog__error" hidden></div>
      </div>
      <div class="load-dialog__footer">
        <button class="btn btn--primary" data-action="load">Load</button>
        <button class="btn" data-action="close">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', close);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  overlay.querySelector('[data-action="load"]')?.addEventListener('click', () => {
    const text = overlay.querySelector('.load-dialog__input')?.value?.trim() ?? '';
    if (!text) { close(); return; }
    const errEl = overlay.querySelector('.load-dialog__error');
    const result = controller.loadNotationString?.(text);
    if (result && result.error) {
      errEl.hidden = false;
      errEl.textContent = result.error;
    } else {
      close();
    }
  });

  overlay.querySelector('.load-dialog__input')?.focus();
}

// ── Notation bar ────────────────────────────────────────────────────────

let lastNotationKey = '';

export function renderNotationBar(container, state, controller) {
  updateNotationBar(container, state, controller);
}

export function updateNotationBar(container, state, controller) {
  const moves = state.actions ?? [];
  const key = moves.map((a) => toAlgebraic(a)).join(' ') + '|' + (state.winner ?? '') + '|' + state.isDraw;

  if (key === lastNotationKey && container.children.length > 0) return;
  lastNotationKey = key;

  // Build move list
  const movePairs = [];
  for (let i = 0; i < moves.length; i += 2) {
    movePairs.push({
      num: Math.floor(i / 2) + 1,
      white: toAlgebraic(moves[i]),
      black: moves[i + 1] ? toAlgebraic(moves[i + 1]) : '',
    });
  }

  // Errors
  const errors = Object.entries(state.engineErrors ?? {})
    .filter(([, m]) => m)
    .map(([seat, m]) => `${seat === '0' ? 'White' : 'Black'}: ${m}`)
    .join(' | ');

  const moveHtml = movePairs.length === 0
    ? '<span class="notation-bar__empty">No moves yet</span>'
    : movePairs.map((p) =>
        `<span class="notation-pair"><span class="notation-num">${p.num}.</span><span class="notation-move">${escHtml(p.white)}</span>${p.black ? `<span class="notation-move">${escHtml(p.black)}</span>` : ''}</span>`,
      ).join('');

  let statusHtml = '';
  if (state.winner) {
    statusHtml = `<span class="notation-bar__result">${state.winner === 1 ? 'White' : 'Black'} wins</span>`;
  } else if (state.isDraw) {
    statusHtml = `<span class="notation-bar__result">Draw</span>`;
  }

  const hasMoves = moves.length > 0;
  container.innerHTML = `
    <div class="notation-bar">
      <div class="notation-bar__moves">${moveHtml}${statusHtml}</div>
      ${hasMoves ? `<button class="btn btn--small notation-bar__copy" data-action="copy-notation" title="Copy game notation">Copy</button>` : ''}
      ${errors ? `<div class="notation-bar__errors">${escHtml(errors)}</div>` : ''}
    </div>
  `;

  // Auto-scroll to end
  const movesEl = container.querySelector('.notation-bar__moves');
  if (movesEl) movesEl.scrollLeft = movesEl.scrollWidth;

  // Wire copy button
  container.querySelector('[data-action="copy-notation"]')?.addEventListener('click', (e) => {
    const btn = e.currentTarget;
    const notation = moves.map((a) => toAlgebraic(a)).join(' ');
    navigator.clipboard.writeText(notation).catch(() => {
      const ta = document.createElement('textarea');
      ta.value = notation;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    });
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  });
}
