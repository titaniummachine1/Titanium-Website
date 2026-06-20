/**
 * Playable board — AceV13.1.html 17×17 groove grid (cells + wall grooves).
 * Rules: pawns on 9×9 nodes, walls only in grooves, legality via QuoridorBoard (BFS).
 */

import { parseAlgebraic, toAlgebraic } from '../lib/gameLogic.js';
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
} from '../lib/aceBoardGrid.js';
import './board.css';

function boardStructureKey(state) {
  return JSON.stringify({
    rotate: state.settings?.rotateBoard,
    showWalls: state.settings?.displayRemainingWalls,
  });
}

function liveGhostKey(state, validActions) {
  if (state.settings?.showBestMoveHint === false) {
    return '';
  }
  return resolveLiveBestMoveKey(state, { validActions }) ?? '';
}

function addWallElement(boardEl, type, viewSlot, { preview, bad, ghost, owner }) {
  const el = document.createElement('div');
  el.className =
    'wallpiece' +
    (owner === 1 ? ' wallpiece--player1' : owner === 2 ? ' wallpiece--player2' : '') +
    (preview ? ' preview' + (bad ? ' bad' : '') : '') +
    (ghost ? ' ghost-pv' : '');
  const { gr, gc, rowSpan, colSpan } = wallGridFromSlot(type, viewSlot);
  applyGridPos(el, gr, gc, rowSpan, colSpan);
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
    cell.classList.remove('hl', 'lastc', 'ghost-pawn');
    cell.removeAttribute('data-action');
  });
  boardEl.querySelectorAll('.wallpiece.lastw, .wallpiece.ghost-pv').forEach((w) => {
    w.classList.remove('lastw', 'ghost-pv');
    if (w.classList.contains('preview')) {
      w.remove();
    }
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
  if (ghostKey && ghostKey !== lastKey) {
    if (ghostKey.length === 2) {
      const cell = viewMove(pawnCellFromCoordinate(parseAlgebraic(ghostKey).coordinate), isFlipped);
      const el = cellEls[cell];
      if (el) {
        el.classList.add('ghost-pawn');
        el.dataset.action = ghostKey;
      }
    } else {
      const move = algebraicToEngineMove(ghostKey);
      if (move >= 100) {
        const type = move < 200 ? 0 : 1;
        const viewSlot = viewMove(move, isFlipped) % 100;
        addWallElement(boardEl, type, viewSlot, {
          preview: true,
          bad: false,
          ghost: true,
        });
      }
    }
  }

  if (canInteract) {
    for (const cellIdx of pawnValid) {
      const cell = cellEls[cellIdx];
      if (!cell) {
        continue;
      }
      cell.classList.add('hl');
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

  gridWrap.appendChild(boardEl);
  container.append(gridWrap, wallRack);
  container._boardDom = dom;
  bindBoardInput(container, () => controller.getState(), controller);

  syncBoardDom(dom, state, controller);
}
