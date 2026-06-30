/**
 * Player selection dialog — shown on page load, "New Game", and "Change players".
 *
 * Engine-specific controls (not a generic difficulty system):
 *
 *   Remote (Ka / Ishtar):   Strength (Beg→Alpha) + thinking mode
 *   zero.ink:               Thinking mode only (Immediate / Short / Medium / Long)
 *   Titanium:               Difficulty (Easy/Medium/Hard) + thinking time slider
 *   ACE v13:                Tier selector (JS→Rust→MoveGen+) + time slider
 *   Gorisanson / QuoridorV3: Thinking time slider
 *   Human:                  No controls
 *
 * Settings are persisted to localStorage and restored on next open.
 * Keyboard: Enter / Escape / X confirm; Cancel (change-players only) discards.
 */

import { PlayerType, TimeToMove, StrengthLevel } from '../lib/engineConfig.js';
import { getPlayerOptionGroups, getAllEngineConfigs } from '../lib/playerRegistry.js';
import { playerColorName } from '../lib/playerColors.js';
import {
  isRemoteEngine,
  isTitaniumEngine,
  isAceFamily,
  STRENGTH_LEVEL_PRESETS,
  TITANIUM_NET_EASY,
  TITANIUM_NET_MEDIUM,
  TITANIUM_NET_HARD,
  migrateTitaniumNet,
  coresSliderMax,
  defaultThreadCount,
  clampCores,
} from '../lib/timeControl.js';

const TITANIUM_NET_OPTIONS = [
  { label: 'Easy', id: TITANIUM_NET_EASY },
  { label: 'Medium', id: TITANIUM_NET_MEDIUM },
  { label: 'Hard', id: TITANIUM_NET_HARD },
];

const PREFS_KEY = 'quoridor-player-prefs-v5';

const TIME_TO_MOVE_OPTIONS = [
  { label: 'Immediate', id: TimeToMove.Intuition },
  { label: 'Short',     id: TimeToMove.Short },
  { label: 'Medium',    id: TimeToMove.Medium },
  { label: 'Long',      id: TimeToMove.Long },
];

const ACE_V13_TIERS = [
  { label: 'JS',       id: 0 },
  { label: 'Rust',     id: 1 },
  { label: 'MoveGen+', id: 2 },
];

const DEFAULT_WALL_CLOCK    = 5;
const DEFAULT_TIME_TO_MOVE  = TimeToMove.Short;
const DEFAULT_ACE_TIER      = 0;
const DEFAULT_CORES         = defaultThreadCount();
const WALL_CLOCK_MIN        = 0.5;
const WALL_CLOCK_MAX        = 60;
const WALL_CLOCK_STEP       = 0.5;
const CORES_MIN             = 1;
// CAT-LMR aggression shown as a percent (0 = no reduction, 100 = max). The
// controller setting is the 0..1 fraction; the dialog works in percent.
const LMR_AGGRESSIVENESS_MIN = 0;
const LMR_AGGRESSIVENESS_MAX = 100;
const LMR_AGGRESSIVENESS_STEP = 5;

const DEFAULT_CAT_VISION = Object.freeze({
  showSquares: true,
  showWalls: true,
  showNumbers: false,
  squareOpacity: 1,
  wallOpacity: 1,
});

const VISION_MODE_OPTIONS = [
  { label: 'Off', id: 'off' },
  { label: 'CAT', id: 'cat' },
  { label: 'LMR', id: 'lmr' },
];

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(seconds) {
  if (seconds < 1) return seconds + ' s';
  return (Number.isInteger(seconds) ? seconds : seconds.toFixed(1)) + ' s';
}

function formatPercent(value) {
  return Math.round(Number(value ?? 1) * 100) + '%';
}

function formatPly(value) {
  const n = Math.round(Number(value) || 0);
  return `${n} ply`;
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return min;
  }
  return Math.min(max, Math.max(min, n));
}

