#!/usr/bin/env node
/**
 * Pondering self-match: engineA vs engineB, each in its own OS process.
 *
 *   node site/self_match.js [options]
 *     --engine-a NAME    engine flag for A (default titanium-v15, our current engine)
 *     --engine-b NAME    engine flag for B (default ace-v13-ti-pure, JS v13 baseline)
 *     --time SEC         think time per move for both (default 2)
 *     --time-a SEC       override think time for A only
 *     --time-b SEC       override think time for B only
 *     --ponder-time SEC  how long to ponder on predicted move (default = think time)
 *     --games N          total games (default 16, rounded up to even)
 *     --concurrency K    games in flight simultaneously (default 1, max 4).
 *                        Each game = 2 titanium.exe sessions (A + B ponder in
 *                        parallel on separate cores).  K=4 → at most 8 processes.
 *     --open N           opening index 0..7 for fixed openings (default cycles)
 *     --max-ply N        ply cap (default 300)
 *     --bin PATH         titanium binary path
 *     --dump-games       GAME/RESULT to stdout; progress to stderr
 *     --no-ponder        disable pondering (pure sequential, useful for baseline)
 *
 * PONDERING DESIGN
 * ─────────────────
 * Each engine has ONE persistent session process that lives for the full game,
 * keeping its TT, history, and killers warm across moves.
 *
 * While the opponent thinks, the waiting engine immediately starts pondering the
 * PREDICTED opponent reply on its OWN persistent process (same TT):
 *
 *   A's turn:  A.bestMove(moves, timeA)  ‖  B.bestMove([moves+predictedAMove], ponderTime)
 *   B's turn:  B.bestMove(moves, timeB)  ‖  A.bestMove([moves+predictedBMove], ponderTime)
 *
 * "predictedXMove" comes from PV[1] of the most recent search by the OTHER engine.
 *
 *   HIT  (opponent played the predicted move): the engine's TT is deep on that
 *        position; dynamic-ID startup skips shallow depths → effectively one
 *        uninterrupted search across ponder + think windows.
 *   MISS: engine resets to the real position; the ponder's TT entries may still
 *        partially help (hash-keyed), but it's essentially a fresh search.
 *
 * CPU is NOT shared between the two sides' searches: each runs on its own OS
 * thread(s), giving trustworthy strength measurements.
 *
 * DUMP FORMAT (stdout, --dump-games):
 *   GAME e2 e8 e3 ...
 *   RESULT W          (W=P1 wins, B=P2 wins)
 */

'use strict';
const fs = require('fs');
const { spawn, spawnSync } = require('child_process');
const readline   = require('readline');
const path       = require('path');
const { ProgressBoard, MAX_SLOTS } = require('./progress_bars');

// ── CLI parsing ───────────────────────────────────────────────────────────────

const MAX_CONCURRENCY = 8;  // 2 engine processes per game (A + B ponder freely)

/** Overnight ladder engines only — bare "titanium" is legacy MCTS, not v15. */
const ALLOWED_ENGINES = new Set([
  'titanium-v15',
  'titanium-v15-frozen',
  'ace-v13-grafted', // historical partial-iter golden build (abe9ba5 worktree)
  'ace-v13-ti-pure',
  'ace-v13',
  'ace-v13-pure',
]);

function assertEngineFlag(flag, label = 'engine') {
  if (ALLOWED_ENGINES.has(flag)) return;
  if (flag === 'titanium' || (flag.startsWith('titanium-') && flag !== 'titanium-v15' && flag !== 'titanium-v15-frozen')) {
    throw new Error(
      `${label} "${flag}" is legacy or unknown — use titanium-v15, titanium-v15-frozen, or ace-v13-*`,
    );
  }
  throw new Error(`${label} "${flag}" not allowed in overnight pool`);
}

