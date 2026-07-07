import { playerColorName } from '../lib/playerColors.js';
import { encodeReplayFromActions } from '../lib/replayCode.js';
import { updateEngineThinkCards } from './engineThinkView.js';

export { updateEngineThinkCards };
import './scrapedSlider.css';

/** Sticky top bar: title, mode tabs, debug toggles, play controls. */
export function renderSiteHeader(container, state, controller) {
  const { settings, aiThinking, uiMode } = state;
  const isReplay = uiMode === 'replay';
  const isPlay = uiMode === 'play';
  const undoLabel = controller.isHumanVsAiPlay?.() ? 'Take back' : 'Undo';
  const canUndo = !isReplay && state.actions.length > 0;

  container.innerHTML = `
    <div class="site-header__inner">
      <div class="site-header__row site-header__row--title">
        <h1 class="app-title">Titanium</h1>
        <div class="mode-tabs mode-tabs--header">
          <button type="button" class="mode-tab ${isPlay ? 'mode-tab--active' : ''}" data-ui-mode="play">Play</button>
          <button type="button" class="mode-tab ${uiMode === 'analysis' ? 'mode-tab--active' : ''}" data-ui-mode="analysis">Analysis</button>
          <button type="button" class="mode-tab ${isReplay ? 'mode-tab--active' : ''}" data-ui-mode="replay">Replay</button>
        </div>
        ${isPlay ? `
          <div class="button-row button-row--header">
            <button class="btn btn--primary" data-action="new-game">New Game</button>
            <button class="btn" data-action="undo" ${canUndo ? '' : 'disabled'}>${undoLabel}</button>
            <button class="btn" data-action="redo" ${aiThinking || !state.canRedo ? 'disabled' : ''}>Redo</button>
          </div>` : ''}
      </div>
      ${!isReplay ? renderBoardToggles(settings) : ''}
    </div>`;

  wireHeaderControls(container, controller);
  syncSiteHeaderOffset(container);
}

/** Keep layout below the fixed header — no overlap, no sticky jitter. */
export function syncSiteHeaderOffset(headerEl) {
  const h = headerEl?.offsetHeight ?? 76;
  document.documentElement.style.setProperty('--site-header-h', `${h}px`);
}

/** Right column: status, engine info cards, mode panels. */
export function renderSidebar(container, state, controller) {
  const engineErrorLines = formatEngineErrorLines(state);
  const isReplay = state.uiMode === 'replay';
  const isAnalysis = state.uiMode === 'analysis';
  const isPlay = state.uiMode === 'play';

  container.innerHTML = `
    <section class="sidebar-card">
      ${isReplay ? renderReplayPanel(state.replay) : ''}
      ${isAnalysis ? renderAnalysisPanel(state) : ''}

      <div class="sidebar-panel ${isPlay || isAnalysis ? '' : 'sidebar-panel--hidden'}">
        <div class="status-panel status-panel--sidebar">
          <div class="status-line">
            <span>Turn</span>
            <strong data-status="turn">${formatTurnLabel(state)}</strong>
          </div>
          <div class="status-line">
            <span>Dist (W−B)</span>
            <strong data-status="dist">${formatDistanceEval(state.eval)}</strong>
          </div>
          <div class="status-line status-line--search-info" data-status="search-info-row" hidden>
            <span>Search</span>
            <strong data-status="search-info"></strong>
          </div>
          ${engineErrorLines ? `<div class="status-line status-line--error" data-status="error-row"><span>Error</span><strong data-status="error">${escapeHtml(engineErrorLines)}</strong></div>` : '<div class="status-line status-line--error" data-status="error-row" hidden><span>Error</span><strong data-status="error"></strong></div>'}
        </div>
        <div class="engine-think-cards-host" data-think-cards-host></div>
      </div>
    </section>
  `;

  updateSidebarPanel(container, state, controller);

  wireReplayPanel(container, controller);
  wireAnalysisPanel(container, controller);
}

/** Incremental sidebar refresh — keeps think-card DOM alive during live search. */
export function updateSidebarPanel(container, state, controller) {
  updateSidebarStatusLines(container, state);
  updateEngineThinkCards(container, state);
}

function formatTurnLabel(state) {
  if (state.isDraw) {
    return 'Over (draw)';
  }
  if (state.winner) {
    return `Over (${playerColorName(state.winner)})`;
  }
  return playerColorName(state.playerToMove);
}

function formatEngineErrorLines(state) {
  return (state.settings?.players ?? [])
    .map((playerType, seat) => {
      const message = state.engineErrors?.[seat];
      if (!message) {
        return '';
      }
      const seatLabel = seat === 0 ? 'White' : 'Black';
      return `${seatLabel}: ${message}`;
    })
    .filter(Boolean)
    .join(' | ');
}