function visionModeFromSettings(settings = {}) {
  if (settings.showLmrVision) {
    return 'lmr';
  }
  if (settings.showCatVision) {
    return 'cat';
  }
  return 'off';
}

/** Classify a player type into a dialog control category. */
function engineCategory(playerType) {
  const configs = getAllEngineConfigs();
  if (playerType === PlayerType.Human) return 'human';
  if (playerType === PlayerType.ZeroInk) return 'zeroink';
  if (isRemoteEngine(playerType, configs)) return 'remote';
  if (isTitaniumEngine(playerType, configs)) return 'titanium';
  if (isAceFamily(playerType, configs)) return 'ace-v13';
  return 'local';
}

function aceDisplayTiers(_playerType) {
  return ACE_V13_TIERS;
}

// ── Prefs ────────────────────────────────────────────────────────────────────

function loadPrefs(state) {
  const defaultPlayers = state.settings?.players ?? [PlayerType.Human, PlayerType.Human];
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return {
      players:     saved.players     ?? [...defaultPlayers],
      wallClock:   saved.wallClock   ?? [DEFAULT_WALL_CLOCK, DEFAULT_WALL_CLOCK],
      timeToMove:  saved.timeToMove  ?? [DEFAULT_TIME_TO_MOVE, DEFAULT_TIME_TO_MOVE],
      aceStrength: saved.aceStrength ?? [DEFAULT_ACE_TIER, DEFAULT_ACE_TIER],
      remoteStrength: saved.remoteStrength ?? [StrengthLevel.Alpha, StrengthLevel.Alpha],
      titaniumNet: (saved.titaniumNet ?? [TITANIUM_NET_HARD, TITANIUM_NET_HARD]).map(migrateTitaniumNet),
      cores: [0, 1].map((seat) =>
        clampCores(
          (Array.isArray(saved.cores) ? saved.cores[seat] : null) ??
            (Array.isArray(saved.threads) ? saved.threads[seat] : null) ??
            DEFAULT_CORES,
        ),
      ),
    };
  } catch {
    return {
      players:     [...defaultPlayers],
      wallClock:   [DEFAULT_WALL_CLOCK, DEFAULT_WALL_CLOCK],
      timeToMove:  [DEFAULT_TIME_TO_MOVE, DEFAULT_TIME_TO_MOVE],
      aceStrength: [DEFAULT_ACE_TIER, DEFAULT_ACE_TIER],
      remoteStrength: [StrengthLevel.Alpha, StrengthLevel.Alpha],
      titaniumNet: [TITANIUM_NET_HARD, TITANIUM_NET_HARD],
      cores: [DEFAULT_CORES, DEFAULT_CORES],
    };
  }
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

function aiSelected(players) {
  return players.some((playerType) => playerType !== PlayerType.Human);
}

function oracleBlocksStart(state, selections) {
  if (!aiSelected(selections.players)) {
    return false;
  }
  return !state.legalityOracleState?.ready;
}

function oracleStatusHtml(state, selections) {
  if (!aiSelected(selections.players)) {
    return '';
  }
  if (state.legalityOracleState?.ready) {
    return '';
  }
  if (state.legalityOracleState?.error) {
    return (
      '<div class="player-dialog__hint player-dialog__hint--error">' +
      'Local legality checker failed to load. Check the copied diagnostic.' +
      '</div>'
    );
  }
  return (
    '<div class="player-dialog__hint">Preparing local legality checker…</div>'
  );
}

function updateStartButtonState(overlay, state, selections) {
  const startBtn = overlay.querySelector('[data-action="start"]');
  if (!startBtn) {
    return;
  }
  const blocked = oracleBlocksStart(state, selections);
  startBtn.disabled = blocked;
  startBtn.title = blocked
    ? 'Waiting for local legality checker'
    : '';
}

// ── Dialog state ─────────────────────────────────────────────────────────────

let currentDialog = null;

