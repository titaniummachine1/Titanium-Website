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
import { renderPlayerCard } from './ui/playerCard.js';
import { openPlayerDialog } from './ui/playerDialog.js';
import { renderGameControls, updateNotationBar } from './ui/gameControls.js';

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
var lastCardKey = '';
var lastTerminal = false;  // true once we've seen a game-over state

function cardKey(state) {
  var ls = state.liveSearch;
  return JSON.stringify({
    players: state.settings.players,
    playerToMove: state.playerToMove,
    thinking: state.aiThinking,
    thinkingSeat: state.thinkingSeatIndex,
    winner: state.winner,
    isDraw: state.isDraw,
    rotated: state.settings.rotateBoard,
    completedSnaps: state.lastCompletedThinkBySeat
      ? state.lastCompletedThinkBySeat.map(function(s) {
          return s ? (s.move + '|' + s.score + '|' + s.depth + '|' + s.nodes + '|' + s.thinkMs) : '';
        })
      : [],
    liveSnap: ls
      ? (ls.mode + '|' + ls.nodes + '|' + ls.elapsedMs + '|' + ls.searchDepth + '|' + (typeof ls.pv === 'string' ? ls.pv : ''))
      : '',
  });
}

function controlsKey(state) {
  return JSON.stringify({
    canUndo: state.actions.length > 0,
    canRedo: state.canRedo,
    winner: state.winner,
    isDraw: state.isDraw,
    rotated: state.settings.rotateBoard,
    undoPaused: controller._undoPaused,
  });
}

function render() {
  var state = controller.getState();

  renderBoard(boardSlot, state, controller);

  var ck = cardKey(state);
  if (ck !== lastCardKey) {
    renderPlayerCard(topCardEl, state, topSeat(state), controller);
    renderPlayerCard(bottomCardEl, state, bottomSeat(state), controller);
    lastCardKey = ck;
  }

  var ctk = controlsKey(state);
  if (ctk !== lastControlsKey) {
    renderGameControls(controlsSlot, state, controller);
    lastControlsKey = ctk;
  }

  updateNotationBar(notationSlot, state, controller);

  lastTerminal = !!(state.winner != null || state.isDraw);
}

function renderLiveUpdate() {
  var state = controller.getState();
  renderBoard(boardSlot, state, controller);
  var ck = cardKey(state);
  if (ck !== lastCardKey) {
    renderPlayerCard(topCardEl, state, topSeat(state), controller);
    renderPlayerCard(bottomCardEl, state, bottomSeat(state), controller);
    lastCardKey = ck;
  }
}

controller.onChange = render;
controller.onLiveUpdate = renderLiveUpdate;

renderGameControls(controlsSlot, controller.getState(), controller);
render();

// Open player dialog on every load.
// AI starts only after user clicks "Start game" — maybeRequestAiMove is called
// inside newGameWithPlayers / changePlayers, not here.
setTimeout(function() {
  openPlayerDialog(controller.getState(), controller, { mode: 'newgame' });
}, 120);
