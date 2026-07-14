/**
 * Playable board — AceV13.1.html 17×17 groove grid (cells + wall grooves).
 * Rules: pawns on 9×9 nodes, walls only in grooves, legality via QuoridorBoard (BFS).
 */

import { parseAlgebraic, toAlgebraic, isWallAction } from '../lib/gameLogic.js';
import {
  formatGameEndHeadline,
  terminalOverlayShowsCopyLogs,
} from '../lib/gameEndMessage.js';
import { formatLogsText } from './gameControls.js';
import {
  normalizeGhostKey,
  pvFirstMoveFromLiveSearch,
  resolveLiveBestMoveKey,
} from '../lib/liveBestMove.js';
import {
  catSquareIndex,
  catSquareOverlay,
  catWallOverlay,
} from '../lib/catHeatmap.js';
import {
  lmrCutIntensity,
  lmrDepthStyle,
  lmrDisplayText,
} from '../lib/lmrHeatmap.js';
import {
  viewMove,
  wallSlotsFromBoard,
  engineMoveToAlgebraic,
  algebraicToEngineMove,
  pawnCellFromCoordinate,
} from '../lib/aceBoardCodec.js';
import {
  applyGridPos,
  cellIndexFromGrid,
  wallGridFromSlot,
} from '../lib/aceBoardGrid.js';
import './board.css';

function boardStructureKey(state) {
  return JSON.stringify({
    rotate: state.settings?.rotateBoard,
    showWalls: state.settings?.displayRemainingWalls,
    showCoords: state.settings?.displayCoordinates !== false,
  });
}

function buildCoordLabels(rotateBoard) {
  const files = 'abcdefghi'.split('');
  const ranks = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  return {
    viewFiles: rotateBoard ? [...files].reverse() : files,
    viewRanks: rotateBoard ? ranks : [...ranks].reverse(),
  };
}

function renderBoardCoords(rotateBoard) {
  const { viewFiles, viewRanks } = buildCoordLabels(rotateBoard);

  const top = document.createElement('div');
  top.className = 'board-coords board-coords--top';
  top.setAttribute('aria-hidden', 'true');
  for (const file of viewFiles) {
    const span = document.createElement('span');
    span.className = 'board-coords__label';
    span.textContent = file;
    top.appendChild(span);
  }

  const left = document.createElement('div');
  left.className = 'board-coords board-coords--left';
  left.setAttribute('aria-hidden', 'true');
  for (const rank of viewRanks) {
    const span = document.createElement('span');
    span.className = 'board-coords__label';
    span.textContent = String(rank);
    left.appendChild(span);
  }

  return { top, left };
}

function liveGhostKey(state, validActions) {
  if (state.settings?.showBestMoveHint === false) {
    return '';
  }
  const seat = state.thinkingSeatIndex;
  const merged =
    state.aiThinking && seat != null
      ? {
          ...state,
          liveSearch:
            (state.thinkingSeatIndex === seat && state.activeSearchInfo
              ? { ...state.liveSearch, ...state.activeSearchInfo }
              : state.liveSearch),
        }
      : state;
  const liveMove = resolveLiveBestMoveKey(merged, { validActions });
  if (liveMove) {
    return liveMove;
  }
  if (
    state.analysisEngineActive &&
    (state.eval?.pv?.length || state.eval?.rootMove || state.eval?.rootMoves?.length)
  ) {
    const validKeySet = new Set();
    for (const action of validActions ?? []) {
      const key = toAlgebraic(action);
      validKeySet.add(key);
      validKeySet.add(normalizeGhostKey(key));
    }
    return pvFirstMoveFromLiveSearch(
      {
        pv: state.eval.pv,
        rootMove: state.eval.rootMove,
        rootMoves: state.eval.rootMoves,
      },
      { validKeySet },
    ) ?? '';
  }
  return '';
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Stadium SVG ring — aspect matches horizontal/vertical wall bars (not a square blob). */
function createGhostWallRing(isHorizontal) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'ghost-pv-ring');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');

  const stroke = document.createElementNS(SVG_NS, 'rect');
  stroke.setAttribute('class', 'ghost-pv-ring__stroke');

  if (isHorizontal) {
    svg.setAttribute('viewBox', '0 0 100 28');
    stroke.setAttribute('x', '1.5');
    stroke.setAttribute('y', '1.5');
    stroke.setAttribute('width', '97');
    stroke.setAttribute('height', '25');
    stroke.setAttribute('rx', '12.5');
    stroke.setAttribute('ry', '12.5');
  } else {
    svg.setAttribute('viewBox', '0 0 28 100');
    stroke.setAttribute('x', '1.5');
    stroke.setAttribute('y', '1.5');
    stroke.setAttribute('width', '25');
    stroke.setAttribute('height', '97');
    stroke.setAttribute('rx', '12.5');
    stroke.setAttribute('ry', '12.5');
  }

  stroke.setAttribute('pathLength', '100');
  svg.appendChild(stroke);
  return svg;
}

function humanSideClass(playerToMove) {
  return playerToMove === 2 ? 'player2' : 'player1';
}

function canHumanInteract(state, controller) {
  const freePlay = state.uiMode === 'analysis';
  const manualWhilePaused = !!state.enginesPaused;
  return (
    !state.winner &&
    !state.isDraw &&
    !state.aiThinking &&
    state.uiMode !== 'replay' &&
    (freePlay || manualWhilePaused || controller.session.isHumanTurn(state.settings.players))
  );
}