export function openPlayerDialog(state, controller, { mode = 'newgame' } = {}) {
  if (currentDialog) { currentDialog.remove(); currentDialog = null; }

  const isNewGame = mode === 'newgame';
  const isSettings = mode === 'settings';
  const title = isNewGame
    ? 'New game — choose players'
    : isSettings
      ? 'Settings'
      : 'Change players';

  const prefs = loadPrefs(state);
  const selections = {
    players:     [...prefs.players],
    wallClock:   [...prefs.wallClock],
    timeToMove:  [...prefs.timeToMove],
    aceStrength: [...prefs.aceStrength],
    remoteStrength: [...prefs.remoteStrength],
    titaniumNet: [...prefs.titaniumNet],
    cores: [...(prefs.cores ?? [DEFAULT_CORES, DEFAULT_CORES])],
    visionMode: visionModeFromSettings(state.settings),
    catVision: {
      ...DEFAULT_CAT_VISION,
      ...(state.settings?.catVision ?? {}),
    },
    lmrAggressiveness: Math.round(clampNumber(
      (state.settings?.lmrAggressiveness ?? 0.5) * 100,
      LMR_AGGRESSIVENESS_MIN,
      LMR_AGGRESSIVENESS_MAX,
    )),
  };

  const groups = getPlayerOptionGroups();

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.innerHTML =
    '<div class="player-dialog" role="dialog" aria-modal="true">' +
      '<div class="player-dialog__header">' +
        '<h2 class="player-dialog__title">' + escHtml(title) + '</h2>' +
        '<button type="button" class="player-dialog__close" aria-label="Close" data-action="close">✕</button>' +
      '</div>' +
      '<div class="player-dialog__body">' +
        '<div class="player-dialog__hint">White starts at the bottom and moves upward. Black starts at the top and moves downward.</div>' +
        renderSeatSection(0, selections, groups) +
        renderSeatSection(1, selections, groups) +
        '<div data-oracle-hint="1">' + oracleStatusHtml(state, selections) + '</div>' +
        '<div class="player-dialog__options">' +
          renderVisionSettings(selections) +
          '<label class="player-dialog__option-row">' +
            '<input type="checkbox" data-option="bestMoveHint"' + (state.settings?.showBestMoveHint !== false ? ' checked' : '') + '>' +
            ' Show best-move hint on board while engine thinks' +
          '</label>' +
        '</div>' +
      '</div>' +
      '<div class="player-dialog__footer">' +
        '<button type="button" class="btn btn--primary player-dialog__start" data-action="start">' +
          (isNewGame ? 'Start game' : isSettings ? 'Apply settings' : 'Apply') +
        '</button>' +
        (!isNewGame ? '<button type="button" class="btn player-dialog__cancel" data-action="cancel">Cancel</button>' : '') +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  overlay._selections = selections;
  currentDialog = overlay;
  updateStartButtonState(overlay, state, selections);

  setTimeout(() => overlay.querySelector('[data-action="start"]')?.focus(), 50);

  // Wire seat selects
  for (const seat of [0, 1]) {
    const sel = overlay.querySelector('[data-seat-select="' + seat + '"]');
    if (sel) {
      sel.addEventListener('change', () => {
        selections.players[seat] = sel.value;
        rebuildEngineControls(overlay, seat, selections);
      });
    }
  }

  wireEngineControls(overlay, 0, selections);
  wireEngineControls(overlay, 1, selections);
  wireVisionSettings(overlay, selections, controller);

  const confirmDialog = () => { applyAndClose(); };
  const cancelDialog = () => { overlay.remove(); currentDialog = null; };

  function applyAndClose() {
    const liveState = controller.getState();
    if (oracleBlocksStart(liveState, selections)) {
      refreshOpenPlayerDialog(liveState);
      return;
    }
    savePrefs({
      players:     selections.players,
      wallClock:   selections.wallClock,
      timeToMove:  selections.timeToMove,
      aceStrength: selections.aceStrength,
      remoteStrength: selections.remoteStrength,
      titaniumNet: selections.titaniumNet,
      cores: selections.cores,
    });
    // Apply display toggles immediately via controller
    const bmHint = overlay.querySelector('[data-option="bestMoveHint"]')?.checked ?? true;
    controller.toggleBestMoveHint?.(bmHint);
    applyVisionSettings(selections, controller);
    applySelections(selections, isNewGame, controller, state);
    overlay.remove();
    currentDialog = null;
  }

  overlay.querySelector('[data-action="start"]')?.addEventListener('click', confirmDialog);
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', cancelDialog);
  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', cancelDialog);

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); confirmDialog(); }
    if (e.key === 'Escape') { e.preventDefault(); cancelDialog(); }
  });

  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) cancelDialog(); });
}