function parseArgs(argv) {
  const o = {
    engineA:    'titanium-v15',
    engineB:    'ace-v13-ti-pure',
    timeA:      2,
    timeB:      2,
    ponderTime: null,   // null = same as opponent think time
    games:      16,
    concurrency: 1,
    bin:        path.resolve(__dirname, '../engine/target/release/titanium.exe'),
    binA:       null,
    binB:       null,
    maxPly:     300,
    dumpGames:  false,
    // Games are appended to this file by default so every match feeds training data.
    // Pass --no-save-games to disable, or --save-games PATH to use a different file.
    saveGames:  path.resolve(__dirname, '../training/data/self_match_games.games'),
    noPonder:   false,
    sourceTag:  'self-match',
    standalone: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], nxt = () => argv[++i];
    if      (a === '--engine-a')     o.engineA    = nxt();
    else if (a === '--engine-b')     o.engineB    = nxt();
    else if (a === '--standalone' || a === '--no-coordinator') o.standalone = true;
    else if (a === '--time')         { o.timeA = o.timeB = Number(nxt()); }
    else if (a === '--time-a')       o.timeA      = Number(nxt());
    else if (a === '--time-b')       o.timeB      = Number(nxt());
    else if (a === '--ponder-time')  o.ponderTime = Number(nxt());
    else if (a === '--games')        o.games      = Number(nxt());
    else if (a === '--concurrency')  o.concurrency = Number(nxt());
    else if (a === '--max-ply')      o.maxPly     = Number(nxt());
    else if (a === '--bin')          o.bin        = nxt();
    else if (a === '--bin-a')        o.binA       = nxt();
    else if (a === '--bin-b')        o.binB       = nxt();
    else if (a === '--dump-games')   o.dumpGames  = true;
    else if (a === '--save-games')   o.saveGames  = nxt();
    else if (a === '--no-save-games') o.saveGames = null;
    else if (a === '--source-tag')   o.sourceTag  = nxt();
    else if (a === '--no-ponder')    o.noPonder   = true;
  }
  if (o.ponderTime === null) o.ponderTime = Math.max(o.timeA, o.timeB);
  if (o.concurrency > MAX_CONCURRENCY) {
    process.stderr.write(
      `warning: --concurrency ${o.concurrency} capped at ${MAX_CONCURRENCY} ` +
      `(each game needs 2 titanium.exe — A thinks while B ponders)\n`,
    );
    o.concurrency = MAX_CONCURRENCY;
  }
  if (o.concurrency < 1) o.concurrency = 1;
  o.binA = o.binA || o.bin;
  o.binB = o.binB || o.bin;
  return o;
}

// ── Fixed opening book (4-ply pawn-only sequences) ───────────────────────────
// Cycled by game index so every opening is played from both colours.

const OPENINGS = [
  ['e2', 'e8', 'e3', 'e7'],   // both straight
  ['e2', 'e8', 'e3', 'd8'],
  ['e2', 'e8', 'e3', 'f8'],
  ['e2', 'e8', 'd2', 'e7'],
  ['e2', 'e8', 'f2', 'e7'],
  ['d1', 'e8', 'd2', 'd8'],
  ['f1', 'e8', 'f2', 'f8'],
  ['e2', 'd8', 'e3', 'd7'],
];

// ── Engine session (mirrors OurEngine from ishtar_match.js) ──────────────────

