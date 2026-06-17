'use strict';
/**
 * Live pool progress dock — scoreboard colors applied after fixed-width pad
 * so Windows terminals don't mis-wrap slot bars.
 */

const MAX_SLOTS = 8;
const MIN_RENDER_MS = 400;
const TICK_MS = 500;
const LABEL_W = 24;
const SCOREBOARD_W = 72;

function termCols(stream) {
  const s = stream || process.stderr;
  return Math.max(80, Math.min(160, s.columns || Number(process.env.PROGRESS_COLS) || 120));
}

function barWidth(cols) {
  return Math.max(8, Math.min(20, cols - LABEL_W - 36));
}

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  bold: '\u001b[1m',
  green: '\u001b[32m',
  red: '\u001b[31m',
  cyan: '\u001b[36m',
  yellow: '\u001b[33m',
  gray: '\u001b[90m',
};

function clamp01(x) {
  return Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
}

function bar(pct, width) {
  const w = Math.max(1, Math.floor(width) || 12);
  const p = clamp01(pct);
  const n = Math.min(w, Math.max(0, Math.round(p * w)));
  return C.cyan + '\u2588'.repeat(n) + C.gray + '\u2591'.repeat(w - n) + C.reset;
}

/** Strip ANSI so padding/wrap math matches visible columns. */
function visible(s) {
  return String(s).replace(/\u001b\[[0-9;]*m/g, '');
}

/** Pad/truncate to exact visible width (no ANSI in input). */
function fitPlain(s, width) {
  const t = visible(s);
  if (t.length >= width) return t.slice(0, width);
  return t + ' '.repeat(width - t.length);
}

function colorScoreboardLine(plain) {
  if (!plain.trim()) return plain;
  let s = plain;
  if (s.includes('| losing')) {
    s = s.replace('| losing', '| ' + C.red + 'losing' + C.reset);
  } else if (s.includes('| winning')) {
    s = s.replace('| winning', '| ' + C.green + 'winning' + C.reset);
  }
  if (s.startsWith('+') || s.startsWith('| QUORIDOR') || s.startsWith('| opponent')) {
    return C.cyan + s + C.reset;
  }
  if (s.startsWith('| TRAIN PLATEAU') || (s.startsWith('| TRAIN') && s.includes('PLATEAU'))) {
    return C.yellow + s + C.reset;
  }
  if (s.startsWith('| v15@10s')) {
    return C.dim + s + C.reset;
  }
  if (s.startsWith('|') && (s.includes('anchor') || s.includes('past-self') || s.includes('js orig'))) {
    return C.dim + s + C.reset;
  }
  if (s.startsWith('|') && s.includes('even')) {
    return C.dim + s + C.reset;
  }
  return s;
}

class ProgressBoard {
  constructor(opts = {}) {
    this.slots = Math.min(Math.max(1, opts.slots || MAX_SLOTS), MAX_SLOTS);
    this.title = opts.title || 'ACTIVE GAMES';
    this.continuous = opts.continuous === true;
    this.scoreboardLines = [];
    this.enabled = process.stderr.isTTY === true && process.env.NO_PROGRESS !== '1';
    this.cols = termCols(process.stderr);
    this.barW = barWidth(this.cols);
    this._timer = null;
    this._lastRender = 0;
    this._dirty = false;
    this._lastSnapshot = '';
    this._flash = '';
    this._flashUntil = 0;
    this.rows = Array.from({ length: this.slots }, (_, slot) => ({
      slot,
      matchLabel: '',
      active: false,
      gameIdx: -1,
      ply: 0,
      maxPly: 300,
      phase: 'idle',
      side: '',
      thinkPct: 0,
      thinkT0: 0,
      thinkBudget: 0,
      done: false,
      result: '',
    }));
  }

  beginPool() {
    if (!this.enabled) return;
    process.stderr.write('\x1b[?1049h\x1b[2J\x1b[H');
  }

  setSlotLabel(slot, label) {
    if (slot < 0 || slot >= this.slots) return;
    this.rows[slot].matchLabel = String(label || '');
  }

  setScoreboard(text) {
    const raw = String(text || '');
    this.scoreboardLines = raw.split('\n').filter((ln, i, arr) => {
      if (!ln.trim() && i === arr.length - 1) return false;
      return true;
    });
    this.render(true);
  }

  start(slot, gameIdx, maxPly, matchLabel = '') {
    if (slot < 0 || slot >= this.slots) return;
    const r = this.rows[slot];
    if (matchLabel) r.matchLabel = String(matchLabel);
    r.active = true;
    r.done = false;
    r.gameIdx = gameIdx;
    r.ply = 0;
    r.maxPly = maxPly;
    r.phase = 'start';
    r.side = '';
    r.thinkPct = 0;
    r.result = '';
    this._ensureTicker();
    this.render(true);
  }

  ply(slot, ply, maxPly) {
    if (slot < 0 || slot >= this.slots) return;
    const r = this.rows[slot];
    r.ply = ply;
    r.maxPly = maxPly;
    r.phase = 'ply';
    r.thinkPct = clamp01(ply / maxPly);
    this.render();
  }

  thinking(slot, side, budgetSec) {
    if (slot < 0 || slot >= this.slots) return;
    const r = this.rows[slot];
    r.phase = 'think';
    r.side = side;
    r.thinkT0 = Date.now();
    r.thinkBudget = Math.max(0.1, budgetSec);
    r.thinkPct = 0;
    this._ensureTicker();
    this.render();
  }

  reconnect(slot, attempt) {
    if (slot < 0 || slot >= this.slots) return;
    const r = this.rows[slot];
    r.active = true;
    r.phase = 'reconnect';
    r.side = attempt > 0 ? String(attempt) : '';
    r.thinkPct = 0;
    this.render(true);
  }

  finish(slot, { plies, label }) {
    if (slot < 0 || slot >= this.slots) return;
    const r = this.rows[slot];
    r.active = false;
    r.done = true;
    r.ply = plies;
    r.phase = 'done';
    r.thinkPct = 1;
    r.side = '';
    r.result = label || 'done';
    this._maybeStopTicker();
    this.render(true);
  }

  idle(slot) {
    if (slot < 0 || slot >= this.slots) return;
    const r = this.rows[slot];
    r.active = false;
    r.done = false;
    r.gameIdx = -1;
    r.ply = 0;
    r.phase = 'idle';
    r.side = '';
    r.thinkPct = 0;
    r.result = '';
    this.render();
  }

  note(msg) {
    this._flash = visible(String(msg)).slice(0, this.cols - 4);
    this._flashUntil = Date.now() + 25000;
    this.render(true);
  }

  dispose() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.enabled) {
      process.stderr.write('\x1b[?1049l');
    }
  }

  _hasThinking() {
    return this.rows.some((r) => r.active && r.phase === 'think');
  }

  _maybeStopTicker() {
    if (this._timer && !this._hasThinking()) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  _ensureTicker() {
    if (!this.enabled || this._timer) return;
    this._timer = setInterval(() => {
      if (!this._hasThinking()) {
        this._maybeStopTicker();
        if (this._dirty) this.render(true);
        return;
      }
      let dirty = false;
      const now = Date.now();
      for (const r of this.rows) {
        if (r.active && r.phase === 'think' && r.thinkBudget > 0) {
          const next = clamp01((now - r.thinkT0) / 1000 / r.thinkBudget);
          if (Math.abs(next - r.thinkPct) > 0.02) {
            r.thinkPct = next;
            dirty = true;
          }
        }
      }
      if (dirty || this._dirty) this.render();
    }, TICK_MS);
  }

  _pct(r) {
    if (!r.active && !r.done) return 0;
    if (r.phase === 'think') return r.thinkPct * 0.95 + (r.ply / r.maxPly) * 0.05;
    if (r.done) return 1;
    return clamp01(r.ply / r.maxPly);
  }

  _status(r) {
    if (r.phase === 'reconnect') {
      return C.yellow + 'reconnect #' + r.side + C.reset;
    }
    if (r.done) {
      return C.green + 'done' + C.reset + ' ply ' + r.ply;
    }
    if (!r.active) {
      return C.dim + 'waiting' + C.reset;
    }
    const who = r.side ? ' ' + r.side : '';
    if (r.phase === 'think') {
      return C.yellow + 'think' + C.reset + who + ' ' + r.ply + '/' + r.maxPly;
    }
    return String(r.ply + '/' + r.maxPly + who);
  }

  _slotLine(r, idx) {
    const num = String(idx + 1).padStart(2, ' ');
    const lbl = (r.matchLabel || '...').slice(0, LABEL_W).padEnd(LABEL_W);
    const status = this._status(r);
    const prefix = num + ' ' + lbl + ' ';
    let barW = this.barW;
    while (barW >= 4) {
      const line = prefix + bar(this._pct(r), barW) + ' ' + status;
      if (visible(line).length <= this.cols) return line;
      barW -= 1;
    }
    return prefix + bar(this._pct(r), 4) + ' ' + status;
  }

  _erase() {
    if (!this.enabled) return;
    process.stderr.write('\x1b[2J\x1b[H');
  }

  _runningCount() {
    return this.rows.filter((r) =>
      r.active || r.phase === 'reconnect' || r.phase === 'think',
    ).length;
  }

  render(force = false) {
    if (!this.enabled) return;
    const now = Date.now();
    if (!force && now - this._lastRender < MIN_RENDER_MS) {
      this._dirty = true;
      return;
    }
    this._lastRender = now;
    this._dirty = false;
    this.cols = termCols(process.stderr);
    this.barW = barWidth(this.cols);

    const running = this._runningCount();
    const lines = [];
    if (this._flash && Date.now() < this._flashUntil) {
      lines.push(C.yellow + this._flash + C.reset);
    } else if (this._flash) {
      this._flash = '';
    }
    if (this.scoreboardLines.length) {
      for (const ln of this.scoreboardLines) {
        const plain = fitPlain(ln, SCOREBOARD_W);
        lines.push(colorScoreboardLine(plain));
      }
    }
    lines.push('');
    lines.push(
      C.bold + this.title + C.reset
      + C.dim + ' (' + running + ' active / ' + this.slots + ' slots)' + C.reset,
    );
    lines.push(C.gray + '\u2500'.repeat(Math.min(this.cols, SCOREBOARD_W)) + C.reset);
    for (let i = 0; i < this.rows.length; i++) {
      lines.push(this._slotLine(this.rows[i], i));
    }
    lines.push(C.dim + ' log: training/data/supervisor.log  supervisor_alert.json' + C.reset);

    const snapshot = lines.join('\n');
    if (!force && snapshot === this._lastSnapshot) return;
    this._lastSnapshot = snapshot;

    this._erase();
    process.stderr.write(snapshot + '\n');
  }
}

module.exports = { ProgressBoard, MAX_SLOTS };