/** Re-enable Start once the legality oracle finishes loading. */
export function refreshOpenPlayerDialog(state) {
  if (!currentDialog) {
    return;
  }
  const overlay = currentDialog;
  const selections = overlay._selections;
  if (!selections) {
    return;
  }
  const hintHost = overlay.querySelector('[data-oracle-hint="1"]');
  if (hintHost) {
    hintHost.innerHTML = oracleStatusHtml(state, selections);
  }
  updateStartButtonState(overlay, state, selections);
}

// ── Rendering ────────────────────────────────────────────────────────────────

function renderVisionSettings(selections) {
  const current = selections.visionMode ?? 'off';
  const btns = VISION_MODE_OPTIONS.map((opt) =>
    '<button type="button" class="btn ' + (opt.id === current ? 'btn--primary' : 'btn--ghost') + ' btn--small btn--fit"' +
    ' data-vision-mode="' + opt.id + '">' +
    escHtml(opt.label) + '</button>'
  ).join('');

  return (
    '<div class="player-dialog__field player-dialog__field--vision">' +
      '<label class="player-dialog__label">Vision overlay</label>' +
      '<div class="player-dialog__preset-group player-dialog__preset-group--vision">' + btns + '</div>' +
      '<div data-vision-detail>' + renderVisionDetail(selections) + '</div>' +
    '</div>'
  );
}

function renderVisionDetail(selections) {
  if (selections.visionMode === 'cat') {
    const catVision = {
      ...DEFAULT_CAT_VISION,
      ...(selections.catVision ?? {}),
    };
    return (
      '<div class="player-dialog__vision-detail">' +
        '<label class="player-dialog__option-row">' +
          '<input type="checkbox" data-cat-setting="showSquares"' + (catVision.showSquares ? ' checked' : '') + '>' +
          ' Squares' +
        '</label>' +
        '<label class="player-dialog__option-row">' +
          '<input type="checkbox" data-cat-setting="showWalls"' + (catVision.showWalls ? ' checked' : '') + '>' +
          ' Walls' +
        '</label>' +
        '<label class="player-dialog__option-row">' +
          '<input type="checkbox" data-cat-setting="showNumbers"' + (catVision.showNumbers ? ' checked' : '') + '>' +
          ' Numbers' +
        '</label>' +
        renderVisionSlider('squareOpacity', 'Square opacity', catVision.squareOpacity, 0.25, 1.5, 0.05, formatPercent(catVision.squareOpacity)) +
        renderVisionSlider('wallOpacity', 'Wall opacity', catVision.wallOpacity, 0.25, 1.5, 0.05, formatPercent(catVision.wallOpacity)) +
      '</div>'
    );
  }

  if (selections.visionMode === 'lmr') {
    const aggr = clampNumber(
      selections.lmrAggressiveness ?? 50,
      LMR_AGGRESSIVENESS_MIN,
      LMR_AGGRESSIVENESS_MAX,
    );
    return (
      '<div class="player-dialog__vision-detail">' +
        renderVisionSlider(
          'lmrAggressiveness',
          'LMR aggression (0 = full depth, 100 = max reduction)',
          aggr,
          LMR_AGGRESSIVENESS_MIN,
          LMR_AGGRESSIVENESS_MAX,
          LMR_AGGRESSIVENESS_STEP,
          `${Math.round(aggr)}%`,
        ) +
      '</div>'
    );
  }

  return '';
}