class Engine {
  constructor(bin, flag) {
    assertEngineFlag(flag, 'session engine');
    this.flag = flag;
    this.bin = bin;
    if (!bin || typeof bin !== 'string') {
      throw new Error(`engine binary path missing for ${flag} — set bin/binA in opts`);
    }
    this.proc = spawn(bin, ['session', '--engine', flag], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.spawnError = null;
    this.proc.on('error', (e) => { this.spawnError = e; });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.stderrLines = [];
    this._chain = Promise.resolve();
    this.proc.stderr.on('data', (d) => {
      for (const ln of d.toString().split('\n'))
        if (ln.trim()) this.stderrLines.push(ln.trim());
    });
    this.queue   = [];
    this.waiters = [];
    this.rl.on('line', (line) => {
      const w = this.waiters.shift();
      if (w) w(line); else this.queue.push(line);
    });
  }

  _readLine(timeoutMs) {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise((resolve, reject) => {
      let timer = null;
      const onLine = (line) => {
        if (timer) clearTimeout(timer);
        resolve(line);
      };
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          const i = this.waiters.indexOf(onLine);
          if (i >= 0) this.waiters.splice(i, 1);
          reject(new Error(`engine read timeout (${timeoutMs}ms)`));
        }, timeoutMs);
      }
      this.waiters.push(onLine);
    });
  }

  _send(cmd) { this.proc.stdin.write(cmd + '\n'); }

  async _awaitAny(prefixes, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remain = deadline - Date.now();
      if (remain <= 0) throw new Error('engine command timeout');
      const line = await this._readLine(remain);
      if (line.startsWith('error ')) throw new Error(line.slice(6).trim());
      for (const p of prefixes) {
        if (line.startsWith(p)) return line;
      }
    }
  }

  _moveTimeoutMs(seconds) {
    const budget = Math.max(1000, Number(seconds) * 1000);
    return budget + 20000;
  }

  /**
   * Search from `moves`.  Returns `{ move, pvOpponentReply }`.
   * Serialized per process — ponder jobs queue behind prior searches instead of
   * interleaving stdin commands (which hangs legacy `titanium` sessions).
   */
  bestMove(moves, seconds) {
    const run = () => this._bestMoveImpl(moves, seconds);
    const p = this._chain.then(run);
    this._chain = p.catch(() => {});
    return p;
  }

  async _bestMoveImpl(moves, seconds) {
    if (this.spawnError) {
      throw new Error(`engine ${this.flag} failed to spawn: ${this.spawnError.message}`);
    }
    if (!this.proc || this.proc.exitCode != null) {
      throw new Error(`engine ${this.flag} process exited`);
    }
    const timeoutMs = this._moveTimeoutMs(seconds);
    try {
      this.stderrLines = [];
      this._send(moves.length ? `position ${moves.join(' ')}` : 'reset');
      await this._awaitAny(['ready'], timeoutMs);
      this._send(`go ${seconds}`);
      const line = await this._awaitAny(['bestmove'], timeoutMs);
      const mv = line.slice('bestmove '.length).trim();

      let pvOpponentReply = null;
      for (let i = this.stderrLines.length - 1; i >= 0; i--) {
        if (this.stderrLines[i].includes('"depthLog"')) {
          const pvM = [...this.stderrLines[i].matchAll(/"pv":"([^"]+)"/g)].pop();
          if (pvM) {
            const tok = pvM[1].split(' ').filter(Boolean);
            if (tok.length >= 2) pvOpponentReply = tok[1];
          }
          break;
        }
      }
      return { move: mv, pvOpponentReply };
    } catch (e) {
      try { this._send('quit'); } catch {}
      try { this.proc.kill(); } catch {}
      throw e;
    }
  }

  destroy() {
    return new Promise((resolve) => {
      const proc = this.proc;
      if (!proc || proc.exitCode !== null) {
        resolve();
        return;
      }
      const force = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch {}
        resolve();
      }, 5000);
      proc.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      try { this.rl.close(); } catch {}
      try { this._send('quit'); } catch {
        try { proc.kill(); } catch {}
      }
    });
  }
}

// ── Single game ───────────────────────────────────────────────────────────────

