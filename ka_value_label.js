#!/usr/bin/env node
'use strict';
/**
 * Ka teacher — one intuition/search eval per position (NOT Ka playing a game).
 *
 *   echo "e2 e8 e3 e7" | node site/ka_value_label.js
 *   node site/ka_value_label.js --mode intuition < positions.txt
 *
 * stdin:  one space-separated move prefix per line (empty = startpos)
 * stdout: one JSON per line { moves, score, cp, mode }
 *
 * Reuses one WebSocket for the whole batch (avoid ~10s connect per line).
 */

const readline = require('readline');
const { QuoridorEngineClient, ENGINES } = require('./extracted/engine_client');

const mode = (process.argv.includes('--mode') && process.argv[process.argv.indexOf('--mode') + 1])
  || process.env.KA_TEACHER_MODE
  || 'intuition';
const TIMEOUT_MS = Number(process.env.KA_TEACHER_TIMEOUT_MS) || 45000;
const CONNECT_MS = Number(process.env.KA_TEACHER_CONNECT_MS) || 25000;

function scoreToCp(score) {
  if (score == null || !Number.isFinite(score)) return null;
  const p = Math.max(1e-4, Math.min(1 - 1e-4, score));
  const logit = Math.log(p / (1 - p));
  return Math.round(logit * 200);
}

class KaTeacherSession {
  constructor(timeMode) {
    this.timeMode = timeMode;
    this.engine = new QuoridorEngineClient(ENGINES.ka);
    this.openPromise = this._waitOpen();
  }

  _waitOpen() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { this.engine.destroy(); } catch {}
        reject(new Error(`ka teacher connect timeout (${CONNECT_MS}ms)`));
      }, CONNECT_MS);

      let settled = false;
      const done = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      this.engine.onError = (err) => done(() => reject(err));
      this.engine.onStatus = (st) => {
        if (st === 'idle' && this.engine.ws?.readyState === 1) {
          done(() => resolve());
        }
      };
      this.engine.connect();
    });
  }

  query(moves) {
    return this.openPromise.then(() => new Promise((resolve, reject) => {
      let lastScore = null;
      const timer = setTimeout(() => {
        reject(new Error(`ka teacher timeout (${TIMEOUT_MS}ms)`));
      }, TIMEOUT_MS);

      this.engine.onInfo = (info) => {
        if (Number.isFinite(info.score)) lastScore = info.score;
      };
      this.engine.onBestMove = () => {
        clearTimeout(timer);
        resolve(lastScore);
      };
      this.engine.onError = (err) => {
        clearTimeout(timer);
        reject(err);
      };

      if (moves.length) {
        this.engine.send(`makemove ${moves.join(' ')}`);
      }
      this.engine.go(this.timeMode);
    }));
  }

  destroy() {
    try { this.engine.destroy(); } catch {}
  }
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    lines.push(trimmed);
  }

  if (!lines.length) return;

  const session = new KaTeacherSession(mode);
  try {
    for (const trimmed of lines) {
      const moves = trimmed.split(/\s+/).filter(Boolean);
      try {
        const score = await session.query(moves);
        const cp = scoreToCp(score);
        process.stdout.write(JSON.stringify({
          moves: moves.join(' '),
          score,
          cp,
          mode,
        }) + '\n');
      } catch (e) {
        process.stderr.write(`KA_LABEL_ERR ${moves.join(' ')}: ${e.message}\n`);
        process.stdout.write(JSON.stringify({
          moves: moves.join(' '),
          score: null,
          cp: null,
          mode,
          error: e.message,
        }) + '\n');
      }
    }
  } finally {
    session.destroy();
  }
}

main().catch((e) => {
  process.stderr.write(String(e.stack || e) + '\n');
  process.exit(1);
});
