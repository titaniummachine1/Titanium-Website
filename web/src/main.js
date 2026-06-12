import { AppController } from './game/appController.js';
import { renderBoard } from './ui/boardView.js';
import { renderCatHint } from './ui/catHint.js';
import { renderLmrHint } from './ui/lmrHint.js';
import {
  renderSiteHeader,
  renderSidebar,
  updateEngineThinkCards,
  updateLmrDispersionPanel,
  updateLmrToggleStatus,
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

function renderBoardArea() {
  const state = controller.getState();
  renderEvalBar(evalRoot, state);
  renderBoard(boardSlot, state, controller);
  renderGameFooter(footerRoot, state);
  renderCatHint(boardRoot, state, controller);
  renderLmrHint(boardRoot, state, controller);
}

function render() {
  const state = controller.getState();
  renderBoardArea();
  renderSiteHeader(headerRoot, state, controller);
  renderPlayersPanel(playersRoot, state, controller);
  renderSidebar(sidebarRoot, state, controller);
}

function renderLiveSearch() {
  const state = controller.getState();
  updateEngineThinkCards(sidebarRoot, state);
  if (state.settings.showLmrVision) {
    renderBoardArea();
    updateLmrToggleStatus(headerRoot, state);
    updateLmrDispersionPanel(sidebarRoot, state);
  }
}

controller.onChange = render;
controller.onLiveUpdate = renderLiveSearch;
render();
controller.maybeRequestAiMove();