async function playGame(opts, gl, gameIdx, aIsP1, slot, progress) {
  assertEngineFlag(opts.engineA, 'engineA');
  assertEngineFlag(opts.engineB, 'engineB');
  const { QuoridorBoard } = gl;
  const opening = OPENINGS[gameIdx % OPENINGS.length];
  const board   = new QuoridorBoard();
  const moves   = [...opening];
  for (const m of opening) board.takeAction(m);

  progress.start(slot, gameIdx, opts.maxPly);
  progress.ply(slot, moves.length, opts.maxPly);

  const engA = new Engine(opts.binA || opts.bin, opts.engineA);
  const engB = new Engine(opts.binB || opts.bin, opts.engineB);

  // PONDERING — one continuous search per engine, no ephemeral processes:
  //
  // After engine X plays, X immediately starts pondering the predicted opponent reply
  // on X's OWN persistent engine (same process, same TT), in parallel with the
  // opponent's real think.  When the opponent plays:
  //
  //   HIT  (opponent played the predicted move): X's session already has this position
  //        applied and the TT is deep.  The next `go timeX` skips shallow depths via
  //        dynamic-ID startup — effectively one uninterrupted search across both windows.
  //   MISS: session resets to the actual position; the ponder's TT entries may partially
  //        help (hash-keyed), but it's essentially a fresh timeX-second search.
  let predictedBMove = null;  // A's prediction of B's next move (from A's PV[1])
  let predictedAMove = null;  // B's prediction of A's next move (from B's PV[1])

  let winner = 0;

  try {
    for (let ply = 0; ply < opts.maxPly; ply++) {
      const term = board.terminal();
      if (term.isTerminal) { winner = term.playerNum; break; }

      const p1ToMove = board.playerToMove() === 1;
      const aTurn    = p1ToMove === aIsP1;

      let mv;

      if (aTurn) {
        progress.thinking(slot, 'A', opts.timeA);
        const aThink = engA.bestMove(moves, opts.timeA);
        if (!opts.noPonder && predictedAMove !== null && opts.ponderTime > 0) {
          void engB.bestMove([...moves, predictedAMove], opts.ponderTime).catch(() => null);
        }
        const aRes = await aThink;
        mv             = aRes.move;
        predictedBMove = aRes.pvOpponentReply;

        if (!mv || mv === '(none)') { winner = aIsP1 ? 2 : 1; break; }

      } else {
        progress.thinking(slot, 'B', opts.timeB);
        const bThink = engB.bestMove(moves, opts.timeB);
        if (!opts.noPonder && predictedBMove !== null && opts.ponderTime > 0) {
          void engA.bestMove([...moves, predictedBMove], opts.ponderTime).catch(() => null);
        }
        const bRes = await bThink;
        mv             = bRes.move;
        predictedAMove = bRes.pvOpponentReply;

        if (!mv || mv === '(none)') { winner = aIsP1 ? 1 : 2; break; }
      }

      if (!board.isValid(mv)) {
        progress.note(`game ${gameIdx}: illegal move "${mv}" by ${aTurn ? 'A' : 'B'} at ply ${ply}`);
        winner = aTurn ? (aIsP1 ? 2 : 1) : (aIsP1 ? 1 : 2);
        break;
      }
      board.takeAction(mv);
      moves.push(mv);
      progress.ply(slot, moves.length, opts.maxPly);
    }
  } finally {
    await engA.destroy();
    await engB.destroy();
  }

  if (winner === 0) {
    // Quoridor has no draws — ply-cap adjudication must always pick a winner.
    const d1 = gl.shortestDistanceToGoal(board, 1);
    const d2 = gl.shortestDistanceToGoal(board, 2);
    if (d1 !== d2) {
      winner = d1 < d2 ? 1 : 2;
    } else {
      const w1 = board.wallsRemaining({ playerNum: 1 });
      const w2 = board.wallsRemaining({ playerNum: 2 });
      winner = w1 !== w2 ? (w1 > w2 ? 1 : 2) : 1;
    }
  }

  const aWins = (winner === 1) === aIsP1;
  progress.finish(slot, {
    plies: moves.length,
    label: aWins ? 'A wins' : 'B wins',
  });
  return {
    gameIdx,
    winner,
    aWins,
    plies: moves.length,
    moves,
  };
}

