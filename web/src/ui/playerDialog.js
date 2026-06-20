/**
 * Player selection dialog — shown on page load, "New Game", and "Change players".
 *
 * Engine-specific controls (not a generic difficulty system):
 *
 *   Remote (Ka / Ishtar):   Thinking mode selector — Immediate / Short / Medium / Long
 *   Titanium (both):        Thinking time slider (wall clock, no fake difficulty)
 *   ACE v8/v10/v13:         Tier selector (JS→Rust→MoveGen+) + time slider
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
  isAceV10Family,
} from '../lib/timeControl.js';

const PREFS_KEY = 'quoridor-player-prefs-v3';

const TIME_TO_MOVE_OPTIONS = [
  { label: 'Immediate', id: TimeToMove.Intuition },
  { label: 'Short',     id: TimeToMove.Short },
  { label: 'Medium',    id: TimeToMove.Medium },
  { label: 'Long',      id: TimeToMove.Long },
];

const ACE_V10_TIERS = [
  { label: 'JS',            id: 0 },
  { label: 'Rust',          id: 1 },
  { label: 'MoveGen+',      id: 2 },
  { label: 'MoveGen+ EME',  id: 3 },
];

const ACE_V13_TIERS = [
  { label: 'JS',       id: 0 },
  { label: 'Rust',     id: 1 },
  { label: 'MoveGen+', id: 2 },
];

const DEFAULT_WALL_CLOCK    = 5;
const DEFAULT_TIME_TO_MOVE  = TimeToMove.Short;
const DEFAULT_ACE_TIER      = 0;
const WALL_CLOCK_MIN        = 0.5;
const WALL_CLOCK_MAX        = 60;
const WALL_CLOCK_STEP       = 0.5;

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatTime(seconds) {
  if (seconds < 1) return seconds + ' s';
  return (Number.isInteger(seconds) ? seconds : seconds.toFixed(1)) + ' s';
}

/** Classify a player type into a dialog control category. */
function engineCategory(playerType) {
  const configs = getAllEngineConfigs();
  if (playerType === PlayerType.Human) return 'human';
  if (isRemoteEngine(playerType, configs)) return 'remote';
  if (isTitaniumEngine(playerType, configs)) return 'titanium';
  if (isAceV10Family(playerType, configs)) return 'ace-v10';
  if (isAceFamily(playerType, configs)) return 'ace-v13';
  return 'local';
}

function aceDisplayTiers(playerType) {
  const configs = getAllEngineConfigs();
  return isAceV10Family(playerType, configs) ? ACE_V10_TIERS : ACE_V13_TIERS;
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
    };
  } catch {
    return {
      players:     [...defaultPlayers],
      wallClock:   [DEFAULT_WALL_CLOCK, DEFAULT_WALL_CLOCK],
      timeToMove:  [DEFAULT_TIME_TO_MOVE, DEFAULT_TIME_TO_MOVE],
      aceStrength: [DEFAULT_ACE_TIER, DEFAULT_ACE_TIER],
    };
  }
}

function savePrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {}
}

// ── Dialog state ─────────────────────────────────────────────────────────────

let currentDialog = null;

export function openPlayerDialog(state, controller, { mode = 'newgame' } = {}) {
  if (currentDialog) { currentDialog.remove(); currentDialog = null; }

  const isNewGame = mode === 'newgame';
  const title = isNewGame ? 'New game — choose players' : 'Change players';

  const prefs = loadPrefs(state);
  const selections = {
    players:     [...prefs.players],
    wallClock:   [...prefs.wallClock],
    timeToMove:  [...prefs.timeToMove],
    aceStrength: [...prefs.aceStrength],
  };

  const groups = getPlayerOptionGroups();

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';
  overlay.innerHTML =
    '<div class="player-dialog" role="dialog" aria-modal="true">' +
      '<div class="player-dialog__header">' +
        '<h2 class="player-dialog__title">' + escHtml(title) + '</h2>' +
        '<button class="player-dialog__close" aria-label="Close" data-action="close">✕</button>' +
      '</div>' +
      '<div class="player-dialog__body">' +
        '<div class="player-dialog__hint">White starts at the bottom and moves upward. Black starts at the top and moves downward.</div>' +
        renderSeatSection(0, selections, groups) +
        renderSeatSection(1, selections, groups) +
      '</div>' +
      '<div class="player-dialog__footer">' +
        '<button class="btn btn--primary player-dialog__start" data-action="start">' +
          (isNewGame ? 'Start game' : 'Apply') +
        '</button>' +
        (!isNewGame ? '<button class="btn player-dialog__cancel" data-action="cancel">Cancel</button>' : '') +
      '</div>' +
    '</div>';

  document.body.appendChild(overlay);
  currentDialog = overlay;

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

  const confirm = () => { applyAndClose(); };
  const cancel  = () => { overlay.remove(); currentDialog = null; };

  function applyAndClose() {
    savePrefs({
      players:     selections.players,
      wallClock:   selections.wallClock,
      timeToMove:  selections.timeToMove,
      aceStrength: selections.aceStrength,
    });
    applySelections(selections, isNewGame, controller, state);
    overlay.remove();
    currentDialog = null;
  }

  overlay.querySelector('[data-action="start"]')?.addEventListener('click', confirm);
  overlay.querySelector('[data-action="close"]')?.addEventListener('click', confirm);
  overlay.querySelector('[data-action="cancel"]')?.addEventListener('click', cancel);

  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); confirm(); }
    if (e.key === 'Escape') { e.preventDefault(); confirm(); }
  });

  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) confirm(); });
}

// ── Rendering ────────────────────────────────────────────────────────────────

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
    return renderTimeModeControls(seat, selections);
  }

  if (cat === 'titanium') {
    return renderTimeSlider(seat, selections, 'Thinking time');
  }

  if (cat === 'ace-v10' || cat === 'ace-v13') {
    return renderAceTierControls(seat, selections, playerType) +
           renderTimeSlider(seat, selections, 'Thinking time');
  }

  // Gorisanson, QuoridorV3, etc.
  return renderTimeSlider(seat, selections, 'Thinking time');
}

function renderTimeModeControls(seat, selections) {
  const current = selections.timeToMove[seat] ?? DEFAULT_TIME_TO_MOVE;
  const btns = TIME_TO_MOVE_OPTIONS.map((opt) =>
    '<button class="btn ' + (opt.id === current ? 'btn--primary' : 'btn--ghost') + ' btn--small"' +
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
    '<button class="btn ' + (t.id === current ? 'btn--primary' : 'btn--ghost') + ' btn--small"' +
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
      strengthLevel: StrengthLevel.Alpha,
      timeToMove:    selections.timeToMove[seat] ?? DEFAULT_TIME_TO_MOVE,
    };
  }

  if (cat === 'titanium') {
    return {
      strengthLevel:    StrengthLevel.Alpha,
      wallClockSeconds: selections.wallClock[seat] ?? DEFAULT_WALL_CLOCK,
      visitsBudget:     0,  // unlimited — time-only budget
    };
  }

  if (cat === 'ace-v10' || cat === 'ace-v13') {
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
