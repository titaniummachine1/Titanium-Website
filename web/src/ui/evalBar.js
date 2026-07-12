/**
 * Eval bar — a fixed-width card to the left of the board, same height as the
 * board. Its column is always reserved (see .board-row__eval in styles.css)
 * so showing/hiding it never shifts the board horizontally; only this
 * component's own content fades in/out.
 *
 * Dead center: the live engine score ("+0.66") and, whenever the warm
 * analysis session has one, the current search depth right after it.
 * Orientation flips with the bar itself: stacked column when vertical
 * (desktop), a row when horizontal (mobile).
 */

import { formatEngineScore } from '../lib/engineScore.js';

export function renderEvalBar(container, props) {
  const {
    settings,
    eval: evalData,
    analysisEngineActive = false,
    analysisEvalDepth = null,
  } = props;

  const visible = settings.displayEvalBar;
  const margin = evalData?.margin ?? 0;
  const p1 = evalData?.p1 ?? 0.5;
  const scale = Math.max(0.02, Math.min(0.98, p1));

  // Prefer the real engine score (centipawn-style, "+0.66") once the warm
  // analysis session has one; fall back to the coarse distance margin only
  // before the first search result arrives.
  const hasRootScore = Number.isFinite(evalData?.rootScore);
  const pending = evalData?.pending === true;
  const scoreLabel = pending
    ? '...'
    : hasRootScore
    ? formatEngineScore(evalData.rootScore)
    : (margin > 0 ? `+${margin}` : String(margin));

  container.className = 'eval-panel' + (visible ? ' eval-panel--visible' : '');

  container.innerHTML = `
    <div class="eval-bar${settings.rotateBoard ? ' eval-bar--rotated' : ''}" title="${pending ? 'Review eval pending' : `White advantage: ${scoreLabel}`}">
      <div class="eval-bar__track"></div>
      <div class="eval-bar__fill" style="--scale: ${scale}"></div>
      <div class="eval-bar__center">
        <div class="eval-bar__score">${scoreLabel}</div>
        ${analysisEngineActive && analysisEvalDepth ? `<div class="eval-bar__depth">D ${analysisEvalDepth}</div>` : ''}
      </div>
    </div>
  `;
}