function renderVisionSlider(key, label, value, min, max, step, displayValue) {
  return (
    '<div class="player-dialog__field player-dialog__field--compact">' +
      '<label class="player-dialog__label">' + escHtml(label) + ': ' +
        '<span class="player-dialog__time-val" data-vision-slider-label="' + escHtml(key) + '">' + escHtml(displayValue) + '</span>' +
      '</label>' +
      '<input type="range" class="player-dialog__time-slider" data-vision-slider="' + escHtml(key) + '"' +
      ' min="' + min + '" max="' + max + '" step="' + step + '" value="' + escHtml(value) + '">' +
    '</div>'
  );
}

function renderSeatSection(seat, selections, groups) {
  const colorName = playerColorName(seat + 1);
  const current   = selections.players[seat];

  const opts = groups.map((group) =>
    '<optgroup label="' + escHtml(group.label) + '">' +
    group.options.map((o) =>
      '<option value="' + escHtml(o.value) + '"' +
      (o.value === current ? ' selected' : '') +
      (o.disabled ? ' disabled' : '') + '>' +
      escHtml(o.label) + '</option>'
    ).join('') +
    '</optgroup>'
  ).join('');

  return (
    '<div class="player-dialog__seat" data-seat-section="' + seat + '">' +
      '<div class="player-dialog__seat-header">' +
        '<div class="pawn-icon pawn-icon--seat' + seat + '"></div>' +
        '<span class="player-dialog__seat-name">' + escHtml(colorName) + '</span>' +
      '</div>' +
      '<div class="player-dialog__field">' +
        '<label class="player-dialog__label" for="seat-select-' + seat + '">Player type</label>' +
        '<select class="player-dialog__select" id="seat-select-' + seat + '" data-seat-select="' + seat + '">' +
          opts +
        '</select>' +
      '</div>' +
      '<div data-engine-controls="' + seat + '">' +
        renderEngineControls(seat, selections) +
      '</div>' +
    '</div>'
  );
}

function renderEngineControls(seat, selections) {
  const playerType = selections.players[seat];
  const cat = engineCategory(playerType);

  if (cat === 'human') return '';

  if (cat === 'remote') {
    return renderRemoteStrengthControls(seat, selections) +
           renderTimeModeControls(seat, selections);
  }

  if (cat === 'zeroink') {
    return renderTimeModeControls(seat, selections);
  }

  if (cat === 'titanium') {
    return renderTitaniumNetControls(seat, selections) +
           renderCoresSlider(seat, selections) +
           renderTimeSlider(seat, selections, 'Thinking time');
  }

  if (cat === 'ace-v13') {
    return renderAceTierControls(seat, selections, playerType) +
           renderTimeSlider(seat, selections, 'Thinking time');
  }

  // Gorisanson, QuoridorV3, etc.
  return renderTimeSlider(seat, selections, 'Thinking time');
}

function renderRemoteStrengthControls(seat, selections) {
  const current = selections.remoteStrength[seat] ?? StrengthLevel.Alpha;
  const btns = STRENGTH_LEVEL_PRESETS.map((opt) =>
    '<button class="btn ' + (opt.id === current ? 'btn--primary' : 'btn--ghost') + ' btn--small btn--fit"' +
    ' data-strength-btn data-seat="' + seat + '" data-strength-id="' + opt.id + '">' +
    escHtml(opt.label) + '</button>'
  ).join('');

  return (
    '<div class="player-dialog__field">' +
      '<label class="player-dialog__label">Strength</label>' +
      '<div class="player-dialog__preset-group player-dialog__preset-group--strength">' + btns + '</div>' +
    '</div>'
  );
}