function updateSidebarStatusLines(container, state) {
  const panel = container.querySelector('.status-panel--sidebar');
  if (!panel) {
    return;
  }
  const turn = panel.querySelector('[data-status="turn"]');
  if (turn) {
    turn.textContent = formatTurnLabel(state);
  }
  const dist = panel.querySelector('[data-status="dist"]');
  if (dist) {
    dist.textContent = formatDistanceEval(state.eval);
  }

  const searchRow = panel.querySelector('[data-status="search-info-row"]');
  const searchInfo = panel.querySelector('[data-status="search-info"]');
  const searchLine = state.searchInfoLine?.trim();
  if (searchRow && searchInfo) {
    const show = Boolean(searchLine) || state.aiThinking;
    searchRow.hidden = !show;
    if (state.aiThinking && state.liveSearch) {
      const deep = state.liveSearch.depthLog?.length
        ? state.liveSearch.depthLog.reduce((best, e) => (e.depth > (best?.depth ?? 0) ? e : best))
        : null;
      const depth = deep?.depth ?? state.liveSearch.searchDepth;
      const score = deep?.score ?? state.liveSearch.rootScore;
      const nodes = state.liveSearch.nodes;
      const elapsed = state.liveSearch.elapsedMs;
      const parts = ['Thinking…'];
      if (elapsed != null && Number.isFinite(Number(elapsed))) {
        parts.push(elapsed < 1000 ? `${Math.round(elapsed)}ms` : `${(elapsed / 1000).toFixed(1)}s`);
      }
      if (depth) {
        parts.push(`d${depth}`);
      }
      if (score != null && Number.isFinite(Number(score))) {
        parts.push(String(score));
      }
      if (nodes > 0) {
        parts.push(`${Number(nodes).toLocaleString()}n`);
      }
      searchInfo.textContent = parts.join(' · ');
    } else if (searchLine) {
      searchInfo.textContent = searchLine;
    } else {
      searchInfo.textContent = '';
    }
  }

  const errorRow = panel.querySelector('[data-status="error-row"]');
  const errorEl = panel.querySelector('[data-status="error"]');
  const errorLines = formatEngineErrorLines(state);
  if (errorRow && errorEl) {
    errorRow.hidden = !errorLines;
    errorEl.textContent = errorLines;
  }
}

/** @deprecated use renderSiteHeader + renderSidebar */
export function renderControls(container, state, controller) {
  renderSiteHeader(container, state, controller);
}

function wireHeaderControls(container, controller) {
  container.querySelectorAll('[data-ui-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      controller.setUiMode(btn.dataset.uiMode);
    });
  });

  container.querySelector('[data-action="new-game"]')?.addEventListener('click', () => {
    controller.newGame();
  });
  container.querySelector('[data-action="undo"]')?.addEventListener('click', () => {
    controller.undo();
  });
  container.querySelector('[data-action="redo"]')?.addEventListener('click', () => {
    controller.redo();
  });

  container.querySelector('[data-toggle="rotate"]')?.addEventListener('change', () => {
    controller.toggleRotateBoard();
  });
  container.querySelector('[data-toggle="coordinates"]')?.addEventListener('change', () => {
    controller.toggleDisplayCoordinates();
  });
  container.querySelector('[data-toggle="walls"]')?.addEventListener('change', () => {
    controller.toggleDisplayRemainingWalls();
  });
  container.querySelector('[data-toggle="eval"]')?.addEventListener('change', () => {
    controller.toggleDisplayEvalBar();
  });
}

function renderBoardToggles(settings) {
  return `
    <div class="toggle-group toggle-group--board toggle-group--header">
      <label class="toggle"><input type="checkbox" data-toggle="rotate" ${settings.rotateBoard ? 'checked' : ''} /> Rotate</label>
      <label class="toggle"><input type="checkbox" data-toggle="coordinates" ${settings.displayCoordinates ? 'checked' : ''} /> Coords</label>
      <label class="toggle"><input type="checkbox" data-toggle="walls" ${settings.displayRemainingWalls ? 'checked' : ''} /> Walls</label>
      <label class="toggle"><input type="checkbox" data-toggle="eval" ${settings.displayEvalBar ? 'checked' : ''} /> Eval</label>
      <label class="toggle toggle--future" title="Future: NN search-pressure head overlay (not wired yet)">
        <input type="checkbox" disabled /> Pressure vision (future)
      </label>
    </div>`;
}

function renderAnalysisPanel(state) {
  const code = encodeReplayFromActionsSafe(state.actions);

  return `
    <div class="analysis-panel">
      <label class="control-label">Position (paste moves or load from replay)</label>
      <textarea class="replay-input" data-analysis-input rows="3" placeholder="tq1 e2 e8 e3v …">${escapeHtml(code)}</textarea>
      <div class="button-row">
        <button type="button" class="btn btn--primary" data-action="load-analysis">Load position</button>
        <button type="button" class="btn" data-action="analysis-undo" ${state.aiThinking ? 'disabled' : ''}>Undo</button>
        <button type="button" class="btn" data-action="analysis-redo" ${state.aiThinking || !state.canRedo ? 'disabled' : ''}>Redo</button>
        <button type="button" class="btn" data-action="analysis-start">Start</button>
      </div>
      <p class="time-hint">Move either side on the board — human vs human. Undo/redo walks the move tree. Load any <code>tq1</code> line to debug a position.</p>
    </div>`;
}

