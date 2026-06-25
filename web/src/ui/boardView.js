/**
 * Playable board — AceV13.1.html 17×17 groove grid (cells + wall grooves).
 * Rules: pawns on 9×9 nodes, walls only in grooves, legality via QuoridorBoard (BFS).
 */

import { parseAlgebraic, toAlgebraic, isWallAction } from '../lib/gameLogic.js';
import { playerColorName } from '../lib/playerColors.js';
import { resolveLiveBestMoveKey } from '../lib/liveBestMove.js';
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
  gridFromCellIndex,
} from '../lib/aceBoardGrid.js';
import './board.css';

const PATH_Q = new Int16Array(81);
const DELTA = [-9, 9, -1, 1];

function blockedBitsFromBoard(board) {
  const blocked = new Uint8Array(81);
  const { hw, vw } = wallSlotsFromBoard(board);
  for (let slot = 0; slot < 64; slot++) {
    const r = (slot / 8) | 0;
    const c = slot % 8;
    const a = r * 9 + c;
    if (hw[slot]) {
      blocked[a] |= 2;
      blocked[a + 1] |= 2;
      blocked[a + 9] |= 1;
      blocked[a + 10] |= 1;
    }
    if (vw[slot]) {
      blocked[a] |= 8;
      blocked[a + 9] |= 8;
      blocked[a + 1] |= 4;
      blocked[a + 10] |= 4;
    }
  }
  return blocked;
}

function bfsFromSources(sources, blocked) {
  const dist = new Uint8Array(81);
  dist.fill(255);
  let head = 0;
  let tail = 0;
  for (const src of sources) {
    dist[src] = 0;
    PATH_Q[tail++] = src;
  }
  while (head < tail) {
    const u = PATH_Q[head++];
    const r = (u / 9) | 0;
    const c = u % 9;
    const du = dist[u] + 1;
    const b = blocked[u];
    for (let d = 0; d < 4; d++) {
      if (b & (1 << d)) continue;
      if ((d === 0 && r === 0) || (d === 1 && r === 8) || (d === 2 && c === 0) || (d === 3 && c === 8)) {
        continue;
      }
      const v = u + DELTA[d];
      if (dist[v] > du) {
        dist[v] = du;
        PATH_Q[tail++] = v;
      }
    }
  }
  return dist;
}

function shortestDagInfo(board, playerPositions) {
  const blocked = blockedBitsFromBoard(board);
  const p0 = pawnCellFromCoordinate(playerPositions[0]);
  const p1 = pawnCellFromCoordinate(playerPositions[1]);
  const toGoal0 = bfsFromSources([0, 1, 2, 3, 4, 5, 6, 7, 8], blocked);
  const toGoal1 = bfsFromSources([72, 73, 74, 75, 76, 77, 78, 79, 80], blocked);
  const from0 = bfsFromSources([p0], blocked);
  const from1 = bfsFromSources([p1], blocked);
  const total0 = toGoal0[p0];
  const total1 = toGoal1[p1];
  const on0 = new Uint8Array(81);
  const on1 = new Uint8Array(81);
  const width0 = new Uint8Array(18);
  const width1 = new Uint8Array(18);
  for (let c = 0; c < 81; c++) {
    if (from0[c] + toGoal0[c] === total0) {
      on0[c] = 1;
      if (toGoal0[c] < 18) width0[toGoal0[c]]++;
    }
    if (from1[c] + toGoal1[c] === total1) {
      on1[c] = 1;
      if (toGoal1[c] < 18) width1[toGoal1[c]]++;
    }
  }
  return { blocked, p0, p1, toGoal0, toGoal1, from0, from1, total0, total1, on0, on1, width0, width1 };
}

function edgePathImpact(u, v, dag) {
  let score = 0;
  if (
    (dag.from0[u] + 1 + dag.toGoal0[v] === dag.total0 && dag.toGoal0[v] < dag.toGoal0[u]) ||
    (dag.from0[v] + 1 + dag.toGoal0[u] === dag.total0 && dag.toGoal0[u] < dag.toGoal0[v])
  ) {
    const layer = Math.min(dag.toGoal0[u], dag.toGoal0[v]);
    score += 1 / Math.max(layer < 18 ? dag.width0[layer] : 1, 1);
  }
  if (
    (dag.from1[u] + 1 + dag.toGoal1[v] === dag.total1 && dag.toGoal1[v] < dag.toGoal1[u]) ||
    (dag.from1[v] + 1 + dag.toGoal1[u] === dag.total1 && dag.toGoal1[u] < dag.toGoal1[v])
  ) {
    const layer = Math.min(dag.toGoal1[u], dag.toGoal1[v]);
    score += 1 / Math.max(layer < 18 ? dag.width1[layer] : 1, 1);
  }
  return score;
}

