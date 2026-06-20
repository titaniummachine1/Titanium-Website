import { AppController } from './game/appController.js';
import { renderBoard } from './ui/boardView.js';
import {
  renderSiteHeader,
  renderSidebar,
  updateSidebarPanel,
  updateEngineThinkCards,
} from './ui/controlsView.js';
import { renderEvalBar } from './ui/evalBar.js';
import { renderGameFooter } from './ui/gameFooter.js';
import { renderPlayersPanel } from './ui/playerSetupView.js';

const appRoot = document.getElementById('app');
const controller = new AppController();
if (import.meta.env.DEV) {
  window.__controller = controller;
}

appRoot.innerHTML = `
  <div class="app-shell">
    <header class="site-header" id="header-root"></header>
    <div class="layout">
      <aside class="layout__players" id="players-root"></aside>
      <main class="layout__board" id="board-root">
        <div class="board-column">
          <div class="board-row">
            <aside class="board-row__eval" id="eval-root"></aside>
            <div class="board-row__grid" id="board-slot"></div>
          </div>
          <footer class="game-footer" id="game-footer"></footer>
        </div>
      </main>
      <aside class="layout__sidebar" id="sidebar-root"></aside>
    </div>
  </div>
`;

const boardRoot = document.getElementById('board-root');
const boardSlot = document.getElementById('board-slot');
const headerRoot = document.getElementById('header-root');
const sidebarRoot = document.getElementById('sidebar-root');
const playersRoot = document.getElementById('players-root');
const evalRoot = document.getElementById('eval-root');
const footerRoot = document.getElementById('game-footer');

let lastPlayersPanelKey = '';
let lastSidebarStructureKey = '';

function playersPanelKey(state) {
  const { settings } = state;
  return JSON.stringify({
    mode: settings.uiMode,
    players: settings.players,
    ai: settings.playerAiSettings,
  });
}

function sidebarStructureKey(state) {
  const errors = Object.entries(state.engineErrors ?? {})
    .filter(([, message]) => message)
    .map(([seat, message]) => `${seat}:${message}`)
    .join('|');
  return JSON.stringify({
    mode: state.uiMode,
    hasReplay: Boolean(state.replay),
    winner: state.winner,
    isDraw: state.isDraw,
    errors,
  });
}

function renderBoardArea() {
  const state = controller.getState();
  renderEvalBar(evalRoot, state);
  renderBoard(boardSlot, state, controller);
  renderGameFooter(footerRoot, state);
}

function render() {
  const state = controller.getState();
  renderBoardArea();
  renderSiteHeader(headerRoot, state, controller);

  const panelKey = playersPanelKey(state);
  if (panelKey !== lastPlayersPanelKey) {
    renderPlayersPanel(playersRoot, state, controller);
    lastPlayersPanelKey = panelKey;
  }

  const sbKey = sidebarStructureKey(state);
  if (sbKey !== lastSidebarStructureKey) {
    renderSidebar(sidebarRoot, state, controller);
    lastSidebarStructureKey = sbKey;
  } else {
    updateSidebarPanel(sidebarRoot, state, controller);
  }
}

function renderLiveSearch() {
  const state = controller.getState();
  updateSidebarPanel(sidebarRoot, state, controller);
}

controller.onChange = render;
controller.onLiveUpdate = renderLiveSearch;
render();
controller.maybeRequestAiMove();