function clearHumanHover(dom) {
  if (dom._hoverPawnCell) {
    dom._hoverPawnCell.classList.remove(
      'human-hover-pawn',
      'human-hover-pawn--player1',
      'human-hover-pawn--player2',
    );
    dom._hoverPawnCell = null;
  }
  dom.previewEl?.remove();
  dom.previewEl = null;
}

function elevatePreviewCell(cell, dom) {
  if (!cell) {
    return;
  }
  cell.style.zIndex = String(dom.pawnZ ?? PAWN_Z);
  dom._visionZCells?.delete(cell);
}

function setHumanPawnHover(dom, cell, playerToMove) {
  if (dom._hoverPawnCell === cell) {
    return;
  }
  clearHumanHover(dom);
  const side = humanSideClass(playerToMove);
  cell.classList.add('human-hover-pawn', `human-hover-pawn--${side}`);
  elevatePreviewCell(cell, dom);
  dom._hoverPawnCell = cell;
}

function updateHumanMoveHover(ev, state, dom, controller) {
  if (!canHumanInteract(state, controller)) {
    clearHumanHover(dom);
    return;
  }

  const cell = ev.target.closest('.quoridor-board .cell.hl');
  if (cell) {
    setHumanPawnHover(dom, cell, state.playerToMove);
    return;
  }

  if (dom._hoverPawnCell) {
    dom._hoverPawnCell.classList.remove(
      'human-hover-pawn',
      'human-hover-pawn--player1',
      'human-hover-pawn--player2',
    );
    dom._hoverPawnCell = null;
  }

  const groove = ev.target.closest('.quoridor-board .groove');
  dom.previewEl?.remove();
  dom.previewEl = null;
  if (!groove?.classList.contains('active')) {
    return;
  }

  const pick = pickWallSlot(
    groove.dataset.gtype,
    Number(groove.dataset.gr),
    Number(groove.dataset.gc),
    ev,
    groove,
    state.board,
    state.settings.rotateBoard,
  );
  if (!pick) {
    return;
  }

  dom.previewEl = addWallElement(dom.root, pick.type, pick.viewSlot, {
    preview: true,
    bad: !pick.legal,
    ghost: pick.legal,
    owner: state.playerToMove,
  });
}

function clearCatVision(dom) {
  dom.catEls?.forEach((el) => el.remove());
  dom.catEls = [];
  resetVisionCellZIndex(dom);
}

function catVizFingerprint(viz) {
  if (!viz) {
    return '';
  }
  const wallKeys = [...(viz.wallIndex?.keys?.() ?? [])].sort().join(',');
  const squareSum = (viz.squares ?? []).reduce((sum, v) => sum + (Number(v) || 0), 0);
  return `${viz.hotCm}|${viz.coldCm}|${squareSum}|${wallKeys}`;
}