function renderTitaniumNetControls(seat, selections) {
  let current = migrateTitaniumNet(selections.titaniumNet[seat] ?? TITANIUM_NET_HARD);
  // Clamp to available options (e.g. production hides Medium/Hard).
  if (!TITANIUM_NET_OPTIONS.some((o) => o.id === current)) {
    current = TITANIUM_NET_OPTIONS[0].id;
  }
  const btns = TITANIUM_NET_OPTIONS.map((opt) =>
    '<button class="btn ' + (opt.id === current ? 'btn--primary' : 'btn--ghost') + ' btn--small btn--fit"' +
    ' data-ti-net-btn data-seat="' + seat + '" data-ti-net-id="' + opt.id + '">' +
    escHtml(opt.label) + '</button>'
  ).join('');

  return (
    '<div class="player-dialog__field">' +
      '<label class="player-dialog__label">Difficulty</label>' +
      '<div class="player-dialog__preset-group">' + btns + '</div>' +
    '</div>'
  );
}

function renderTimeModeControls(seat, selections) {
  const current = selections.timeToMove[seat] ?? DEFAULT_TIME_TO_MOVE;
  const btns = TIME_TO_MOVE_OPTIONS.map((opt) =>
    '<button class="btn ' + (opt.id === current ? 'btn--primary' : 'btn--ghost') + ' btn--small btn--fit"' +
    ' data-tm-btn data-seat="' + seat + '" data-tm-id="' + opt.id + '">' +
    escHtml(opt.label) + '</button>'
  ).join('');

  return (
    '<div class="player-dialog__field">' +
      '<label class="player-dialog__label">Thinking mode</label>' +
      '<div class="player-dialog__preset-group">' + btns + '</div>' +
    '</div>'
  );
}

function renderAceTierControls(seat, selections, playerType) {
  const tiers = aceDisplayTiers(playerType);
  const current = selections.aceStrength[seat] ?? DEFAULT_ACE_TIER;
  const btns = tiers.map((t) =>
    '<button class="btn ' + (t.id === current ? 'btn--primary' : 'btn--ghost') + ' btn--small btn--fit"' +
    ' data-ace-btn data-seat="' + seat + '" data-ace-id="' + t.id + '">' +
    escHtml(t.label) + '</button>'
  ).join('');

  return (
    '<div class="player-dialog__field">' +
      '<label class="player-dialog__label">Engine tier</label>' +
      '<div class="player-dialog__preset-group">' + btns + '</div>' +
    '</div>'
  );
}

function renderCoresSlider(seat, selections) {
  const max = coresSliderMax();
  const c = Math.min(max, Math.max(CORES_MIN, selections.cores[seat] ?? DEFAULT_CORES));
  selections.cores[seat] = c;
  return (
    '<div class="player-dialog__field">' +
      '<label class="player-dialog__label">Search threads: ' +
        '<span class="player-dialog__time-val" data-cores-label="' + seat + '">' + c + '</span>' +
      '</label>' +
      '<input type="range" class="player-dialog__time-slider" data-cores-slider="' + seat + '"' +
      ' min="' + CORES_MIN + '" max="' + max + '" step="1" value="' + c + '">' +
    '</div>'
  );
}

function renderTimeSlider(seat, selections, labelText) {
  const wc = selections.wallClock[seat] ?? DEFAULT_WALL_CLOCK;
  return (
    '<div class="player-dialog__field">' +
      '<label class="player-dialog__label">' + escHtml(labelText) + ': ' +
        '<span class="player-dialog__time-val" data-time-label="' + seat + '">' + formatTime(wc) + '</span>' +
      '</label>' +
      '<input type="range" class="player-dialog__time-slider" data-time-slider="' + seat + '"' +
      ' min="' + WALL_CLOCK_MIN + '" max="' + WALL_CLOCK_MAX + '" step="' + WALL_CLOCK_STEP + '" value="' + wc + '">' +
    '</div>'
  );
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wireVisionSettings(overlay, selections, controller) {
  const refreshDetail = () => {
    const host = overlay.querySelector('[data-vision-detail]');
    if (host) {
      host.innerHTML = renderVisionDetail(selections);
    }
    overlay.querySelectorAll('[data-vision-mode]').forEach((btn) => {
      const active = btn.dataset.visionMode === selections.visionMode;
      btn.classList.toggle('btn--primary', active);
      btn.classList.toggle('btn--ghost', !active);
    });
    wireVisionDetail(overlay, selections, controller);
  };

  overlay.querySelectorAll('[data-vision-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      selections.visionMode = btn.dataset.visionMode ?? 'off';
      refreshDetail();
    });
  });

  wireVisionDetail(overlay, selections, controller);
}