function wallPathImpact(move, dag) {
  const slot = move % 100;
  const a = ((slot / 8) | 0) * 9 + (slot % 8);
  if (move < 200) {
    return edgePathImpact(a, a + 9, dag) + edgePathImpact(a + 1, a + 10, dag);
  }
  return edgePathImpact(a, a + 1, dag) + edgePathImpact(a + 9, a + 10, dag);
}

function buildMoveOrderGhosts(state) {
  if (!state.settings?.showCatVision || state.winner || state.isDraw) {
    return { pawns: [], walls: [], pathCells: [] };
  }

  const dag = shortestDagInfo(state.board, state.playerPositions);
  const mover = state.playerToMove;
  const distMe = mover === 1 ? dag.toGoal0 : dag.toGoal1;
  const pawnMe = mover === 1 ? dag.p0 : dag.p1;

  const pathCells = [];
  for (let cell = 0; cell < 81; cell++) {
    const overlap = dag.on0[cell] && dag.on1[cell];
    if (overlap || dag.on0[cell] || dag.on1[cell]) {
      const distFromMover = Math.abs(((cell / 9) | 0) - ((pawnMe / 9) | 0)) + Math.abs((cell % 9) - (pawnMe % 9));
      pathCells.push({
        cell,
        heat: overlap ? 1 : Math.max(0.25, 0.75 - distFromMover * 0.07),
        overlap,
      });
    }
  }

  const ordered = [];
  let maxScore = 1;
  for (const action of state.validActions ?? []) {
    const alg = toAlgebraic(action);
    const move = algebraicToEngineMove(alg);
    let score = 0;
    let kind = 'wall';
    if (move < 100) {
      score = 1_000_000 - distMe[move] * 1000;
      kind = 'pawn';
    } else {
      score = wallPathImpact(move, dag) * 100_000;
    }
    if (move < 100 || score > 0) {
      ordered.push({ move, alg, score, kind });
      if (score > maxScore) maxScore = score;
    }
  }
  ordered.sort((a, b) => b.score - a.score);
  const ranked = ordered.map((entry, idx) => ({
    ...entry,
    rank: idx + 1,
    heat: entry.score / maxScore,
  }));
  return {
    pawns: ranked.filter((entry) => entry.kind === 'pawn'),
    walls: ranked.filter((entry) => entry.kind === 'wall'),
    pathCells,
  };
}

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
  return resolveLiveBestMoveKey(state, { validActions }) ?? '';
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

function clearGhostPawnHints(cellEls) {
  cellEls.forEach((cell) => {
    cell.classList.remove('ghost-pawn', 'ghost-pawn--player1', 'ghost-pawn--player2');
  });
}

function clearCatVision(dom) {
  dom.catEls?.forEach((el) => el.remove());
  dom.catEls = [];
}

/** Rank + heat → alpha; compresses score gaps so late-ordered moves stay visible. */
function catMoveAlpha(rank, total, heat, { min = 0.34, max = 0.92 } = {}) {
  const order = total > 1 ? 1 - (rank - 1) / (total - 1) : 1;
  const boosted = Math.pow(Math.max(heat, 0), 0.38);
  const blend = 0.7 * order + 0.3 * boosted;
  return min + blend * (max - min);
}

function addCatPawnGhost(dom, viewCell, heat, rank, total) {
  const cell = dom.cellEls[viewCell];
  if (!cell) return;
  const el = document.createElement('div');
  el.className = 'cat-move-ghost cat-move-ghost--pawn';
  el.style.setProperty('--cat-alpha', String(catMoveAlpha(rank, total, heat)));
  el.textContent = String(rank);
  cell.appendChild(el);
  dom.catEls.push(el);
}

function addCatWallGhost(dom, boardEl, type, viewSlot, heat, rank, total) {
  const el = document.createElement('div');
  el.className = 'cat-move-ghost cat-move-ghost--wall ' + (type === 0 ? 'wallpiece--h' : 'wallpiece--v');
  el.style.setProperty('--cat-alpha', String(catMoveAlpha(rank, total, heat, { min: 0.3, max: 0.9 })));
  const { gr, gc, rowSpan, colSpan } = wallGridFromSlot(type, viewSlot);
  applyGridPos(el, gr, gc, rowSpan, colSpan);
  boardEl.appendChild(el);
  dom.catEls.push(el);
}