function lmrVizFingerprint(viz) {
  if (!viz) {
    return '';
  }
  return (viz.moves ?? [])
    .map((m) => `${m.move}:${m.catCm}:${m.reduction}:${m.childDepthUsed}`)
    .join('|');
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

const VISION_Z_MIN = 2;
const VISION_Z_MAX = 19;
const VISION_Z_LABEL_BOOST = 1;
const VISION_Z_TOP = VISION_Z_MAX + VISION_Z_LABEL_BOOST;
const PAWN_Z_ABOVE_VISION = 4;
const PAWN_Z = VISION_Z_TOP + PAWN_Z_ABOVE_VISION;
const PAWN_UI_Z = PAWN_Z + 4;
const BOARD_OVERLAY_Z = PAWN_Z + 8;

function applyBoardStackOrder(boardEl) {
  if (!boardEl) {
    return;
  }
  boardEl.style.setProperty('--vision-z-top', String(VISION_Z_TOP));
  boardEl.style.setProperty('--pawn-z', String(PAWN_Z));
  boardEl.style.setProperty('--pawn-ui-z', String(PAWN_UI_Z));
  boardEl.style.setProperty('--board-overlay-z', String(BOARD_OVERLAY_Z));
}

/** Map priority (depth / heat) into a stacking band so larger values paint on top. */
function visionStackZ(priority, maxPriority) {
  const max = Math.max(1, Number(maxPriority) || 1);
  const p = Math.max(0, Number(priority) || 0);
  if (p <= 0) {
    return VISION_Z_MIN;
  }
  const t = Math.min(1, p / max);
  return Math.round(VISION_Z_MIN + t * (VISION_Z_MAX - VISION_Z_MIN));
}

function trackVisionCellZ(dom, cell, priority, maxPriority) {
  if (!cell) {
    return;
  }
  cell.style.zIndex = String(visionStackZ(priority, maxPriority));
  if (!dom._visionZCells) {
    dom._visionZCells = new Set();
  }
  dom._visionZCells.add(cell);
}

function resetVisionCellZIndex(dom) {
  for (const cell of dom._visionZCells ?? []) {
    if (cell.classList.contains('pawn-cell')) {
      continue;
    }
    cell.style.zIndex = '';
  }
  dom._visionZCells = new Set();
}

function applyPieceLayerStacking(dom, pawnViewCells) {
  const pawnSet = new Set(pawnViewCells);
  const pawnZ = String(dom.pawnZ ?? PAWN_Z);
  for (let i = 0; i < (dom.cellEls?.length ?? 0); i++) {
    const cell = dom.cellEls[i];
    if (!cell) {
      continue;
    }
    const isPawnHome = pawnSet.has(i);
    cell.classList.toggle('pawn-cell', isPawnHome);
    const elevate =
      isPawnHome ||
      cell.classList.contains('hl') ||
      cell.classList.contains('ghost-pawn') ||
      cell.classList.contains('human-hover-pawn');
    if (elevate) {
      cell.style.zIndex = pawnZ;
      dom._visionZCells?.delete(cell);
    }
  }
  for (const pawnEl of dom.pawnEls ?? []) {
    pawnEl.style.zIndex = pawnZ;
  }
  if (dom._ghostWallEl) {
    dom._ghostWallEl.style.zIndex = pawnZ;
  }
  if (dom.previewEl) {
    dom.previewEl.style.zIndex = pawnZ;
  }
}

function lmrEntryDepth(entry) {
  const used = Number(entry?.childDepthUsed);
  if (Number.isFinite(used) && (used > 0 || entry?.deadTail)) {
    return used;
  }
  return Number(entry?.childDepthFull ?? 0) || 0;
}

function catHeatLabel(heat) {
  const n = Number(heat) || 0;
  return n > 0 ? String(Math.round(n)) : '';
}

function resolveCatVisualSettings(state) {
  return {
    showSquares: true,
    showWalls: true,
    squareOpacity: 1,
    wallOpacity: 1,
    ...(state.settings?.catVision ?? {}),
  };
}

function catPaintScale(values, fallback = {}) {
  let maxHeat = 0;
  for (const value of values ?? []) {
    const heat = Number(value) || 0;
    if (heat > maxHeat) {
      maxHeat = heat;
    }
  }
  if (maxHeat <= 0) {
    return {
      coldCm: 0,
      hotCm: fallback.hotCm ?? 1,
      maxCm: fallback.maxCm ?? 2,
    };
  }
  return {
    coldCm: 0,
    hotCm: Math.max(1, maxHeat * 0.45),
    maxCm: Math.max(2, maxHeat),
  };
}

function addCatWallBar(dom, boardEl, type, viewSlot, entry, scale, visual, maxHeat) {
  const el = document.createElement('div');
  el.className = 'cat-move-ghost cat-move-ghost--wall ' + (type === 0 ? 'wallpiece--h' : 'wallpiece--v');
  const heat = Number(entry.heat) || 0;
  const skipped = entry.skip || !entry.search;
  const wallStyle = catWallOverlay(heat, scale);
  const alpha = clampNumber((skipped ? 0.35 : 1) * visual.wallOpacity, 0.05, 1.2);
  el.style.opacity = String(alpha);
  el.style.background = wallStyle.fill;
  el.style.boxShadow = `0 0 10px ${wallStyle.glow}`;
  el.style.borderColor = wallStyle.fill;
  el.style.zIndex = String(visionStackZ(heat, maxHeat));
  const direct = Number(entry.directHeat ?? heat) || 0;
  const counter = Math.max(0, heat - direct);
  const detail = counter > 0 ? ` · counter +${Math.round(counter)}cm` : '';
  el.title = `${heat}cm${detail}${entry.skip ? ' skipped' : ' impact'}`;
  const { gr, gc, rowSpan, colSpan } = wallGridFromSlot(type, viewSlot);
  applyGridPos(el, gr, gc, rowSpan, colSpan);
  boardEl.appendChild(el);
  dom.catEls.push(el);
}

function addCatSquareHeat(dom, engineCell, heat, overlay, squareOpacity, isFlipped, maxHeat) {
  const viewCell = viewMove(engineCell, isFlipped);
  const cell = dom.cellEls[viewCell];
  if (!cell) {
    return;
  }
  const label = catHeatLabel(heat);
  const el = document.createElement('div');
  el.className =
    'cat-move-ghost cat-move-ghost--pawn lmr-move-ghost lmr-move-ghost--pawn cat-vision-ghost cat-vision-ghost--pawn';
  el.style.background = overlay.fill;
  el.style.opacity = String(clampNumber(overlay.opacity * squareOpacity, 0.05, 1));
  el.style.zIndex = String(visionStackZ(heat, maxHeat));
  el.textContent = label;
  el.title = `${heat}cm`;
  cell.appendChild(el);
  dom.catEls.push(el);
  trackVisionCellZ(dom, cell, heat, maxHeat);
}

/** Same second-pass label anchors as LMR wall depth badges. */
function addVisionWallLabel(dom, boardEl, type, viewSlot, text, priority, maxPriority) {
  if (!text) {
    return;
  }
  const { gr, gc, rowSpan, colSpan } = wallGridFromSlot(type, viewSlot);
  const anchor = document.createElement('div');
  anchor.className =
    'lmr-wall-label-anchor ' + (type === 0 ? 'wallpiece--h' : 'wallpiece--v');
  anchor.style.zIndex = String(visionStackZ(priority, maxPriority) + VISION_Z_LABEL_BOOST);
  const label = document.createElement('span');
  label.className = 'lmr-wall-label ' + (type === 0 ? 'lmr-wall-label--h' : 'lmr-wall-label--v');
  label.textContent = text;
  anchor.appendChild(label);
  applyGridPos(anchor, gr, gc, rowSpan, colSpan);
  boardEl.appendChild(anchor);
  dom.catEls.push(anchor);
}

function renderCatVision(dom, state) {
  const fp = catVizFingerprint(state.catViz);
  const loading = !!state.catVizLoading;
  dom.root?.classList.toggle('board-vision--refreshing', loading && !!dom._catVizFp);
  if (!state.settings?.showCatVision || state.winner || state.isDraw) {
    if (dom._catVizFp) {
      clearCatVision(dom);
      dom._catVizFp = '';
    }
    dom.root?.classList.remove('board-vision--refreshing');
    return;
  }
  if (!state.catViz) {
    if (loading && dom._catVizFp) {
      return;
    }
    if (dom._catVizFp) {
      clearCatVision(dom);
      dom._catVizFp = '';
    }
    return;
  }
  if (dom._catVizFp === fp) {
    return;
  }
  dom._catVizFp = fp;
  clearCatVision(dom);
  const viz = state.catViz;
  const visual = resolveCatVisualSettings(state);
  const squareScale = catPaintScale(viz.squares, viz);
  const wallScale = catPaintScale(
    [...(viz.wallIndex?.values?.() ?? [])].map((entry) => entry?.heat),
    viz,
  );
  const isFlipped = state.settings.rotateBoard;
  const boardEl = dom.root;

  let maxSquareHeat = 0;
  const squareEntries = [];
  if (visual.showSquares) {
    for (let engineCell = 0; engineCell < 81; engineCell++) {
      const row = (engineCell / 9) | 0;
      const col = engineCell % 9;
      const catIndex = catSquareIndex(row, col);
      const heat = Number(viz.squares?.[catIndex] ?? 0);
      const reachable = viz.reachable ? viz.reachable[catIndex] : true;
      const overlay = catSquareOverlay(heat, reachable, squareScale);
      if (!overlay) {
        continue;
      }
      maxSquareHeat = Math.max(maxSquareHeat, heat);
      squareEntries.push({ engineCell, heat, overlay });
    }
    squareEntries.sort((a, b) => a.heat - b.heat);
    const squareOpacity = clampNumber(visual.squareOpacity, 0.05, 1.5);
    for (const { engineCell, heat, overlay } of squareEntries) {
      addCatSquareHeat(dom, engineCell, heat, overlay, squareOpacity, isFlipped, maxSquareHeat);
    }
  }

  if (visual.showWalls) {
    const wallEntries = [];
    for (const [alg, entry] of viz.wallIndex ?? []) {
      const heat = Number(entry.heat) || 0;
      if (heat <= 0) {
        continue;
      }
      const move = algebraicToEngineMove(alg);
      if (move < 100) {
        continue;
      }
      const type = move < 200 ? 0 : 1;
      const viewSlot = viewMove(move, isFlipped) % 100;
      wallEntries.push({ type, viewSlot, entry, heat });
    }
    const maxWallHeat = wallEntries.reduce((max, w) => Math.max(max, w.heat), 0);
    wallEntries.sort((a, b) => a.heat - b.heat);
    for (const { type, viewSlot, entry, heat } of wallEntries) {
      addCatWallBar(dom, boardEl, type, viewSlot, entry, wallScale, visual, maxWallHeat);
    }
    for (const { type, viewSlot, heat } of wallEntries) {
      addVisionWallLabel(dom, boardEl, type, viewSlot, catHeatLabel(heat), heat, maxWallHeat);
    }
  }
}

function addLmrPawnHeat(dom, engineMove, entry, isFlipped, viz, maxDepth) {
  const viewCell = viewMove(engineMove, isFlipped);
  const cell = dom.cellEls[viewCell];
  if (!cell) {
    return;
  }
  const depth = lmrEntryDepth(entry);
  const style = lmrDepthStyle(entry, viz);
  const depthLabel = lmrDisplayText(entry, viz);
  const el = document.createElement('div');
  el.className = 'cat-move-ghost cat-move-ghost--pawn lmr-move-ghost lmr-move-ghost--pawn';
  el.style.background = style.fill;
  el.classList.toggle('lmr-move-ghost--light-text', style.textLight);
  el.classList.toggle('lmr-move-ghost--dead-tail', style.mode === 'dead-tail');
  el.style.zIndex = String(visionStackZ(depth, maxDepth));
  el.textContent = depthLabel;
  el.title = `${entry.move}: cut ${entry.reduction} ply, child d${entry.childDepthUsed} (req ${Number(entry.requestedReductionFp ?? 0).toFixed(2)}, full ${entry.childDepthFull})`;
  cell.appendChild(el);
  dom.catEls.push(el);
  trackVisionCellZ(dom, cell, depth, maxDepth);
}

function addLmrWallBar(dom, boardEl, type, viewSlot, entry, viz, maxDepth) {
  const depth = lmrEntryDepth(entry);
  const style = lmrDepthStyle(entry, viz);
  const depthLabel = lmrDisplayText(entry, viz);
  const el = document.createElement('div');
  el.className = 'cat-move-ghost cat-move-ghost--wall lmr-move-ghost lmr-move-ghost--wall ' + (type === 0 ? 'wallpiece--h' : 'wallpiece--v');
  el.style.background = style.fill;
  el.style.borderColor = style.fill;
  el.classList.toggle('lmr-move-ghost--dead-tail', style.mode === 'dead-tail');
  el.style.zIndex = String(visionStackZ(depth, maxDepth));
  el.title = `${entry.move}: cut ${entry.reduction} ply, child d${entry.childDepthUsed} (req ${Number(entry.requestedReductionFp ?? 0).toFixed(2)}, full ${entry.childDepthFull})`;
  const { gr, gc, rowSpan, colSpan } = wallGridFromSlot(type, viewSlot);
  applyGridPos(el, gr, gc, rowSpan, colSpan);
  boardEl.appendChild(el);
  dom.catEls.push(el);
}

/** Second pass: same slot/offset as wall bar, labels only — z above same-depth bar. */
function addLmrWallLabel(dom, boardEl, type, viewSlot, entry, viz, maxDepth) {
  const depthLabel = lmrDisplayText(entry, viz);
  if (!depthLabel) {
    return;
  }
  const style = lmrDepthStyle(entry, viz);
  const { gr, gc, rowSpan, colSpan } = wallGridFromSlot(type, viewSlot);
  const anchor = document.createElement('div');
  anchor.className =
    'lmr-wall-label-anchor ' +
    (type === 0 ? 'wallpiece--h' : 'wallpiece--v') +
    (style.mode === 'dead-tail' ? ' lmr-move-ghost--dead-tail' : '');
  anchor.style.zIndex = String(visionStackZ(lmrEntryDepth(entry), maxDepth) + VISION_Z_LABEL_BOOST);
  const label = document.createElement('span');
  label.className = 'lmr-wall-label ' + (type === 0 ? 'lmr-wall-label--h' : 'lmr-wall-label--v');
  label.textContent = depthLabel;
  anchor.appendChild(label);
  applyGridPos(anchor, gr, gc, rowSpan, colSpan);
  boardEl.appendChild(anchor);
  dom.catEls.push(anchor);
}

function clearLmrVision(dom) {
  dom.catEls?.forEach((el) => {
    if (
      el.classList.contains('lmr-move-ghost') ||
      el.classList.contains('lmr-wall-label-anchor')
    ) {
      el.remove();
    }
  });
  dom.catEls = (dom.catEls ?? []).filter(
    (el) =>
      !el.classList.contains('lmr-move-ghost') &&
      !el.classList.contains('lmr-wall-label-anchor'),
  );
  resetVisionCellZIndex(dom);
}

function renderLmrVision(dom, state) {
  const fp = lmrVizFingerprint(state.lmrViz);
  const loading = !!state.lmrVizLoading;
  if (state.settings?.showLmrVision) {
    dom.root?.classList.toggle('board-vision--refreshing', loading && !!dom._lmrVizFp);
  }
  if (!state.settings?.showLmrVision || state.winner || state.isDraw) {
    if (dom._lmrVizFp) {
      clearLmrVision(dom);
      dom._lmrVizFp = '';
    }
    dom.root?.classList.remove('board-vision--refreshing');
    return;
  }
  if (!state.lmrViz) {
    if (loading && dom._lmrVizFp) {
      return;
    }
    if (dom._lmrVizFp) {
      clearLmrVision(dom);
      dom._lmrVizFp = '';
    }
    return;
  }
  if (dom._lmrVizFp === fp) {
    return;
  }
  dom._lmrVizFp = fp;
  clearLmrVision(dom);
  const viz = state.lmrViz;
  const isFlipped = state.settings.rotateBoard;
  const boardEl = dom.root;
  const sourceMoves = viz.visibleMoves?.length ? viz.visibleMoves : [];
  const pawnEntries = [];
  const wallEntries = [];
  for (const entry of sourceMoves ?? []) {
    if (!entry?.move) {
      continue;
    }
    const move = algebraicToEngineMove(entry.move);
    if (move < 100) {
      pawnEntries.push({ entry, move });
      continue;
    }
    const type = move < 200 ? 0 : 1;
    const viewSlot = viewMove(move, isFlipped) % 100;
    wallEntries.push({ entry, type, viewSlot });
  }
  const maxDepth = Math.max(
    1,
    ...pawnEntries.map(({ entry }) => lmrEntryDepth(entry)),
    ...wallEntries.map(({ entry }) => lmrEntryDepth(entry)),
  );
  pawnEntries.sort((a, b) => lmrEntryDepth(a.entry) - lmrEntryDepth(b.entry));
  wallEntries.sort((a, b) => lmrEntryDepth(a.entry) - lmrEntryDepth(b.entry));
  for (const { entry, move } of pawnEntries) {
    addLmrPawnHeat(dom, move, entry, isFlipped, viz, maxDepth);
  }
  for (const { entry, type, viewSlot } of wallEntries) {
    addLmrWallBar(dom, boardEl, type, viewSlot, entry, viz, maxDepth);
  }
  for (const { entry, type, viewSlot } of wallEntries) {
    addLmrWallLabel(dom, boardEl, type, viewSlot, entry, viz, maxDepth);
  }
}

function addWallElement(boardEl, type, viewSlot, { preview, bad, ghost, owner }) {
  const el = document.createElement('div');
  el.className =
    'wallpiece' +
    (type === 0 ? ' wallpiece--h' : ' wallpiece--v') +
    (owner === 1 ? ' wallpiece--player1' : owner === 2 ? ' wallpiece--player2' : '') +
    (preview ? ' preview' + (bad ? ' bad' : '') : '') +
    (ghost ? ' ghost-pv' : '');
  const { gr, gc, rowSpan, colSpan } = wallGridFromSlot(type, viewSlot);
  applyGridPos(el, gr, gc, rowSpan, colSpan);
  if (ghost) {
    const inner = document.createElement('div');
    inner.className = 'ghost-pv-inner';
    inner.appendChild(createGhostWallRing(type === 0));
    el.appendChild(inner);
  }
  if (preview || ghost) {
    el.style.zIndex = String(PAWN_Z);
  }
  boardEl.appendChild(el);
  return el;
}

function slotCandidates(gtype, r, c, ev, el) {
  const rect = el.getBoundingClientRect();
  if (gtype === 'h') {
    const frac = (ev.clientX - rect.left) / rect.width;
    const first = frac < 0.5 ? c - 1 : c;
    const second = frac < 0.5 ? c : c - 1;
    return [0, validSlot(r, first), validSlot(r, second)];
  }
  if (gtype === 'v') {
    const fracY = (ev.clientY - rect.top) / rect.height;
    const first = fracY < 0.5 ? r - 1 : r;
    const second = fracY < 0.5 ? r : r - 1;
    return [1, validSlot(first, c), validSlot(second, c)];
  }
  return [0, validSlot(r, c), null];

  function validSlot(rr, cc) {
    return rr >= 0 && rr <= 7 && cc >= 0 && cc <= 7 ? rr * 8 + cc : null;
  }
}

function pickWallSlot(gtype, r, c, ev, el, board, isFlipped) {
  const cand = slotCandidates(gtype, r, c, ev, el);
  const type = cand[0];
  const wbase = type === 0 ? 100 : 200;
  for (let i = 1; i <= 2; i++) {
    if (cand[i] === null) {
      continue;
    }
    const engineSlot = viewMove(wbase + cand[i], isFlipped) % 100;
    const alg = engineMoveToAlgebraic(wbase + engineSlot);
    if (board.isValid(parseAlgebraic(alg))) {
      return { type, viewSlot: cand[i], legal: true, alg };
    }
  }
  if (cand[1] !== null) {
    const engineSlot = viewMove(wbase + cand[1], isFlipped) % 100;
    const alg = engineMoveToAlgebraic(wbase + engineSlot);
    const action = parseAlgebraic(alg);
    if (!board.collidesWithExistingWall(action)) {
      return { type, viewSlot: cand[1], legal: false, alg };
    }
  }
  return null;
}

function buildBoardDom(boardEl) {
  applyBoardStackOrder(boardEl);
  const cellEls = [];
  const grooves = [];
  for (let gr = 1; gr <= 17; gr++) {
    for (let gc = 1; gc <= 17; gc++) {
      const isCellRow = gr % 2 === 1;
      const isCellCol = gc % 2 === 1;
      const el = document.createElement('div');
      applyGridPos(el, gr, gc);
      if (isCellRow && isCellCol) {
        el.className = 'cell';
        const cell = cellIndexFromGrid(gr, gc);
        el.dataset.cell = String(cell);
        cellEls[cell] = el;
      } else {
        el.className = 'groove';
        if (!isCellRow && isCellCol) {
          el.dataset.gtype = 'h';
          el.dataset.gr = String((gr - 2) / 2);
          el.dataset.gc = String((gc - 1) / 2);
        } else if (isCellRow && !isCellCol) {
          el.dataset.gtype = 'v';
          el.dataset.gr = String((gr - 1) / 2);
          el.dataset.gc = String((gc - 2) / 2);
        } else {
          el.dataset.gtype = 'x';
          el.dataset.gr = String((gr - 2) / 2);
          el.dataset.gc = String((gc - 2) / 2);
        }
        grooves.push(el);
      }
      boardEl.appendChild(el);
    }
  }
  const pawnEls = [document.createElement('div'), document.createElement('div')];
  pawnEls[0].className = 'pawn p0';
  pawnEls[1].className = 'pawn p1';
  return { cellEls, grooves, pawnEls, wallEls: {} };
}

function renderWallMarks(playerNum, remaining, visible, controller) {
  const wrap = document.createElement('div');
  wrap.className = `wall-marks wall-marks--p${playerNum}`;
  wrap.addEventListener('click', () => controller.toggleDisplayRemainingWalls?.());

  const count = document.createElement('span');
  count.className = 'wall-marks__count' + (visible ? ' wall-marks__count--visible' : '');
  count.textContent = String(remaining);

  const slots = [];
  for (let index = 0; index < 10; index++) {
    const slot = document.createElement('div');
    const isAvailable = playerNum === 1 ? index < remaining : 10 - index <= remaining;
    slot.className =
      'wall-marks__slot' +
      (isAvailable ? ' wall-marks__slot--available' : '') +
      ` wall-marks__slot--player${playerNum}`;
    slots.push(slot);
  }

  if (playerNum === 2) {
    wrap.append(count, ...slots);
  } else {
    wrap.append(...slots, count);
  }

  return wrap;
}

function syncWallRack(dom, state, controller) {
  const rack = dom.wallRack;
  if (!rack) {
    return;
  }
  const { wallsRemaining, settings } = state;
  const visible = settings.displayRemainingWalls;

  // Screen-stable rack: top = Black (seat 2), bottom = White (seat 1) — never swap on flip.
  const topSection = dom.wallRackTop;
  const bottomSection = dom.wallRackBottom;
  if (!topSection || !bottomSection) {
    return;
  }
  topSection.replaceChildren(renderWallMarks(2, wallsRemaining[1], visible, controller));
  bottomSection.replaceChildren(renderWallMarks(1, wallsRemaining[0], visible, controller));
}

function copyTextToClipboard(text, onCopied) {
  const flash = () => {
    onCopied?.();
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(flash, () => {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      } catch {
        /* clipboard unavailable */
      }
      flash();
    });
  } else {
    flash();
  }
}