function wireVisionDetail(overlay, selections, controller) {
  overlay.querySelectorAll('[data-cat-setting]').forEach((input) => {
    const update = (event) => {
      const target = event.currentTarget;
      const key = target.dataset.catSetting;
      selections.catVision = {
        ...DEFAULT_CAT_VISION,
        ...(selections.catVision ?? {}),
        [key]: target.type === 'checkbox' ? target.checked : Number(target.value),
      };
    };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
  });

  overlay.querySelectorAll('[data-vision-slider]').forEach((slider) => {
    slider.addEventListener('input', () => {
      const key = slider.dataset.visionSlider;
      const value = Number(slider.value);
      if (key === 'lmrAggressiveness') {
        selections.lmrAggressiveness = Math.round(clampNumber(
          value,
          LMR_AGGRESSIVENESS_MIN,
          LMR_AGGRESSIVENESS_MAX,
        ));
        if (selections.visionMode === 'lmr') {
          controller.setLmrAggressiveness?.(selections.lmrAggressiveness / 100);
          controller.setVisionMode?.('lmr');
        }
      } else if (key === 'squareOpacity' || key === 'wallOpacity') {
        selections.catVision = {
          ...DEFAULT_CAT_VISION,
          ...(selections.catVision ?? {}),
          [key]: clampNumber(value, 0.25, 1.5),
        };
        if (selections.visionMode === 'cat') {
          controller.updateCatVisionSettings?.(selections.catVision);
          controller.setVisionMode?.('cat');
        }
      }
      const label = overlay.querySelector('[data-vision-slider-label="' + key + '"]');
      if (label) {
        label.textContent =
          key === 'lmrAggressiveness' ? `${Math.round(value)}%` : formatPercent(value);
      }
    });
  });
}

function wireEngineControls(overlay, seat, selections) {
  const host = overlay.querySelector('[data-engine-controls="' + seat + '"]');
  if (!host) return;

  // TimeToMove buttons (remote engines)
  host.querySelectorAll('[data-tm-btn][data-seat="' + seat + '"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.tmId);
      selections.timeToMove[seat] = id;
      host.querySelectorAll('[data-tm-btn][data-seat="' + seat + '"]').forEach((b) => {
        b.classList.toggle('btn--primary', Number(b.dataset.tmId) === id);
        b.classList.toggle('btn--ghost',   Number(b.dataset.tmId) !== id);
      });
    });
  });

  // Remote strength buttons
  host.querySelectorAll('[data-strength-btn][data-seat="' + seat + '"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.strengthId);
      selections.remoteStrength[seat] = id;
      host.querySelectorAll('[data-strength-btn][data-seat="' + seat + '"]').forEach((b) => {
        b.classList.toggle('btn--primary', Number(b.dataset.strengthId) === id);
        b.classList.toggle('btn--ghost', Number(b.dataset.strengthId) !== id);
      });
    });
  });

  // Titanium NNUE net buttons
  host.querySelectorAll('[data-ti-net-btn][data-seat="' + seat + '"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.tiNetId;
      selections.titaniumNet[seat] = id;
      host.querySelectorAll('[data-ti-net-btn][data-seat="' + seat + '"]').forEach((b) => {
        b.classList.toggle('btn--primary', b.dataset.tiNetId === id);
        b.classList.toggle('btn--ghost', b.dataset.tiNetId !== id);
      });
    });
  });

  // ACE tier buttons
  host.querySelectorAll('[data-ace-btn][data-seat="' + seat + '"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.aceId);
      selections.aceStrength[seat] = id;
      host.querySelectorAll('[data-ace-btn][data-seat="' + seat + '"]').forEach((b) => {
        b.classList.toggle('btn--primary', Number(b.dataset.aceId) === id);
        b.classList.toggle('btn--ghost',   Number(b.dataset.aceId) !== id);
      });
    });
  });

  // Wall clock slider
  const slider = host.querySelector('[data-time-slider="' + seat + '"]');
  const label  = host.querySelector('[data-time-label="' + seat + '"]');
  if (slider) {
    slider.addEventListener('input', () => {
      const v = Number(slider.value);
      selections.wallClock[seat] = v;
      if (label) label.textContent = formatTime(v);
    });
  }

  const coresSlider = host.querySelector('[data-cores-slider="' + seat + '"]');
  const coresLabel = host.querySelector('[data-cores-label="' + seat + '"]');
  if (coresSlider) {
    coresSlider.addEventListener('input', () => {
      const v = Number(coresSlider.value);
      selections.cores[seat] = v;
      if (coresLabel) coresLabel.textContent = String(v);
    });
  }

}

