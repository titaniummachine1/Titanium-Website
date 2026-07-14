/**
 * Eval bar — a fixed-width card to the left of the board, same height as the
 * board. Its column is always reserved (see .board-row__eval in styles.css)
 * so showing/hiding it never shifts the board horizontally; only this
 * component's own content fades in/out.
 */

import { formatEngineScore } from '../lib/engineScore.js';

function whiteWinRateLabel(evalData) {
  const wr = Number(evalData?.rootWinRate);
  if (!Number.isFinite(wr)) {
    return null;
  }
  const whiteWr = evalData?.playerToMove === 2 ? 1 - wr : wr;
  return `${Math.round(Math.max(0, Math.min(1, whiteWr)) * 100)}%`;
}

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

  const hasRootScore = Number.isFinite(evalData?.rootScore);
  const useWinRate = evalData?.evalKind === "winrate" && !hasRootScore;
  const winRateLabel = useWinRate ? whiteWinRateLabel(evalData) : null;
  const pending = evalData?.pending === true;
  const scoreLabel = pending
    ? '...'
    : hasRootScore
      ? formatEngineScore(evalData.rootScore)
      : winRateLabel
        ? winRateLabel
        : (margin > 0 ? `+${margin}` : margin < 0 ? String(margin) : '=');

  container.className = 'eval-panel' + (visible ? ' eval-panel--visible' : '');

  const depthLabel =
    analysisEngineActive && analysisEvalDepth
      ? `<div class="eval-bar__depth">D ${analysisEvalDepth}</div>`
      : evalData?.depth != null && !analysisEngineActive
        ? `<div class="eval-bar__depth">D ${evalData.depth}</div>`
        : '';

  container.innerHTML = `
    <div class="eval-bar${settings.rotateBoard ? ' eval-bar--rotated' : ''}" title="${pending ? 'Eval pending' : `White advantage: ${scoreLabel}`}">
      <div class="eval-bar__track"></div>
      <div class="eval-bar__fill" style="--scale: ${scale}"></div>
      <div class="eval-bar__center">
        <div class="eval-bar__score">${scoreLabel}</div>
        ${depthLabel}
      </div>
    </div>
  `;
}