// ── Incremental training ingest (via localhost coordinator) ─────────────────

const coord = require('./coordinator_client');

async function persistGame(moves, result, sourceTag, gamesFile, { standalone = false } = {}) {
  if (standalone) {
    if (gamesFile) {
      fs.appendFileSync(gamesFile, `GAME ${moves.join(' ')}\nRESULT ${result}\n`);
    }
    try {
      const py = path.resolve(__dirname, '../training/ingest_self_match_game.py');
      spawnSync('python', [py, '--moves', moves.join(' '), '--result', result, '--tag', sourceTag || 'self-match'], {
        cwd: path.resolve(__dirname, '..'),
        stdio: 'ignore',
      });
    } catch {
      /* DB ingest best-effort */
    }
    return;
  }
  try {
    await coord.upsertGame({ moves, result, tag: sourceTag, gamesFile });
  } catch (e) {
    if (gamesFile) {
      fs.appendFileSync(gamesFile, `GAME ${moves.join(' ')}\nRESULT ${result}\n`);
    } else {
      throw e;
    }
  }
}

function tcLabel(seconds) {
  return `${seconds}s`;
}

async function loadPriorMatchup(engineA, engineB, tcA, tcB) {
  try {
    const j = await coord.lookupMatchup(engineA, engineB, tcA, tcB);
    return { aW: j.aW, bW: j.bW };
  } catch {
    return { aW: 0, bW: 0 };
  }
}

function runningElo(aW, bW) {
  const n = aW + bW;
  if (!n) return { elo: null, se: null };
  const p = aW / n;
  if (p <= 0 || p >= 1) return { elo: p >= 1 ? Infinity : -Infinity, se: 0 };
  const elo = -400 * Math.log10((1 - p) / p);
  const se  = Math.sqrt((p * (1 - p)) / n) * 196;
  return { elo, se };
}