function renderTerminalOverlay(state, controller) {
  const message = formatGameEndHeadline(state);
  const showCopyLogs = terminalOverlayShowsCopyLogs(state);
  const banner = document.createElement('div');
  banner.className = 'ace-terminal-overlay';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-modal', 'true');

  const messageEl = document.createElement('span');
  messageEl.className = 'ace-terminal-overlay__message';
  messageEl.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'ace-terminal-overlay__actions';
  if (showCopyLogs) {
    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'btn btn--small ace-terminal-overlay__copy';
    copyBtn.dataset.action = 'copy-logs';
    copyBtn.textContent = 'Copy logs';
    copyBtn.addEventListener('click', () => {
      const text = formatLogsText(state);
      copyTextToClipboard(text, () => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => {
          copyBtn.textContent = 'Copy logs';
        }, 1500);
      });
    });
    actions.appendChild(copyBtn);
  }
  const newGameBtn = document.createElement('button');
  newGameBtn.type = 'button';
  newGameBtn.className = 'btn btn--small ace-terminal-overlay__close';
  newGameBtn.textContent = 'New game';
  newGameBtn.addEventListener('click', () => {
    controller.dismissTerminalOverlay?.();
    controller._openPlayerDialog?.({ mode: 'newgame' });
  });
  actions.appendChild(newGameBtn);

  banner.append(messageEl, actions);
  return banner;
}