function rebuildEngineControls(overlay, seat, selections) {
  const host = overlay.querySelector('[data-engine-controls="' + seat + '"]');
  if (!host) return;
  host.innerHTML = renderEngineControls(seat, selections);
  wireEngineControls(overlay, seat, selections);
}

// ── Apply ────────────────────────────────────────────────────────────────────

function buildAiSettings(playerType, selections, seat) {
  if (playerType === PlayerType.Human) return null;
  const cat = engineCategory(playerType);

  if (cat === 'remote') {
    return {
      strengthLevel: selections.remoteStrength[seat] ?? StrengthLevel.Alpha,
      timeToMove:    selections.timeToMove[seat] ?? DEFAULT_TIME_TO_MOVE,
    };
  }

  if (cat === 'zeroink') {
    return {
      timeToMove: selections.timeToMove[seat] ?? DEFAULT_TIME_TO_MOVE,
    };
  }

  if (cat === 'titanium') {
    return {
      titaniumNet:      migrateTitaniumNet(selections.titaniumNet[seat] ?? TITANIUM_NET_HARD),
      wallClockSeconds: selections.wallClock[seat] ?? DEFAULT_WALL_CLOCK,
      visitsBudget:     0,
      cores:            clampCores(selections.cores[seat] ?? DEFAULT_CORES),
    };
  }

  if (cat === 'ace-v13') {
    return {
      strengthLevel:    selections.aceStrength[seat] ?? DEFAULT_ACE_TIER,
      wallClockSeconds: selections.wallClock[seat] ?? DEFAULT_WALL_CLOCK,
    };
  }

  // local (Gorisanson, QuoridorV3, others)
  return {
    wallClockSeconds: selections.wallClock[seat] ?? DEFAULT_WALL_CLOCK,
    visitsBudget:     0,  // time-bounded; engine uses default node budget
  };
}

function applyVisionSettings(selections, controller) {
  const mode = selections.visionMode ?? 'off';
  controller.updateCatVisionSettings?.({
    ...DEFAULT_CAT_VISION,
    ...(selections.catVision ?? {}),
  });
  controller.setLmrAggressiveness?.((selections.lmrAggressiveness ?? 50) / 100);
  controller.setVisionMode?.(mode);
}

function applySelections(selections, isNewGame, controller, state) {
  const [p1Type, p2Type] = selections.players;

  const payload = {
    players: [p1Type, p2Type],
    playerAiSettings: [
      buildAiSettings(p1Type, selections, 0),
      buildAiSettings(p2Type, selections, 1),
    ],
  };

  if (isNewGame) {
    controller.newGameWithPlayers?.(payload);
  } else {
    controller.changePlayers?.(payload);
  }
}