function renderCatVision(dom, state) {
  clearCatVision(dom);
  const ghosts = buildMoveOrderGhosts(state);
  const isFlipped = state.settings.rotateBoard;
  const boardEl = dom.root;

  for (const entry of ghosts.pathCells) {
    const viewCell = viewMove(entry.cell, isFlipped);
    const cell = dom.cellEls[viewCell];
    if (!cell) continue;
    const el = document.createElement('div');
    el.className = 'cat-path-cell' + (entry.overlap ? ' cat-path-cell--overlap' : '');
    el.style.setProperty(
      '--cat-alpha',
      String(0.14 + Math.pow(Math.max(entry.heat, 0), 0.5) * 0.28),
    );
    cell.appendChild(el);
    dom.catEls.push(el);
  }

  const wallTotal = ghosts.walls.length;
  for (const wall of ghosts.walls) {
    const type = wall.move < 200 ? 0 : 1;
    const viewSlot = viewMove(wall.move, isFlipped) % 100;
    addCatWallGhost(dom, boardEl, type, viewSlot, wall.heat, wall.rank, wallTotal);
  }

  const pawnTotal = ghosts.pawns.length;
  for (const pawn of ghosts.pawns) {
    const viewCell = viewMove(pawn.move, isFlipped);
    addCatPawnGhost(dom, viewCell, pawn.heat, pawn.rank, pawnTotal);
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
  const isFlipped = settings.rotateBoard;

  rack.replaceChildren();
  const top = renderWallMarks(isFlipped ? 1 : 2, wallsRemaining[isFlipped ? 0 : 1], visible, controller);
  const bottom = renderWallMarks(isFlipped ? 2 : 1, wallsRemaining[isFlipped ? 1 : 0], visible, controller);
  rack.append(top, bottom);
}

function renderTerminalOverlay(message, controller) {
  const banner = document.createElement('div');
  banner.className = 'ace-terminal-overlay';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-modal', 'true');
  banner.innerHTML =
    `<span>${message}</span>` +
    '<button type="button" class="btn btn--small ace-terminal-overlay__close">New game</button>';
  banner.querySelector('button').addEventListener('click', () => {
    controller.dismissTerminalOverlay?.();
    controller._openPlayerDialog?.({ mode: 'newgame' });
  });
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
  const canInteract =
    !winner &&
    !isDraw &&
    !aiThinking &&
    uiMode !== 'replay' &&
    (freePlay || controller.session.isHumanTurn(settings.players));

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
  const sideClass = thinkSeat === 1 ? 'player2' : 'player1';
  const ghostIdentity = `${ghostKey}|${sideClass}`;
  if (dom._ghostIdentity !== ghostIdentity) {
    clearGhostPawnHints(cellEls);
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
      cell.classList.add('hl', `hl--${sideClass}`);
      cell.dataset.action = engineMoveToAlgebraic(viewMove(cellIdx, isFlipped));
    }
    if (board.playerHasWalls()) {
      dom.grooves.forEach((g) => g.classList.add('active'));
    } else {
      dom.grooves.forEach((g) => g.classList.remove('active'));
    }
  } else {
    dom.grooves.forEach((g) => g.classList.remove('active'));
  }

  dom.previewEl?.remove();
  dom.previewEl = null;

  renderCatVision(dom, state);

  syncWallRack(dom, state, controller);

  dom.overlay?.remove();
  dom.overlay = null;
  if (isDraw && !state.terminalOverlayDismissed) {
    dom.overlay = renderTerminalOverlay('Draw — threefold repetition', controller);
    boardEl.appendChild(dom.overlay);
  } else if (winner && !state.terminalOverlayDismissed) {
    dom.overlay = renderTerminalOverlay(`${playerColorName(winner)} wins!`, controller);
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
    if (!state || !dom || state.aiThinking || state.winner || state.uiMode === 'replay') {
      dom?.previewEl?.remove();
      if (dom) {
        dom.previewEl = null;
      }
      return;
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
      owner: state.playerToMove,
    });
  });

  container.addEventListener('mouseleave', () => {
    const dom = container._boardDom;
    dom?.previewEl?.remove();
    if (dom) {
      dom.previewEl = null;
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

  const dom = buildBoardDom(boardEl);
  dom.root = boardEl;
  dom.previewEl = null;
  dom.overlay = null;
  dom.wallRack = wallRack;
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