function syncBoardDom(dom, state, controller) {
  const { board, validActions, playerPositions, settings, aiThinking, winner, isDraw, uiMode } =
    state;

  const isFlipped = settings.rotateBoard;
  const { cellEls, pawnEls, wallEls } = dom;
  const boardEl = dom.root;
  const lastKey = state.lastAction ? toAlgebraic(state.lastAction) : null;
  const freePlay = uiMode === 'analysis';
  const canInteract = canHumanInteract(state, controller);
  const interactSide = humanSideClass(state.playerToMove);

  const validKeys = new Set(validActions.map((a) => toAlgebraic(a)));
  const wallOwners = new Map();
  for (const [playerNum, coordinate, wallType] of state.wallsByPlayer ?? []) {
    wallOwners.set(toAlgebraic({ coordinate, wallType }), playerNum);
  }
  const pawnValid = new Set();
  for (const key of validKeys) {
    if (key.length !== 2) {
      continue;
    }
    const cell = pawnCellFromCoordinate(parseAlgebraic(key).coordinate);
    pawnValid.add(viewMove(cell, isFlipped));
  }

  const whiteCell = pawnCellFromCoordinate(playerPositions[0]);
  const blackCell = pawnCellFromCoordinate(playerPositions[1]);
  cellEls[viewMove(whiteCell, isFlipped)]?.appendChild(pawnEls[0]);
  cellEls[viewMove(blackCell, isFlipped)]?.appendChild(pawnEls[1]);

  for (const key of Object.keys(wallEls)) {
    wallEls[key].remove();
    delete wallEls[key];
  }

  const { hw, vw } = wallSlotsFromBoard(board);
  for (let slot = 0; slot < 64; slot++) {
    if (hw[slot]) {
      const viewSlot = viewMove(100 + slot, isFlipped) % 100;
      const alg = engineMoveToAlgebraic(100 + slot);
      wallEls[`h${slot}`] = addWallElement(boardEl, 0, viewSlot, {
        preview: false,
        owner: wallOwners.get(alg),
      });
    }
    if (vw[slot]) {
      const viewSlot = viewMove(200 + slot, isFlipped) % 100;
      const alg = engineMoveToAlgebraic(200 + slot);
      wallEls[`v${slot}`] = addWallElement(boardEl, 1, viewSlot, {
        preview: false,
        owner: wallOwners.get(alg),
      });
    }
  }

  cellEls.forEach((cell) => {
    cell.classList.remove('hl', 'hl--player1', 'hl--player2', 'lastc');
    if (!cell.classList.contains('ghost-pawn')) {
      cell.removeAttribute('data-action');
    }
  });
  boardEl.querySelectorAll('.wallpiece.lastw').forEach((w) => {
    w.classList.remove('lastw');
  });

  if (lastKey) {
    if (lastKey.length === 2) {
      const cell = viewMove(pawnCellFromCoordinate(parseAlgebraic(lastKey).coordinate), isFlipped);
      cellEls[cell]?.classList.add('lastc');
    } else {
      const move = algebraicToEngineMove(lastKey);
      if (move >= 100) {
        const k = (move < 200 ? 'h' : 'v') + (move % 100);
        wallEls[k]?.classList.add('lastw');
      }
    }
  }

  const ghostKey = liveGhostKey(state, validActions);
  const thinkSeat = state.aiThinking ? state.thinkingSeatIndex : null;
  const ghostPlayer = thinkSeat != null ? thinkSeat + 1 : (state.eval?.playerToMove ?? state.playerToMove);
  const sideClass = ghostPlayer === 2 ? 'player2' : 'player1';
  const ghostIdentity = `${ghostKey}|${sideClass}`;
  if (dom._ghostIdentity !== ghostIdentity) {
    cellEls.forEach((cell) => {
      cell.classList.remove('ghost-pawn', 'ghost-pawn--player1', 'ghost-pawn--player2');
    });
    dom._ghostWallEl?.remove();
    dom._ghostWallEl = null;

    if (ghostKey) {
      let action;
      try {
        action = parseAlgebraic(ghostKey);
      } catch {
        action = null;
      }
      if (action && !isWallAction(action)) {
        const cell = viewMove(pawnCellFromCoordinate(action.coordinate), isFlipped);
        const el = cellEls[cell];
        if (el) {
          el.classList.add('ghost-pawn', `ghost-pawn--${sideClass}`);
          el.dataset.action = ghostKey;
        }
      } else if (action && isWallAction(action)) {
        const move = algebraicToEngineMove(ghostKey);
        if (move >= 100) {
          const type = move < 200 ? 0 : 1;
          const viewSlot = viewMove(move, isFlipped) % 100;
          dom._ghostWallEl = addWallElement(boardEl, type, viewSlot, {
            preview: true,
            bad: false,
            ghost: true,
            owner: state.playerToMove,
          });
        }
      }
    }
    dom._ghostIdentity = ghostIdentity;
  }

  if (canInteract) {
    for (const cellIdx of pawnValid) {
      const cell = cellEls[cellIdx];
      if (!cell) {
        continue;
      }
      cell.classList.add('hl', `hl--${interactSide}`);
      cell.dataset.action = engineMoveToAlgebraic(viewMove(cellIdx, isFlipped));
    }
    if (board.playerHasWalls()) {
      dom.grooves.forEach((g) => g.classList.add('active'));
    } else {
      dom.grooves.forEach((g) => g.classList.remove('active'));
    }
  } else {
    dom.grooves.forEach((g) => g.classList.remove('active'));
    clearHumanHover(dom);
  }

  renderCatVision(dom, state);
  renderLmrVision(dom, state);

  applyPieceLayerStacking(dom, [
    viewMove(whiteCell, isFlipped),
    viewMove(blackCell, isFlipped),
  ]);

  syncWallRack(dom, state, controller);

  dom.overlay?.remove();
  dom.overlay = null;
  const headline = formatGameEndHeadline(state);
  if (headline && !state.terminalOverlayDismissed) {
    dom.overlay = renderTerminalOverlay(state, controller);
    boardEl.appendChild(dom.overlay);
  }
}

