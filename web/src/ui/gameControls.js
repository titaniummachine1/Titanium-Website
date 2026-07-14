/**
 * Controls bar beneath the board — three big, evenly-sized buttons filling
 * the full board width: ◀ Undo | ⏸ Pause | Redo ▶.
 *
 * New game / Settings live above the sidebar's moves-card, Load lives in the
 * moves-card header, and full engine logs open from the player-card pawn icon
 * (see ui/sidebarView.js and ui/playerCard.js).
 */

import { toAlgebraic } from '../lib/gameLogic.js';
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

const PAUSE_ICON = '⏸';
const PLAY_ICON = '▶';
const PAUSE_HINT = 'Engines paused — make moves manually, or press Space / ▶ to resume';

export function renderGameControls(container, state, controller) {
  const canUndo = state.actions.length > 0;
  const canRedo = !!state.canRedo;
  const paused = !!state.enginesPaused;
  const pauseTitle = state.uiMode === 'replay'
    ? (paused ? 'Resume review analysis (Space)' : 'Pause review analysis (Space)')
    : (paused ? PAUSE_HINT : 'Pause engines (Space)');
  const pauseLabel = state.uiMode === 'replay'
    ? (paused ? 'Resume review analysis' : 'Pause review analysis')
    : (paused ? 'Resume engines' : 'Pause engines');

  container.innerHTML = `
    <div class="game-controls">
      <button type="button" class="game-controls__btn game-controls__btn--nav" data-action="undo" ${canUndo ? '' : 'disabled'} title="Undo last move (Left Arrow)" aria-label="Undo last move">◀</button>
      <button type="button" class="game-controls__btn game-controls__btn--pause${paused ? ' game-controls__btn--pause-active' : ''}" data-action="pause" title="${escHtml(pauseTitle)}" aria-label="${escHtml(pauseLabel)}" aria-pressed="${paused ? 'true' : 'false'}">${paused ? PLAY_ICON : PAUSE_ICON}</button>
      <button type="button" class="game-controls__btn game-controls__btn--nav" data-action="redo" ${canRedo ? '' : 'disabled'} title="Redo next move (Right Arrow)" aria-label="Redo next move">▶</button>
    </div>
  `;

  wireControls(container, state, controller);
}

function wireControls(container, state, controller) {
  container.querySelector('[data-action="undo"]')?.addEventListener('click', () => {
    controller.undo?.();
  });

  container.querySelector('[data-action="redo"]')?.addEventListener('click', () => {
    controller.redo?.();
  });

  container.querySelector('[data-action="pause"]')?.addEventListener('click', () => {
    controller.toggleEnginesPaused?.();
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
  const thinkLog = state.moveThinkLog ?? [];
  if (thinkLog.length) {
    lines.push('=== Think log (all plies) ===');
    for (const entry of thinkLog) {
      const parts = [`ply ${entry.ply ?? '?'}`];
      if (entry.move != null) {
        parts.push(`move ${entry.move}`);
      }
      parts.push(`engine=${entry.engine ?? '?'}`);
      if (entry.budget) {
        parts.push(`budget=${entry.budget}`);
      }
      if (entry.stoppedBy) {
        parts.push(`stopped=${entry.stoppedBy}`);
      }
      if (entry.nodes != null) {
        parts.push(`nodes=${entry.nodes}`);
      }
      if (entry.thinkMs != null) {
        parts.push(`think=${entry.thinkMs}ms`);
      }
      if (entry.error) {
        parts.push(`ERROR: ${entry.error}`);
      }
      if (entry.note) {
        parts.push(`note: ${entry.note}`);
      }
      lines.push(`  ${parts.join('  ')}`);
      if (entry.depthLog?.length) {
        for (const e of entry.depthLog) {
          const score = e.score ?? e.rootScore;
          const scoreStr = score != null ? formatEngineScore(score) : '?';
          const nodes = (e.nodes ?? 0).toLocaleString();
          const pv = e.pv ? `  pv ${e.pv}` : '';
          lines.push(`    d${e.depth}  ${scoreStr}  ${nodes}n${pv}`);
        }
      }
    }
    lines.push('');
  }

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

  if (lines.length <= 1 && !thinkLog.length) {
    return '(no AI thinking logs available)';
  }
  return lines.join('\n');
}

export { formatLogsText };

export function openLogsDialog(state) {
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

/**
 * Single Load entry point (Moves card, next to Copy) for every mode:
 *  - Review: loads into the ply scrubber (controller.loadReplay) so you can
 *    step through it move by move.
 *  - Play/Analysis: jumps straight to the final position (controller.loadNotationString).
 * Accepts plain "e2 e8 e3 e7 ..." lists and the raw wallz.gg move-history
 * copy-paste layout (numbered lines, one move per line) -- both already
 * parse fine through the same tokenizer.
 */
export function openLoadNotationDialog(controller) {
  const existing = document.querySelector('.load-notation-dialog');
  if (existing) { existing.remove(); return; }

  const isReview = controller.getState?.().uiMode === 'replay';

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay load-notation-dialog';
  overlay.innerHTML = `
    <div class="load-dialog" role="dialog" aria-modal="true" aria-label="Load game">
      <div class="load-dialog__header">
        <h2 class="load-dialog__title">Load game</h2>
        <button class="load-dialog__close" data-action="close">✕</button>
      </div>
      <div class="load-dialog__body">
        <textarea class="load-dialog__input" placeholder="Paste move list (e2 e8 e3 e7 ... or wallz move-history copy-paste)" rows="5" spellcheck="false"></textarea>
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
    if (isReview) {
      try {
        controller.loadReplay(text);
        close();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err?.message ?? String(err);
      }
      return;
    }
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

