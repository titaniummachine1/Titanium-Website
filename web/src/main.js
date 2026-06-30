/**
 * Main entry point — clean game layout
 *
 * Layout (desktop and mobile):
 *   top-card (opponent)
 *   board
 *   bottom-card (active player)
 *   controls
 *   notation bar
 */

import { AppController } from './game/appController.js';
import { renderBoard } from './ui/boardView.js';
import { renderPlayerCard, playerCardStructureKey } from './ui/playerCard.js';
import { openPlayerDialog, refreshOpenPlayerDialog } from './ui/playerDialog.js';
import { renderGameControls, updateNotationBar } from './ui/gameControls.js';
import { updateVisionTuningPanel } from './ui/visionTuningPanel.js';
import { renderWasmDebugPanel, logBuildIdentity } from './lib/wasmBuildInfo.js';

const appRoot = document.getElementById('app');
const controller = new AppController();
if (import.meta.env.DEV) {
  window.__controller = controller;
}

controller._openPlayerDialog = function(opts) {
  openPlayerDialog(controller.getState(), controller, opts);
};

appRoot.innerHTML =
  '<div class="app-shell">' +
    '<div class="game-layout" id="game-layout">' +
      '<div class="card-slot" id="top-card"></div>' +
      '<div class="board-slot" id="board-slot"></div>' +
      '<div class="card-slot" id="bottom-card"></div>' +
      '<div class="controls-slot" id="controls-slot"></div>' +
      '<div class="notation-slot" id="notation-slot"></div>' +
      '<div class="wasm-debug-slot" id="wasm-debug-slot"></div>' +
    '</div>' +
  '</div>';

var topCardEl    = document.getElementById('top-card');
var bottomCardEl = document.getElementById('bottom-card');
var boardSlot    = document.getElementById('board-slot');
var controlsSlot = document.getElementById('controls-slot');
var notationSlot = document.getElementById('notation-slot');

function topSeat(state) {
  return state.settings.rotateBoard ? 0 : 1;
}
function bottomSeat(state) {
  return state.settings.rotateBoard ? 1 : 0;
}

var lastControlsKey = '';
var lastCardStructureKey = '';
var lastTerminal = false;  // true once we've seen a game-over state

function cardStructureKey(state) {
  return (
    playerCardStructureKey(state, topSeat(state)) +
    '|' +
    playerCardStructureKey(state, bottomSeat(state))
  );
}

function renderPlayerCards(state) {
  renderPlayerCard(topCardEl, state, topSeat(state), controller);
  renderPlayerCard(bottomCardEl, state, bottomSeat(state), controller);
  lastCardStructureKey = cardStructureKey(state);
}

function controlsKey(state) {
  return JSON.stringify({
    canUndo: state.actions.length > 0,
    canRedo: state.canRedo,
    winner: state.winner,
    isDraw: state.isDraw,
    enginesPaused: state.enginesPaused,
  });
}

function render() {
  var state = controller.getState();

  renderBoard(boardSlot, state, controller);

  renderPlayerCards(state);

  var ctk = controlsKey(state);
  if (ctk !== lastControlsKey) {
    renderGameControls(controlsSlot, state, controller);
    lastControlsKey = ctk;
  }

  updateNotationBar(notationSlot, state, controller);
  updateVisionTuningPanel(document.getElementById('game-layout'), state, controller);

  var isTerminal = !!(state.winner != null || state.isDraw);
  if (isTerminal && !lastTerminal && !state.terminalOverlayDismissed) {
    setTimeout(function() {
      openPlayerDialog(controller.getState(), controller, { mode: 'newgame' });
    }, 180);
  }
  lastTerminal = isTerminal;
}

function renderLiveUpdate() {
  var state = controller.getState();
  renderBoard(boardSlot, state, controller);
  renderPlayerCards(state);
  updateVisionTuningPanel(document.getElementById('game-layout'), state, controller);
}

function renderAndRefreshDialog() {
  render();
  refreshOpenPlayerDialog(controller.getState());
}

function isTextEditingTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"]'),
  );
}

function hasOpenDialog() {
  return Boolean(document.querySelector('.dialog-overlay, .player-dialog, .load-dialog'));
}

document.addEventListener('keydown', function(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  if (isTextEditingTarget(event.target) || hasOpenDialog()) {
    return;
  }

  if (event.key === 'ArrowLeft') {
    const state = controller.getState();
    if (state.actions.length > 0) {
      event.preventDefault();
      controller.undo?.();
    }
    return;
  }

  if (event.key === 'ArrowRight') {
    const state = controller.getState();
    if (state.canRedo) {
      event.preventDefault();
      controller.redo?.();
    }
    return;
  }

  if (event.key === ' ' || event.code === 'Space') {
    event.preventDefault();
    controller.toggleEnginesPaused?.();
  }
});

controller.onChange = renderAndRefreshDialog;
controller.onLiveUpdate = renderLiveUpdate;

void controller.initializeLegalityOracle();

renderGameControls(controlsSlot, controller.getState(), controller);
logBuildIdentity();
renderWasmDebugPanel(document.getElementById('wasm-debug-slot'));
render();

// Open player dialog on every load.
// AI starts only after user clicks "Start game" — maybeRequestAiMove is called
// inside newGameWithPlayers / changePlayers, not here.
setTimeout(function() {
  openPlayerDialog(controller.getState(), controller, { mode: 'newgame' });
}, 120);