function bindBoardInput(container, getState, controller) {
  if (container._boardInputBound) {
    return;
  }
  container._boardInputBound = true;

  container.addEventListener('click', (ev) => {
    const state = getState();
    if (!state) {
      return;
    }
    const isFlipped = state.settings.rotateBoard;
    const cell = ev.target.closest('.quoridor-board .cell');
    if (cell?.classList.contains('hl')) {
      const alg = cell.dataset.action;
      if (alg) {
        controller.tryAction(parseAlgebraic(alg));
      } else {
        const engineCell = viewMove(Number(cell.dataset.cell), isFlipped);
        controller.tryAction(parseAlgebraic(engineMoveToAlgebraic(engineCell)));
      }
      return;
    }
    const groove = ev.target.closest('.quoridor-board .groove');
    if (!groove?.classList.contains('active')) {
      return;
    }
    const pick = pickWallSlot(
      groove.dataset.gtype,
      Number(groove.dataset.gr),
      Number(groove.dataset.gc),
      ev,
      groove,
      state.board,
      isFlipped,
    );
    if (pick?.legal) {
      controller.tryAction(parseAlgebraic(pick.alg));
    }
  });

  container.addEventListener('mousemove', (ev) => {
    const state = getState();
    const dom = container._boardDom;
    if (!state || !dom) {
      return;
    }
    updateHumanMoveHover(ev, state, dom, controller);
  });

  container.addEventListener('mouseleave', () => {
    const dom = container._boardDom;
    if (dom) {
      clearHumanHover(dom);
    }
  });
}

