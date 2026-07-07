/**
 * Main entry point — two-column game layout
 *
 * Layout (desktop):
 *   board-row: [eval bar | top-card / board / bottom-card / controls]   sidebar: [moves card / review card]
 *
 * Play/Analysis/Review mode is chosen from the Settings dialog (ui/playerDialog.js),
 * not a page header. Collapses to a single column on narrow viewports (see styles.css).
 */

import { AppController } from './game/appController.js';
import { renderBoard } from './ui/boardView.js';
import { renderPlayerCard, playerCardStructureKey } from './ui/playerCard.js';
import { openPlayerDialog, refreshOpenPlayerDialog } from './ui/playerDialog.js';
import { renderGameControls } from './ui/gameControls.js';
import { renderSidebar } from './ui/sidebarView.js';
import { renderEvalBar } from './ui/evalBar.js';
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
    '<div class="layout" id="layout">' +
      '<div class="board-row" id="board-row">' +
        '<div class="board-row__eval" id="eval-slot"><div id="eval-inner"></div></div>' +
        '<div class="board-row__grid" id="board-row-grid">' +
          '<div class="card-slot" id="top-card"></div>' +
          '<div class="board-slot" id="board-slot"></div>' +
          '<div class="card-slot" id="bottom-card"></div>' +
          '<div class="controls-slot" id="controls-slot"></div>' +
        '</div>' +
      '</div>' +
      '<div class="layout__sidebar" id="sidebar-slot"></div>' +
    '</div>' +
    '<div class="wasm-debug-slot" id="wasm-debug-slot"></div>' +
  '</div>';

var boardRowEl   = document.getElementById('board-row');
var evalSlot     = document.getElementById('eval-inner');
var topCardEl    = document.getElementById('top-card');
var bottomCardEl = document.getElementById('bottom-card');
var boardSlot    = document.getElementById('board-slot');
var controlsSlot = document.getElementById('controls-slot');
var sidebarSlot  = document.getElementById('sidebar-slot');

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
  // Bot info cards only make sense in Play mode; Analysis/Review are
  // human-vs-human free play evaluated by the dedicated analysis engine.
  if (state.uiMode !== 'play') {
    if (topCardEl.childElementCount || topCardEl.innerHTML) topCardEl.innerHTML = '';
    if (bottomCardEl.childElementCount || bottomCardEl.innerHTML) bottomCardEl.innerHTML = '';
    lastCardStructureKey = '';
    return;
  }
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

function evalBarVisible(state) {
  return state.settings.displayEvalBar !== false;
}

var lastSidebarKey = '';

function render() {
  var state = controller.getState();

  // The eval bar's column is always reserved (fixed width) so toggling it
  // on/off never shifts the board's horizontal position -- only its inner
  // content fades in/out (see .eval-panel / .eval-panel--visible in evalBar.js).
  renderEvalBar(evalSlot, {
    settings: { ...state.settings, displayEvalBar: evalBarVisible(state) },
    eval: state.eval,
    analysisEngineActive: state.analysisEngineActive || state.eval?.source === 'play-live',
    analysisEvalDepth: state.analysisEvalDepth,
  });

  renderBoard(boardSlot, state, controller);

  renderPlayerCards(state);

  var ctk = controlsKey(state);
  if (ctk !== lastControlsKey) {
    renderGameControls(controlsSlot, state, controller);
    lastControlsKey = ctk;
  }

  // Excludes analysisEvalDepth on purpose: analysis eval ticks every ~100-300ms
  // during a warm search, and a full sidebar rebuild would blow away focus/typed
  // text in the Review card's paste textarea. The eval bar itself (cheap, no
  // inputs) still refreshes every render above.
  var reviewKey = state.reviewAnalysis
    ? [
        state.reviewAnalysis.status,
        state.reviewAnalysis.paused ? 'paused' : 'active',
        state.reviewAnalysis.completed,
        state.reviewAnalysis.running,
        state.reviewAnalysis.workerCount,
      ].join('/')
    : '';
  var sidebarKey = state.uiMode + '|' + state.actions.length + '|' + (state.replay ? state.replay.index + '/' + state.replay.total : '') + '|' + reviewKey + '|' + JSON.stringify(state.settings.analysisEngine);
  if (sidebarKey !== lastSidebarKey) {
    renderSidebar(sidebarSlot, state, controller);
    lastSidebarKey = sidebarKey;
  }

  updateVisionTuningPanel(boardRowEl, state, controller);

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
  renderEvalBar(evalSlot, {
    settings: { ...state.settings, displayEvalBar: evalBarVisible(state) },
    eval: state.eval,
    analysisEngineActive: state.analysisEngineActive || state.eval?.source === 'play-live',
    analysisEvalDepth: state.analysisEvalDepth,
  });
  renderBoard(boardSlot, state, controller);
  renderPlayerCards(state);
  updateVisionTuningPanel(boardRowEl, state, controller);
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
