'use strict';
/**
 * Linux-style progress dock — one bar per concurrent game (up to MAX_SLOTS).
 * Only uses ANSI cursor control on a real TTY (never when piped).
 */

const MAX_SLOTS = 8;
const BAR_W = 26;
const MIN_RENDER_MS = 400;
const TICK_MS = 500;

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  gray: '\x1b[90m',
};

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function bar(pct, width = BAR_W) {
  const p = clamp01(pct);
  const n = Math.round(p * width);
  return `${C.cyan}${'█'.repeat(n)}${C.gray}${'░'.repeat(width - n)}${C.reset}`;
}

class ProgressBoard {
  constructor(opts = {}) {
    this.slots = Math.min(Math.max(1, opts.slots || MAX_SLOTS), MAX_SLOTS);
    this.title = opts.title || 'games';
    this.enabled = process.stderr.isTTY === true && process.env.NO_PROGRESS !== '1';
    this._lines = 0;
    this._timer = null;
    this._lastRender = 0;
    this._dirty = false;
    this._lastSnapshot = '';
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

  setSlotLabel(slot, label) {
    if (slot < 0 || slot >= this.slots) return;
    this.rows[slot].matchLabel = String(label || '');
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
    const text = String(msg).endsWith('\n') ? String(msg) : `${msg}\n`;
    if (!this.enabled) {
      process.stderr.write(text);
      return;
    }
    this._erase();
    process.stderr.write(text);
    this.render(true);
  }

  dispose() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (this.enabled && this._lines > 0) {
      this._erase();
      this._lines = 0;
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

  _label(r) {
    const tag = r.matchLabel
      ? `${C.bold}${r.matchLabel.slice(0, 24)}${C.reset} `
      : '';
    if (r.done) {
      return `${tag}${C.green}ok${C.reset} ${r.result}  ply ${r.ply}`;
    }
    if (!r.active) {
      return `${tag}${C.dim}idle${C.reset}`;
    }
    const side = r.side ? ` ${r.side}` : '';
    if (r.phase === 'think') {
      const elapsed = (Date.now() - r.thinkT0) / 1000;
      const over = elapsed > r.thinkBudget
        ? ` +${Math.round(elapsed - r.thinkBudget)}s`
        : '';
      return `${tag}${C.yellow}>>${C.reset} ply ${r.ply}/${r.maxPly}${side}${over}`;
    }
    return `${tag}ply ${r.ply}/${r.maxPly}${side}`;
  }

  _erase() {
    if (!this.enabled || this._lines <= 0) return;
    // Move cursor up N lines then erase from cursor to end of screen.
    // \x1b[0J avoids writing any newlines, preventing Windows console from scrolling/expanding.
    process.stderr.write(`\x1b[${this._lines}A\x1b[0J`);
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

    const active = this.rows.filter((r) => r.active).length;
    const done = this.rows.filter((r) => r.done).length;
    const lines = [
      `${C.gray}${'─'.repeat(72)}${C.reset}`,
      `${C.bold}${this.title}${C.reset}  ${C.dim}${active} active / ${done} done${C.reset}`,
    ];
    for (const r of this.rows) {
      lines.push(` ${bar(this._pct(r))} ${this._label(r)}`);
    }

    const snapshot = lines.join('\n');
    if (!force && snapshot === this._lastSnapshot) return;
    this._lastSnapshot = snapshot;

    this._erase();
    process.stderr.write(`${snapshot}\n`);
    this._lines = lines.length;
  }
}

module.exports = { ProgressBoard, MAX_SLOTS };