function encodeReplayFromActionsSafe(actions) {
  if (!actions?.length) {
    return '';
  }
  return encodeReplayFromActions(actions);
}

function wireAnalysisPanel(container, controller) {
  container.querySelector('[data-action="load-analysis"]')?.addEventListener('click', () => {
    const text = container.querySelector('[data-analysis-input]')?.value ?? '';
    try {
      controller.loadAnalysisPosition(text);
    } catch (err) {
      window.alert(err.message ?? String(err));
    }
  });

  container.querySelector('[data-action="analysis-start"]')?.addEventListener('click', () => {
    controller.newGame();
    controller.setUiMode('analysis');
  });

  container.querySelector('[data-action="analysis-undo"]')?.addEventListener('click', () => {
    controller.undo();
  });
  container.querySelector('[data-action="analysis-redo"]')?.addEventListener('click', () => {
    controller.redo();
  });
}

function renderReplayPanel(replay) {
  const index = replay?.index ?? 0;
  const total = replay?.total ?? 0;
  const code = replay?.code ?? '';
  const metaLine = replay?.meta
    ? `<p class="replay-meta">${escapeHtml(JSON.stringify(replay.meta))}</p>`
    : '';

  return `
    <div class="replay-panel">
      <label class="control-label">Paste terminal replay code</label>
      <textarea class="replay-input" data-replay-input rows="4" placeholder="tq1 e2 e8 e3 …">${escapeHtml(code)}</textarea>
      ${metaLine}
      <div class="button-row">
        <button type="button" class="btn btn--primary" data-action="load-replay">Load</button>
        <button type="button" class="btn btn--accent" data-action="continue-replay" ${total ? '' : 'disabled'}>Play from here</button>
        <button type="button" class="btn" data-action="copy-replay" ${code ? '' : 'disabled'}>Copy</button>
      </div>
      <div class="replay-scrub">
        <button type="button" class="btn btn--icon" data-action="replay-start" title="Start" ${total ? '' : 'disabled'}>⏮</button>
        <button type="button" class="btn btn--icon" data-action="replay-prev" ${total ? '' : 'disabled'}>◀</button>
        <input type="range" class="replay-slider" data-replay-slider min="0" max="${total}" value="${index}" ${total ? '' : 'disabled'} />
        <button type="button" class="btn btn--icon" data-action="replay-next" ${total ? '' : 'disabled'}>▶</button>
        <button type="button" class="btn btn--icon" data-action="replay-end" title="End" ${total ? '' : 'disabled'}>⏭</button>
      </div>
      <p class="replay-status">Ply <strong>${index}</strong> / ${total}${total ? ` · ${replayStatusLabel(replay)}` : ' — load a code'}</p>
      <p class="time-hint">Terminal prints <code>tq1 …</code> after each benchmark game. Paste here to step through on the board. Use <strong>Play from here</strong> to leave replay mode and move as human. Supports <code>e3v</code> and <code>ve3</code> wall notation.</p>
    </div>`;
}

function replayStatusLabel(replay) {
  if (!replay || replay.total === 0) {
    return '';
  }
  if (replay.index === 0) {
    return 'start position';
  }
  if (replay.index >= replay.total) {
    return 'final position';
  }
  return `after move ${replay.index}`;
}

function wireReplayPanel(container, controller) {
  container.querySelector('[data-action="continue-replay"]')?.addEventListener('click', () => {
    controller.continueFromReplay();
  });

  container.querySelector('[data-action="load-replay"]')?.addEventListener('click', () => {
    const text = container.querySelector('[data-replay-input]')?.value ?? '';
    try {
      controller.loadReplay(text);
    } catch (err) {
      window.alert(err.message ?? String(err));
    }
  });

  container.querySelector('[data-action="copy-replay"]')?.addEventListener('click', async () => {
    const code = controller.exportReplayCode();
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      window.prompt('Copy replay code:', code);
    }
  });

  container.querySelector('[data-action="replay-prev"]')?.addEventListener('click', () => {
    controller.replayStep(-1);
  });
  container.querySelector('[data-action="replay-next"]')?.addEventListener('click', () => {
    controller.replayStep(1);
  });
  container.querySelector('[data-action="replay-start"]')?.addEventListener('click', () => {
    controller.setReplayIndex(0);
  });
  container.querySelector('[data-action="replay-end"]')?.addEventListener('click', () => {
    const total = controller.replay?.actions.length ?? 0;
    controller.setReplayIndex(total);
  });

  const slider = container.querySelector('[data-replay-slider]');
  slider?.addEventListener('input', () => {
    controller.setReplayIndex(Number(slider.value));
  });
}

function formatDistanceEval(evalState) {
  const w = evalState.whiteDist;
  const b = evalState.blackDist;
  if (!Number.isFinite(w) || !Number.isFinite(b)) {
    return `${Math.round((evalState.p1 ?? 0.5) * 100)}%`;
  }
  const margin = evalState.margin ?? b - w;
  const sign = margin > 0 ? '+' : '';
  return `W${w} B${b} (${sign}${margin})`;
}

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