async function updateMatchup(opts, aW, bW, logFn) {
  if (opts.standalone) {
    return;
  }
  try {
    const entry = await coord.upsertMatchup({
      engineA: opts.engineA,
      engineB: opts.engineB,
      aWins: aW,
      bWins: bW,
      tcA: tcLabel(opts.timeA),
      tcB: tcLabel(opts.timeB),
      gamesFile: opts.saveGames,
      source: opts.sourceTag,
    });
    if (entry.elo_a_vs_b != null && logFn) {
      logFn(`Elo diff (A vs B): ${entry.elo_a_vs_b}`);
    }
  } catch (e) {
    if (logFn) logFn(`matchup upsert skipped (no coordinator): ${e.message}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const gl   = await import('./web/src/lib/gameLogic.js');

  // Round up to even so every opening is played from both colours (multi-game batches only)
  if (opts.games > 1 && opts.games % 2 !== 0) opts.games++;

  // Always log progress to stderr — unbuffered even in non-TTY / background mode.
  const progress = new ProgressBoard({
    slots: Math.min(opts.concurrency, MAX_SLOTS),
    title: `${opts.engineA} vs ${opts.engineB}`,
  });
  const log = (...a) => progress.note(a.join(' '));

  const ponderNote = opts.noPonder ? 'no-ponder' : `ponder ${opts.ponderTime}s`;
  log(
    `self-match: A=${opts.engineA} (${opts.timeA}s)  vs  B=${opts.engineB} (${opts.timeB}s)` +
    `  [${ponderNote}]  ${opts.games} games  concurrency=${opts.concurrency}` +
    `  (≤${opts.concurrency * 2} titanium.exe)`,
  );

  // Open save-games file for append (creates it if missing).
  if (opts.saveGames) log(`saving games -> ${opts.saveGames}`);

  const prior = opts.standalone
    ? { aW: 0, bW: 0 }
    : await loadPriorMatchup(opts.engineA, opts.engineB, tcLabel(opts.timeA), tcLabel(opts.timeB));
  let aW = prior.aW, bW = prior.bW;
  let sessionAW = 0, sessionBW = 0;
  let done = 0;
  const started = Date.now();
  let next = 0;

  if (prior.aW + prior.bW > 0) {
    const { elo, se } = runningElo(aW, bW);
    log(
      `prior score (all runs): A ${aW} - ${bW} B  /  ${aW + bW} games` +
      (elo != null && Number.isFinite(elo) ? `  ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} Elo (±${se.toFixed(0)}%)` : ''),
    );
  }
  log(`Elo tracker: training/data/STATUS.txt`);

  async function worker(workerId) {
    const slot = workerId;
    for (;;) {
      const idx = next++;
      if (idx >= opts.games) {
        progress.idle(slot);
        return;
      }
      // Alternate which engine holds Player 1 so every opening covers both colours
      const aIsP1 = (idx % 2 === 0);
      let r;
      try {
        r = await playGame(opts, gl, idx, aIsP1, slot, progress);
      } catch (e) {
        progress.note(`game ${idx} error: ${e.message}`);
        progress.idle(slot);
        continue;
      }

      if (r.aWins) { aW++; sessionAW++; }
      else         { bW++; sessionBW++; }
      done++;

      const gameLines = `GAME ${r.moves.join(' ')}\nRESULT ${r.winner === 1 ? 'W' : 'B'}\n`;
      if (opts.dumpGames) process.stdout.write(gameLines);
      if (opts.saveGames || opts.sourceTag) {
        await persistGame(
          r.moves,
          r.winner === 1 ? 'W' : 'B',
          opts.sourceTag,
          opts.saveGames,
          { standalone: opts.standalone },
        );
      }
      await updateMatchup(opts, aW, bW, (msg) => log(msg));

      const { elo, se } = runningElo(aW, bW);
      const secs  = ((Date.now() - started) / 1000).toFixed(0);
      const eloS  = elo != null && Number.isFinite(elo)
        ? `  ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} Elo (±${se.toFixed(0)}%)`
        : '';
      log(
        `  [${done} this run, ${aW + bW} total] A ${aW} - ${bW} B` +
        `  (session ${sessionAW}-${sessionBW})${eloS}  ${r.plies} plies  ${secs}s`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, (_, i) => worker(i)));
  progress.dispose();

  if (opts.saveGames) {
    log(`training DB: ${path.resolve(__dirname, '../training/data/all_games.db')}`);
  }

  const n     = aW + bW || 1;
  const sessionN = sessionAW + sessionBW || done || 1;
  const p     = aW / n;
  const se    = Math.sqrt((p * (1 - p)) / n);
  const elo   = p > 0 && p < 1
    ? -400 * Math.log10((1 - p) / p)
    : (p >= 1 ? Infinity : -Infinity);

  log('=== MATCH RESULT ===');
  log(`A=${opts.engineA}  vs  B=${opts.engineB}`);
  log(`This run: A ${sessionAW} | B ${sessionBW}  (${sessionN} games)`);
  log(`Cumulative (all runs): A ${aW} | B ${bW}  (${n} games)`);
  log(
    `score ${aW}/${n} = ${(p * 100).toFixed(1)}%` +
    ` (+-${(se * 196).toFixed(1)}%)  ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} Elo`,
  );
  log(`Updated: training/data/STATUS.txt`);
  process.stderr.write(
    `MATCH_SUMMARY A=${aW} B=${bW} DRAWS=0 SCORE=${aW}/${n} ELO=${Number.isFinite(elo) ? elo.toFixed(0) : elo}\n`,
  );
}

if (require.main === module) {
  main().catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });
}

module.exports = {
  playGame,
  persistGame,
  loadPriorMatchup,
  updateMatchup,
  tcLabel,
  runningElo,
};