export function renderBoard(container, state, controller) {
  const structureKey = boardStructureKey(state);
  const existing = container.querySelector('.quoridor-board');

  if (existing && container.dataset.boardStructureKey === structureKey && container._boardDom) {
    syncBoardDom(container._boardDom, state, controller);
    return;
  }

  container.innerHTML = '';
  container.dataset.boardStructureKey = structureKey;
  container.className = 'board-panel';

  const showCoords = state.settings?.displayCoordinates !== false;
  const coordsWrap = document.createElement('div');
  coordsWrap.className = 'board-panel__coords-wrap';

  const gridWrap = document.createElement('div');
  gridWrap.className = 'board-panel__grid-wrap';

  const boardEl = document.createElement('div');
  boardEl.className = 'quoridor-board';
  boardEl.id = 'quoridor-board';

  const wallRack = document.createElement('aside');
  wallRack.className = 'board-wall-rack';
  wallRack.setAttribute('aria-hidden', 'true');

  const wallRackTop = document.createElement('div');
  wallRackTop.className = 'board-wall-rack__section board-wall-rack__section--top';

  const flipBtn = document.createElement('button');
  flipBtn.type = 'button';
  flipBtn.className = 'board-flip-btn';
  flipBtn.title = 'Flip board orientation';
  flipBtn.setAttribute('aria-label', 'Flip board orientation');
  flipBtn.innerHTML = '<span class="board-flip-btn__icon" aria-hidden="true">⇅</span>';
  flipBtn.addEventListener('click', () => controller.toggleRotateBoard?.());

  const wallRackBottom = document.createElement('div');
  wallRackBottom.className = 'board-wall-rack__section board-wall-rack__section--bottom';

  wallRack.append(wallRackTop, flipBtn, wallRackBottom);

  const dom = buildBoardDom(boardEl);
  dom.root = boardEl;
  dom.pawnZ = PAWN_Z;
  dom.previewEl = null;
  dom.overlay = null;
  dom.wallRack = wallRack;
  dom.wallRackTop = wallRackTop;
  dom.wallRackBottom = wallRackBottom;
  dom.flipBtn = flipBtn;
  dom.catEls = [];

  gridWrap.appendChild(boardEl);

  if (showCoords) {
    const { top, left } = renderBoardCoords(Boolean(state.settings?.rotateBoard));
    const row = document.createElement('div');
    row.className = 'board-panel__coords-row';
    row.append(left, gridWrap);
    coordsWrap.append(top, row);
  } else {
    coordsWrap.appendChild(gridWrap);
  }

  container.append(coordsWrap, wallRack);
  container._boardDom = dom;
  bindBoardInput(container, () => controller.getState(), controller);

  syncBoardDom(dom, state, controller);
}
