#!/usr/bin/env node
/**
 * Pondering self-match: engineA vs engineB, each in its own OS process.
 *
 *   node site/self_match.js [options]
 *     --engine-a NAME    engine flag for A (default titanium-v14)
 *     --engine-b NAME    engine flag for B (default ace-v13-pure)
 *     --time SEC         think time per move for both (default 2)
 *     --time-a SEC       override think time for A only
 *     --time-b SEC       override think time for B only
 *     --ponder-time SEC  how long to ponder on predicted move (default = think time)
 *     --games N          total games (default 16, rounded up to even)
 *     --concurrency K    games in flight simultaneously (default 1)
 *     --open N           opening index 0..7 for fixed openings (default cycles)
 *     --max-ply N        ply cap (default 300)
 *     --bin PATH         titanium binary path
 *     --dump-games       GAME/RESULT to stdout; progress to stderr
 *     --no-ponder        disable pondering (pure sequential, useful for baseline)
 *
 * PONDERING DESIGN
 * ─────────────────
 * Each engine has ONE persistent session process that stays alive for the full
 * game, keeping its TT, history, and killers warm (state-retention).
 *
 * On every opponent turn, an *ephemeral* ponder process is spawned for the
 * side whose turn it ISN'T:
 *
 *   A's turn:  real A.think(2s)  ‖  ephemeral B.ponder([moves+predicted_A_reply], 2s)
 *   B's turn:  real B.think(2s)  ‖  ephemeral A.ponder([moves+predicted_B_reply], 2s)
 *
 * "predicted_X_reply" comes from the PV[1] of the last search by the OTHER engine.
 * If the prediction was correct the ponder result is used as the engine's next
 * move (instant deep reply). The ephemeral processes are separate from the
 * persistent real engines, so real-engine state is never disturbed by pondering.
 *
 * CPU is NOT shared between the two sides' searches: each process runs on its
 * own OS thread(s), giving trustworthy strength measurements.
 *
 * DUMP FORMAT (stdout, --dump-games):
 *   GAME e2 e8 e3 ...
 *   RESULT W          (W=P1 wins, B=P2 wins)
 */

'use strict';
const { spawn }  = require('child_process');
const readline   = require('readline');
const path       = require('path');
const fs         = require('fs');

// ── CLI parsing ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const o = {
    engineA:    'titanium-v14',
    engineB:    'ace-v13-pure',
    timeA:      2,
    timeB:      2,
    ponderTime: null,   // null = same as opponent think time
    games:      16,
    concurrency: 1,
    bin:        path.resolve(__dirname, '../engine/target/release/titanium.exe'),
    maxPly:     300,
    dumpGames:  false,
    // Games are appended to this file by default so every match feeds training data.
    // Pass --no-save-games to disable, or --save-games PATH to use a different file.
    saveGames:  path.resolve(__dirname, '../training/data/self_match_games.games'),
    noPonder:   false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i], nxt = () => argv[++i];
    if      (a === '--engine-a')     o.engineA    = nxt();
    else if (a === '--engine-b')     o.engineB    = nxt();
    else if (a === '--time')         { o.timeA = o.timeB = Number(nxt()); }
    else if (a === '--time-a')       o.timeA      = Number(nxt());
    else if (a === '--time-b')       o.timeB      = Number(nxt());
    else if (a === '--ponder-time')  o.ponderTime = Number(nxt());
    else if (a === '--games')        o.games      = Number(nxt());
    else if (a === '--concurrency')  o.concurrency = Number(nxt());
    else if (a === '--max-ply')      o.maxPly     = Number(nxt());
    else if (a === '--bin')          o.bin        = nxt();
    else if (a === '--dump-games')   o.dumpGames  = true;
    else if (a === '--save-games')   o.saveGames  = nxt();
    else if (a === '--no-save-games') o.saveGames = null;
    else if (a === '--no-ponder')    o.noPonder   = true;
  }
  if (o.ponderTime === null) o.ponderTime = Math.max(o.timeA, o.timeB);
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
    this.proc = spawn(bin, ['session', '--engine', flag], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.stderrLines = [];
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

  _readLine() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    return new Promise(res => this.waiters.push(res));
  }
  _send(cmd) { this.proc.stdin.write(cmd + '\n'); }
  async _await(prefix) {
    for (;;) { const l = await this._readLine(); if (l.startsWith(prefix)) return l; }
  }

  /**
   * Search from `moves`.  Returns `{ move, pvOpponentReply }`.
   * pvOpponentReply is PV[1] — the engine's prediction of the opponent's
   * reply, extracted from the depthLog on stderr.
   */
  async bestMove(moves, seconds) {
    this.stderrLines = [];
    this._send(moves.length ? `position ${moves.join(' ')}` : 'reset');
    await this._await('ready');
    this._send(`go ${seconds}`);
    const line = await this._await('bestmove');
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
  }

  destroy() {
    try { this._send('quit'); } catch {}
    this.proc.kill();
  }
}

// ── Single game ───────────────────────────────────────────────────────────────

async function playGame(opts, gl, gameIdx, aIsP1) {
  const { QuoridorBoard } = gl;
  const opening = OPENINGS[gameIdx % OPENINGS.length];
  const board   = new QuoridorBoard();
  const moves   = [...opening];
  for (const m of opening) board.takeAction(m);

  const engA = new Engine(opts.bin, opts.engineA);
  const engB = new Engine(opts.bin, opts.engineB);

  // Pondering state: what each engine predicted the opponent would play (from PV[1]).
  // Ephemeral ponder processes run during the opponent's think (free wall-clock time)
  // and warm the TT on the predicted continuation — but the persistent engine ALWAYS
  // searches for its full time budget.  No instant replies: a ponder hit gives a head
  // start (warm TT via dynamic-ID startup) but we keep thinking until time is up.
  let predictedBMove = null;  // what A predicts B will play (from A's last PV[1])
  let predictedAMove = null;  // what B predicts A will play (from B's last PV[1])

  let winner = 0;

  try {
    for (let ply = 0; ply < opts.maxPly; ply++) {
      const term = board.terminal();
      if (term.isTerminal) { winner = term.playerNum; break; }

      const p1ToMove = board.playerToMove() === 1;
      const aTurn    = p1ToMove === aIsP1;

      let mv;

      if (aTurn) {
        // ── A's turn ──────────────────────────────────────────────────────
        // Concurrently: B ponders its reply to predictedAMove while A thinks.
        // B's ponder runs for free (wall-clock) during A's think time.
        let bPonderProc    = null;
        let bPonderPromise = null;
        if (!opts.noPonder && predictedAMove !== null && opts.ponderTime > 0) {
          bPonderProc    = new Engine(opts.bin, opts.engineB);
          bPonderPromise = bPonderProc.bestMove([...moves, predictedAMove], opts.ponderTime);
        }

        // Always search with the persistent engine for the full time budget.
        // On a ponder hit the engine's dynamic-ID startup skips shallow depths
        // (TT already has a deep entry) giving more time to search deeper — but
        // we never cut the search short just because a ponder result is available.
        const res      = await engA.bestMove(moves, opts.timeA);
        mv             = res.move;
        predictedBMove = res.pvOpponentReply;

        // Collect B's ponder; if A played what B predicted, B already knows its reply.
        if (bPonderPromise) {
          const pRes = await bPonderPromise;
          bPonderProc.destroy();
          // Store so B's persistent engine can skip those shallow depths next turn
          // (the ponder warmed the position — but B will still search full timeB).
          if (mv === predictedAMove) predictedAMove = pRes.pvOpponentReply ?? predictedAMove;
        }

        if (!mv || mv === '(none)') { winner = aIsP1 ? 2 : 1; break; }

      } else {
        // ── B's turn ──────────────────────────────────────────────────────
        // Concurrently: A ponders its reply to predictedBMove while B thinks.
        let aPonderProc    = null;
        let aPonderPromise = null;
        if (!opts.noPonder && predictedBMove !== null && opts.ponderTime > 0) {
          aPonderProc    = new Engine(opts.bin, opts.engineA);
          aPonderPromise = aPonderProc.bestMove([...moves, predictedBMove], opts.ponderTime);
        }

        const res      = await engB.bestMove(moves, opts.timeB);
        mv             = res.move;
        predictedAMove = res.pvOpponentReply;

        // Collect A's ponder.
        if (aPonderPromise) {
          const pRes = await aPonderPromise;
          aPonderProc.destroy();
          if (mv === predictedBMove) predictedBMove = pRes.pvOpponentReply ?? predictedBMove;
        }

        if (!mv || mv === '(none)') { winner = aIsP1 ? 1 : 2; break; }
      }

      if (!board.isValid(mv)) {
        process.stderr.write(
          `game ${gameIdx}: illegal move "${mv}" by ${aTurn ? 'A' : 'B'} at ply ${ply}\n`,
        );
        winner = aTurn ? (aIsP1 ? 2 : 1) : (aIsP1 ? 1 : 2);
        break;
      }
      board.takeAction(mv);
      moves.push(mv);
    }
  } finally {
    engA.destroy();
    engB.destroy();
  }

  if (winner === 0) {
    const d1 = gl.shortestDistanceToGoal(board, 1);
    const d2 = gl.shortestDistanceToGoal(board, 2);
    winner = d1 < d2 ? 1 : d2 < d1 ? 2 : 0;
  }

  const aWins = winner !== 0 && (winner === 1) === aIsP1;
  return {
    gameIdx,
    winner,
    aWins,
    draw:  winner === 0,
    plies: moves.length,
    moves,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);
  const gl   = await import('./web/src/lib/gameLogic.js');

  // Round up to even so every opening is played from both colours
  if (opts.games % 2 !== 0) opts.games++;

  // Always log progress to stderr — unbuffered even in non-TTY / background mode.
  // GAME/RESULT data lines go to stdout (for --dump-games piping).
  const log = (...a) => process.stderr.write(a.join(' ') + '\n');

  const ponderNote = opts.noPonder ? 'no-ponder' : `ponder ${opts.ponderTime}s`;
  log(
    `self-match: A=${opts.engineA} (${opts.timeA}s)  vs  B=${opts.engineB} (${opts.timeB}s)` +
    `  [${ponderNote}]  ${opts.games} games  concurrency=${opts.concurrency}`,
  );

  // Open save-games file for append (creates it if missing).
  const saveStream = opts.saveGames
    ? fs.createWriteStream(opts.saveGames, { flags: 'a', encoding: 'utf8' })
    : null;
  if (saveStream) log(`saving games -> ${opts.saveGames}`);

  let aW = 0, bW = 0, draws = 0, done = 0;
  const started = Date.now();
  let next = 0;

  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= opts.games) return;
      // Alternate which engine holds Player 1 so every opening covers both colours
      const aIsP1 = (idx % 2 === 0);
      let r;
      try {
        r = await playGame(opts, gl, idx, aIsP1);
      } catch (e) {
        process.stderr.write(`game ${idx} error: ${e.message}\n${e.stack}\n`);
        continue;
      }

      if (r.draw)       draws++;
      else if (r.aWins) aW++;
      else              bW++;
      done++;

      if (!r.draw) {
        const gameLines = `GAME ${r.moves.join(' ')}\nRESULT ${r.winner === 1 ? 'W' : 'B'}\n`;
        if (opts.dumpGames)  process.stdout.write(gameLines);
        if (saveStream)      saveStream.write(gameLines);
      }

      const score = aW + 0.5 * draws;
      const secs  = ((Date.now() - started) / 1000).toFixed(0);
      log(
        `  [${done}/${opts.games}] A ${aW} - ${bW} B  (${draws} draws)  ` +
        `score ${score.toFixed(1)}/${done}  ${r.plies} plies  ${secs}s`,
      );
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  if (saveStream) await new Promise(res => saveStream.end(res));

  // Auto-ingest into training DB immediately after match completes.
  if (opts.saveGames) {
    const dbPath = path.resolve(__dirname, '../training/data/all_games.jsonl');
    const datagen = path.resolve(__dirname, '../training/datagen.py');
    log(`ingesting games into training DB: ${dbPath}`);
    await new Promise((resolve, reject) => {
      const py = spawn('python', [datagen, '--from-file', opts.saveGames, '--out', dbPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      py.stdout.on('data', d => log(d.toString().trim()));
      py.stderr.on('data', d => process.stderr.write(d));
      py.on('close', code => {
        if (code === 0) resolve();
        else reject(new Error(`datagen.py exited with code ${code}`));
      });
    });
  }

  const n     = done || 1;
  const score = aW + 0.5 * draws;
  const p     = score / n;
  const se    = Math.sqrt((p * (1 - p)) / n);
  const elo   = p > 0 && p < 1
    ? -400 * Math.log10((1 - p) / p)
    : (p >= 1 ? Infinity : -Infinity);

  log('=== MATCH RESULT ===');
  log(`A=${opts.engineA}  vs  B=${opts.engineB}`);
  log(`A ${aW} | B ${bW} | draws ${draws}`);
  log(
    `score ${score.toFixed(1)}/${n} = ${(p * 100).toFixed(1)}%` +
    ` (+-${(se * 196).toFixed(1)}%)  ~${elo >= 0 ? '+' : ''}${elo.toFixed(0)} Elo`,
  );
  process.stderr.write(
    `MATCH_SUMMARY A=${aW} B=${bW} DRAWS=${draws} SCORE=${score.toFixed(1)}/${n} ELO=${elo.toFixed(0)}\n`,
  );
}

main().catch(e => { process.stderr.write(e.stack + '\n'); process.exit(1); });
